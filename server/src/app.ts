import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { ZodError } from 'zod';
import { loadConfig, type AppConfig } from './config.js';
import { openDb, type Db } from './db/index.js';
import { AppError, unauthorized } from './errors.js';
import { miscRoutes, fallbackSyncRoutes } from './routes/misc.js';
import { reminderRoutes } from './routes/reminders.js';
import { loadGoogle } from './services/hooks.js';
import type { Ctx } from './services/reminders.js';
import { userFromRequest } from './session.js';

const PUBLIC = new Set(['/api/health', '/api/demo/login', '/api/auth/login', '/api/auth/google/start', '/api/auth/callback', '/api/auth/me']);
const IDEM_TTL_MS = 24 * 3600_000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.woff2': 'font/woff2',
};

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: AppConfig;
  }
}

export async function buildApp(overrides: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  const config = loadConfig(overrides);
  const db = openDb(config.dbPath);
  const google = await loadGoogle();
  google.migrate?.(db);
  const ctx: Ctx = { db, config, hooks: google.hooks };

  const app = Fastify({ logger: config.logger ? { level: 'info' } : false });
  app.decorate('db', db);
  app.decorate('config', config);
  app.decorateRequest('user', null);
  app.addHook('onClose', async () => { db.close(); });

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
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'fetch') {
      throw new AppError(403, 'unauthorized', 'Missing X-Requested-With: fetch header');
    }
    req.user = userFromRequest(db, req);
    if (!req.user && !PUBLIC.has(path)) throw unauthorized();
  });

  // Idempotency-Key replay for offline mutation queue (24h)
  const idemKey = (req: { headers: Record<string, unknown>; user: { id: string } | null }) =>
    typeof req.headers['idempotency-key'] === 'string' && req.user && req.headers['idempotency-key'] ? `${req.user.id}:${req.headers['idempotency-key']}` : null;
  app.addHook('preHandler', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
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
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || reply.statusCode >= 500 || reply.getHeader('idempotent-replay')) return payload;
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
    if (google.registerGoogle) await google.registerGoogle(api, { db, config });
    else fallbackSyncRoutes(api);
  }, { prefix: '/api' });

  return app;
}

function serveStatic(config: AppConfig, url: string, reply: import('fastify').FastifyReply) {
  const root = resolve(config.webDist);
  if (!existsSync(root)) return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  let file = resolve(join(root, decodeURIComponent(url.split('?')[0]!)));
  if (file !== root && !file.startsWith(root + sep)) return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // SPA fallback
  if (!existsSync(file)) return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  return reply.header('content-type', MIME[extname(file)] ?? 'application/octet-stream').send(readFileSync(file));
}
