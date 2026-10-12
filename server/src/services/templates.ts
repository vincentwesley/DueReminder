import type { Priority, Reminder, ReminderCreate, ReminderTemplate } from '../../../shared/types.js';
import type { Ctx } from '../ctx.js';
import { exec, many, one } from '../db/index.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { normalizeRrule } from './recurrence.js';
import { cleanLine, cleanText, MAX_NOTES } from './sanitize.js';
import { createReminder, getReminder } from './reminders.js';
import { isValidTz, toFloating, wallToInstant } from './tz.js';

export const MAX_TEMPLATES = 100;

interface Row {
  id: string; user_id: string; name: string; title: string; notes: string; list_id: string | null; priority: number; all_day: number;
  timezone: string | null; rrule: string | null; tag_ids: string; subtasks: string; due_offset_minutes: number | null; time_of_day: string | null;
  created_at: string; updated_at: string;
}
const toTemplate = (r: Row): ReminderTemplate => ({
  id: r.id, name: r.name, title: r.title, notes: r.notes, listId: r.list_id, priority: r.priority as Priority, allDay: !!r.all_day,
  timezone: r.timezone, rrule: r.rrule, tagIds: JSON.parse(r.tag_ids), subtasks: JSON.parse(r.subtasks),
  dueOffsetMinutes: r.due_offset_minutes, timeOfDay: r.time_of_day, createdAt: r.created_at, updatedAt: r.updated_at,
});

type Fields = Partial<Omit<ReminderTemplate, 'id' | 'createdAt' | 'updatedAt'>>;

async function validate(ctx: Ctx, userId: string, f: Fields): Promise<Fields> {
  const out: Fields = { ...f };
  if (f.name !== undefined) { out.name = cleanLine(f.name, 100); if (!out.name) throw badRequest('Template name is empty'); }
  if (f.title !== undefined) { out.title = cleanLine(f.title, 500); if (!out.title) throw badRequest('Template title is empty'); }
  if (f.notes !== undefined) out.notes = cleanText(f.notes, MAX_NOTES);
  if (f.timezone != null && !isValidTz(f.timezone)) throw badRequest('Invalid timezone');
  if (f.rrule) { try { out.rrule = normalizeRrule(f.rrule); } catch { throw badRequest('Invalid rrule'); } }
  if (f.listId && !(await one(ctx.db, 'SELECT 1 FROM lists WHERE id = ? AND user_id = ? AND deleted_at IS NULL', f.listId, userId))) throw badRequest('Unknown listId');
  if (f.tagIds) {
    out.tagIds = [...new Set(f.tagIds)];
    for (const t of out.tagIds) if (!(await one(ctx.db, 'SELECT 1 FROM tags WHERE id = ? AND user_id = ?', t, userId))) throw badRequest(`Unknown tag id ${t}`);
  }
  if (f.subtasks) out.subtasks = f.subtasks.map((s) => ({ title: cleanLine(s.title, 200) })).filter((s) => s.title);
  return out;
}

const getRow = async (ctx: Ctx, userId: string, id: string): Promise<Row> => {
  const r = await one<Row>(ctx.db, 'SELECT * FROM templates WHERE id = ? AND user_id = ?', id, userId);
  if (!r) throw notFound('Template not found');
  return r;
};

export const listTemplates = async (ctx: Ctx, userId: string): Promise<ReminderTemplate[]> =>
  (await many<Row>(ctx.db, 'SELECT * FROM templates WHERE user_id = ? ORDER BY name COLLATE NOCASE, created_at', userId)).map(toTemplate);
export const getTemplate = async (ctx: Ctx, userId: string, id: string): Promise<ReminderTemplate> => toTemplate(await getRow(ctx, userId, id));

