import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { loadConfig, type AppConfig, type Env } from './config.js';
import type { Ctx } from './ctx.js';
import { exec, one } from './db/index.js';
import { AppError, unauthorized } from './errors.js';
import { googleRoutes } from './google/index';
import { runSync } from './google/sync';
import { PUBLIC_PATHS } from './http/auth.js';
import { CSRF_MESSAGE, failsCsrf, isSafeMethod } from './http/csrf.js';
import type { C, HonoEnv } from './http/types.js';
import { miscRoutes } from './routes/misc.js';
import { reminderRoutes } from './routes/reminders.js';
import { templateRoutes } from './routes/templates.js';
import { userFromRequest } from './session.js';
import { sha256b64, sha256hex } from './util.js';

const IDEM_TTL_MS = 24 * 3600_000;
const RATE_WINDOW_MS = 60_000;

const CSP_BASE = [
  "default-src 'self'", "img-src 'self' https://*.googleusercontent.com data:", "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'", "font-src 'self'", "manifest-src 'self'", "worker-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
];

/** CSP for an HTML document: scripts from self plus the exact inline scripts it contains (hashed, not 'unsafe-inline'). */
async function cspFor(html: string | null): Promise<string> {
  const hashes: string[] = [];
  if (html) {
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      hashes.push(`'sha256-${(await sha256b64(m[1]!))}'`);
    }
  }
  return [`script-src 'self' ${hashes.join(' ')}`.trim(), ...CSP_BASE].join('; ');
}

export interface AppDeps {
  /** Replaces global fetch for calls to Google (tests simulate outages with it). */
  fetch?: typeof fetch;
}

/** Builds the per-request service bundle; config is parsed once per env object. */
export function ctxFactory(deps: AppDeps = {}) {
  const configs = new WeakMap<object, AppConfig>();
  const log = { info: (...a: unknown[]) => console.info(...a), warn: (...a: unknown[]) => console.warn(...a), error: (...a: unknown[]) => console.error(...a) };
  return (env: Env, waitUntil?: (p: Promise<unknown>) => void): Ctx => {
    let config = configs.get(env);
    if (!config) { config = loadConfig(env, deps); configs.set(env, config); }
    const google = { db: env.DB, config: config.google, log };
    const cfg = config;
    return {
      db: env.DB, config: cfg, google,
      kick: (userId) => { if (cfg.autoSync && waitUntil) waitUntil(runSync(google, userId).then(() => undefined, (e) => log.warn('background sync failed', (e as Error).message))); },
    };
  };
}

const json = (c: C, status: number, code: string, message: string, details?: unknown) =>
  c.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, status as ContentfulStatusCode);

