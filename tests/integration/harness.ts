import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { afterAll } from 'vitest';
import type { Hono } from 'hono';
import { createApp, type AppDeps } from '../../server/src/app';
import type { Env } from '../../server/src/config';
import type { Db } from '../../server/src/db/index';
import type { HonoEnv } from '../../server/src/http/types';

// Integration tests run the real Hono app in Node against a real D1 (workerd's SQLite via wrangler's getPlatformProxy),
// so SQL, batches and constraint behaviour match production. Google calls hit the Node mock-google server.

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));
const TABLES = ['reminder_tags', 'subtasks', 'reminders', 'tags', 'lists', 'templates', 'sessions', 'idempotency_keys', 'google_accounts', 'outbox', 'oauth_states', 'users'];

let proxy: Awaited<ReturnType<typeof getPlatformProxy>> | undefined;
let migrated = false;

afterAll(async () => { await proxy?.dispose(); proxy = undefined; migrated = false; });

/** An empty, fully migrated D1 database (one in-memory D1 per test file, tables wiped on every call). */
export async function freshDb(): Promise<Db> {
  proxy ??= await getPlatformProxy({ configPath: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)), persist: false });
  const db = (proxy.env as { DB: unknown }).DB as Db;
  if (!migrated) {
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
      const sql = readFileSync(MIGRATIONS + f, 'utf8').replace(/^\s*--.*$/gm, '');
      for (const stmt of sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
    }
    migrated = true;
  }
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
  return db;
}

export const TEST_SECRET = 'test-secret-test-secret-test-secret-0123';

/** Worker env for tests: demo mode against the mock, plain cookies, no background sync kicks unless a test opts in. */
export const testEnv = (db: Db, over: Partial<Env> = {}): Env => ({
  DB: db, DEMO_MODE: '1', SESSION_SECRET: TEST_SECRET, INSECURE_COOKIES: '1', AUTO_SYNC: '0', DEFAULT_TIMEZONE: 'UTC',
  OAUTH_REDIRECT_URI: 'http://localhost:4000/api/auth/callback', GOOGLE_CLIENT_ID: 'mock-client-id', GOOGLE_CLIENT_SECRET: 'mock-client-secret', ...over,
});

export interface InjectOpts { method?: string; url: string; headers?: Record<string, string>; payload?: unknown }
export interface InjectRes { statusCode: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any }

/** Fastify-`inject`-style adapter over `app.fetch`; `settle()` awaits work the app handed to `waitUntil`. */
export function makeInject(app: Hono<HonoEnv>, env: Env) {
  const pending: Promise<unknown>[] = [];
  const execCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(Promise.resolve(p).catch(() => undefined)); }, passThroughOnException() { /* none */ }, props: {} };
  const inject = async (o: InjectOpts): Promise<InjectRes> => {
    const headers = new Headers(o.headers);
    let body: string | undefined;
    if (o.payload !== undefined) {
      body = typeof o.payload === 'string' ? o.payload : JSON.stringify(o.payload);
      if (typeof o.payload !== 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
    }
    const res = await app.fetch(new Request('http://localhost' + o.url, { method: o.method ?? 'GET', headers, body, redirect: 'manual' }), env, execCtx as never);
    const text = await res.text();
    const out: InjectRes['headers'] = Object.fromEntries(res.headers.entries());
    const cookies = res.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    return { statusCode: res.status, headers: out, body: text, json: () => JSON.parse(text) };
  };
  const settle = async () => { while (pending.length) await pending.shift(); };
  return { inject, settle };
}

export function makeTestApp(db: Db, over: Partial<Env> = {}, deps: AppDeps = {}) {
  const env = testEnv(db, over);
  return { env, ...makeInject(createApp(deps), env) };
}
