import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, one } from '../../server/src/db/index';
import { enqueueSync } from '../../server/src/google/outbox';
import { addReminder, auth, connectCalendarViaMock, followOAuth, loginViaMock, makeHarness, signInViaMock, type Harness } from './google-helpers';

let h: Harness;
beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });

const calendarRows = (userId: string) => one<{ n: number }>(h.db, 'SELECT COUNT(*) n FROM google_accounts WHERE user_id = ?', userId);
const json = { 'content-type': 'application/json' };
const del = (cookie: string, body: unknown) => h.app.inject({ method: 'DELETE', url: '/api/account', headers: { ...auth(cookie), ...json }, payload: JSON.stringify(body) });

describe('two-step OAuth', () => {
  it('sign-in creates the user but stores no Google tokens; the calendar step adds them', async () => {
    const { cookie, userId } = await signInViaMock(h, 'two-step@example.com');
    expect(await calendarRows(userId)).toEqual({ n: 0 });
    const st = await h.app.inject({ method: 'GET', url: '/api/sync/state', headers: auth(cookie) });
    expect(st.json()).toMatchObject({ connected: false, status: 'disconnected' });

    const start = await h.app.inject({ method: 'GET', url: '/api/auth/google/calendar', headers: { cookie } });
    expect(start.statusCode).toBe(302);
    const loc = new URL(String(start.headers.location));
    expect(loc.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events');
    expect(loc.searchParams.get('include_granted_scopes')).toBe('true');
    expect(loc.searchParams.get('access_type')).toBe('offline');
    expect(loc.searchParams.get('prompt')).toBe('consent');
    const { res } = await followOAuth(h, start, cookie);
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain('calendar=connected');
    expect(await calendarRows(userId)).toEqual({ n: 1 });
    const row = (await one<any>(h.db, 'SELECT scope, refresh_token_enc FROM google_accounts WHERE user_id = ?', userId))!;
    expect(row.scope).toContain('calendar.events');
    expect(row.scope).toContain('openid'); // include_granted_scopes
    expect(row.refresh_token_enc).toMatch(/^v2:/);
    const after = await h.app.inject({ method: 'GET', url: '/api/sync/state', headers: auth(cookie) });
    expect(after.json()).toMatchObject({ connected: true, googleEmail: 'two-step@example.com', status: 'idle' });
  });

  it('calendar route needs a signed-in user', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/google/calendar' })).statusCode).toBe(401);
  });

  it('user denying the calendar scope stays signed in, with a message code and no tokens', async () => {
    const { cookie, userId } = await signInViaMock(h, 'deny@example.com');
    await h.mockCtl('/__mock/config', { consentNext: 'deny' });
    const { res } = await connectCalendarViaMock(h, cookie);
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain('calendar_error=access_denied');
    expect(await calendarRows(userId)).toEqual({ n: 0 });
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
  });

  it('granular consent without the calendar box ticked is treated as denied', async () => {
    const { cookie, userId } = await signInViaMock(h, 'partial@example.com');
    await h.mockCtl('/__mock/config', { consentNext: 'partial' });
    const { res } = await connectCalendarViaMock(h, cookie);
    expect(String(res.headers.location)).toContain('calendar_error=calendar_denied');
    expect(await calendarRows(userId)).toEqual({ n: 0 });
  });

  it('calendar callback must finish in the session that started it', async () => {
    const a = await signInViaMock(h, 'sess-a@example.com');
    const b = await signInViaMock(h, 'sess-b@example.com');
    const start = await h.app.inject({ method: 'GET', url: '/api/auth/google/calendar', headers: { cookie: a.cookie } });
    const { res } = await followOAuth(h, start, b.cookie);
    expect(res.statusCode).toBe(400);
    expect(await calendarRows(a.userId)).toEqual({ n: 0 });
    expect(await calendarRows(b.userId)).toEqual({ n: 0 });
  });

  it('the mock rejects calendar calls from a token without the calendar scope', async () => {
    const issued = await h.mockCtl('/__mock/issue-token', { email: 'x@example.com', scope: 'openid email profile' });
    const r = await fetch(h.mock.url + '/calendar/v3/calendars/primary/events', { headers: { authorization: `Bearer ${issued.access_token}` } });
    expect(r.status).toBe(403);
  });
});

describe('only app-created events are touched', () => {
  it('pull ignores events without extendedProperties.private.reminderId', async () => {
    const { userId } = await loginViaMock(h, 'foreign@example.com');
    await enqueueSync(h.db, userId, await addReminder(h.db, userId, { title: 'Mine' }), 'upsert');
    await h.google.runSync(userId);
    const span = { start: { dateTime: new Date(Date.now() + 3e6).toISOString() }, end: { dateTime: new Date(Date.now() + 4e6).toISOString() } };
    const foreign = await h.mockCtl('/__mock/events', { event: { summary: 'Dentist', ...span } });
    await h.mockCtl('/__mock/events', { event: { summary: 'Other app', ...span, extendedProperties: { private: { other: 'x' } } } });
    await h.google.runSync(userId);
    const count = async () => ((await one<any>(h.db, 'SELECT COUNT(*) n FROM reminders WHERE user_id = ? AND deleted_at IS NULL', userId)) as any).n;
    expect(await count()).toBe(1);
    // deleting the foreign event in Google must not delete anything locally
    await h.mockCtl('/__mock/events', { id: foreign.id, delete: true });
    await h.google.runSync(userId);
    expect(await count()).toBe(1);
  });
});

