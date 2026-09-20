import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveGoogleConfig, type GoogleConfig, type GoogleCtx } from './config';
import { apiError, handleCallback, saveAccount, startLogin } from './oauth';
import { setSyncTrigger } from './outbox';
import { migrate } from './schema';
import { clearCookie, loadUser, parseCookies, sessionUserId } from './session';
import { SESSION_COOKIE } from './config';
import { changeCalendar, disconnectAccount, getSyncState, runSync, settleSyncs } from './sync';

export { enqueueSync } from './outbox';
export { migrate } from './schema';
export { resolveGoogleConfig, type GoogleConfig } from './config';
export { getSyncState, runSync } from './sync';
export { backoffDelayMs } from './backoff';
export { codeChallengeS256, generateCodeVerifier } from './pkce';

/** Called by WP-B after demo seeding: pre-link the mock Google account (PLAN.md section 9). Opt-in: set DEMO_PRELINK=1. Off by default so the UI's 'Connect Google Calendar' flow is testable after demo login. */
export async function onDemoSeed(db: Database, userId: string): Promise<void> {
  const api = current;
  if (!api || !api.ctx.config.demoMode || process.env.DEMO_PRELINK !== '1') return;
  if (db.prepare('SELECT 1 FROM google_accounts WHERE user_id = ?').get(userId)) return;
  try {
    await api.linkDemoAccount(userId);
  } catch (e) {
    api.ctx.log?.warn({ err: (e as Error).message }, 'demo pre-link skipped (is mock-google running?)');
  }
}

let current: GoogleApi | null = null;

export interface GoogleDeps {
  db: Database;
  /** Explicit values override environment (GOOGLE_*, SESSION_SECRET, DEMO_MODE, OAUTH_REDIRECT_URI). */
  config?: Partial<GoogleConfig> | Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}

export interface GoogleApi {
  ctx: GoogleCtx;
  runSync: (userId: string) => ReturnType<typeof runSync>;
  getSyncState: (userId: string) => ReturnType<typeof getSyncState>;
  /** Demo mode only: attach a mock-Google account to a user without the browser flow. */
  linkDemoAccount: (userId: string, email?: string) => Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance { google?: GoogleApi }
}

