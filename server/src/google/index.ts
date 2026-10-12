import { Hono } from 'hono';
import type { Ctx } from '../ctx.js';
import { one } from '../db/index.js';
import { sessionIdFromRequest, userIdForSession } from '../http/auth.js';
import type { HonoEnv } from '../http/types.js';
import { getUserById } from '../session.js';
import { apiError, handleCallback, saveAccount, startOAuth } from './oauth';
import { changeCalendar, disconnectAccount, getSyncState, runSync } from './sync';

export { enqueueSync } from './outbox';
export { getSyncState, runSync } from './sync';

/** Demo mode only: attach a mock-Google account to a user without the browser flow. */
export async function linkDemoAccount(ctx: Ctx, userId: string, email = 'demo@example.com'): Promise<void> {
  const g = ctx.google;
  if (!g.config.demoMode) throw new Error('linkDemoAccount is only available in DEMO_MODE');
  const f = g.config.fetch;
  const url = `${g.config.authBase}/__mock/issue-token`;
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) };
  const r = await (f ? f(url, init) : fetch(url, init));
  if (!r.ok) throw new Error(`mock-google issue-token failed (${r.status})`);
  const tok = (await r.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  await saveAccount(g, userId, 'mock-sub-' + email, email, tok);
}

/** Called after demo seeding: pre-link the mock Google account (PLAN.md section 9). Opt-in: DEMO_PRELINK=1, so the UI's 'Connect Google Calendar' flow is testable after demo login. */
export async function onDemoSeed(ctx: Ctx, userId: string): Promise<void> {
  if (!ctx.config.demoMode || !ctx.config.demoPrelink) return;
  if (await one(ctx.db, 'SELECT 1 FROM google_accounts WHERE user_id = ?', userId)) return;
  try {
    await linkDemoAccount(ctx, userId);
  } catch (e) {
    ctx.google.log?.warn({ err: (e as Error).message }, 'demo pre-link skipped (is mock-google running?)');
  }
}

/** /api/auth/{login,google/start,google/calendar,callback,me} and /api/sync/*. Global CSRF + session checks run before these. */
export function googleRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  const google = (c: { var: { ctx: Ctx } }) => c.var.ctx.google;
  const uid = (c: { var: { user: { id: string } | null } }) => c.var.user!.id;

  app.get('/auth/login', (c) => startOAuth(google(c), c, 'signin'));
  app.get('/auth/google/start', (c) => startOAuth(google(c), c, 'signin'));
  app.get('/auth/google/calendar', (c) => startOAuth(google(c), c, 'calendar'));
  app.get('/auth/callback', async (c) => {
    const { res, userId } = await handleCallback(google(c), c);
    if (userId) c.var.ctx.kick(userId);
    return res;
  });
  app.get('/auth/me', async (c) => {
    const uidv = await userIdForSession(c.var.ctx.db, sessionIdFromRequest(c));
    const user = uidv ? await getUserById(c.var.ctx.db, uidv) : null;
    return user ? c.json(user) : apiError(c, 401, 'unauthorized', 'Not signed in');
  });

  app.get('/sync/state', async (c) => c.json(await getSyncState(google(c), uid(c))));
  app.post('/sync/run', async (c) => c.json(await runSync(google(c), uid(c), { retryFailed: true })));
  app.post('/sync/disconnect', async (c) => c.json(await disconnectAccount(google(c), uid(c))));
  app.patch('/sync/settings', async (c) => {
    const g = google(c);
    const cal = (c.var.body as { calendarId?: unknown } | undefined)?.calendarId;
    if (cal !== undefined && (typeof cal !== 'string' || !cal.trim() || cal.length > 256)) return apiError(c, 400, 'bad_request', 'calendarId must be a non-empty string');
    const state = await getSyncState(g, uid(c));
    if (!state.connected) return apiError(c, 400, 'bad_request', 'Google is not connected');
    if (typeof cal === 'string' && cal.trim() !== state.calendarId) {
      const next = await changeCalendar(g, uid(c), cal.trim());
      c.var.ctx.kick(uid(c));
      return c.json(next);
    }
    return c.json(state);
  });
  return app;
}
