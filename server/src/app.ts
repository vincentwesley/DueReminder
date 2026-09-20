import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { ZodError } from 'zod';
import { loadConfig, type AppConfig } from './config.js';
import { openDb, type Db } from './db/index.js';
import { AppError, unauthorized } from './errors.js';
import { miscRoutes, fallbackSyncRoutes } from './routes/misc.js';
import { reminderRoutes } from './routes/reminders.js';
import { templateRoutes } from './routes/templates.js';
import { loadGoogle } from './services/hooks.js';
import type { Ctx } from './services/reminders.js';
import { userFromRequest } from './session.js';
import { PUBLIC_PATHS } from './http/auth.js';
import { CSRF_MESSAGE, failsCsrf, isSafeMethod } from './http/csrf.js';

const IDEM_TTL_MS = 24 * 3600_000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.woff2': 'font/woff2',
};

const CSP_BASE = [
  "default-src 'self'", "img-src 'self' https://*.googleusercontent.com data:", "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'", "font-src 'self'", "manifest-src 'self'", "worker-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
];
const SESSION_PRUNE_MS = 10 * 60_000;
const RATE_WINDOW_MS = 60_000;

/** CSP for an HTML document: scripts from self plus the exact inline scripts it contains (hashed, not 'unsafe-inline'). */
function cspFor(html: string | null): string {
  const hashes = html
    ? [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`)
    : [];
  return [`script-src 'self' ${hashes.join(' ')}`.trim(), ...CSP_BASE].join('; ');
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: AppConfig;
    pruneExpired: () => void;
  }
}

export async function buildApp(overrides: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  const config = loadConfig(overrides);
  const db = openDb(config.dbPath);
  const google = await loadGoogle();
  google.migrate?.(db);
  const ctx: Ctx = { db, config, hooks: google.hooks };

  const app = Fastify({ logger: config.logger ? { level: 'info' } : false, trustProxy: config.trustProxy,
    connectionTimeout: config.connectionTimeoutMs,
    keepAliveTimeout: config.keepAliveTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    routerOptions: { maxParamLength: config.maxParamLength },
    bodyLimit: config.bodyLimitBytes,
  });
  app.decorate('db', db);
  app.decorate('config', config);
  app.decorateRequest('user', null);
  app.addHook('onClose', async () => { db.close(); });

  // Expired sessions and abandoned OAuth states would otherwise accumulate forever.
  const prune = () => {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
    try { db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(Date.now() - 10 * 60_000); } catch { /* table is created by the google migration */ }
  };
  prune();
  const pruneTimer = setInterval(prune, SESSION_PRUNE_MS);
  pruneTimer.unref();
  app.addHook('onClose', async () => { clearInterval(pruneTimer); });
  app.decorate('pruneExpired', prune);

  // Security headers on every response (API and static).
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (config.nodeEnv === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    const isHtml = String(reply.getHeader('content-type') ?? '').startsWith('text/html');
    reply.header('content-security-policy', cspFor(isHtml && (typeof payload === 'string' || Buffer.isBuffer(payload)) ? payload.toString('utf8') : null));
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  // Fixed-window rate limit for the unauthenticated, row-creating routes (login, callback, demo).
  const hits = new Map<string, { n: number; reset: number }>();
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    const limited = path.startsWith('/api/demo/') || (path.startsWith('/api/auth/') && path !== '/api/auth/me' && path !== '/api/auth/logout');
    if (!limited) return;
    const t = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
    const key = `${req.ip}:${path.startsWith('/api/demo/') ? 'demo' : 'auth'}`;
    const h = hits.get(key);
    if (!h || h.reset <= t) { hits.set(key, { n: 1, reset: t + RATE_WINDOW_MS }); return; }
    if (++h.n > config.authRateLimit) {
      reply.header('retry-after', String(Math.ceil((h.reset - t) / 1000)));
      throw new AppError(429, 'rate_limited', 'Too many requests. Try again shortly.');
    }
  });

  await app.register(cookie);
  await app.register(cors, { origin: [`http://localhost:${config.webPort}`, `http://127.0.0.1:${config.webPort}`], credentials: true });

  // Tolerate empty JSON bodies (e.g. POST /complete sent with a JSON content-type).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const s = (body as string).trim();
    if (!s) return done(null, undefined);
    try { done(null, JSON.parse(s)); } catch { done(new AppError(400, 'bad_request', 'Malformed JSON body'), undefined); }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'bad_request', message: 'Validation failed', details: err.issues } });
    if (err.validation || (err.statusCode && err.statusCode >= 400 && err.statusCode < 500)) {
      return reply.code(err.statusCode ?? 400).send({ error: { code: err.statusCode === 429 ? 'rate_limited' : 'bad_request', message: err.message } });
    }
    app.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
    return serveStatic(config, req.url, reply);
  });

  // Auth + CSRF for /api
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/')) return;
    if (failsCsrf(req)) throw new AppError(403, 'unauthorized', CSRF_MESSAGE);
    req.user = userFromRequest(db, req);
    if (!req.user && !PUBLIC_PATHS.has(path)) throw unauthorized();
  });

  // Idempotency-Key replay for offline mutation queue (24h)
  // Scoped to user, method, URL and body so reusing a key on a different request never replays the wrong response.
  const idemKey = (req: { method: string; url: string; body?: unknown; headers: Record<string, unknown>; user: { id: string } | null }) => {
    const k = req.headers['idempotency-key'];
    if (typeof k !== 'string' || !k || !req.user) return null;
    const fingerprint = createHash('sha256').update(`${req.method} ${req.url.split('?')[0]}
${JSON.stringify(req.body ?? null)}`).digest('hex');
    return `${req.user.id}:${k}:${fingerprint}`;
  };
  app.addHook('preHandler', async (req, reply) => {
    if (isSafeMethod(req.method)) return;
    const key = idemKey(req as never);
    if (!key) return;
    db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(new Date(Date.now() - IDEM_TTL_MS).toISOString());
    const row = db.prepare('SELECT response_json FROM idempotency_keys WHERE key = ?').get(key) as { response_json: string } | undefined;
    if (!row) return;
    const { status, body } = JSON.parse(row.response_json) as { status: number; body: string };
    reply.header('idempotent-replay', 'true');
    if (body) reply.header('content-type', 'application/json; charset=utf-8');
    return reply.code(status).send(body || undefined);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (isSafeMethod(req.method) || reply.statusCode >= 400 || reply.getHeader('idempotent-replay')) return payload;
    const key = idemKey(req as never);
    if (key && (typeof payload === 'string' || payload == null)) {
      db.prepare('INSERT OR IGNORE INTO idempotency_keys (key, user_id, response_json, created_at) VALUES (?, ?, ?, ?)')
        .run(key, req.user!.id, JSON.stringify({ status: reply.statusCode, body: payload ?? '' }), new Date().toISOString());
    }
    return payload;
  });

  await app.register(async (api) => {
    miscRoutes(api, ctx);
    reminderRoutes(api, ctx);
    templateRoutes(api, ctx);
    if (google.registerGoogle) await google.registerGoogle(api, { db, config });
    else fallbackSyncRoutes(api);
  }, { prefix: '/api' });

  return app;
}

function serveStatic(config: AppConfig, url: string, reply: import('fastify').FastifyReply) {
  const root = resolve(config.webDist);
  if (!existsSync(root)) return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  let decoded: string;
  try { decoded = decodeURIComponent(url.split('?')[0]!); } catch { return reply.code(400).send({ error: { code: 'bad_request', message: 'Malformed URL' } }); }
  let file = resolve(join(root, decoded));
  if (file !== root && !file.startsWith(root + sep)) return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // SPA fallback
  if (!existsSync(file)) return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  const hashed = file.startsWith(join(root, 'assets') + sep);
  return reply
    .header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
    .header('content-type', MIME[extname(file)] ?? 'application/octet-stream')
    .send(readFileSync(file));
}