describe('account export and delete', () => {
  it('export contains the data and no tokens', async () => {
    const { cookie, userId } = await loginViaMock(h, 'export@example.com');
    await addReminder(h.db, userId, { title: 'Exported one' });
    const res = await h.app.inject({ method: 'GET', url: '/api/account/export', headers: auth(cookie) });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    const body = res.json();
    expect(body.reminders.map((r: any) => r.title)).toContain('Exported one');
    expect(body.user.email).toBe('export@example.com');
    expect(body.googleCalendar).toMatchObject({ connected: true });
    expect(res.body).not.toMatch(/mock-at-|mock-rt-|v2:|access_token|refresh_token|google_etag/);
  });

  it('DELETE needs CSRF, a session and the confirm body', async () => {
    const { cookie } = await loginViaMock(h, 'guard@example.com');
    expect((await h.app.inject({ method: 'DELETE', url: '/api/account' })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/account', headers: { 'x-requested-with': 'fetch' } })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/account', headers: auth(cookie) })).statusCode).toBe(400);
    expect((await del(cookie, { confirm: 'yes' })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
  });

  it('deletes every row, the Google events we created, revokes tokens and clears the cookie', async () => {
    const { cookie, userId } = await loginViaMock(h, 'gone@example.com');
    const keep = await loginViaMock(h, 'stays@example.com');
    const rid = await addReminder(h.db, userId);
    await addReminder(h.db, keep.userId);
    await exec(h.db, "INSERT INTO lists (id,user_id,name,color,is_default,created_at,updated_at) VALUES (?,?,'Inbox','#fff',1,'2020','2020')", 'l-' + userId, userId);
    await exec(h.db, "INSERT INTO subtasks (id,reminder_id,title) VALUES ('st1',?,'sub')", rid);
    await exec(h.db, "INSERT INTO tags (id,user_id,name,color) VALUES ('tg1',?,'t','#fff')", userId);
    await exec(h.db, "INSERT INTO reminder_tags (reminder_id,tag_id) VALUES (?, 'tg1')", rid);
    await exec(h.db, "INSERT INTO templates (id,user_id,name,title,created_at,updated_at) VALUES ('tp1',?,'n','t','2020','2020')", userId);
    await exec(h.db, "INSERT INTO idempotency_keys (key,user_id,response_json,created_at) VALUES ('k1',?,'{}','2020')", userId);
    await enqueueSync(h.db, userId, rid, 'upsert');
    await h.google.runSync(userId);
    const foreign = await h.mockCtl('/__mock/events', { event: { summary: 'Not ours', start: { dateTime: '2030-01-01T10:00:00Z' }, end: { dateTime: '2030-01-01T11:00:00Z' } } });
    const live = async () => ((await h.mockState()).calendars.primary as any[]).filter((e) => e.status !== 'cancelled');
    expect((await live()).some((e) => e.extendedProperties?.private?.reminderId === rid)).toBe(true);
    const before = (await h.mockState()).refreshTokens;

    const res = await del(cookie, { confirm: 'delete' });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/rs_session=;|Max-Age=0/i);

    for (const t of ['reminders', 'lists', 'tags', 'templates', 'outbox', 'idempotency_keys', 'sessions', 'google_accounts', 'oauth_states']) {
      expect(await one(h.db, `SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`, userId), t).toEqual({ n: 0 });
    }
    expect(await one(h.db, 'SELECT COUNT(*) n FROM users WHERE id = ?', userId)).toEqual({ n: 0 });
    expect(await one(h.db, 'SELECT COUNT(*) n FROM subtasks WHERE reminder_id = ?', rid)).toEqual({ n: 0 });
    expect(await one(h.db, 'SELECT COUNT(*) n FROM reminder_tags WHERE reminder_id = ?', rid)).toEqual({ n: 0 });
    const left = await live();
    expect(left.some((e) => e.extendedProperties?.private?.reminderId === rid)).toBe(false);
    expect(left.some((e) => e.id === foreign.id)).toBe(true);
    expect((await h.mockState()).refreshTokens).toBe(before - 1);
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: keep.cookie } })).statusCode).toBe(200);
    expect(await one(h.db, 'SELECT COUNT(*) n FROM reminders WHERE user_id = ?', keep.userId)).toEqual({ n: 1 });
  });

  it('still deletes locally when Google is unreachable', async () => {
    const { cookie, userId } = await loginViaMock(h, 'offline-del@example.com');
    h.net.offline = true;
    try { expect((await del(cookie, { confirm: 'delete' })).statusCode).toBe(204); } finally { h.net.offline = false; }
    expect(await one(h.db, 'SELECT COUNT(*) n FROM users WHERE id = ?', userId)).toEqual({ n: 0 });
  });
});