/** Mounts /api/auth/* and /api/sync/*, runs migrations, starts the poller. Routes already registered by others are skipped. */
export async function registerGoogle(app: FastifyInstance, deps: GoogleDeps): Promise<GoogleApi> {
  const config = resolveGoogleConfig(deps.config ?? {}, deps.env ?? process.env);
  const log = { info: (...a: unknown[]) => app.log.info(a as never), warn: (...a: unknown[]) => app.log.warn(a as never), error: (...a: unknown[]) => app.log.error(a as never) };
  const ctx: GoogleCtx = { db: deps.db, config, log };
  migrate(ctx.db);

  // When mounted inside a `/api` prefix (buildApp) routes are relative; standalone they carry the full /api path.
  const inApiPrefix = app.prefix.endsWith('/api');
  const route = (method: 'GET' | 'POST' | 'PATCH', url: string, handler: (req: FastifyRequest, reply: FastifyReply) => unknown) => {
    const rel = inApiPrefix ? url.replace(/^\/api/, '') : url;
    if (app.hasRoute({ method, url: app.prefix + rel })) return; // another package already owns it
    app.route({ method, url: rel, handler: handler as never });
  };
  const csrfOk = (req: FastifyRequest) => (req.headers['x-requested-with'] ?? '') === 'fetch';
  const guarded = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (req.method !== 'GET' && !csrfOk(req)) { apiError(reply, 400, 'bad_request', 'Missing X-Requested-With: fetch header'); return null; }
    const uid = sessionUserId(ctx.db, req);
    if (!uid) { apiError(reply, 401, 'unauthorized', 'Not signed in'); return null; }
    return uid;
  };

  // ---- auth ----
  route('GET', '/api/auth/login', (req, reply) => startLogin(ctx, req, reply));
  route('GET', '/api/auth/google/start', (req, reply) => startLogin(ctx, req, reply));
  route('GET', '/api/auth/callback', async (req, reply) => {
    const uid = await handleCallback(ctx, req, reply);
    if (uid && config.debounceMs > 0) scheduleSync(uid, 0); // debounceMs=0 disables all automatic syncing (tests)
    return reply;
  });
  route('POST', '/api/auth/logout', (req, reply) => {
    if (!csrfOk(req)) return apiError(reply, 400, 'bad_request', 'Missing X-Requested-With: fetch header');
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    clearCookie(reply, config, SESSION_COOKIE);
    return reply.code(204).send();
  });
  route('GET', '/api/auth/me', (req, reply) => {
    const uid = sessionUserId(ctx.db, req);
    const user = uid ? loadUser(ctx.db, uid) : null;
    return user ?? apiError(reply, 401, 'unauthorized', 'Not signed in');
  });

  // ---- sync ----
  route('GET', '/api/sync/state', (req, reply) => {
    const uid = guarded(req, reply);
    return uid ? getSyncState(ctx, uid) : reply;
  });
  route('POST', '/api/sync/run', async (req, reply) => {
    const uid = guarded(req, reply);
    return uid ? runSync(ctx, uid) : reply;
  });
  route('POST', '/api/sync/disconnect', async (req, reply) => {
    const uid = guarded(req, reply);
    return uid ? disconnectAccount(ctx, uid) : reply;
  });
  route('PATCH', '/api/sync/settings', (req, reply) => {
    const uid = guarded(req, reply);
    if (!uid) return reply;
    const cal = (req.body as { calendarId?: unknown } | undefined)?.calendarId;
    if (cal !== undefined && (typeof cal !== 'string' || !cal.trim() || cal.length > 256)) return apiError(reply, 400, 'bad_request', 'calendarId must be a non-empty string');
    if (!getSyncState(ctx, uid).connected) return apiError(reply, 400, 'bad_request', 'Google is not connected');
    if (typeof cal === 'string' && cal.trim() !== getSyncState(ctx, uid).calendarId) {
      const state = changeCalendar(ctx, uid, cal.trim());
      scheduleSync(uid, 0);
      return state;
    }
    return getSyncState(ctx, uid);
  });

  // ---- scheduling: debounce after local writes + background poll ----
  const timers = new Map<string, NodeJS.Timeout>();
  function scheduleSync(userId: string, delayMs: number) {
    if (timers.has(userId)) return;
    const t = setTimeout(() => {
      timers.delete(userId);
      runSync(ctx, userId).catch((e) => ctx.log?.warn({ err: (e as Error).message }, 'background sync failed'));
    }, delayMs);
    t.unref();
    timers.set(userId, t);
  }
  if (config.debounceMs > 0) setSyncTrigger((uid) => scheduleSync(uid, config.debounceMs));

  let poller: NodeJS.Timeout | undefined;
  if (config.pollMs > 0) {
    poller = setInterval(() => {
      const rows = ctx.db.prepare("SELECT user_id FROM google_accounts WHERE status != 'reauth_required'").all() as { user_id: string }[];
      for (const { user_id } of rows) {
        const active = ctx.db.prepare('SELECT 1 FROM sessions WHERE user_id = ? LIMIT 1').all(user_id).length > 0; // only while a session exists
        if (active) runSync(ctx, user_id).catch(() => undefined);
      }
    }, config.pollMs);
    poller.unref();
  }
  app.addHook('onClose', async () => {
    if (poller) clearInterval(poller);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    setSyncTrigger(null);
    await settleSyncs();
  });

  const api: GoogleApi = {
    ctx,
    runSync: (uid) => runSync(ctx, uid),
    getSyncState: (uid) => getSyncState(ctx, uid),
    async linkDemoAccount(userId, email = 'demo@example.com') {
      if (!config.demoMode) throw new Error('linkDemoAccount is only available in DEMO_MODE');
      const f = config.fetch ?? fetch;
      const r = await f(`${config.authBase}/__mock/issue-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      if (!r.ok) throw new Error(`mock-google issue-token failed (${r.status})`);
      const tok = (await r.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
      saveAccount(ctx, userId, 'mock-sub-' + email, email, tok);
    },
  };
  if (!app.hasDecorator('google')) app.decorate('google', api);
  current = api;
  app.addHook('onClose', async () => { if (current === api) current = null; });
  return api;
}

/** Fastify plugin form: `await app.register(googlePlugin, { db, config })`. Skips encapsulation so routes land on the root. */
export const googlePlugin = async (app: FastifyInstance, deps: GoogleDeps): Promise<void> => { await registerGoogle(app, deps); };
(googlePlugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;

export default googlePlugin;
