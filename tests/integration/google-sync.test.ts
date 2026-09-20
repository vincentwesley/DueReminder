import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backoffDelayMs } from '../../server/src/google/backoff';
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
  ({ userId, cookie } = await loginViaMock(h, `sync${++n}@example.com`));
});

const events = async () => ((await h.mockState()).calendars.primary ?? []) as any[];
const push = async (id: string, op: 'upsert' | 'delete' = 'upsert') => { enqueueSync(h.db, userId, id, op); return h.google.runSync(userId); };

describe('two-way calendar sync against mock', () => {
  it('pushes create, update and delete', async () => {
    const id = addReminder(h.db, userId, { title: 'Pay rent', notes: 'via bank' });
    const st = await push(id);
    expect(st).toMatchObject({ status: 'idle', pendingOps: 0 });
    const r = reminder(h.db, id);
    expect(r.google_event_id).toBeTruthy();
    expect(r.google_etag).toBeTruthy();
    let evs = await events();
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ summary: 'Pay rent', description: 'via bank', extendedProperties: { private: { reminderId: id } } });
    expect(new Date(evs[0].end.dateTime).getTime() - new Date(evs[0].start.dateTime).getTime()).toBe(15 * 60_000);

    h.db.prepare("UPDATE reminders SET title = 'Pay rent NOW', status='done', updated_at = ?, version = version+1 WHERE id = ?").run(new Date().toISOString(), id);
    await push(id);
    evs = await events();
    expect(evs).toHaveLength(1);
    expect(evs[0].summary).toBe('✓ Pay rent NOW');
    expect(evs[0].transparency).toBe('transparent');

    h.db.prepare('UPDATE reminders SET deleted_at = ?, updated_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), id);
    await push(id, 'delete');
    evs = await events();
    expect(evs[0].status).toBe('cancelled');
    expect(reminder(h.db, id).google_event_id).toBeNull();
  });

  it('maps all-day and recurring reminders', async () => {
    const id = addReminder(h.db, userId, { title: 'Birthday', all_day: 1, due_at: '2030-05-01T00:00:00.000Z', rrule: 'FREQ=YEARLY' });
    await push(id);
    const [ev] = await events();
    expect(ev.start).toEqual({ date: '2030-05-01' });
    expect(ev.end).toEqual({ date: '2030-05-02' });
    expect(ev.recurrence).toEqual(['RRULE:FREQ=YEARLY']);
  });

  it('turning calendarSync off deletes the remote event', async () => {
    const id = addReminder(h.db, userId);
    await push(id);
    h.db.prepare('UPDATE reminders SET calendar_sync = 0 WHERE id = ?').run(id);
    await push(id);
    expect((await events())[0].status).toBe('cancelled');
  });

  it('pulls remote edits and deletions incrementally via syncToken', async () => {
    const id = addReminder(h.db, userId, { updated_at: '2020-01-01T00:00:00.000Z' });
    await push(id);
    const evId = reminder(h.db, id).google_event_id;
    const tok1 = (h.db.prepare('SELECT sync_token t FROM google_accounts WHERE user_id = ?').get(userId) as any).t;
    expect(tok1).toMatch(/^st-/);

    await h.mockCtl('/__mock/events', { id: evId, event: { summary: 'Edited in Google', start: { dateTime: '2031-01-01T10:00:00.000Z', timeZone: 'UTC' }, end: { dateTime: '2031-01-01T10:15:00.000Z', timeZone: 'UTC' } } });
    const st = await h.google.runSync(userId);
    expect(st.status).toBe('idle');
    let r = reminder(h.db, id);
    expect(r.title).toBe('Edited in Google');
    expect(r.due_at).toBe('2031-01-01T10:00:00.000Z');
    expect(r.version).toBe(2);
    expect(r.google_etag).toBeTruthy();

    // nothing changed: incremental pull applies nothing (etag echo skip)
    await h.google.runSync(userId);
    expect(reminder(h.db, id).version).toBe(2);
    const reqs = ((await h.mockState()).requests as any[]).filter((q) => q.url.includes('syncToken'));
    expect(reqs.length).toBeGreaterThan(0);

    await h.mockCtl('/__mock/events', { id: evId, delete: true });
    await h.google.runSync(userId);
    r = reminder(h.db, id);
    expect(r.deleted_at).toBeTruthy();
  });

  it('ignores events without our reminderId', async () => {
    await h.mockCtl('/__mock/events', { event: { summary: 'Foreign', start: { dateTime: '2031-01-01T10:00:00.000Z' }, end: { dateTime: '2031-01-01T11:00:00.000Z' } } });
    await h.google.runSync(userId);
    expect(h.db.prepare('SELECT COUNT(*) n FROM reminders').get()).toEqual({ n: 0 });
  });

  it('recovers from 410 (stale sync token) with a full resync', async () => {
    const id = addReminder(h.db, userId, { updated_at: '2020-01-01T00:00:00.000Z' });
    await push(id);
    const evId = reminder(h.db, id).google_event_id;
    await h.mockCtl('/__mock/events', { id: evId, event: { summary: 'After 410' } });
    await h.mockCtl('/__mock/config', { expireSyncToken: true });
    // first attempt with the stale token 410s; the engine drops the token and does a full list. The mock keeps
    // rejecting *sync tokens* only, so the full list succeeds.
    const st = await h.google.runSync(userId);
    expect(st.status).toBe('idle');
    expect(reminder(h.db, id).title).toBe('After 410');
    const listCalls = ((await h.mockState()).requests as any[]).filter((q) => q.url.includes('/events?'));
    expect(listCalls.some((q) => q.url.includes('syncToken'))).toBe(true);
    expect(listCalls.some((q) => q.url.includes('timeMin'))).toBe(true);
  });

  it('last-writer-wins: newer remote overrides a pending local edit and counts a conflict', async () => {
    const id = addReminder(h.db, userId, { title: 'Original', updated_at: '2020-01-01T00:00:00.000Z' });
    await push(id);
    const evId = reminder(h.db, id).google_event_id;
    // local edit at t=now-2h (pending, not yet pushed); remote edit at t=now
    h.db.prepare("UPDATE reminders SET title='Local edit', updated_at=? WHERE id=?").run(new Date(Date.now() - 2 * 3600_000).toISOString(), id);
    enqueueSync(h.db, userId, id, 'upsert');
    await h.mockCtl('/__mock/events', { id: evId, event: { summary: 'Remote edit' }, updated: new Date().toISOString() });
    const st = await h.google.runSync(userId);
    expect(reminder(h.db, id).title).toBe('Remote edit');
    expect(st.conflictsResolved).toBe(1);
    expect(st.pendingOps).toBe(0);
  });

  it('last-writer-wins: newer local edit overwrites remote', async () => {
    const id = addReminder(h.db, userId, { title: 'Original', updated_at: '2020-01-01T00:00:00.000Z' });
    await push(id);
    const evId = reminder(h.db, id).google_event_id;
    await h.mockCtl('/__mock/events', { id: evId, event: { summary: 'Remote edit' }, updated: new Date(Date.now() - 2 * 3600_000).toISOString() });
    h.db.prepare("UPDATE reminders SET title='Local wins', updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    enqueueSync(h.db, userId, id, 'upsert');
    const st = await h.google.runSync(userId);
    expect(reminder(h.db, id).title).toBe('Local wins');
    expect((await events())[0].summary).toBe('Local wins');
    expect(st.pendingOps).toBe(0);
    expect(st.conflictsResolved).toBeGreaterThanOrEqual(1);
  });

  it('412 on stale etag refetches and resolves by LWW', async () => {
    const id = addReminder(h.db, userId, { title: 'Original', updated_at: '2020-01-01T00:00:00.000Z' });
    await push(id);
    const evId = reminder(h.db, id).google_event_id;
    // remote changes without us pulling; then local newer edit pushes with a stale etag
    await h.mockCtl('/__mock/events', { id: evId, event: { summary: 'Remote edit' }, updated: new Date(Date.now() - 3600_000).toISOString() });
    h.db.prepare("UPDATE reminders SET title='Local newer', updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    const st = await push(id);
    expect(st.pendingOps).toBe(0);
    expect((await events())[0].summary).toBe('Local newer');
    expect(st.conflictsResolved).toBeGreaterThanOrEqual(1);
  });

  it('done wins: remote completion is kept even if local edit is newer', async () => {
    const id = addReminder(h.db, userId, { updated_at: '2020-01-01T00:00:00.000Z' });
    await push(id);
    const evId = reminder(h.db, id).google_event_id;
    await h.mockCtl('/__mock/events', { id: evId, event: { summary: '✓ Pay rent' }, updated: new Date(Date.now() - 3600_000).toISOString() });
    h.db.prepare("UPDATE reminders SET title='Renamed locally', updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    await push(id);
    const r = reminder(h.db, id);
    expect(r.title).toBe('Renamed locally');
    expect(r.status).toBe('done');
  });

  it('429 backs off, keeps the op queued, then retries successfully', async () => {
    const id = addReminder(h.db, userId);
    await h.mockCtl('/__mock/config', { failNext: { status: 429, count: 1, retryAfterSec: 30 } });
    const st = await push(id);
    expect(st.status).toBe('error');
    expect(st.pendingOps).toBe(1);
    const row = h.db.prepare('SELECT * FROM outbox').get() as any;
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBeGreaterThan(Date.now() + 25_000); // Retry-After honoured

    // not due yet -> nothing pushed
    await h.google.runSync(userId);
    expect(await events()).toHaveLength(0);

    h.db.prepare('UPDATE outbox SET next_attempt_at = 0').run();
    const ok = await h.google.runSync(userId);
    expect(ok).toMatchObject({ status: 'idle', pendingOps: 0 });
    expect(await events()).toHaveLength(1);
  });

  it('5xx is retried with backoff too', async () => {
    const id = addReminder(h.db, userId);
    await h.mockCtl('/__mock/config', { failNext: { status: 503, count: 1 } });
    const st = await push(id);
    expect(st.pendingOps).toBe(1);
    h.db.prepare('UPDATE outbox SET next_attempt_at = 0').run();
    expect((await h.google.runSync(userId)).pendingOps).toBe(0);
  });

  it('offline: queue is retained and replayed when connectivity returns', async () => {
    const id = addReminder(h.db, userId);
    h.net.offline = true;
    const st = await push(id);
    expect(st.status).toBe('offline');
    expect(st.pendingOps).toBe(1);
    expect(await events()).toHaveLength(0);
    h.net.offline = false;
    const ok = await h.google.runSync(userId);
    expect(ok).toMatchObject({ status: 'idle', pendingOps: 0 });
    expect(await events()).toHaveLength(1);
  });

  it('401 transparently refreshes; persistent 401 -> reauth_required', async () => {
    const id = addReminder(h.db, userId);
    await h.mockCtl('/__mock/expire-access'); // server forgets the access token; local expiry still in future
    expect(await push(id)).toMatchObject({ status: 'idle', pendingOps: 0 });
    expect(await events()).toHaveLength(1);

    const id2 = addReminder(h.db, userId, { title: 'second' });
    await h.mockCtl('/__mock/config', { failNext: { status: 401, count: 5 } });
    const st = await push(id2);
    expect(st.status).toBe('reauth_required');
    expect(st.pendingOps).toBe(1);
  });

  it('syncs via the REST endpoints and changes calendar', async () => {
    const id = addReminder(h.db, userId);
    enqueueSync(h.db, userId, id, 'upsert');
    const run = await h.app.inject({ method: 'POST', url: '/api/sync/run', headers: auth(cookie) });
    expect(run.json()).toMatchObject({ status: 'idle', pendingOps: 0 });
    const patch = await h.app.inject({ method: 'PATCH', url: '/api/sync/settings', headers: { ...auth(cookie), 'content-type': 'application/json' }, payload: { calendarId: 'work' } });
    expect(patch.json()).toMatchObject({ calendarId: 'work', pendingOps: 1 });
    await h.google.runSync(userId);
    expect(((await h.mockState()).calendars.work as any[]).length).toBe(1);
  });
});

describe('backoff', () => {
  it('grows exponentially with full jitter, capped, honouring Retry-After', () => {
    expect(backoffDelayMs(1, { random: () => 0.999 })).toBeLessThan(1000);
    expect(backoffDelayMs(4, { random: () => 0.999 })).toBeLessThan(8000);
    expect(backoffDelayMs(4, { random: () => 0.999 })).toBeGreaterThan(4000);
    expect(backoffDelayMs(30, { random: () => 0.999 })).toBeLessThanOrEqual(300_000);
    expect(backoffDelayMs(1, { random: () => 0, retryAfterMs: 7000 })).toBe(7000);
  });
});
