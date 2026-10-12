import type { Subtask, SubtaskInput } from '../../../shared/types.js';
import { many, one, q, type Db, type Stmt } from '../db/index.js';
import { badRequest, notFound } from '../errors.js';
import { chunk } from '../util.js';
import { cleanLine } from './sanitize.js';

export const MAX_SUBTASKS = 100;
interface SubRow { id: string; reminder_id: string; title: string; done: number; position: number }
const toSub = (r: SubRow): Subtask => ({ id: r.id, title: r.title, done: !!r.done, position: r.position });

export async function subtasksFor(db: Db, ids: string[]): Promise<Map<string, Subtask[]>> {
  const m = new Map<string, Subtask[]>();
  if (!ids.length) return m;
  for (const part of chunk(ids)) {
    const rows = await many<SubRow>(db, `SELECT * FROM subtasks WHERE reminder_id IN (${part.map(() => '?').join(',')}) ORDER BY position, rowid`, ...part);
    for (const r of rows) (m.get(r.reminder_id) ?? m.set(r.reminder_id, []).get(r.reminder_id)!).push(toSub(r));
  }
  return m;
}

/**
 * Statements that replace the whole checklist (the caller batches them). Ids that already belong to this reminder
 * are kept; others are generated. Validation happens here, before anything is written.
 */
export async function setSubtasks(db: Db, reminderId: string, items: SubtaskInput[]): Promise<Stmt[]> {
  if (items.length > MAX_SUBTASKS) throw badRequest(`At most ${MAX_SUBTASKS} subtasks per reminder`);
  const existing = new Set((await many<{ id: string }>(db, 'SELECT id FROM subtasks WHERE reminder_id = ?', reminderId)).map((r) => r.id));
  const stmts = [q(db, 'DELETE FROM subtasks WHERE reminder_id = ?', reminderId)];
  const used = new Set<string>();
  items.forEach((it, i) => {
    const title = cleanLine(it.title, 200);
    if (!title) throw badRequest('Subtask title is empty');
    const id = it.id && existing.has(it.id) && !used.has(it.id) ? it.id : crypto.randomUUID();
    used.add(id);
    stmts.push(q(db, 'INSERT INTO subtasks (id, reminder_id, title, done, position) VALUES (?, ?, ?, ?, ?)', id, reminderId, title, it.done ? 1 : 0, i));
  });
  return stmts;
}

export async function addSubtask(db: Db, reminderId: string, input: SubtaskInput): Promise<Stmt[]> {
  const n = (await one<{ n: number; p: number }>(db, 'SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS p FROM subtasks WHERE reminder_id = ?', reminderId))!;
  if (n.n >= MAX_SUBTASKS) throw badRequest(`At most ${MAX_SUBTASKS} subtasks per reminder`);
  const title = cleanLine(input.title, 200);
  if (!title) throw badRequest('Subtask title is empty');
  return [q(db, 'INSERT INTO subtasks (id, reminder_id, title, done, position) VALUES (?, ?, ?, ?, ?)', crypto.randomUUID(), reminderId, title, input.done ? 1 : 0, n.p + 1)];
}

export async function patchSubtask(db: Db, reminderId: string, subId: string, patch: { title?: string; done?: boolean }): Promise<Stmt[]> {
  const cur = await one<SubRow>(db, 'SELECT * FROM subtasks WHERE id = ? AND reminder_id = ?', subId, reminderId);
  if (!cur) throw notFound('Subtask not found');
  const title = patch.title !== undefined ? cleanLine(patch.title, 200) : cur.title;
  if (!title) throw badRequest('Subtask title is empty');
  return [q(db, 'UPDATE subtasks SET title = ?, done = ? WHERE id = ?', title, patch.done === undefined ? cur.done : patch.done ? 1 : 0, subId)];
}

export async function removeSubtask(db: Db, reminderId: string, subId: string): Promise<Stmt[]> {
  if (!(await one(db, 'SELECT 1 FROM subtasks WHERE id = ? AND reminder_id = ?', subId, reminderId))) throw notFound('Subtask not found');
  return [q(db, 'DELETE FROM subtasks WHERE id = ? AND reminder_id = ?', subId, reminderId)];
}
