import type { ListReminders, Priority, Reminder, ReminderCreate, ReminderFilter, ReminderPatch } from '../../../shared/types.js';
import type { Ctx } from '../ctx.js';
import { batch, exec, many, one, q, type Db, type Stmt } from '../db/index.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { enqueueSync } from '../google/outbox';
import { b64url, chunk, fromUtf8, unb64url, utf8 } from '../util.js';
import { nextOccurrence, normalizeRrule, wallClock } from './recurrence.js';
import { isValidTz, startOfDay } from './tz.js';
import { cleanLine, cleanText, MAX_NOTES } from './sanitize.js';
import { addSubtask, patchSubtask, removeSubtask, setSubtasks, subtasksFor } from './subtasks.js';

export type { Ctx };

interface Row {
  id: string; user_id: string; list_id: string; title: string; notes: string; status: 'open' | 'done'; priority: number;
  due_at: string | null; all_day: number; timezone: string; rrule: string | null; snoozed_until: string | null;
  completed_at: string | null; calendar_sync: number; google_event_id: string | null; google_etag: string | null;
  created_at: string; updated_at: string; deleted_at: string | null; version: number;
  rrule_anchor?: string | null; rrule_anchor_due?: string | null;
}

const iso = (d: string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const nowIso = () => new Date().toISOString();

async function tagsFor(db: Db, ids: string[]): Promise<Map<string, string[]>> {
  const m = new Map<string, string[]>();
  if (!ids.length) return m;
  for (const part of chunk(ids)) {
    const rows = await many<{ reminder_id: string; tag_id: string }>(db, `SELECT reminder_id, tag_id FROM reminder_tags WHERE reminder_id IN (${part.map(() => '?').join(',')}) ORDER BY rowid`, ...part);
    for (const r of rows) (m.get(r.reminder_id) ?? m.set(r.reminder_id, []).get(r.reminder_id)!).push(r.tag_id);
  }
  return m;
}

function toReminder(r: Row, tagIds: string[], subtasks: Reminder['subtasks'] = []): Reminder {
  return {
    id: r.id, listId: r.list_id, title: r.title, notes: r.notes, status: r.status, priority: r.priority as Priority,
    dueAt: r.due_at, allDay: !!r.all_day, timezone: r.timezone, rrule: r.rrule, snoozedUntil: r.snoozed_until,
    completedAt: r.completed_at, tagIds, calendarSync: !!r.calendar_sync, googleEventId: r.google_event_id,
    googleEtag: r.google_etag, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at, version: r.version, subtasks,
  };
}

const rowById = (db: Db, userId: string, id: string) =>
  one<Row>(db, 'SELECT * FROM reminders WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, userId);

export async function getReminder(ctx: Ctx, userId: string, id: string): Promise<Reminder> {
  const r = await rowById(ctx.db, userId, id);
  if (!r) throw notFound('Reminder not found');
  return toReminder(r, (await tagsFor(ctx.db, [id])).get(id) ?? [], (await subtasksFor(ctx.db, [id])).get(id) ?? []);
}

export async function defaultListId(db: Db, userId: string): Promise<string> {
  const find = () => one<{ id: string }>(db, 'SELECT id FROM lists WHERE user_id = ? AND is_default = 1 AND deleted_at IS NULL', userId);
  const r = await find();
  if (r) return r.id;
  const t = nowIso();
  // The partial unique index makes a racing second insert a no-op; either way the winner is read back.
  await exec(db, "INSERT OR IGNORE INTO lists (id, user_id, name, color, sort_order, is_default, created_at, updated_at) VALUES (?, ?, 'Inbox', '#6366f1', 0, 1, ?, ?)", crypto.randomUUID(), userId, t, t);
  return (await find())!.id;
}

async function checkList(db: Db, userId: string, listId: string) {
  if (!(await one(db, 'SELECT 1 FROM lists WHERE id = ? AND user_id = ? AND deleted_at IS NULL', listId, userId))) throw badRequest('Unknown listId');
}
async function checkTags(db: Db, userId: string, tagIds: string[]) {
  for (const t of tagIds) if (!(await one(db, 'SELECT 1 FROM tags WHERE id = ? AND user_id = ?', t, userId))) throw badRequest(`Unknown tag id ${t}`);
}
const setTags = (db: Db, reminderId: string, tagIds: string[]): Stmt[] => [
  q(db, 'DELETE FROM reminder_tags WHERE reminder_id = ?', reminderId),
  ...tagIds.map((t) => q(db, 'INSERT OR IGNORE INTO reminder_tags (reminder_id, tag_id) VALUES (?, ?)', reminderId, t)),
];

function cleanRrule(v: string | null | undefined): string | null {
  if (v == null || v === '') return null;
  try { return normalizeRrule(v); } catch { throw badRequest('Invalid rrule'); }
}
function cleanTz(v: string | undefined, fallback: string): string {
  if (v === undefined) return fallback;
  if (!isValidTz(v)) throw badRequest('Invalid timezone');
  return v;
}
function cleanDate(v: string | null | undefined): string | null | undefined {
  return v === undefined ? undefined : iso(v);
}

async function sync(ctx: Ctx, userId: string, id: string, op: 'upsert' | 'delete', wasSynced: boolean, isSynced: boolean) {
  if (!wasSynced && !isSynced) return;
  if (await enqueueSync(ctx.db, userId, id, op === 'upsert' && !isSynced ? 'delete' : op)) ctx.kick(userId);
}

export async function createReminder(ctx: Ctx, userId: string, input: ReminderCreate): Promise<Reminder> {
  const { db } = ctx;
  const id = crypto.randomUUID();
  const t = nowIso();
  const listId = input.listId ?? (await defaultListId(db, userId));
  await checkList(db, userId, listId);
  const tagIds = [...new Set(input.tagIds ?? [])];
  await checkTags(db, userId, tagIds);
  const done = input.status === 'done';
  const stmts: Stmt[] = [
    q(db, `INSERT INTO reminders (id, user_id, list_id, title, notes, status, priority, due_at, all_day, timezone, rrule, snoozed_until, completed_at, calendar_sync, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    id, userId, listId, cleanLine(input.title, 500) || 'Untitled', cleanText(input.notes ?? '', MAX_NOTES), done ? 'done' : 'open', input.priority ?? 0,
    cleanDate(input.dueAt) ?? null, input.allDay ? 1 : 0, cleanTz(input.timezone, ctx.config.defaultTimezone), cleanRrule(input.rrule),
    cleanDate(input.snoozedUntil) ?? null, done ? t : null, input.calendarSync ? 1 : 0, t, t),
    ...tagIds.map((tag) => q(db, 'INSERT OR IGNORE INTO reminder_tags (reminder_id, tag_id) VALUES (?, ?)', id, tag)),
  ];
  if (input.subtasks?.length) stmts.push(...(await setSubtasks(db, id, input.subtasks)));
  await batch(db, stmts);
  await sync(ctx, userId, id, 'upsert', false, !!input.calendarSync);
  return getReminder(ctx, userId, id);
}

export async function updateReminder(ctx: Ctx, userId: string, id: string, patch: ReminderPatch): Promise<Reminder> {
  const { db } = ctx;
  const cur = await rowById(db, userId, id);
  if (!cur) throw notFound('Reminder not found');
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw conflict('Reminder was modified elsewhere', await getReminder(ctx, userId, id));
  }
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) set.title = cleanLine(patch.title, 500) || cur.title;
  if (patch.notes !== undefined) set.notes = cleanText(patch.notes, MAX_NOTES);
  if (patch.listId !== undefined) { await checkList(db, userId, patch.listId); set.list_id = patch.listId; }
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.dueAt !== undefined) {
    set.due_at = cleanDate(patch.dueAt);
    if (patch.snoozedUntil === undefined && set.due_at !== cur.due_at) set.snoozed_until = null;
  }
  if (patch.allDay !== undefined) set.all_day = patch.allDay ? 1 : 0;
  if (patch.timezone !== undefined) set.timezone = cleanTz(patch.timezone, cur.timezone);
  if (patch.rrule !== undefined) set.rrule = cleanRrule(patch.rrule);
  if (patch.snoozedUntil !== undefined) set.snoozed_until = cleanDate(patch.snoozedUntil);
  if (patch.calendarSync !== undefined) set.calendar_sync = patch.calendarSync ? 1 : 0;
  if (patch.status !== undefined && patch.status !== cur.status) {
    set.status = patch.status;
    set.completed_at = patch.status === 'done' ? nowIso() : null;
  }
  if (patch.tagIds !== undefined) await checkTags(db, userId, patch.tagIds);
  const t = nowIso();
  const cols = Object.keys(set);
  const stmts: Stmt[] = [
    q(db, `UPDATE reminders SET ${cols.map((c) => `${c} = ?`).join(', ')}${cols.length ? ',' : ''} updated_at = ?, version = version + 1 WHERE id = ?`, ...cols.map((c) => set[c]), t, id),
  ];
  if (patch.tagIds !== undefined) stmts.push(...setTags(db, id, [...new Set(patch.tagIds)]));
  if (patch.subtasks !== undefined) stmts.push(...(await setSubtasks(db, id, patch.subtasks)));
  await batch(db, stmts);
  const after = await getReminder(ctx, userId, id);
  await sync(ctx, userId, id, 'upsert', !!cur.calendar_sync, after.calendarSync);
  return after;
}

/** Checklist edits bump the reminder version (so clients see the change) but never sync to Google. */
export async function editSubtasks(ctx: Ctx, userId: string, id: string, fn: (db: Db) => Promise<Stmt[]>): Promise<Reminder> {
  if (!(await rowById(ctx.db, userId, id))) throw notFound('Reminder not found');
  const stmts = await fn(ctx.db);
  await batch(ctx.db, [...stmts, q(ctx.db, 'UPDATE reminders SET updated_at = ?, version = version + 1 WHERE id = ?', nowIso(), id)]);
  return getReminder(ctx, userId, id);
}
export const subtaskOps = { addSubtask, patchSubtask, removeSubtask };

export async function completeReminder(ctx: Ctx, userId: string, id: string): Promise<Reminder> {
  const cur = await rowById(ctx.db, userId, id);
  if (!cur) throw notFound('Reminder not found');
  if (cur.status === 'done') return getReminder(ctx, userId, id);
  const anchor = cur.due_at && cur.rrule_anchor && cur.rrule_anchor_due === cur.due_at ? cur.rrule_anchor : cur.due_at ? wallClock(cur.timezone, cur.due_at) : undefined;
  const next = cur.rrule && cur.due_at ? nextOccurrence(cur.rrule, cur.due_at, cur.timezone, { anchor, now: Date.now() }) : null;
  const t = nowIso();
  if (next) {
    await exec(ctx.db, "UPDATE reminders SET due_at = ?, rrule = ?, rrule_anchor = ?, rrule_anchor_due = ?, snoozed_until = NULL, status = 'open', completed_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?", next.dueAt, next.rrule, anchor ?? null, next.dueAt, t, id);
  } else {
    await exec(ctx.db, "UPDATE reminders SET status = 'done', completed_at = ?, snoozed_until = NULL, updated_at = ?, version = version + 1 WHERE id = ?", t, t, id);
  }
  await sync(ctx, userId, id, 'upsert', !!cur.calendar_sync, !!cur.calendar_sync);
  return getReminder(ctx, userId, id);
}

export async function uncompleteReminder(ctx: Ctx, userId: string, id: string): Promise<Reminder> {
  const cur = await rowById(ctx.db, userId, id);
  if (!cur) throw notFound('Reminder not found');
  if (cur.status === 'open') return getReminder(ctx, userId, id);
  await exec(ctx.db, "UPDATE reminders SET status = 'open', completed_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?", nowIso(), id);
  await sync(ctx, userId, id, 'upsert', !!cur.calendar_sync, !!cur.calendar_sync);
  return getReminder(ctx, userId, id);
}

export async function snoozeReminder(ctx: Ctx, userId: string, id: string, body: { until: string } | { minutes: number }): Promise<Reminder> {
  const cur = await rowById(ctx.db, userId, id);
  if (!cur) throw notFound('Reminder not found');
  const until = 'until' in body ? new Date(body.until).toISOString() : new Date(Date.now() + body.minutes * 60_000).toISOString();
  await exec(ctx.db, 'UPDATE reminders SET snoozed_until = ?, updated_at = ?, version = version + 1 WHERE id = ?', until, nowIso(), id);
  return getReminder(ctx, userId, id);
}

export async function deleteReminder(ctx: Ctx, userId: string, id: string): Promise<void> {
  const cur = await rowById(ctx.db, userId, id);
  if (!cur) throw notFound('Reminder not found');
  const t = nowIso();
  await exec(ctx.db, 'UPDATE reminders SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?', t, t, id);
  await sync(ctx, userId, id, 'delete', !!cur.calendar_sync || !!cur.google_event_id, false);
}

export interface ListQuery { filter: ReminderFilter; listId?: string; tagId?: string; q?: string; cursor?: string; limit: number; tz?: string }

/**
 * Filters (open reminders unless noted; snoozed-into-the-future ones are hidden from today/overdue):
 *  today = due within today's local day; upcoming = due after today; overdue = due before now (all-day: before today);
 *  all = every open reminder; done = completed reminders.
 */
export async function listReminders(ctx: Ctx, userId: string, query: ListQuery, now = new Date()): Promise<ListReminders> {
  const tz = query.tz && isValidTz(query.tz) ? query.tz : ctx.config.defaultTimezone;
  const nowS = now.toISOString();
  const sod = new Date(startOfDay(tz, now.getTime())).toISOString();
  const eod = new Date(startOfDay(tz, now.getTime(), 1)).toISOString();
  const where = ['user_id = ?', 'deleted_at IS NULL'];
  const args: unknown[] = [userId];
  const notSnoozed = '(snoozed_until IS NULL OR snoozed_until <= ?)';
  let order = 'due_at IS NULL, due_at ASC, priority DESC, created_at ASC';
  switch (query.filter) {
    case 'today': where.push("status = 'open'", 'due_at >= ? AND due_at < ?', notSnoozed); args.push(sod, eod, nowS); break;
    case 'upcoming': where.push("status = 'open'", 'due_at >= ?'); args.push(eod); break;
    case 'overdue': where.push("status = 'open'", '((all_day = 0 AND due_at < ?) OR (all_day = 1 AND due_at < ?))', notSnoozed); args.push(nowS, sod, nowS); break;
    case 'done': where.push("status = 'done'"); order = 'completed_at DESC'; break;
    default: where.push("status = 'open'");
  }
  if (query.listId) { where.push('list_id = ?'); args.push(query.listId); }
  if (query.tagId) { where.push('EXISTS (SELECT 1 FROM reminder_tags rt WHERE rt.reminder_id = reminders.id AND rt.tag_id = ?)'); args.push(query.tagId); }
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  let offset = 0;
  if (query.cursor) {
    try { offset = Number(fromUtf8(unb64url(query.cursor))); } catch { offset = NaN; }
    if (!Number.isInteger(offset) || offset < 0) throw badRequest('Invalid cursor');
  }
  const rows = await many<Row>(ctx.db, `SELECT * FROM reminders WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, query.limit + 1, offset);
  const page = rows.slice(0, query.limit);
  const tm = await tagsFor(ctx.db, page.map((r) => r.id));
  const sm = await subtasksFor(ctx.db, page.map((r) => r.id));
  return {
    items: page.map((r) => toReminder(r, tm.get(r.id) ?? [], sm.get(r.id) ?? [])),
    nextCursor: rows.length > query.limit ? b64url(utf8(String(offset + query.limit))) : null,
  };
}

/** Open reminders whose effective alert time (snoozedUntil, else dueAt) is in (since, now]. Timed reminders only. */
export async function dueNotifications(ctx: Ctx, userId: string, since: Date, now = new Date()): Promise<Reminder[]> {
  const rows = await many<Row>(ctx.db, `SELECT * FROM reminders WHERE user_id = ? AND deleted_at IS NULL AND status = 'open' AND due_at IS NOT NULL
    AND (all_day = 0 OR snoozed_until IS NOT NULL) AND COALESCE(snoozed_until, due_at) > ? AND COALESCE(snoozed_until, due_at) <= ?
    ORDER BY COALESCE(snoozed_until, due_at)`, userId, since.toISOString(), now.toISOString());
  const tm = await tagsFor(ctx.db, rows.map((r) => r.id));
  const sm = await subtasksFor(ctx.db, rows.map((r) => r.id));
  return rows.map((r) => toReminder(r, tm.get(r.id) ?? [], sm.get(r.id) ?? []));
}

export { AppError };
