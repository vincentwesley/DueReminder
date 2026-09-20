import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, sessionSecretProblem } from '../../server/src/config';
import { resolveGoogleConfig, type GoogleCtx } from '../../server/src/google/config';
import { encryptToken } from '../../server/src/google/crypto';
import { verifyIdToken } from '../../server/src/google/idtoken';
import { getAccessToken } from '../../server/src/google/tokens';
import { cookieOf, makeHarness } from './google-helpers';

const STRONG = 'a'.repeat(8) + 'Zk3'.repeat(8);

describe('SESSION_SECRET enforcement (H1)', () => {
  it('flags unset, short and example secrets', () => {
    expect(sessionSecretProblem(undefined)).toMatch(/not set/);
    expect(sessionSecretProblem('short')).toMatch(/shorter/);
    expect(sessionSecretProblem('change-me-to-32+-random-chars')).toMatch(/example/);
    expect(sessionSecretProblem('dev-insecure-session-secret-change-me')).toMatch(/example/);
    expect(sessionSecretProblem(STRONG)).toBeNull();
  });
  it('refuses to start in production without a strong secret', () => {
    expect(() => loadConfig({}, { NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({}, { NODE_ENV: 'production', SESSION_SECRET: 'change-me-to-32+-random-chars' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({}, { NODE_ENV: 'production', SESSION_SECRET: STRONG })).not.toThrow();
  });
  it('refuses to start with demo mode off and a weak secret', () => {
    expect(() => loadConfig({}, { DEMO_MODE: '0', SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
  it('refuses demo mode in production', () => {
    expect(() => loadConfig({}, { NODE_ENV: 'production', DEMO_MODE: '1', SESSION_SECRET: STRONG })).toThrow(/DEMO_MODE/);
  });
  it('generates a random secret in dev (never the old constant)', () => {
    const c = loadConfig({ dbPath: ':memory:' }, { DEMO_MODE: '1' });
    expect(c.sessionSecret).toHaveLength(64);
    expect(sessionSecretProblem(c.sessionSecret)).toBeNull();
  });
  it('the google config applies the same rule', () => {
    expect(() => resolveGoogleConfig({ sessionSecret: 'change-me-to-32+-random-chars', nodeEnv: 'production', demoMode: false, authBase: 'https://accounts.google.com' }, {})).toThrow(/SESSION_SECRET/);
  });
});

describe('id_token trust (H2)', () => {
  it('refuses a non-Google auth base when demo mode is off', () => {
    expect(() => resolveGoogleConfig({ sessionSecret: STRONG, demoMode: false, authBase: 'http://localhost:4010' }, {})).toThrow(/GOOGLE_AUTH_BASE/);
    expect(() => resolveGoogleConfig({ sessionSecret: STRONG, demoMode: false, authBase: 'https://evil.example' }, {})).toThrow(/GOOGLE_AUTH_BASE/);
  });
  it('only the local mock in demo mode skips signature verification', () => {
    expect(resolveGoogleConfig({ sessionSecret: STRONG, demoMode: true, authBase: 'http://127.0.0.1:4010' }, {}).verifyIdTokenSignature).toBe(false);
    expect(resolveGoogleConfig({ sessionSecret: STRONG, demoMode: true, authBase: 'https://proxy.example.com' }, {}).verifyIdTokenSignature).toBe(true);
    expect(resolveGoogleConfig({ sessionSecret: STRONG, demoMode: false, authBase: 'https://accounts.google.com' }, {}).verifyIdTokenSignature).toBe(true);
    expect(() => resolveGoogleConfig({ sessionSecret: STRONG, demoMode: true, authBase: 'https://proxy.example.com', verifyIdTokenSignature: false }, {})).toThrow(/signature/);
  });
  const jwt = (claims: object, header: object = { alg: 'none' }) =>
    [Buffer.from(JSON.stringify(header)).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), ''].join('.');
  it('rejects an unsigned token for real Google', async () => {
    const config = resolveGoogleConfig({ sessionSecret: STRONG, demoMode: false, authBase: 'https://accounts.google.com', clientId: 'cid' }, {});
    const ctx = { db: null as never, config } as GoogleCtx;
    const nonce = createHash('sha256').update('nonce:s').digest('base64url');
    const token = jwt({ iss: 'https://accounts.google.com', aud: 'cid', sub: '1', exp: 9e9, nonce, email: 'a@b.c', email_verified: true });
    await expect(verifyIdToken(ctx, token, 's')).rejects.toThrow(/alg|signature/);
  });
  it('requires the nonce even for the local mock', async () => {
    const config = resolveGoogleConfig({ sessionSecret: STRONG, demoMode: true, authBase: 'http://localhost:4010', clientId: 'cid' }, {});
    const ctx = { db: null as never, config } as GoogleCtx;
    const token = jwt({ iss: 'https://accounts.google.com', aud: 'cid', sub: '1', exp: 9e9 });
    await expect(verifyIdToken(ctx, token, 's')).rejects.toThrow(/nonce/);
  });
});

/** Runs the mock login but lets the test rewrite the id_token claims returned by the token endpoint. */
async function loginWithClaims(edit: (c: Record<string, unknown>) => void) {
  const h = await makeHarness({
    fetch: (async (url: string, init?: RequestInit) => {
      const res = await fetch(url, init);
      if (!String(url).endsWith('/token') || init?.method !== 'POST') return res;
      const body = (await res.json()) as { id_token?: string };
      if (body.id_token) {
        const [a, b, c] = body.id_token.split('.');
        const claims = JSON.parse(Buffer.from(b!, 'base64url').toString());
        edit(claims);
        body.id_token = [a, Buffer.from(JSON.stringify(claims)).toString('base64url'), c].join('.');
      }
      return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
    }) as never,
  });
  return { h, res: await callback(h) };
}

async function callback(h: Awaited<ReturnType<typeof makeHarness>>, sessionCookie?: string) {
  const login = await h.app.inject({ method: 'GET', url: '/api/auth/login', headers: sessionCookie ? { cookie: sessionCookie } : {} });
  const oauth = cookieOf(login.headers['set-cookie'], 'rs_oauth');
  const authRes = await fetch(String(login.headers.location), { redirect: 'manual' });
  const cb = new URL(authRes.headers.get('location')!);
  return h.app.inject({ method: 'GET', url: cb.pathname + cb.search, headers: { cookie: `rs_oauth=${oauth}${sessionCookie ? `; ${sessionCookie}` : ''}` } });
}

describe('account linking and session rotation', () => {
  it('rejects a login whose email is not verified and creates no user', async () => {
    const { h, res } = await loginWithClaims((c) => { c.email_verified = false; });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain('auth_error=email_unverified');
    expect((h.db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n).toBe(0);
    await h.close();
  });
  it('does not take over an account bound to a different Google subject', async () => {
    const h = await makeHarness();
    h.db.prepare("INSERT INTO users (id,email,google_sub,name,created_at) VALUES ('u1','other@example.com','other-sub','X','2020-01-01')").run();
    // mock logs in as demo@example.com; make that address collide with an account owned by another subject
    h.db.prepare("UPDATE users SET email = 'demo@example.com' WHERE id = 'u1'").run();
    const r = await callback(h);
    const sid = cookieOf(r.headers['set-cookie'], 'rs_session');
    const owner = h.db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sid) as { user_id: string } | undefined;
    expect(r.statusCode).toBe(302);
    expect(owner?.user_id).not.toBe('u1');
    await h.close();
  });
  it('replaces a pre-login session id on login (no fixation)', async () => {
    const h = await makeHarness();
    h.db.prepare("INSERT INTO users (id,email,name,created_at) VALUES ('pre','pre@example.com','P','2020-01-01')").run();
    h.db.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES ('planted','pre',?)").run(new Date(Date.now() + 1e9).toISOString());
    const r = await callback(h, 'rs_session=planted');
    const sid = cookieOf(r.headers['set-cookie'], 'rs_session');
    expect(sid).toBeTruthy();
    expect(sid).not.toBe('planted');
    expect(h.db.prepare("SELECT 1 FROM sessions WHERE id = 'planted'").get()).toBeUndefined();
    await h.close();
  });
});

describe('secret rotation (L8)', () => {
  it('marks the account reauth_required instead of failing forever', async () => {
    const h = await makeHarness();
    h.db.prepare("INSERT INTO users (id,email,name,created_at) VALUES ('u','u@example.com','U','2020-01-01')").run();
    const other = 'a-different-secret-a-different-secret';
    h.db.prepare("INSERT INTO google_accounts (user_id,google_sub,email,access_token_enc,refresh_token_enc,expires_at) VALUES ('u','s','u@example.com',?,?,?)")
      .run(encryptToken('at', other), encryptToken('rt', other), Date.now() + 3_600_000);
    await expect(getAccessToken(h.google.ctx, 'u')).rejects.toThrow();
    expect((h.db.prepare("SELECT status FROM google_accounts WHERE user_id='u'").get() as { status: string }).status).toBe('reauth_required');
    await h.close();
  });
});
