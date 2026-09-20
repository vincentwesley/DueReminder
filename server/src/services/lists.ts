import { randomUUID } from 'node:crypto';
import type { List, Tag } from '../../../shared/types.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { defaultListId, type Ctx } from './reminders.js';

interface ListRow { id: string; name: string; color: string; sort_order: number; created_at: string; updated_at: string; deleted_at: string | null }
const toList = (r: ListRow): List => ({ id: r.id, name: r.name, color: r.color, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at });
const PALETTE = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];

export function listLists(ctx: Ctx, userId: string): List[] {
  defaultListId(ctx.db, userId);
  return (ctx.db.prepare('SELECT * FROM lists WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at').all(userId) as ListRow[]).map(toList);
}

export function findListByName(ctx: Ctx, userId: string, name: string): List | null {
  const r = ctx.db.prepare('SELECT * FROM lists WHERE user_id = ? AND deleted_at IS NULL AND name = ? COLLATE NOCASE').get(userId, name) as ListRow | undefined;
  return r ? toList(r) : null;
}

export function createList(ctx: Ctx, userId: string, input: { name: string; color?: string }): List {
  defaultListId(ctx.db, userId);
  const id = randomUUID();
  const t = new Date().toISOString();
  const max = (ctx.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM lists WHERE user_id = ?').get(userId) as { m: number }).m;
  ctx.db.prepare('INSERT INTO lists (id, user_id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, input.name, input.color ?? PALETTE[(max + 1) % PALETTE.length], max + 1, t, t);
  return toList(ctx.db.prepare('SELECT * FROM lists WHERE id = ?').get(id) as ListRow);
}

export function updateList(ctx: Ctx, userId: string, id: string, patch: { name?: string; color?: string; sortOrder?: number }): List {
  const cur = ctx.db.prepare('SELECT * FROM lists WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId) as ListRow | undefined;
  if (!cur) throw notFound('List not found');
  ctx.db.prepare('UPDATE lists SET name = ?, color = ?, sort_order = ?, updated_at = ? WHERE id = ?')
    .run(patch.name ?? cur.name, patch.color ?? cur.color, patch.sortOrder ?? cur.sort_order, new Date().toISOString(), id);
  return toList(ctx.db.prepare('SELECT * FROM lists WHERE id = ?').get(id) as ListRow);
}

export function deleteList(ctx: Ctx, userId: string, id: string): void {
  const cur = ctx.db.prepare('SELECT * FROM lists WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId) as (ListRow & { is_default: number }) | undefined;
  if (!cur) throw notFound('List not found');
  if (cur.is_default) throw badRequest('The default list cannot be deleted');
  const def = defaultListId(ctx.db, userId);
  const t = new Date().toISOString();
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE reminders SET list_id = ?, updated_at = ?, version = version + 1 WHERE list_id = ? AND user_id = ?').run(def, t, id, userId);
    ctx.db.prepare('UPDATE lists SET deleted_at = ?, updated_at = ? WHERE id = ?').run(t, t, id);
  })();
}

export function listTags(ctx: Ctx, userId: string): Tag[] {
  return ctx.db.prepare('SELECT id, name, color FROM tags WHERE user_id = ? ORDER BY name').all(userId) as Tag[];
}

export function findOrCreateTag(ctx: Ctx, userId: string, name: string, color?: string): Tag {
  const ex = ctx.db.prepare('SELECT id, name, color FROM tags WHERE user_id = ? AND name = ?').get(userId, name) as Tag | undefined;
  if (ex) return ex;
  const id = randomUUID();
  const n = (ctx.db.prepare('SELECT COUNT(*) AS c FROM tags WHERE user_id = ?').get(userId) as { c: number }).c;
  const c = color ?? PALETTE[n % PALETTE.length]!;
  ctx.db.prepare('INSERT INTO tags (id, user_id, name, color) VALUES (?, ?, ?, ?)').run(id, userId, name, c);
  return { id, name, color: c };
}

export function createTag(ctx: Ctx, userId: string, input: { name: string; color?: string }): Tag {
  if (ctx.db.prepare('SELECT 1 FROM tags WHERE user_id = ? AND name = ?').get(userId, input.name)) throw conflict('Tag already exists');
  return findOrCreateTag(ctx, userId, input.name, input.color);
}

export function deleteTag(ctx: Ctx, userId: string, id: string): void {
  if (!ctx.db.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').run(id, userId).changes) throw notFound('Tag not found');
}
