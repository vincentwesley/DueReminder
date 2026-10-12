import { afterEach, describe, expect, it, vi } from 'vitest';
import { cookieOf } from './google-helpers';
import { freshDb, makeTestApp } from './harness';

afterEach(() => { vi.useRealTimers(); });

describe('recurring reminders over the API', () => {
  const H = { 'x-requested-with': 'fetch' };

  it('completes a recurring reminder by advancing it, and one-off by finishing it', async () => {
    const app = makeTestApp(await freshDb(), {});
    const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    expect(login.statusCode).toBe(200);
    const cookie = `rs_session=${cookieOf(login.headers['set-cookie'], 'rs_session')}`;
    const headers = { ...H, cookie };

    const due = new Date(Date.now() + 3_600_000);
    due.setUTCMilliseconds(0);
    const rec = (await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: 'r', dueAt: due.toISOString(), rrule: 'FREQ=DAILY', timezone: 'UTC' } })).json();
    const c = (await app.inject({ method: 'POST', url: `/api/reminders/${rec.id}/complete`, headers })).json();
    expect(c).toMatchObject({ status: 'open', dueAt: new Date(due.getTime() + 86_400_000).toISOString(), completedAt: null, version: 2 });

    const one = (await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: 'o' } })).json();
    const d = (await app.inject({ method: 'POST', url: `/api/reminders/${one.id}/complete`, headers })).json();
    expect(d.status).toBe('done');
    expect(d.completedAt).toBeTruthy();

    const stale = await app.inject({ method: 'PATCH', url: `/api/reminders/${one.id}`, headers, payload: { title: 'x', version: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('conflict');

    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/reminders', headers: { cookie }, payload: { title: 'x' } })).statusCode).toBe(403);
  });

  it('completing an overdue recurring reminder lands after now at the same wall time', async () => {
    // Freeze only Date so the server's "now" equals the test's "now" (no wall-clock drift/boundary races).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-10T12:00:00.000Z') });
    const app = makeTestApp(await freshDb(), {});
    const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const headers = { ...H, cookie: `rs_session=${cookieOf(login.headers['set-cookie'], 'rs_session')}` };
    const due = new Date(Date.now() - 50 * 86_400_000);
    due.setUTCHours(9, 0, 0, 0);
    const rec = (await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: 'late', dueAt: due.toISOString(), rrule: 'FREQ=DAILY', timezone: 'UTC' } })).json();
    const c = (await app.inject({ method: 'POST', url: `/api/reminders/${rec.id}/complete`, headers })).json();
    expect(Date.parse(c.dueAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(c.dueAt)).toBeLessThanOrEqual(Date.now() + 86_400_000);
    expect(c.dueAt).toContain('T09:00:00');
    expect(c.status).toBe('open');
  });
});
