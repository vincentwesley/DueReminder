import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, one } from '../../server/src/db/index';
import { runScheduled, SYNC_BATCH } from '../../server/src/worker';
import { addReminder, auth, loginViaMock, makeHarness, type Harness } from './google-helpers';
import { testEnv } from './harness';

let h: Harness;
beforeAll(async () => { h = await makeHarness({ env: { AUTO_SYNC: '1' } }); });
afterAll(async () => { await h.close(); });

const events = async () => ((await h.mockState()).calendars.primary ?? []) as any[];

describe('background sync without a long-lived server', () => {
  it('a local write kicks a sync through waitUntil (no debounce timer)', async () => {
    const { cookie, userId } = await loginViaMock(h, 'kick@example.com');
    await h.app.settle(); // the login itself kicks a first sync
    const res = await h.app.inject({
      method: 'POST', url: '/api/reminders', headers: { ...auth(cookie), 'content-type': 'application/json' },
      payload: { title: 'Kicked', dueAt: new Date(Date.now() + 3_600_000).toISOString(), calendarSync: true, timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(201);
    await h.app.settle();
    expect((await events()).map((e) => e.summary)).toContain('Kicked');
    expect((await one<{ n: number }>(h.db, 'SELECT COUNT(*) n FROM outbox WHERE user_id = ?', userId))!.n).toBe(0);
  });

  it('the cron syncs users that have a live session, and skips users without one', async () => {
    const live = await loginViaMock(h, 'cron-live@example.com');
    const idle = await loginViaMock(h, 'cron-idle@example.com');
    await h.app.settle();
    await exec(h.db, 'DELETE FROM sessions WHERE user_id = ?', idle.userId);
    const a = await addReminder(h.db, live.userId, { title: 'Cron live' });
    const b = await addReminder(h.db, idle.userId, { title: 'Cron idle' });
    await exec(h.db, 'DELETE FROM outbox');
    await exec(h.db, 'INSERT INTO outbox (user_id, reminder_id, op, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, 0, 0, ?)', live.userId, a, 'upsert', new Date().toISOString());
    await exec(h.db, 'INSERT INTO outbox (user_id, reminder_id, op, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, 0, 0, ?)', idle.userId, b, 'upsert', new Date().toISOString());
    await runScheduled(testEnv(h.db, { GOOGLE_AUTH_BASE: h.mock.url, GOOGLE_API_BASE: h.mock.url }));
    const titles = (await events()).map((e) => e.summary);
    expect(titles).toContain('Cron live');
    expect(titles).not.toContain('Cron idle');
    expect(SYNC_BATCH).toBeGreaterThan(0);
  });
});
