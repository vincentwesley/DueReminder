import { Hono } from 'hono';
import { ListCreateSchema, ListPatchSchema, TagCreateSchema } from '../../../shared/schemas.js';
import { batch, exec, q } from '../db/index.js';
import { notFound } from '../errors.js';
import { idParam, uidOf } from '../http/auth.js';
import type { HonoEnv } from '../http/types.js';
import { seedDemoData } from '../services/demo.js';
import { createList, createTag, deleteList, deleteTag, listLists, listTags, updateList } from '../services/lists.js';
import { defaultListId } from '../services/reminders.js';
import { endSession, startSession, upsertUser } from '../session.js';

export function miscRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get('/health', (c) => c.json({ ok: true, demo: c.var.ctx.config.demoMode }));
  app.get('/me', (c) => c.json(c.var.user));

  app.post('/demo/login', async (c) => {
    const { ctx } = c.var;
    if (!ctx.config.demoMode) throw notFound('Demo mode is disabled');
    const user = await upsertUser(ctx.db, { email: 'demo@example.com', name: 'Demo User', demo: true });
    await exec(ctx.db, 'UPDATE users SET demo = 1 WHERE id = ?', user.id);
    await defaultListId(ctx.db, user.id);
    await seedDemoData(ctx, user.id);
    await startSession(c, user.id);
    return c.json({ ...user, demo: true });
  });

  /** Demo mode only: wipe the signed-in demo user's data (including any Google link) and reseed. Used by E2E tests and the "reset demo" affordance. */
  app.post('/demo/reset', async (c) => {
    const { ctx } = c.var;
    if (!ctx.config.demoMode) throw notFound('Demo mode is disabled');
    const id = uidOf(c);
    if (!c.var.user!.demo) throw notFound('Only the demo user can be reset');
    await batch(ctx.db, [
      q(ctx.db, 'DELETE FROM outbox WHERE user_id = ?', id),
      q(ctx.db, 'DELETE FROM google_accounts WHERE user_id = ?', id),
      q(ctx.db, 'DELETE FROM reminder_tags WHERE reminder_id IN (SELECT id FROM reminders WHERE user_id = ?)', id),
      q(ctx.db, 'DELETE FROM reminders WHERE user_id = ?', id),
      q(ctx.db, 'DELETE FROM tags WHERE user_id = ?', id),
      q(ctx.db, 'DELETE FROM lists WHERE user_id = ?', id),
      q(ctx.db, 'DELETE FROM idempotency_keys WHERE user_id = ?', id),
    ]);
    await defaultListId(ctx.db, id);
    await seedDemoData(ctx, id);
    return c.json(c.var.user);
  });

  app.post('/auth/logout', async (c) => {
    await endSession(c);
    return c.body(null, 204);
  });

  app.get('/lists', async (c) => c.json(await listLists(c.var.ctx, uidOf(c))));
  app.post('/lists', async (c) => c.json(await createList(c.var.ctx, uidOf(c), ListCreateSchema.parse(c.var.body)), 201));
  app.patch('/lists/:id', async (c) => c.json(await updateList(c.var.ctx, uidOf(c), idParam(c), ListPatchSchema.parse(c.var.body))));
  app.delete('/lists/:id', async (c) => { await deleteList(c.var.ctx, uidOf(c), idParam(c)); return c.body(null, 204); });

  app.get('/tags', async (c) => c.json(await listTags(c.var.ctx, uidOf(c))));
  app.post('/tags', async (c) => c.json(await createTag(c.var.ctx, uidOf(c), TagCreateSchema.parse(c.var.body)), 201));
  app.delete('/tags/:id', async (c) => { await deleteTag(c.var.ctx, uidOf(c), idParam(c)); return c.body(null, 204); });

  return app;
}