export async function createTemplate(ctx: Ctx, userId: string, input: Fields & { name: string; fromReminderId?: string }): Promise<ReminderTemplate> {
  const count = (await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM templates WHERE user_id = ?', userId))!.n;
  if (count >= MAX_TEMPLATES) throw badRequest(`At most ${MAX_TEMPLATES} templates`);
  let base: Fields = {};
  if (input.fromReminderId) {
    const r: Reminder = await getReminder(ctx, userId, input.fromReminderId);
    base = {
      title: r.title, notes: r.notes, listId: r.listId, priority: r.priority, allDay: r.allDay, timezone: r.timezone, rrule: r.rrule,
      tagIds: r.tagIds, subtasks: (r.subtasks ?? []).map((s) => ({ title: s.title })),
    };
  }
  const { fromReminderId: _f, ...rest } = input;
  const f = await validate(ctx, userId, { ...base, ...rest });
  if (!f.title) throw badRequest('title is required (or pass fromReminderId)');
  const id = crypto.randomUUID();
  const t = new Date().toISOString();
  await exec(ctx.db, `INSERT INTO templates (id, user_id, name, title, notes, list_id, priority, all_day, timezone, rrule, tag_ids, subtasks, due_offset_minutes, time_of_day, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, userId, f.name, f.title, f.notes ?? '', f.listId ?? null, f.priority ?? 0, f.allDay ? 1 : 0, f.timezone ?? null, f.rrule ?? null,
  JSON.stringify(f.tagIds ?? []), JSON.stringify(f.subtasks ?? []), f.dueOffsetMinutes ?? null, f.timeOfDay ?? null, t, t);
  return getTemplate(ctx, userId, id);
}

export async function updateTemplate(ctx: Ctx, userId: string, id: string, patch: Fields): Promise<ReminderTemplate> {
  const cur = toTemplate(await getRow(ctx, userId, id));
  const f = await validate(ctx, userId, patch);
  const m = { ...cur, ...f };
  await exec(ctx.db, `UPDATE templates SET name=?, title=?, notes=?, list_id=?, priority=?, all_day=?, timezone=?, rrule=?, tag_ids=?, subtasks=?, due_offset_minutes=?, time_of_day=?, updated_at=? WHERE id=?`,
    m.name, m.title, m.notes, m.listId, m.priority, m.allDay ? 1 : 0, m.timezone, m.rrule, JSON.stringify(m.tagIds), JSON.stringify(m.subtasks),
    m.dueOffsetMinutes, m.timeOfDay, new Date().toISOString(), id);
  return getTemplate(ctx, userId, id);
}

export async function deleteTemplate(ctx: Ctx, userId: string, id: string): Promise<void> {
  if (!(await exec(ctx.db, 'DELETE FROM templates WHERE id = ? AND user_id = ?', id, userId))) throw notFound('Template not found');
}

/** Next instant strictly after `nowMs` whose wall-clock time in `tz` is `hhmm`. */
export function nextTimeOfDay(tz: string, hhmm: string, nowMs: number): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const f = new Date(toFloating(tz, nowMs));
  for (let add = 0; add < 3; add++) {
    const t = wallToInstant(tz, f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate() + add, h, m);
    if (t > nowMs) return t;
  }
  throw conflict('Could not compute a due time');
}

export async function createFromTemplate(ctx: Ctx, userId: string, id: string, o: { title?: string; dueAt?: string | null; listId?: string; timezone?: string }, now = Date.now()): Promise<Reminder> {
  const t = toTemplate(await getRow(ctx, userId, id));
  const timezone = o.timezone ?? t.timezone ?? ctx.config.defaultTimezone;
  if (!isValidTz(timezone)) throw badRequest('Invalid timezone');
  let dueAt: string | null;
  if (o.dueAt !== undefined) dueAt = o.dueAt;
  else if (t.timeOfDay) dueAt = new Date(nextTimeOfDay(timezone, t.timeOfDay, now)).toISOString();
  else if (t.dueOffsetMinutes != null) dueAt = new Date(now + t.dueOffsetMinutes * 60_000).toISOString();
  else dueAt = null;
  // Tags or the list may have been deleted since the template was saved: drop dangling references instead of failing.
  const tagIds: string[] = [];
  for (const x of t.tagIds) if (await one(ctx.db, 'SELECT 1 FROM tags WHERE id = ? AND user_id = ?', x, userId)) tagIds.push(x);
  const listOk = async (l: string | null | undefined) => !!l && !!(await one(ctx.db, 'SELECT 1 FROM lists WHERE id = ? AND user_id = ? AND deleted_at IS NULL', l, userId));
  const listId = o.listId ?? ((await listOk(t.listId)) ? t.listId! : undefined);
  const input: ReminderCreate = {
    title: o.title ?? t.title, notes: t.notes, priority: t.priority, allDay: t.allDay, timezone, rrule: t.rrule, tagIds, dueAt,
    subtasks: t.subtasks, ...(listId ? { listId } : {}),
  };
  return createReminder(ctx, userId, input);
}
