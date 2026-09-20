import { describe, expect, it } from 'vitest';
import { BACKOFF_CAP_MS, MAX_ATTEMPTS, backoffDelayMs, isRetryableStatus, parseRetryAfter } from '../../server/src/google/backoff';
import { DONE_PREFIX, dateInZone, fromEvent, midnightInZoneToUtc, toEvent, type ReminderRow } from '../../server/src/google/mapping';

const row = (o: Partial<ReminderRow> = {}): ReminderRow => ({
  id: 'r1', user_id: 'u', title: 'Pay rent', notes: 'note', status: 'open', priority: 0, due_at: '2026-09-16T09:00:00.000Z', all_day: 0,
  timezone: 'UTC', rrule: null, completed_at: null, calendar_sync: 1, google_event_id: null, google_etag: null,
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null, version: 1, ...o,
});

describe('backoff', () => {
  it('doubles the jitter ceiling per attempt and caps at 5 minutes', () => {
    const top = () => 0.999999;
    expect(backoffDelayMs(1, { random: top })).toBeLessThan(1000);
    expect(backoffDelayMs(2, { random: top })).toBeLessThan(2000);
    expect(backoffDelayMs(2, { random: top })).toBeGreaterThanOrEqual(1000);
    expect(backoffDelayMs(4, { random: top })).toBeGreaterThanOrEqual(4000);
    expect(backoffDelayMs(MAX_ATTEMPTS + 10, { random: top })).toBeLessThan(BACKOFF_CAP_MS);
    expect(backoffDelayMs(MAX_ATTEMPTS + 10, { random: top })).toBeGreaterThan(BACKOFF_CAP_MS * 0.99);
  });

  it('full jitter can be zero and never exceeds the ceiling', () => {
    expect(backoffDelayMs(3, { random: () => 0 })).toBe(0);
    for (let i = 0; i < 200; i++) expect(backoffDelayMs(5)).toBeLessThan(16_000);
  });

  it('Retry-After is a lower bound', () => {
    expect(backoffDelayMs(1, { random: () => 0, retryAfterMs: 7000 })).toBe(7000);
    expect(backoffDelayMs(8, { random: () => 0.5, retryAfterMs: 1 })).toBeGreaterThan(1);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('Wed, 16 Sep 2026 10:00:10 GMT', Date.parse('2026-09-16T10:00:00Z'))).toBe(10_000);
    expect(parseRetryAfter('Wed, 16 Sep 2026 09:00:00 GMT', Date.parse('2026-09-16T10:00:00Z'))).toBe(0);
    expect(parseRetryAfter('garbage')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('classifies retryable statuses', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(403, ['rateLimitExceeded'])).toBe(true);
    expect(isRetryableStatus(403, ['forbidden'])).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(412)).toBe(false);
  });
});

describe('reminder <-> event mapping (basis of conflict resolution)', () => {
  it('timed reminder becomes a 15 minute event linked by reminderId', () => {
    const ev = toEvent(row());
    expect(ev.start?.dateTime).toBe('2026-09-16T09:00:00.000Z');
    expect(ev.end?.dateTime).toBe('2026-09-16T09:15:00.000Z');
    expect(ev.extendedProperties?.private?.reminderId).toBe('r1');
    expect(ev.transparency).toBe('opaque');
  });

  it('done reminder is prefixed and transparent, and round-trips as done', () => {
    const ev = toEvent(row({ status: 'done' }));
    expect(ev.summary).toBe(DONE_PREFIX + 'Pay rent');
    expect(ev.transparency).toBe('transparent');
    expect(fromEvent(ev, { timezone: 'UTC' })).toMatchObject({ title: 'Pay rent', done: true });
  });

  it('all-day round trip is stable across zones', () => {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
      const due = midnightInZoneToUtc('2026-09-16', tz);
      expect(dateInZone(due, tz)).toBe('2026-09-16');
      const ev = toEvent(row({ all_day: 1, due_at: due, timezone: tz }));
      expect(ev.start?.date).toBe('2026-09-16');
      expect(ev.end?.date).toBe('2026-09-17');
      const back = fromEvent(ev, { timezone: tz });
      expect(back.all_day).toBe(1);
      expect(back.due_at).toBe(due);
    }
  });

  it('recurrence round-trips and is dropped when the remote removes it', () => {
    const ev = toEvent(row({ rrule: 'FREQ=WEEKLY;BYDAY=MO' }));
    expect(ev.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    expect(fromEvent(ev, { timezone: 'UTC' }).rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(fromEvent({ ...ev, recurrence: [] }, { timezone: 'UTC' }).rrule).toBeNull();
  });

  it('remote event with a bare check mark or missing title is handled', () => {
    expect(fromEvent({ summary: '✓Buy milk', start: { dateTime: '2026-09-16T09:00:00Z' } }, { timezone: 'UTC' })).toMatchObject({ title: 'Buy milk', done: true });
    expect(fromEvent({ start: { dateTime: '2026-09-16T09:00:00Z' } }, { timezone: 'UTC' }).title).toBe('(untitled)');
  });
});
