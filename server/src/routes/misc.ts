import type { FastifyInstance } from 'fastify';
import type { SyncState } from '../../../shared/types.js';
import { ListCreateSchema, ListPatchSchema, TagCreateSchema } from '../../../shared/schemas.js';
import { AppError, notFound } from '../errors.js';
import { createList, createTag, deleteList, deleteTag, listLists, listTags, updateList } from '../services/lists.js';
import { defaultListId, type Ctx } from '../services/reminders.js';
import { seedDemoData } from '../services/demo.js';
import { idParam, uidOf } from '../http/auth.js';
import { endSession, startSession, upsertUser } from '../session.js';


export function miscRoutes(app: FastifyInstance, ctx: Ctx) {
  const uid = uidOf;
  const idOf = idParam;

  app.get('/health', async () => ({ ok: true, demo: ctx.config.demoMode }));
  app.get('/me', async (req) => req.user);

  app.post('/demo/login', async (req, reply) => {
    if (!ctx.config.demoMode) throw notFound('Demo mode is disabled');
    const user = upsertUser(ctx.db, { email: 'demo@example.com', name: 'Demo User', demo: true });
    ctx.db.prepare('UPDATE users SET demo = 1 WHERE id = ?').run(user.id);
    defaultListId(ctx.db, user.id);
    await seedDemoData(ctx, user.id);
    startSession(ctx.db, ctx.config, reply, user.id, req);
    return { ...user, demo: true };
  });

  /** Demo mode only: wipe the signed-in demo user's data (including any Google link) and reseed. Used by E2E tests and the "reset demo" affordance. */
  app.post('/demo/reset', async (req) => {
    if (!ctx.config.demoMode) throw notFound('Demo mode is disabled');
    const id = uid(req);
    if (!req.user!.demo) throw notFound('Only the demo user can be reset');
    const tx = ctx.db.transaction(() => {
      for (const t of ['outbox', 'google_accounts']) {
        try { ctx.db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id); } catch { /* table absent when Google is not loaded */ }
      }
      ctx.db.prepare('DELETE FROM reminder_tags WHERE reminder_id IN (SELECT id FROM reminders WHERE user_id = ?)').run(id);
      ctx.db.prepare('DELETE FROM reminders WHERE user_id = ?').run(id);
      ctx.db.prepare('DELETE FROM tags WHERE user_id = ?').run(id);
      ctx.db.prepare('DELETE FROM lists WHERE user_id = ?').run(id);
      ctx.db.prepare('DELETE FROM idempotency_keys WHERE user_id = ?').run(id);
    });
    tx();
    defaultListId(ctx.db, id);
    await seedDemoData(ctx, id);
    return req.user;
  });

  app.post('/auth/logout', async (req, reply) => {
    endSession(ctx.db, req, reply);
    return reply.code(204).send();
  });

  app.get('/lists', async (req) => listLists(ctx, uid(req)));
  app.post('/lists', async (req, reply) => reply.code(201).send(createList(ctx, uid(req), ListCreateSchema.parse(req.body))));
  app.patch('/lists/:id', async (req) => updateList(ctx, uid(req), idOf(req), ListPatchSchema.parse(req.body)));
  app.delete('/lists/:id', async (req, reply) => { deleteList(ctx, uid(req), idOf(req)); return reply.code(204).send(); });

  app.get('/tags', async (req) => listTags(ctx, uid(req)));
  app.post('/tags', async (req, reply) => reply.code(201).send(createTag(ctx, uid(req), TagCreateSchema.parse(req.body))));
  app.delete('/tags/:id', async (req, reply) => { deleteTag(ctx, uid(req), idOf(req)); return reply.code(204).send(); });
}

/** Stand-in /sync/* routes used only when the Google plugin is absent. */
export function fallbackSyncRoutes(app: FastifyInstance) {
  const state = (): SyncState => ({ status: 'disconnected', connected: false, googleEmail: null, calendarId: 'primary', lastSyncAt: null, lastError: null, pendingOps: 0, conflictsResolved: 0, failedOps: 0 });
  app.get('/sync/state', async () => state());
  app.post('/sync/run', async () => state());
  app.post('/sync/disconnect', async () => state());
  app.patch('/sync/settings', async () => state());
  app.get('/auth/google/start', async () => { throw new AppError(404, 'not_found', 'Google sync is not installed'); });
}
