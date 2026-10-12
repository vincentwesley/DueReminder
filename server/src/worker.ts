import type { ExecutionContext } from 'hono';
import { createApp, ctxFactory, type AppDeps } from './app.js';
import type { Env } from './config.js';
import { exec, many } from './db/index.js';
import { runSync } from './google/sync';

/** Users synced per cron tick (each cycle costs a few subrequests; the oldest-synced go first, so everyone rotates through). */
export const SYNC_BATCH = 10;

/** Cron: sync users with a Google link and a live session, then drop expired rows. */
export async function runScheduled(env: Env, deps: AppDeps = {}): Promise<void> {
  const ctx = ctxFactory(deps)(env);
  const now = new Date();
  const users = await many<{ user_id: string }>(ctx.db,
    `SELECT a.user_id FROM google_accounts a
     WHERE a.status != 'reauth_required' AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = a.user_id AND s.expires_at > ?)
     ORDER BY COALESCE(a.last_sync_at, '') LIMIT ?`, now.toISOString(), SYNC_BATCH);
  await Promise.allSettled(users.map((u) => runSync(ctx.google, u.user_id)));
  // Expired sessions, abandoned OAuth states and old idempotency keys would otherwise accumulate forever.
  await exec(ctx.db, 'DELETE FROM sessions WHERE expires_at < ?', now.toISOString());
  await exec(ctx.db, 'DELETE FROM oauth_states WHERE created_at < ?', now.getTime() - 10 * 60_000);
  await exec(ctx.db, 'DELETE FROM idempotency_keys WHERE created_at < ?', new Date(now.getTime() - 24 * 3600_000).toISOString());
}

const app = createApp();

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  scheduled: (_event: unknown, env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>) => { ctx.waitUntil(runScheduled(env)); },
};
