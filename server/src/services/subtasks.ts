import { randomUUID } from 'node:crypto';
import type { Subtask, SubtaskInput } from '../../../shared/types.js';
import type { Db } from '../db/index.js';
import { badRequest, notFound } from '../errors.js';
import { cleanLine } from './sanitize.js';

export const MAX_SUBTASKS = 100;
interface SubRow { id: string; reminder_id: string; title: string; done: number; position: number }
const toSub = (r: SubRow): Subtask => ({ id: r.id, title: r.title, done: !!r.done, position: r.position });

export function subtasksFor(db: Db, ids: string[]): Map<string, Subtask[]> {
  const m = new Map<string, Subtask[]>();
  if (!ids.length) return m;
  const rows = db.prepare(`SELECT * FROM subtasks WHERE reminder_id IN (${ids.map(() => '?').join(',')}) ORDER BY position, rowid`).all(...ids) as SubRow[];
  for (const r of rows) (m.get(r.reminder_id) ?? m.set(r.reminder_id, []).get(r.reminder_id)!).push(toSub(r));
  return m;
}

/** Replaces the whole checklist. Ids that already belong to this reminder are kept; others are generated. */
export function setSubtasks(db: Db, reminderId: string, items: SubtaskInput[]): void {
  if (items.length > MAX_SUBTASKS) throw badRequest(`At most ${MAX_SUBTASKS} subtasks per reminder`);
  const existing = new Set((db.prepare('SELECT id FROM subtasks WHERE reminder_id = ?').all(reminderId) as { id: string }[]).map((r) => r.id));
  db.prepare('DELETE FROM subtasks WHERE reminder_id = ?').run(reminderId);
  const ins = db.prepare('INSERT INTO subtasks (id, reminder_id, title, done, position) VALUES (?, ?, ?, ?, ?)');
  const used = new Set<string>();
  items.forEach((it, i) => {
    const title = cleanLine(it.title, 200);
    if (!title) throw badRequest('Subtask title is empty');
    const id = it.id && existing.has(it.id) && !used.has(it.id) ? it.id : randomUUID();
    used.add(id);
    ins.run(id, reminderId, title, it.done ? 1 : 0, i);
  });
}

export function addSubtask(db: Db, reminderId: string, input: SubtaskInput): void {
  const n = (db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS p FROM subtasks WHERE reminder_id = ?').get(reminderId) as { n: number; p: number });
  if (n.n >= MAX_SUBTASKS) throw badRequest(`At most ${MAX_SUBTASKS} subtasks per reminder`);
  const title = cleanLine(input.title, 200);
  if (!title) throw badRequest('Subtask title is empty');
  db.prepare('INSERT INTO subtasks (id, reminder_id, title, done, position) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), reminderId, title, input.done ? 1 : 0, n.p + 1);
}

export function patchSubtask(db: Db, reminderId: string, subId: string, patch: { title?: string; done?: boolean }): void {
  const cur = db.prepare('SELECT * FROM subtasks WHERE id = ? AND reminder_id = ?').get(subId, reminderId) as SubRow | undefined;
  if (!cur) throw notFound('Subtask not found');
  const title = patch.title !== undefined ? cleanLine(patch.title, 200) : cur.title;
  if (!title) throw badRequest('Subtask title is empty');
  db.prepare('UPDATE subtasks SET title = ?, done = ? WHERE id = ?').run(title, patch.done === undefined ? cur.done : patch.done ? 1 : 0, subId);
}

export function removeSubtask(db: Db, reminderId: string, subId: string): void {
  if (!db.prepare('DELETE FROM subtasks WHERE id = ? AND reminder_id = ?').run(subId, reminderId).changes) throw notFound('Subtask not found');
}
