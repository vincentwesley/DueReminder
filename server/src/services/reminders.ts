import { randomUUID } from 'node:crypto';
import type { ListReminders, Priority, Reminder, ReminderCreate, ReminderFilter, ReminderPatch } from '../../../shared/types.js';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import type { SyncHooks } from './hooks.js';
import { nextOccurrence, normalizeRrule } from './recurrence.js';
import { isValidTz, startOfDay } from './tz.js';

export interface Ctx { db: Db; config: AppConfig; hooks: SyncHooks }

interface Row {
  id: string; user_id: string; list_id: string; title: string; notes: string; status: 'open' | 'done'; priority: number;
  due_at: string | null; all_day: number; timezone: string; rrule: string | null; snoozed_until: string | null;
  completed_at: string | null; calendar_sync: number; google_event_id: string | null; google_etag: string | null;
  created_at: string; updated_at: string; deleted_at: string | null; version: number;
}

const iso = (d: string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const nowIso = () => new Date().toISOString();

function tagsFor(db: Db, ids: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!ids.length) return m;
  const rows = db.prepare(`SELECT reminder_id, tag_id FROM reminder_tags WHERE reminder_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`).all(...ids) as { reminder_id: string; tag_id: string }[];
  for (const r of rows) (m.get(r.reminder_id) ?? m.set(r.reminder_id, []).get(r.reminder_id)!).push(r.tag_id);
  return m;
}

function toReminder(r: Row, tagIds: string[]): Reminder {
  return {
    id: r.id, listId: r.list_id, title: r.title, notes: r.notes, status: r.status, priority: r.priority as Priority,
    dueAt: r.due_at, allDay: !!r.all_day, timezone: r.timezone, rrule: r.rrule, snoozedUntil: r.snoozed_until,
    completedAt: r.completed_at, tagIds, calendarSync: !!r.calendar_sync, googleEventId: r.google_event_id,
    googleEtag: r.google_etag, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at, version: r.version,
  };
}

function rowById(db: Db, userId: string, id: string): Row | undefined {
  return db.prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId) as Row | undefined;
}

export function getReminder(ctx: Ctx, userId: string, id: string): Reminder {
  const r = rowById(ctx.db, userId, id);
  if (!r) throw notFound('Reminder not found');
  return toReminder(r, tagsFor(ctx.db, [id]).get(id) ?? []);
}

export function defaultListId(db: Db, userId: string): string {
  const r = db.prepare('SELECT id FROM lists WHERE user_id = ? AND is_default = 1 AND deleted_at IS NULL').get(userId) as { id: string } | undefined;
  if (r) return r.id;
  const id = randomUUID();
  const t = nowIso();
  db.prepare("INSERT INTO lists (id, user_id, name, color, sort_order, is_default, created_at, updated_at) VALUES (?, ?, 'Inbox', '#6366f1', 0, 1, ?, ?)").run(id, userId, t, t);
  return id;
}

