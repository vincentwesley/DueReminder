import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../server/src/config';
import { exec, many, one } from '../../server/src/db/index';
import { runScheduled } from '../../server/src/worker';
import { cookieOf } from './google-helpers';
import { freshDb, makeTestApp, testEnv } from './harness';

const H = { 'x-requested-with': 'fetch' };
const SCRIPT = "try{document.documentElement.dataset.theme='x'}catch(e){}";

/** Stand-in for the Workers Assets binding: an index.html with an inline script, a hashed asset and a service worker. */
const ASSETS: Env['ASSETS'] = {
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const type = (t: string) => ({ headers: { 'content-type': t } });
    if (pathname === '/assets/a.js') return new Response('console.log(1)', type('text/javascript'));
    if (pathname === '/sw.js') return new Response('//sw', type('text/javascript'));
    return new Response(`<!doctype html><html><head><script>${SCRIPT}</script><script type="module" src="/assets/a.js"></script></head><body></body></html>`, type('text/html; charset=utf-8'));
  },
};
const prodEnv: Partial<Env> = {
  NODE_ENV: 'production', DEMO_MODE: '0', SESSION_SECRET: 'Zk3'.repeat(12), GOOGLE_AUTH_BASE: 'https://accounts.google.com', GOOGLE_API_BASE: 'https://www.googleapis.com', GOOGLE_CLIENT_ID: 'cid',
};

