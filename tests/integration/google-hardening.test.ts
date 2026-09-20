import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueSync } from '../../server/src/google/outbox';
import { addReminder, auth, loginViaMock, makeHarness, reminder, type Harness } from './google-helpers';

let h: Harness;
let userId: string;
let cookie: string;
let n = 0;

beforeAll(async () => { h = await makeHarness(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await h.mockCtl('/__mock/reset');
  h.net.offline = false;
  h.db.prepare('DELETE FROM outbox').run();
  h.db.prepare('DELETE FROM reminders').run();
  ({ userId, cookie } = await loginViaMock(h, `hard${++n}@example.com`));
});

const events = async () => ((await h.mockState()).calendars.primary ?? []) as any[];
const push = async (id: string) => { enqueueSync(h.db, userId, id, 'upsert'); return h.google.runSync(userId); };

describe('sync hardening', () => {
  it('a Google event marked Free does not complete the reminder (M7)', async () => {
    const id = addReminder(h.db, userId, { updated_at: '2020-01-01T00:00:00.000Z' });
    await push(id);
    const evId = reminder(h.db, id).google_event_id;
    await h.mockCtl('/__mock/events', { id: evId, event: { transparency: 'transparent' }, updated: new Date().toISOString() });
    await h.google.runSync(userId);
    expect(reminder(h.db, id).status).toBe('open');
  });

  it('remote text is clamped to the API limits (L5)', async () => {
    const id = addReminder(h.db, userId, { updated_at: '2020-01-01T00:00:00.000Z' });
    await push(id);
    const evId = reminder(h.db, id).google_event_id;
    await h.mockCtl('/__mock/events', { id: evId, event: { summary: 'x'.repeat(900), description: 'n'.repeat(30_000) }, updated: new Date().toISOString() });
    await h.google.runSync(userId);
    const r = reminder(h.db, id);
    expect(r.title).toHaveLength(500);
    expect(r.notes).toHaveLength(20_000);
  });

  it('a push that exhausts its retries stays failed and visible, then recovers via Sync now (M8)', async () => {
    const id = addReminder(h.db, userId, { title: 'Will fail' });
    await h.mockCtl('/__mock/config', { failNext: { status: 503, count: 100 } });
    enqueueSync(h.db, userId, id, 'upsert');
    let st = await h.google.runSync(userId);
    for (let i = 0; i < 12; i++) {
      h.db.prepare('UPDATE outbox SET next_attempt_at = 0').run();
      st = await h.google.runSync(userId);
    }
    const row = h.db.prepare('SELECT * FROM outbox').get() as any;
    expect(row).toBeTruthy();
    expect(row.failed).toBe(1);
    expect(st).toMatchObject({ status: 'error', pendingOps: 0, failedOps: 1 });
    expect(st.lastError).toMatch(/could not be pushed/);
    // a later cycle neither drops the row nor clears the message
    st = await h.google.runSync(userId);
    expect(st.failedOps).toBe(1);
    expect(st.lastError).toMatch(/could not be pushed/);
    expect(await events()).toHaveLength(0);

    await h.mockCtl('/__mock/config', { failNext: null });
    const res = await h.app.inject({ method: 'POST', url: '/api/sync/run', headers: auth(cookie) });
    expect(res.json()).toMatchObject({ status: 'idle', pendingOps: 0, failedOps: 0, lastError: null });
    expect(await events()).toHaveLength(1);
  });

  it('a permanent Google rejection is flagged failed, not silently dropped (M8)', async () => {
    const id = addReminder(h.db, userId);
    await h.mockCtl('/__mock/config', { failNext: { status: 400, count: 1 } });
    const st = await push(id);
    expect(st).toMatchObject({ status: 'error', failedOps: 1 });
  });

  it('editing a failed reminder re-queues it (M8)', async () => {
    const id = addReminder(h.db, userId);
    await h.mockCtl('/__mock/config', { failNext: { status: 400, count: 1 } });
    await push(id);
    const st = await push(id);
    expect(st).toMatchObject({ status: 'idle', failedOps: 0, pendingOps: 0 });
    expect(await events()).toHaveLength(1);
  });
});
