import { ctxFactory, IDEM_TTL_MS, type AppDeps } from './app.js';
import type { Env } from './config.js';
import { exec, many } from './db/index.js';
import { runSync } from './google/sync';
import { OAUTH_STATE_TTL_MS } from './http/auth.js';

/** Users synced per cron tick (each cycle costs a few subrequests; the least recently attempted go first, failures included, so everyone rotates through). */
export const SYNC_BATCH = 10;

/** Cron: sync users with a Google link and a live session, then drop expired rows. */
export async function runScheduled(env: Env, deps: AppDeps = {}): Promise<void> {
  const ctx = ctxFactory(deps)(env);
  const now = new Date();
  const users = await many<{ user_id: string }>(ctx.db,
    `SELECT a.user_id FROM google_accounts a
     WHERE a.status != 'reauth_required' AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = a.user_id AND s.expires_at > ?)
     ORDER BY COALESCE(a.last_attempt_at, '') LIMIT ?`, now.toISOString(), SYNC_BATCH);
  // Sequential: one cron invocation shares a single Workers subrequest budget.
  for (const u of users) {
    try { await runSync(ctx.google, u.user_id); } catch { /* one user's failure must not stop the rest */ }
  }
  if (now.getMinutes() % 15 !== 0) return;
  // Expired sessions, abandoned OAuth states and old idempotency keys would otherwise accumulate forever.
  await exec(ctx.db, 'DELETE FROM sessions WHERE expires_at < ?', now.toISOString());
  await exec(ctx.db, 'DELETE FROM oauth_states WHERE created_at < ?', now.getTime() - OAUTH_STATE_TTL_MS);
  await exec(ctx.db, 'DELETE FROM idempotency_keys WHERE created_at < ?', new Date(now.getTime() - IDEM_TTL_MS).toISOString());
}
