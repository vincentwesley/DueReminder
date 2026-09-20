import { describe, expect, it } from 'vitest';
import { isValidRrule, nextOccurrence, normalizeRrule, wallClock } from '../../server/src/services/recurrence';

const next = (rule: string, due: string, tz = 'UTC') => nextOccurrence(rule, due, tz);

describe('recurrence edge cases', () => {
  it('monthly on the 31st skips short months', () => {
    expect(next('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-31T09:00:00.000Z')?.dueAt).toBe('2026-03-31T09:00:00.000Z');
  });

  it('yearly on Feb 29 lands on the next leap year', () => {
    expect(next('FREQ=YEARLY', '2024-02-29T09:00:00.000Z')?.dueAt).toBe('2028-02-29T09:00:00.000Z');
  });

  it('honours INTERVAL', () => {
    expect(next('FREQ=WEEKLY;INTERVAL=2', '2026-09-16T09:00:00.000Z')?.dueAt).toBe('2026-09-30T09:00:00.000Z');
    expect(next('FREQ=DAILY;INTERVAL=3', '2026-09-16T09:00:00.000Z')?.dueAt).toBe('2026-09-19T09:00:00.000Z');
  });

  it('accepts the RRULE: prefix and keeps rule text unchanged', () => {
    expect(next('RRULE:FREQ=DAILY', '2026-09-16T09:00:00.000Z')?.dueAt).toBe('2026-09-17T09:00:00.000Z');
    expect(normalizeRrule('RRULE:FREQ=DAILY')).toBe('FREQ=DAILY');
  });

  it('UNTIL on a later date still yields the next occurrence, and stops after it', () => {
    expect(next('FREQ=DAILY;UNTIL=20260918T235959Z', '2026-09-17T09:00:00.000Z')?.dueAt).toBe('2026-09-18T09:00:00.000Z');
    expect(next('FREQ=DAILY;UNTIL=20260918T235959Z', '2026-09-18T09:00:00.000Z')).toBeNull();
  });

  it('spring-forward: a daily 02:30 local reminder does not vanish', () => {
    // US DST began 2026-03-08; 02:30 does not exist that day.
    const n = next('FREQ=DAILY', '2026-03-07T07:30:00.000Z', 'America/New_York');
    expect(n).not.toBeNull();
    const delta = Date.parse(n!.dueAt) - Date.parse('2026-03-07T07:30:00.000Z');
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(26 * 3600_000);
  });

  it('positive-offset zones keep the local wall time', () => {
    expect(next('FREQ=DAILY', '2026-09-16T00:00:00.000Z', 'Asia/Tokyo')?.dueAt).toBe('2026-09-17T00:00:00.000Z');
  });

  it('last day of month via BYMONTHDAY=-1', () => {
    expect(next('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-02-28T09:00:00.000Z')?.dueAt).toBe('2026-03-31T09:00:00.000Z');
  });

  it('successive completions walk a COUNT series to exhaustion', () => {
    let rule = 'FREQ=DAILY;COUNT=3';
    let due = '2026-09-16T09:00:00.000Z';
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const n = next(rule, due);
      if (!n) break;
      seen.push(n.dueAt);
      rule = n.rrule;
      due = n.dueAt;
    }
    expect(seen).toEqual(['2026-09-17T09:00:00.000Z', '2026-09-18T09:00:00.000Z']);
  });

  it('rejects garbage', () => {
    for (const bad of ['', 'nonsense', 'COUNT=3', 'FREQ=SOMETIMES']) expect(isValidRrule(bad), bad).toBe(false);
  });
});

describe('overdue completion (M1)', () => {
  const now = Date.parse('2026-09-20T12:00:00.000Z');
  it('advances a daily reminder 50 days overdue to the first occurrence after now', () => {
    const n = nextOccurrence('FREQ=DAILY', '2026-08-01T09:00:00.000Z', 'UTC', { now });
    expect(n?.dueAt).toBe('2026-09-21T09:00:00.000Z');
  });
  it('stays on the rule (weekly on Mondays) when skipping missed occurrences', () => {
    const n = nextOccurrence('FREQ=WEEKLY;BYDAY=MO', '2026-08-03T09:00:00.000Z', 'UTC', { now });
    expect(n?.dueAt).toBe('2026-09-21T09:00:00.000Z');
  });
  it('counts skipped occurrences against COUNT', () => {
    // 10 daily occurrences from Sep 1; on Sep 20 the 21st does not exist, so the series is exhausted
    expect(nextOccurrence('FREQ=DAILY;COUNT=10', '2026-09-01T09:00:00.000Z', 'UTC', { now })).toBeNull();
    // 30 occurrences from Sep 1: Sep 21 is the 21st, leaving 10 including itself
    expect(nextOccurrence('FREQ=DAILY;COUNT=30', '2026-09-01T09:00:00.000Z', 'UTC', { now })).toEqual({ dueAt: '2026-09-21T09:00:00.000Z', rrule: 'FREQ=DAILY;COUNT=10' });
  });
  it('is unchanged when the reminder is not overdue', () => {
    expect(nextOccurrence('FREQ=DAILY', '2026-09-25T09:00:00.000Z', 'UTC', { now })?.dueAt).toBe('2026-09-26T09:00:00.000Z');
  });
});

describe('DST gap (M2)', () => {
  const tz = 'America/New_York';
  it('moves a non-existent 02:30 forward to 03:30 EDT', () => {
    expect(nextOccurrence('FREQ=DAILY', '2026-03-07T07:30:00.000Z', tz)?.dueAt).toBe('2026-03-08T07:30:00.000Z');
  });
  it('returns to 02:30 the day after when given the wall-time anchor', () => {
    const gap = nextOccurrence('FREQ=DAILY', '2026-03-07T07:30:00.000Z', tz, { anchor: '02:30:00' })!;
    const after = nextOccurrence('FREQ=DAILY', gap.dueAt, tz, { anchor: '02:30:00' })!;
    expect(after.dueAt).toBe('2026-03-09T06:30:00.000Z'); // 02:30 EDT
  });
  it('a full walk across the gap keeps local 02:30 every day it exists', () => {
    let due = '2026-03-06T07:30:00.000Z';
    const walls: string[] = [];
    for (let i = 0; i < 5; i++) {
      due = nextOccurrence('FREQ=DAILY', due, tz, { anchor: '02:30:00' })!.dueAt;
      walls.push(wallClock(tz, due));
    }
    expect(walls).toEqual(['02:30:00', '03:30:00', '02:30:00', '02:30:00', '02:30:00']);
  });
});

describe('rule restrictions (L6)', () => {
  it('rejects sub-daily frequencies', () => {
    for (const f of ['SECONDLY', 'MINUTELY', 'HOURLY']) expect(isValidRrule(`FREQ=${f}`)).toBe(false);
    for (const f of ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']) expect(isValidRrule(`FREQ=${f}`)).toBe(true);
  });
  it('interprets UNTIL in local time so the last local occurrence is kept', () => {
    // Tokyo 09:00 on Sep 18 is 00:00Z; UNTIL 23:59:59 local Sep 18 == 14:59:59Z
    expect(nextOccurrence('FREQ=DAILY;UNTIL=20260918T145959Z', '2026-09-17T00:00:00.000Z', 'Asia/Tokyo')?.dueAt).toBe('2026-09-18T00:00:00.000Z');
    expect(nextOccurrence('FREQ=DAILY;UNTIL=20260918T145959Z', '2026-09-18T00:00:00.000Z', 'Asia/Tokyo')).toBeNull();
  });
});