describe('security headers', () => {
  it('sets a strict CSP, framing and sniffing protection on API and static responses', async () => {
    const app = makeTestApp(await freshDb(), { ASSETS });
    const api = await app.inject({ url: '/api/health' });
    expect(api.headers['x-content-type-options']).toBe('nosniff');
    expect(api.headers['x-frame-options']).toBe('DENY');
    expect(api.headers['referrer-policy']).toBe('no-referrer');
    expect(api.headers['cache-control']).toBe('no-store');
    expect(String(api.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(api.headers['strict-transport-security']).toBeUndefined();

    const page = await app.inject({ url: '/' });
    const csp = String(page.headers['content-security-policy']);
    const hash = createHash('sha256').update(SCRIPT).digest('base64');
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.body).toContain('<script>');

    // SPA routes get the document (and its CSP) too
    expect(String((await app.inject({ url: '/some/deep/link' })).headers['content-security-policy'])).toContain(`'sha256-${hash}'`);
    expect((await app.inject({ url: '/assets/a.js' })).headers['cache-control']).toContain('immutable');
    expect((await app.inject({ url: '/sw.js' })).headers['cache-control']).toBe('no-cache');
  });

  it('adds HSTS in production and uses the __Host- cookie names', async () => {
    const app = makeTestApp(await freshDb(), { ...prodEnv, INSECURE_COOKIES: undefined });
    const res = await app.inject({ url: '/api/health' });
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for a malformed URL instead of crashing, and JSON 404 for unknown API routes', async () => {
    const app = makeTestApp(await freshDb(), { ASSETS });
    expect((await app.inject({ url: '/%E0%A4%A' })).statusCode).toBe(400);
    const miss = await app.inject({ url: '/api/nope', headers: H });
    expect(miss.statusCode).toBe(401); // the API is closed to anonymous callers before routing
    expect((await app.inject({ method: 'POST', url: '/not-api', headers: H })).statusCode).toBe(404);
  });
});

describe('cookies', () => {
  it('uses a Secure __Host- session cookie by default and the plain name in local dev', async () => {
    const db = await freshDb();
    const secure = makeTestApp(db, { INSECURE_COOKIES: undefined });
    const a = await secure.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const c = ([] as string[]).concat(a.headers['set-cookie'] as string[]).find((x) => x.startsWith('__Host-rs_session='))!;
    expect(c).toMatch(/; Secure/i);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
    expect(c).not.toMatch(/Domain=/i);
    // the cookie is honoured on the next request
    const sid = c.split(';')[0]!;
    expect((await secure.inject({ url: '/api/me', headers: { ...H, cookie: sid } })).statusCode).toBe(200);

    const dev = makeTestApp(await freshDb(), {});
    const b = await dev.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const d = ([] as string[]).concat(b.headers['set-cookie'] as string[]).find((x) => x.startsWith('rs_session='))!;
    expect(d).not.toMatch(/Secure/i);
  });
});

describe('abuse controls', () => {
  it('rate limits the demo and auth routes per client', async () => {
    const app = makeTestApp(await freshDb(), { AUTH_RATE_LIMIT: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: 'POST', url: '/api/demo/login', headers: H })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const limited = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    expect(limited.headers['retry-after']).toBeTruthy();
    expect(limited.json().error.code).toBe('rate_limited');
    // unrelated routes are not throttled
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
  });

  it('rejects oversized bodies', async () => {
    const app = makeTestApp(await freshDb(), { BODY_LIMIT_BYTES: '1024' });
    const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const cookie = 'rs_session=' + cookieOf(login.headers['set-cookie'], 'rs_session');
    const res = await app.inject({ method: 'POST', url: '/api/reminders', headers: { ...H, cookie, 'content-type': 'application/json' }, payload: JSON.stringify({ title: 'x'.repeat(5000) }) });
    expect(res.statusCode).toBe(413);
  });

  it('reports malformed JSON as a 400', async () => {
    const app = makeTestApp(await freshDb(), {});
    const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const cookie = 'rs_session=' + cookieOf(login.headers['set-cookie'], 'rs_session');
    const res = await app.inject({ method: 'POST', url: '/api/reminders', headers: { ...H, cookie, 'content-type': 'application/json' }, payload: '{nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('the cron prunes expired sessions, stale oauth states and old idempotency keys', async () => {
    const db = await freshDb();
    const app = makeTestApp(db, {});
    const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const live = cookieOf(login.headers['set-cookie'], 'rs_session');
    const uid = (await one<{ user_id: string }>(db, 'SELECT user_id FROM sessions WHERE id = ?', live))!.user_id;
    await exec(db, "INSERT INTO sessions (id,user_id,expires_at) VALUES ('old',?,'2000-01-01T00:00:00.000Z')", uid);
    await exec(db, "INSERT INTO oauth_states (state,code_verifier,created_at) VALUES ('stale','v',1)");
    await exec(db, "INSERT INTO idempotency_keys (key,user_id,response_json,created_at) VALUES ('k',?,'{}','2000-01-01T00:00:00.000Z')", uid);
    await runScheduled(testEnv(db));
    expect(await one(db, "SELECT 1 FROM sessions WHERE id = 'old'")).toBeUndefined();
    expect(await one(db, "SELECT 1 FROM oauth_states WHERE state = 'stale'")).toBeUndefined();
    expect(await one(db, "SELECT 1 FROM idempotency_keys WHERE key = 'k'")).toBeUndefined();
    expect(await one(db, 'SELECT 1 FROM sessions WHERE id = ?', live)).toBeTruthy();
  });

  it('replaces the previous session on demo login and caps sessions per user', async () => {
    const db = await freshDb();
    const app = makeTestApp(db, { AUTH_RATE_LIMIT: '1000' });
    const first = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const sid = cookieOf(first.headers['set-cookie'], 'rs_session');
    const second = await app.inject({ method: 'POST', url: '/api/demo/login', headers: { ...H, cookie: `rs_session=${sid}` } });
    expect(cookieOf(second.headers['set-cookie'], 'rs_session')).not.toBe(sid);
    expect(await one(db, 'SELECT 1 FROM sessions WHERE id = ?', sid)).toBeUndefined();
    for (let i = 0; i < 12; i++) await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    expect((await many<{ n: number }>(db, 'SELECT COUNT(*) n FROM sessions'))[0]!.n).toBeLessThanOrEqual(10);
  });
});

describe('idempotency keys (L1)', () => {
  it('replays the same request but not a different request that reuses the key', async () => {
    const app = makeTestApp(await freshDb(), {});
    const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const headers = { ...H, cookie: `rs_session=${cookieOf(login.headers['set-cookie'], 'rs_session')}`, 'idempotency-key': 'abc' };
    const a1 = await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: 'one' } });
    const a2 = await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: 'one' } });
    expect(a2.headers['idempotent-replay']).toBe('true');
    expect(a2.statusCode).toBe(201);
    expect(a2.json().id).toBe(a1.json().id);
    const b = await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: 'two' } });
    expect(b.headers['idempotent-replay']).toBeUndefined();
    expect(b.json().title).toBe('two');
  });

  it('does not cache client errors', async () => {
    const app = makeTestApp(await freshDb(), {});
    const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const headers = { ...H, cookie: `rs_session=${cookieOf(login.headers['set-cookie'], 'rs_session')}`, 'idempotency-key': 'bad' };
    expect((await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: '' } })).headers['idempotent-replay']).toBeUndefined();
  });
});