function checkList(db: Db, userId: string, listId: string) {
  if (!db.prepare('SELECT 1 FROM lists WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(listId, userId)) throw badRequest('Unknown listId');
}
function checkTags(db: Db, userId: string, tagIds: string[]) {
  for (const t of tagIds) if (!db.prepare('SELECT 1 FROM tags WHERE id = ? AND user_id = ?').get(t, userId)) throw badRequest(`Unknown tag id ${t}`);
}
function setTags(db: Db, reminderId: string, tagIds: string[]) {
  db.prepare('DELETE FROM reminder_tags WHERE reminder_id = ?').run(reminderId);
  const ins = db.prepare('INSERT OR IGNORE INTO reminder_tags (reminder_id, tag_id) VALUES (?, ?)');
  for (const t of tagIds) ins.run(reminderId, t);
}

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

function sync(ctx: Ctx, userId: string, id: string, op: 'upsert' | 'delete', wasSynced: boolean, isSynced: boolean) {
  if (!wasSynced && !isSynced) return;
  ctx.hooks.enqueueSync(ctx.db, userId, id, op === 'upsert' && !isSynced ? 'delete' : op);
}

export function createReminder(ctx: Ctx, userId: string, input: ReminderCreate): Reminder {
  const { db } = ctx;
  const id = randomUUID();
  const t = nowIso();
  const listId = input.listId ?? defaultListId(db, userId);
  checkList(db, userId, listId);
  const tagIds = [...new Set(input.tagIds ?? [])];
  checkTags(db, userId, tagIds);
  const done = input.status === 'done';
  db.transaction(() => {
    db.prepare(`INSERT INTO reminders (id, user_id, list_id, title, notes, status, priority, due_at, all_day, timezone, rrule, snoozed_until, completed_at, calendar_sync, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
      id, userId, listId, input.title.trim(), input.notes ?? '', done ? 'done' : 'open', input.priority ?? 0,
      cleanDate(input.dueAt) ?? null, input.allDay ? 1 : 0, cleanTz(input.timezone, ctx.config.defaultTimezone), cleanRrule(input.rrule),
      cleanDate(input.snoozedUntil) ?? null, done ? t : null, input.calendarSync ? 1 : 0, t, t);
    setTags(db, id, tagIds);
  })();
  sync(ctx, userId, id, 'upsert', false, !!input.calendarSync);
  return getReminder(ctx, userId, id);
}

export function updateReminder(ctx: Ctx, userId: string, id: string, patch: ReminderPatch): Reminder {
  const { db } = ctx;
  const cur = rowById(db, userId, id);
  if (!cur) throw notFound('Reminder not found');
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw conflict('Reminder was modified elsewhere', getReminder(ctx, userId, id));
  }
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) set.title = patch.title.trim();
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.listId !== undefined) { checkList(db, userId, patch.listId); set.list_id = patch.listId; }
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
  if (patch.tagIds !== undefined) checkTags(db, userId, patch.tagIds);
  const t = nowIso();
  db.transaction(() => {
    const cols = Object.keys(set);
    db.prepare(`UPDATE reminders SET ${cols.map((c) => `${c} = ?`).join(', ')}${cols.length ? ',' : ''} updated_at = ?, version = version + 1 WHERE id = ?`)
      .run(...cols.map((c) => set[c]), t, id);
    if (patch.tagIds !== undefined) setTags(db, id, [...new Set(patch.tagIds)]);
  })();
  const after = getReminder(ctx, userId, id);
  sync(ctx, userId, id, 'upsert', !!cur.calendar_sync, after.calendarSync);
  return after;
}

export function completeReminder(ctx: Ctx, userId: string, id: string): Reminder {
  const cur = rowById(ctx.db, userId, id);
  if (!cur) throw notFound('Reminder not found');
  if (cur.status === 'done') return getReminder(ctx, userId, id);
  const next = cur.rrule && cur.due_at ? nextOccurrence(cur.rrule, cur.due_at, cur.timezone) : null;
  const t = nowIso();
  if (next) {
    ctx.db.prepare("UPDATE reminders SET due_at = ?, rrule = ?, snoozed_until = NULL, status = 'open', completed_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(next.dueAt, next.rrule, t, id);
  } else {
    ctx.db.prepare("UPDATE reminders SET status = 'done', completed_at = ?, snoozed_until = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(t, t, id);
  }
  sync(ctx, userId, id, 'upsert', !!cur.calendar_sync, !!cur.calendar_sync);
  return getReminder(ctx, userId, id);
}

export function uncompleteReminder(ctx: Ctx, userId: string, id: string): Reminder {
  const cur = rowById(ctx.db, userId, id);
  if (!cur) throw notFound('Reminder not found');
  if (cur.status === 'open') return getReminder(ctx, userId, id);
  ctx.db.prepare("UPDATE reminders SET status = 'open', completed_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(nowIso(), id);
  sync(ctx, userId, id, 'upsert', !!cur.calendar_sync, !!cur.calendar_sync);
  return getReminder(ctx, userId, id);
}

export function snoozeReminder(ctx: Ctx, userId: string, id: string, body: { until: string } | { minutes: number }): Reminder {
  const cur = rowById(ctx.db, userId, id);
  if (!cur) throw notFound('Reminder not found');
  const until = 'until' in body ? new Date(body.until).toISOString() : new Date(Date.now() + body.minutes * 60_000).toISOString();
  ctx.db.prepare('UPDATE reminders SET snoozed_until = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(until, nowIso(), id);
  return getReminder(ctx, userId, id);
}

export function deleteReminder(ctx: Ctx, userId: string, id: string): void {
  const cur = rowById(ctx.db, userId, id);
  if (!cur) throw notFound('Reminder not found');
  const t = nowIso();
  ctx.db.prepare('UPDATE reminders SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(t, t, id);
  sync(ctx, userId, id, 'delete', !!cur.calendar_sync || !!cur.google_event_id, false);
}

export interface ListQuery { filter: ReminderFilter; listId?: string; tagId?: string; q?: string; cursor?: string; limit: number; tz?: string }

/**
 * Filters (open reminders unless noted; snoozed-into-the-future ones are hidden from today/overdue):
 *  today = due within today's local day; upcoming = due after today; overdue = due before now (all-day: before today);
 *  all = every open reminder; done = completed reminders.
 */
export function listReminders(ctx: Ctx, userId: string, q: ListQuery, now = new Date()): ListReminders {
  const tz = q.tz && isValidTz(q.tz) ? q.tz : ctx.config.defaultTimezone;
  const nowS = now.toISOString();
  const sod = new Date(startOfDay(tz, now.getTime())).toISOString();
  const eod = new Date(startOfDay(tz, now.getTime(), 1)).toISOString();
  const where = ['user_id = ?', 'deleted_at IS NULL'];
  const args: unknown[] = [userId];
  const notSnoozed = '(snoozed_until IS NULL OR snoozed_until <= ?)';
  let order = 'due_at IS NULL, due_at ASC, priority DESC, created_at ASC';
  switch (q.filter) {
    case 'today': where.push("status = 'open'", 'due_at >= ? AND due_at < ?', notSnoozed); args.push(sod, eod, nowS); break;
    case 'upcoming': where.push("status = 'open'", 'due_at >= ?'); args.push(eod); break;
    case 'overdue': where.push("status = 'open'", '((all_day = 0 AND due_at < ?) OR (all_day = 1 AND due_at < ?))', notSnoozed); args.push(nowS, sod, nowS); break;
    case 'done': where.push("status = 'done'"); order = 'completed_at DESC'; break;
    default: where.push("status = 'open'");
  }
  if (q.listId) { where.push('list_id = ?'); args.push(q.listId); }
  if (q.tagId) { where.push('EXISTS (SELECT 1 FROM reminder_tags rt WHERE rt.reminder_id = reminders.id AND rt.tag_id = ?)'); args.push(q.tagId); }
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  let offset = 0;
  if (q.cursor) {
    offset = Number(Buffer.from(q.cursor, 'base64url').toString());
    if (!Number.isInteger(offset) || offset < 0) throw badRequest('Invalid cursor');
  }
  const rows = ctx.db.prepare(`SELECT * FROM reminders WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, q.limit + 1, offset) as Row[];
  const page = rows.slice(0, q.limit);
  const tm = tagsFor(ctx.db, page.map((r) => r.id));
  return {
    items: page.map((r) => toReminder(r, tm.get(r.id) ?? [])),
    nextCursor: rows.length > q.limit ? Buffer.from(String(offset + q.limit)).toString('base64url') : null,
  };
}

/** Open reminders whose effective alert time (snoozedUntil, else dueAt) is in (since, now]. Timed reminders only. */
export function dueNotifications(ctx: Ctx, userId: string, since: Date, now = new Date()): Reminder[] {
  const rows = ctx.db.prepare(`SELECT * FROM reminders WHERE user_id = ? AND deleted_at IS NULL AND status = 'open' AND due_at IS NOT NULL
    AND (all_day = 0 OR snoozed_until IS NOT NULL) AND COALESCE(snoozed_until, due_at) > ? AND COALESCE(snoozed_until, due_at) <= ?
    ORDER BY COALESCE(snoozed_until, due_at)`).all(userId, since.toISOString(), now.toISOString()) as Row[];
  const tm = tagsFor(ctx.db, rows.map((r) => r.id));
  return rows.map((r) => toReminder(r, tm.get(r.id) ?? []));
}

export { AppError };
