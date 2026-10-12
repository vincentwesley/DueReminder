import { describe, expect, it } from 'vitest';
import { isValidRrule, nextOccurrence } from '../../server/src/services/recurrence';

describe('nextOccurrence', () => {
  it('advances a daily rule', () => {
    expect(nextOccurrence('FREQ=DAILY', '2026-09-16T09:00:00.000Z', 'UTC')).toEqual({ dueAt: '2026-09-17T09:00:00.000Z', rrule: 'FREQ=DAILY' });
  });

  it('honours BYDAY', () => {
    // Friday -> next Monday
    expect(nextOccurrence('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-09-18T09:00:00.000Z', 'UTC')?.dueAt).toBe('2026-09-21T09:00:00.000Z');
  });

  it('keeps wall-clock time across DST', () => {
    // US DST ended 2026-11-01; 9:00 EDT (13:00Z) -> 9:00 EST (14:00Z)
    expect(nextOccurrence('FREQ=DAILY', '2026-10-31T13:00:00.000Z', 'America/New_York')?.dueAt).toBe('2026-11-01T14:00:00.000Z');
  });

  it('decrements COUNT and ends the series', () => {
    expect(nextOccurrence('FREQ=DAILY;COUNT=2', '2026-09-16T09:00:00.000Z', 'UTC')?.rrule).toBe('FREQ=DAILY;COUNT=1');
    expect(nextOccurrence('FREQ=DAILY;COUNT=1', '2026-09-16T09:00:00.000Z', 'UTC')).toBeNull();
  });

  it('respects UNTIL', () => {
    expect(nextOccurrence('FREQ=DAILY;UNTIL=20260916T235959Z', '2026-09-16T09:00:00.000Z', 'UTC')).toBeNull();
  });

  it('validates rules', () => {
    expect(isValidRrule('RRULE:FREQ=WEEKLY')).toBe(true);
    expect(isValidRrule('nonsense')).toBe(false);
  });
});
