import type { List, Tag } from '../../../shared/types.js';
import type { Ctx } from '../ctx.js';
import { batch, exec, many, one, q } from '../db/index.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { defaultListId } from './reminders.js';

interface ListRow { id: string; name: string; color: string; sort_order: number; created_at: string; updated_at: string; deleted_at: string | null }
const toList = (r: ListRow): List => ({ id: r.id, name: r.name, color: r.color, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at });
const PALETTE = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];

export async function listLists(ctx: Ctx, userId: string): Promise<List[]> {
  await defaultListId(ctx.db, userId);
  return (await many<ListRow>(ctx.db, 'SELECT * FROM lists WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at', userId)).map(toList);
}

export async function findListByName(ctx: Ctx, userId: string, name: string): Promise<List | null> {
  const r = await one<ListRow>(ctx.db, 'SELECT * FROM lists WHERE user_id = ? AND deleted_at IS NULL AND name = ? COLLATE NOCASE', userId, name);
  return r ? toList(r) : null;
}

export async function createList(ctx: Ctx, userId: string, input: { name: string; color?: string }): Promise<List> {
  await defaultListId(ctx.db, userId);
  const id = crypto.randomUUID();
  const t = new Date().toISOString();
  const max = (await one<{ m: number }>(ctx.db, 'SELECT COALESCE(MAX(sort_order), 0) AS m FROM lists WHERE user_id = ?', userId))!.m;
  await exec(ctx.db, 'INSERT INTO lists (id, user_id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, userId, input.name, input.color ?? PALETTE[(max + 1) % PALETTE.length], max + 1, t, t);
  return toList((await one<ListRow>(ctx.db, 'SELECT * FROM lists WHERE id = ?', id))!);
}

export async function updateList(ctx: Ctx, userId: string, id: string, patch: { name?: string; color?: string; sortOrder?: number }): Promise<List> {
  const cur = await one<ListRow>(ctx.db, 'SELECT * FROM lists WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, userId);
  if (!cur) throw notFound('List not found');
  await exec(ctx.db, 'UPDATE lists SET name = ?, color = ?, sort_order = ?, updated_at = ? WHERE id = ?',
    patch.name ?? cur.name, patch.color ?? cur.color, patch.sortOrder ?? cur.sort_order, new Date().toISOString(), id);
  return toList((await one<ListRow>(ctx.db, 'SELECT * FROM lists WHERE id = ?', id))!);
}

export async function deleteList(ctx: Ctx, userId: string, id: string): Promise<void> {
  const cur = await one<ListRow & { is_default: number }>(ctx.db, 'SELECT * FROM lists WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, userId);
  if (!cur) throw notFound('List not found');
  if (cur.is_default) throw badRequest('The default list cannot be deleted');
  const def = await defaultListId(ctx.db, userId);
  const t = new Date().toISOString();
  await batch(ctx.db, [
    q(ctx.db, 'UPDATE reminders SET list_id = ?, updated_at = ?, version = version + 1 WHERE list_id = ? AND user_id = ?', def, t, id, userId),
    q(ctx.db, 'UPDATE lists SET deleted_at = ?, updated_at = ? WHERE id = ?', t, t, id),
  ]);
}

export const listTags = (ctx: Ctx, userId: string): Promise<Tag[]> => many<Tag>(ctx.db, 'SELECT id, name, color FROM tags WHERE user_id = ? ORDER BY name', userId);

export async function findOrCreateTag(ctx: Ctx, userId: string, name: string, color?: string): Promise<Tag> {
  const ex = await one<Tag>(ctx.db, 'SELECT id, name, color FROM tags WHERE user_id = ? AND name = ?', userId, name);
  if (ex) return ex;
  const id = crypto.randomUUID();
  const n = (await one<{ c: number }>(ctx.db, 'SELECT COUNT(*) AS c FROM tags WHERE user_id = ?', userId))!.c;
  const c = color ?? PALETTE[n % PALETTE.length]!;
  await exec(ctx.db, 'INSERT INTO tags (id, user_id, name, color) VALUES (?, ?, ?, ?)', id, userId, name, c);
  return { id, name, color: c };
}

export async function createTag(ctx: Ctx, userId: string, input: { name: string; color?: string }): Promise<Tag> {
  if (await one(ctx.db, 'SELECT 1 FROM tags WHERE user_id = ? AND name = ?', userId, input.name)) throw conflict('Tag already exists');
  return findOrCreateTag(ctx, userId, input.name, input.color);
}

export async function deleteTag(ctx: Ctx, userId: string, id: string): Promise<void> {
  if (!(await exec(ctx.db, 'DELETE FROM tags WHERE id = ? AND user_id = ?', id, userId))) throw notFound('Tag not found');
}
