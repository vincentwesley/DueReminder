import { describe, expect, it } from 'vitest';
import { isValidRrule, nextOccurrence, normalizeRrule } from '../../server/src/services/recurrence';

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
