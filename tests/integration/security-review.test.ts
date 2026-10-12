import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, one } from '../../server/src/db/index';
import { loadConfig } from '../../server/src/config';
import { enqueueSync } from '../../server/src/google/outbox';
import { MAX_PULL_PAGES, MAX_PUSH_ROWS } from '../../server/src/google/sync';
import { addReminder, auth, connectCalendarViaMock, followOAuth, loginViaMock, makeHarness, signInViaMock, type Harness } from './google-helpers';

let h: Harness;
let strip = false; // when set, token responses lose their id_token (L2)
beforeAll(async () => {
  const base = fetch;
  h = await makeHarness({
    fetch: (async (...a: Parameters<typeof fetch>) => {
      const res = await base(...a);
      if (!strip || !String(a[0]).endsWith('/token')) return res;
      const j = (await res.json()) as Record<string, unknown>;
      delete j.id_token;
      return new Response(JSON.stringify(j), { status: res.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
});
afterAll(async () => { await h.close(); });

const account = (uid: string) => one<any>(h.db, 'SELECT * FROM google_accounts WHERE user_id = ?', uid);
const sessionUser = async (sid: string) => (await one<{ user_id: string }>(h.db, 'SELECT user_id FROM sessions WHERE id = ?', sid))?.user_id;

describe('security review findings', () => {
  it('M1: a failed attempt is recorded in last_attempt_at (cron orders by it)', async () => {
    const a = await loginViaMock(h, 'm1a@example.com');
    await exec(h.db, "UPDATE google_accounts SET last_attempt_at = '2020-01-01' WHERE user_id = ?", a.userId);
    h.net.offline = true; // every attempt fails; last_sync_at never moves
    const st = await h.google.runSync(a.userId);
    expect(st.status).toBe("offline");
    h.net.offline = false;
    const row = await account(a.userId);
    expect(row.last_attempt_at > '2020-01-01').toBe(true);
    expect(row.last_sync_at).toBeNull();
  });

  it('M1: pull and push are capped per cycle and the leftovers carry to the next tick', async () => {
    const { userId } = await loginViaMock(h, 'm1cap@example.com');
    await h.google.runSync(userId); // settle the sync token
    const total = MAX_PULL_PAGES * 250 + 10;
    for (let i = 0; i < total; i += 50) await Promise.all(Array.from({ length: Math.min(50, total - i) }, () => h.mockCtl('/__mock/events', { event: { summary: 'x' } })));
    await h.google.runSync(userId);
    const mid = await account(userId);
    expect(mid.pull_resume).toBeTruthy(); // stopped early, cursor kept
    await h.google.runSync(userId);
    expect((await account(userId)).pull_resume).toBeNull(); // finished next tick

    for (let i = 0; i < MAX_PUSH_ROWS + 5; i++) await enqueueSync(h.db, userId, await addReminder(h.db, userId), 'upsert');
    await h.google.runSync(userId);
    const left = await one<{ n: number }>(h.db, 'SELECT COUNT(*) n FROM outbox WHERE user_id = ?', userId);
    expect(left!.n).toBe(5);
    await h.google.runSync(userId);
    expect((await one<{ n: number }>(h.db, 'SELECT COUNT(*) n FROM outbox WHERE user_id = ?', userId))!.n).toBe(0);
  }, 60_000);

  it('L1: signing in while another user is signed in does not reuse that session user', async () => {
    const a = await signInViaMock(h, 'l1a@example.com');
    const start = await h.app.inject({ method: 'GET', url: '/api/auth/login?email=l1b@example.com', headers: { cookie: a.cookie } });
    expect((await one<{ user_id: string | null }>(h.db, 'SELECT user_id FROM oauth_states ORDER BY created_at DESC LIMIT 1'))!.user_id).toBeNull();
    const { res } = await followOAuth(h, start, a.cookie);
    const sid = (([] as string[]).concat(res.headers['set-cookie'] as string[]).join(';').match(/rs_session=([^;]+)/) ?? [])[1];
    const uid = await sessionUser(decodeURIComponent(sid!));
    expect(uid).not.toBe(a.userId);
    expect((await one<{ email: string }>(h.db, 'SELECT email FROM users WHERE id = ?', uid))!.email).toBe('l1b@example.com');
  });

  it('L1: google_sub is unique', async () => {
    const { userId } = await signInViaMock(h, 'l1u@example.com');
    const other = await signInViaMock(h, 'l1v@example.com');
    const sub = (await one<{ google_sub: string }>(h.db, 'SELECT google_sub FROM users WHERE id = ?', userId))!.google_sub;
    await expect(exec(h.db, 'UPDATE users SET google_sub = ? WHERE id = ?', sub, other.userId)).rejects.toThrow(/constraint|unique/i);
  });

  it('L2: calendar step without id_token verifies via userinfo and rejects a different account', async () => {
    const s = await signInViaMock(h, 'l2@example.com');
    await exec(h.db, "UPDATE users SET google_sub = 'someone-else' WHERE id = ?", s.userId);
    strip = true;
    const { res } = await connectCalendarViaMock(h, s.cookie);
    strip = false;
    expect(String(res.headers.location)).toContain('calendar_error=account_mismatch');
    expect(await account(s.userId)).toBeUndefined();
    await exec(h.db, "UPDATE users SET google_sub = 'mock-sub-l2@example.com' WHERE id = ?", s.userId);
    strip = true;
    const ok = await connectCalendarViaMock(h, s.cookie);
    strip = false;
    expect(String(ok.res.headers.location)).toContain('calendar=connected');
  });

  it('L3: INSECURE_COOKIES is refused in production', () => {
    const env = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), INSECURE_COOKIES: '1' };
    expect(() => loadConfig(env)).toThrow(/INSECURE_COOKIES/);
  });

  it('L4: changing calendars deletes the app events on the old calendar first', async () => {
    const { userId, cookie } = await loginViaMock(h, 'l4@example.com');
    const id = await addReminder(h.db, userId);
    await enqueueSync(h.db, userId, id, 'upsert');
    await h.google.runSync(userId);
    const live = async () => (((await h.mockState()).calendars.primary ?? []) as any[]).filter((e) => e.status !== 'cancelled' && e.extendedProperties?.private?.reminderId === id);
    expect(await live()).toHaveLength(1);
    const patch = await h.app.inject({ method: 'PATCH', url: '/api/sync/settings', headers: { ...auth(cookie), 'content-type': 'application/json' }, payload: { calendarId: 'other' } });
    expect(patch.statusCode).toBe(200);
    expect(await live()).toHaveLength(0);
  });
});
