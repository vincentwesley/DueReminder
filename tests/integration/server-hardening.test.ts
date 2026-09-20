import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../server/src/app';
import { cookieOf } from './google-helpers';

const H = { 'x-requested-with': 'fetch' };

function siteDir(): { dir: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rs-web-'));
  mkdirSync(join(dir, 'assets'));
  const script = "try{document.documentElement.dataset.theme='x'}catch(e){}";
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><script>${script}</script><script type="module" src="/assets/a.js"></script></head><body></body></html>`);
  writeFileSync(join(dir, 'assets', 'a.js'), 'console.log(1)');
  writeFileSync(join(dir, 'sw.js'), '//sw');
  return { dir, script };
}

describe('security headers', () => {
  it('sets a strict CSP, framing and sniffing protection on API and static responses', async () => {
    const { dir, script } = siteDir();
    const app = await buildApp({ dbPath: ':memory:', demoMode: true, logger: false, webDist: dir });
    const api = await app.inject({ url: '/api/health' });
    expect(api.headers['x-content-type-options']).toBe('nosniff');
    expect(api.headers['x-frame-options']).toBe('DENY');
    expect(api.headers['referrer-policy']).toBe('no-referrer');
    expect(api.headers['cache-control']).toBe('no-store');
    expect(String(api.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(api.headers['strict-transport-security']).toBeUndefined();

    const page = await app.inject({ url: '/' });
    const csp = String(page.headers['content-security-policy']);
    const hash = createHash('sha256').update(script).digest('base64');
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(page.headers['cache-control']).toBe('no-cache');

    expect((await app.inject({ url: '/assets/a.js' })).headers['cache-control']).toContain('immutable');
    expect((await app.inject({ url: '/sw.js' })).headers['cache-control']).toBe('no-cache');
    await app.close();
  });

  it('adds HSTS in production', async () => {
    const app = await buildApp({
      dbPath: ':memory:', demoMode: false, logger: false, nodeEnv: 'production', sessionSecret: 'Zk3'.repeat(12),
      googleAuthBase: 'https://accounts.google.com', googleApiBase: 'https://www.googleapis.com', googleClientId: 'cid',
    });
    expect((await app.inject({ url: '/api/health' })).headers['strict-transport-security']).toContain('max-age=');
    await app.close();
  });

  it('returns 400 for a malformed URL instead of crashing', async () => {
    const { dir } = siteDir();
    const app = await buildApp({ dbPath: ':memory:', demoMode: true, logger: false, webDist: dir });
    expect((await app.inject({ url: '/%E0%A4%A' })).statusCode).toBe(400);
    await app.close();
  });
});

describe('abuse controls', () => {
  it('rate limits the demo and auth routes per client', async () => {
    const app = await buildApp({ dbPath: ':memory:', demoMode: true, logger: false, authRateLimit: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: 'POST', url: '/api/demo/login', headers: H })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const limited = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    expect(limited.headers['retry-after']).toBeTruthy();
    expect(limited.json().error.code).toBe('rate_limited');
    // unrelated routes are not throttled
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('prunes expired sessions and stale oauth states', async () => {
    const app = await buildApp({ dbPath: ':memory:', demoMode: true, logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const live = cookieOf(login.headers['set-cookie'], 'rs_session');
    const uid = (app.db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(live) as { user_id: string }).user_id;
    app.db.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES ('old',?,'2000-01-01T00:00:00.000Z')").run(uid);
    app.db.prepare("INSERT INTO oauth_states (state,code_verifier,created_at) VALUES ('stale','v',1)").run();
    app.pruneExpired();
    expect(app.db.prepare("SELECT 1 FROM sessions WHERE id = 'old'").get()).toBeUndefined();
    expect(app.db.prepare("SELECT 1 FROM oauth_states WHERE state = 'stale'").get()).toBeUndefined();
    expect(app.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(live)).toBeTruthy();
    await app.close();
  });

  it('replaces the previous session on demo login and caps sessions per user', async () => {
    const app = await buildApp({ dbPath: ':memory:', demoMode: true, logger: false, authRateLimit: 1000 });
    const first = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const sid = cookieOf(first.headers['set-cookie'], 'rs_session');
    const second = await app.inject({ method: 'POST', url: '/api/demo/login', headers: { ...H, cookie: `rs_session=${sid}` } });
    expect(cookieOf(second.headers['set-cookie'], 'rs_session')).not.toBe(sid);
    expect(app.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sid)).toBeUndefined();
    for (let i = 0; i < 25; i++) await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    expect((app.db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n).toBeLessThanOrEqual(10);
    await app.close();
  });
});

describe('idempotency keys (L1)', () => {
  it('replays the same request but not a different request that reuses the key', async () => {
    const app = await buildApp({ dbPath: ':memory:', demoMode: true, logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const headers = { ...H, cookie: `rs_session=${cookieOf(login.headers['set-cookie'], 'rs_session')}`, 'idempotency-key': 'abc' };
    const a1 = await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: 'one' } });
    const a2 = await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: 'one' } });
    expect(a2.headers['idempotent-replay']).toBe('true');
    expect(a2.json().id).toBe(a1.json().id);
    const b = await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: 'two' } });
    expect(b.headers['idempotent-replay']).toBeUndefined();
    expect(b.json().title).toBe('two');
    await app.close();
  });

  it('does not cache client errors', async () => {
    const app = await buildApp({ dbPath: ':memory:', demoMode: true, logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const headers = { ...H, cookie: `rs_session=${cookieOf(login.headers['set-cookie'], 'rs_session')}`, 'idempotency-key': 'bad' };
    expect((await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: '' } })).headers['idempotent-replay']).toBeUndefined();
    await app.close();
  });
});
