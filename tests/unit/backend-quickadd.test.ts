import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from '../../server/src/nlp/quickAdd';

// Wednesday 2026-09-16 10:00 UTC
const now = new Date('2026-09-16T10:00:00.000Z');

describe('parseQuickAdd', () => {
  it('parses "call mom tomorrow 5pm"', () => {
    const p = parseQuickAdd('call mom tomorrow 5pm', { now, timezone: 'UTC' });
    expect(p.title).toBe('call mom');
    expect(p.dueAt).toBe('2026-09-17T17:00:00.000Z');
    expect(p.allDay).toBe(false);
    expect(p.rrule).toBeNull();
  });

  it('respects the timezone', () => {
    const p = parseQuickAdd('call mom tomorrow 5pm', { now, timezone: 'America/New_York' });
    expect(p.dueAt).toBe('2026-09-17T21:00:00.000Z');
  });

  it('treats date-only input as all-day', () => {
    const p = parseQuickAdd('file taxes tomorrow', { now, timezone: 'UTC' });
    expect(p.allDay).toBe(true);
    expect(p.dueAt).toBe('2026-09-17T00:00:00.000Z');
    expect(p.title).toBe('file taxes');
  });

  it('extracts priority, tags and list', () => {
    const p = parseQuickAdd('pay rent !high #home #bills @Personal', { now, timezone: 'UTC' });
    expect(p).toMatchObject({ title: 'pay rent', priority: 3, tags: ['home', 'bills'], listName: 'Personal', dueAt: null });
    expect(parseQuickAdd('x !1', { now }).priority).toBe(1);
    expect(parseQuickAdd('x !med', { now }).priority).toBe(2);
  });

  it('maps "every monday 9am" to a weekly RRULE', () => {
    const p = parseQuickAdd('standup every monday 9am', { now, timezone: 'UTC' });
    expect(p.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(p.dueAt).toBe('2026-09-21T09:00:00.000Z');
    expect(p.title).toBe('standup');
  });

  it('maps daily / intervals', () => {
    expect(parseQuickAdd('vitamins daily 8am', { now, timezone: 'UTC' })).toMatchObject({ rrule: 'FREQ=DAILY', title: 'vitamins', dueAt: '2026-09-17T08:00:00.000Z' });
    expect(parseQuickAdd('water plants every 2 weeks', { now, timezone: 'UTC' }).rrule).toBe('FREQ=WEEKLY;INTERVAL=2');
    expect(parseQuickAdd('review weekly', { now }).rrule).toBe('FREQ=WEEKLY');
  });

  it('keeps plain text as the title', () => {
    const p = parseQuickAdd('buy milk', { now });
    expect(p).toMatchObject({ title: 'buy milk', dueAt: null, rrule: null, priority: 0, tags: [], listName: null });
  });
});