export function createApp(deps: AppDeps = {}): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  const ctxFor = ctxFactory(deps);
  // ponytail: per-isolate fixed-window limiter (Workers isolates do not share memory, so the effective limit is per isolate, not global). Upgrade to a `ratelimits` binding when this protects anything beyond demo/OAuth row creation.
  const hits = new Map<string, { n: number; reset: number }>();

  // Service bundle for this request.
  app.use('*', async (c, next) => {
    let waitUntil: ((p: Promise<unknown>) => void) | undefined;
    try { const ec = c.executionCtx; waitUntil = (p) => ec.waitUntil(p); } catch { /* no ExecutionContext (unit tests) */ }
    c.set('ctx', ctxFor(c.env, waitUntil));
    c.set('user', null);
    c.set('body', undefined);
    await next();
  });

  // Security headers on every response (API and static).
  app.use('*', async (c, next) => {
    await next();
    const h = new Headers(c.res.headers);
    h.set('x-content-type-options', 'nosniff');
    h.set('x-frame-options', 'DENY');
    h.set('referrer-policy', 'no-referrer');
    h.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    h.set('cross-origin-opener-policy', 'same-origin');
    if (c.var.ctx.config.nodeEnv === 'production') h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (!h.has('content-security-policy')) h.set('content-security-policy', [`script-src 'self'`, ...CSP_BASE].join('; '));
    if (new URL(c.req.url).pathname.startsWith('/api/')) h.set('cache-control', 'no-store');
    c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: h });
  });

  // Fixed-window rate limit for the unauthenticated, row-creating routes (login, callback, demo).
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const limited = path.startsWith('/api/demo/') || (path.startsWith('/api/auth/') && path !== '/api/auth/me' && path !== '/api/auth/logout');
    if (!limited) return next();
    const t = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
    const key = `${ip}:${path.startsWith('/api/demo/') ? 'demo' : 'auth'}`;
    const h = hits.get(key);
    if (!h || h.reset <= t) hits.set(key, { n: 1, reset: t + RATE_WINDOW_MS });
    else if (++h.n > c.var.ctx.config.authRateLimit) {
      c.header('retry-after', String(Math.ceil((h.reset - t) / 1000)));
      throw new AppError(429, 'rate_limited', 'Too many requests. Try again shortly.');
    }
    return next();
  });

  // JSON body (tolerates an empty one, e.g. POST /complete sent with a JSON content-type), capped by BODY_LIMIT_BYTES.
  app.use('*', async (c, next) => {
    if (isSafeMethod(c.req.method)) return next();
    const max = c.var.ctx.config.bodyLimitBytes;
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > max) throw new AppError(413, 'bad_request', 'Request body too large');
    if (!(c.req.header('content-type') ?? '').includes('json')) return next();
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > max) throw new AppError(413, 'bad_request', 'Request body too large');
    if (text.trim()) {
      try { c.set('body', JSON.parse(text)); } catch { throw new AppError(400, 'bad_request', 'Malformed JSON body'); }
    }
    return next();
  });

  // Auth + CSRF for /api
  app.use('/api/*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (failsCsrf(c.req.raw)) throw new AppError(403, 'unauthorized', CSRF_MESSAGE);
    c.set('user', await userFromRequest(c));
    if (!c.var.user && !PUBLIC_PATHS.has(path)) throw unauthorized();
    return next();
  });

  // Idempotency-Key replay for the offline mutation queue (24h). Scoped to user, method, URL and body so
  // reusing a key on a different request never replays the wrong response.
  app.use('/api/*', async (c, next) => {
    const k = c.req.header('idempotency-key');
    if (isSafeMethod(c.req.method) || !k || !c.var.user) return next();
    const { db } = c.var.ctx;
    const fingerprint = await sha256hex(`${c.req.method} ${new URL(c.req.url).pathname}\n${JSON.stringify(c.var.body ?? null)}`);
    const key = `${c.var.user.id}:${k}:${fingerprint}`;
    const row = await one<{ response_json: string }>(db, 'SELECT response_json FROM idempotency_keys WHERE key = ? AND created_at >= ?', key, new Date(Date.now() - IDEM_TTL_MS).toISOString());
    if (row) {
      const { status, body } = JSON.parse(row.response_json) as { status: number; body: string };
      return new Response(body || null, { status, headers: { 'idempotent-replay': 'true', ...(body ? { 'content-type': 'application/json; charset=UTF-8' } : {}) } });
    }
    await next();
    if (c.res.status < 400) {
      const body = await c.res.clone().text();
      await exec(db, 'INSERT OR IGNORE INTO idempotency_keys (key, user_id, response_json, created_at) VALUES (?, ?, ?, ?)',
        key, c.var.user.id, JSON.stringify({ status: c.res.status, body }), new Date().toISOString());
    }
  });

  const api = new Hono<HonoEnv>();
  api.route('/', miscRoutes());
  api.route('/', reminderRoutes());
  api.route('/', templateRoutes());
  api.route('/', googleRoutes());
  app.route('/api', api);

  app.onError((err, c) => {
    if (err instanceof AppError) return json(c, err.status, err.code, err.message, err.details);
    if (err instanceof ZodError) return json(c, 400, 'bad_request', 'Validation failed', err.issues);
    if (err instanceof HTTPException) return json(c, err.status, err.status === 429 ? 'rate_limited' : 'bad_request', err.message);
    console.error(err);
    return json(c, 500, 'internal', 'Internal server error');
  });

  app.notFound(async (c) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith('/api/') || (c.req.method !== 'GET' && c.req.method !== 'HEAD')) return json(c, 404, 'not_found', 'Route not found');
    return serveStatic(c);
  });

  return app;
}

/** Static UI from the ASSETS binding (SPA fallback is configured in wrangler.jsonc). HTML gets a CSP hashing its inline scripts. */
async function serveStatic(c: C): Promise<Response> {
  const assets = c.env.ASSETS;
  if (!assets) return json(c, 404, 'not_found', 'Route not found');
  const { pathname } = new URL(c.req.url);
  try { decodeURIComponent(pathname); } catch { return json(c, 400, 'bad_request', 'Malformed URL'); }
  const res = await assets.fetch(c.req.raw);
  if (!res.ok) return json(c, 404, 'not_found', 'Route not found');
  const headers = new Headers(res.headers);
  headers.set('cache-control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  if ((headers.get('content-type') ?? '').startsWith('text/html')) {
    const html = await res.text();
    headers.set('content-security-policy', await cspFor(html));
    headers.delete('content-length');
    return new Response(html, { status: res.status, headers });
  }
  return new Response(res.body, { status: res.status, headers });
}
