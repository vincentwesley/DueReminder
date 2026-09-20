import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptToken } from '../../server/src/google/crypto';
import { getAccessToken } from '../../server/src/google/tokens';
import { auth, cookieOf, loginViaMock, makeHarness, type Harness } from './google-helpers';

let h: Harness;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

describe('google OAuth (PKCE) against mock', () => {
  it('login redirects with state + S256 challenge, callback creates session and user', async () => {
    const login = await h.app.inject({ method: 'GET', url: '/api/auth/login' });
    expect(login.statusCode).toBe(302);
    const loc = new URL(String(login.headers.location));
    expect(loc.origin).toBe(h.mock.url);
    expect(loc.pathname).toBe('/o/oauth2/v2/auth');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('scope')).toContain('calendar.events');
    expect(loc.searchParams.get('scope')).not.toContain('auth/calendar ');
    expect(loc.searchParams.get('access_type')).toBe('offline');
    const state = loc.searchParams.get('state')!;
    expect(state.length).toBeGreaterThanOrEqual(43);
    const cookieHeader = ([] as string[]).concat(login.headers['set-cookie'] as string[]).join(';');
    expect(cookieHeader).toMatch(/HttpOnly/);

    const { cookie, userId } = await loginViaMock(h);
    const me = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: userId, email: 'demo@example.com' });
    expect(JSON.stringify(me.json())).not.toMatch(/token/i);

    const sync = await h.app.inject({ method: 'GET', url: '/api/sync/state', headers: auth(cookie) });
    expect(sync.json()).toMatchObject({ connected: true, googleEmail: 'demo@example.com', calendarId: 'primary', status: 'idle' });
  });

  it('stores tokens encrypted at rest', async () => {
    const row = h.db.prepare('SELECT * FROM google_accounts').get() as any;
    expect(row.access_token_enc).toMatch(/^v1:/);
    expect(row.refresh_token_enc).toMatch(/^v1:/);
    expect(row.access_token_enc).not.toContain('mock-at-');
    const plain = decryptToken(row.refresh_token_enc, 'test-secret-test-secret-test-secret-0123');
    expect(plain).toMatch(/^mock-rt-/);
    expect(() => decryptToken(row.refresh_token_enc, 'another-secret-another-secret-xx')).toThrow();
  });

  it('rejects replayed, unknown and cross-browser state', async () => {
    const login = await h.app.inject({ method: 'GET', url: '/api/auth/login' });
    const oauth = cookieOf(login.headers['set-cookie'], 'rs_oauth');
    const authRes = await fetch(String(login.headers.location), { redirect: 'manual' });
    const cb = new URL(authRes.headers.get('location')!);
    const path = cb.pathname + cb.search;
    // wrong browser (no cookie) -> rejected; state is burned either way
    const wrong = await h.app.inject({ method: 'GET', url: path });
    expect(wrong.statusCode).toBe(400);
    const replay = await h.app.inject({ method: 'GET', url: path, headers: { cookie: `rs_oauth=${oauth}` } });
    expect(replay.statusCode).toBe(400);
    const bogus = await h.app.inject({ method: 'GET', url: '/api/auth/callback?code=x&state=nope' });
    expect(bogus.statusCode).toBe(400);
  });

  it('mock enforces PKCE verification', async () => {
    const verifier = 'v'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const u = new URL(h.mock.url + '/o/oauth2/v2/auth');
    Object.entries({ client_id: 'mock-client-id', redirect_uri: 'http://x.test/cb', response_type: 'code', state: 's', code_challenge: challenge, code_challenge_method: 'S256', auto: '1' })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    const post = async (code: string, ver: string) =>
      fetch(h.mock.url + '/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: ver, redirect_uri: 'http://x.test/cb', client_id: 'mock-client-id' }).toString(),
      });
    const code1 = new URL((await fetch(u, { redirect: 'manual' })).headers.get('location')!).searchParams.get('code')!;
    const bad = await post(code1, 'w'.repeat(64));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_grant');
    const code2 = new URL((await fetch(u, { redirect: 'manual' })).headers.get('location')!).searchParams.get('code')!;
    expect((await post(code2, verifier)).status).toBe(200);
    expect((await post(code2, verifier)).status).toBe(400); // single-use code
  });

  it('refreshes an expired access token once (single-flight) and persists it', async () => {
    const { userId } = await loginViaMock(h, 'refresh@example.com');
    const before = decryptToken((h.db.prepare('SELECT access_token_enc e FROM google_accounts WHERE user_id = ?').get(userId) as any).e, 'test-secret-test-secret-test-secret-0123');
    h.db.prepare('UPDATE google_accounts SET expires_at = ? WHERE user_id = ?').run(Date.now() + 30_000, userId); // inside the 60s skew window
    const count = async () => ((await h.mockState()).requests as any[]).filter((r) => r.url === '/token').length;
    const c0 = await count();
    const toks = await Promise.all([1, 2, 3].map(() => getAccessToken(h.google.ctx, userId)));
    expect(new Set(toks).size).toBe(1);
    expect(toks[0]).not.toBe(before);
    expect((await count()) - c0).toBe(1);
    // fresh token is reused without another refresh
    expect(await getAccessToken(h.google.ctx, userId)).toBe(toks[0]);
    expect((await count()) - c0).toBe(1);
  });

  it('marks reauth_required when the grant is revoked, and stops syncing', async () => {
    const { cookie, userId } = await loginViaMock(h, 'revoked@example.com');
    await h.mockCtl('/__mock/revoke-all');
    h.db.prepare('UPDATE google_accounts SET expires_at = 0 WHERE user_id = ?').run(userId);
    const run = await h.app.inject({ method: 'POST', url: '/api/sync/run', headers: auth(cookie) });
    expect(run.json()).toMatchObject({ status: 'reauth_required', connected: true });
    expect(run.json().lastError).toMatch(/reconnect/i);
    await expect(getAccessToken(h.google.ctx, userId)).rejects.toThrow(/reconnect|authorization/i);
    // reconnecting fixes it
    const again = await loginViaMock(h, 'revoked@example.com');
    const st = await h.app.inject({ method: 'GET', url: '/api/sync/state', headers: auth(again.cookie) });
    expect(st.json().status).toBe('idle');
  });

  it('requires session and CSRF header on sync routes; logout and disconnect work', async () => {
    const { cookie, userId } = await loginViaMock(h, 'bye@example.com');
    expect((await h.app.inject({ method: 'GET', url: '/api/sync/state' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: '/api/sync/run', headers: { cookie } })).statusCode).toBe(400);
    const disc = await h.app.inject({ method: 'POST', url: '/api/sync/disconnect', headers: auth(cookie) });
    expect(disc.json()).toMatchObject({ connected: false, status: 'disconnected' });
    expect(h.db.prepare('SELECT COUNT(*) n FROM google_accounts WHERE user_id = ?').get(userId)).toEqual({ n: 0 });
    const out = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(cookie) });
    expect(out.statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});
