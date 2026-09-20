import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from '../../server/src/nlp/quickAdd';

const now = new Date('2026-09-16T10:00:00.000Z'); // Wednesday
const p = (s: string, tz = 'UTC') => parseQuickAdd(s, { now, timezone: tz });

describe('quick-add edge cases', () => {
  it('numeric and word priorities', () => {
    expect(p('a !1').priority).toBe(1);
    expect(p('a !2').priority).toBe(2);
    expect(p('a !med').priority).toBe(2);
    expect(p('a !low').priority).toBe(1);
    expect(p('a !HIGH').priority).toBe(3);
  });

  it('de-duplicates tags case-insensitively', () => {
    expect(p('x #Home #home #work').tags).toEqual(['Home', 'work']);
  });

  it('does not treat mid-word @ as a list marker (emails)', () => {
    const r = p('email bob@example.com');
    expect(r.listName).toBeNull();
    expect(r.title).toBe('email bob@example.com');
  });

  it('empty and whitespace-only input yields empty title without throwing', () => {
    expect(p('').title).toBe('');
    expect(p('   ').dueAt).toBeNull();
  });

  it('only markers falls back to the original text as title', () => {
    expect(p('#home').title).toBe('#home');
  });

  it('a weekday name rolls forward', () => {
    expect(p('gym monday 7am').dueAt).toBe('2026-09-21T07:00:00.000Z');
  });

  it('recurrence phrases map to RRULEs', () => {
    expect(p('standup every weekday 9am').rrule).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(p('review every 2 weeks').rrule).toBe('FREQ=WEEKLY;INTERVAL=2');
    expect(p('rent every month').rrule).toBe('FREQ=MONTHLY');
    expect(p('rent yearly').rrule).toBe('FREQ=YEARLY');
  });

  it('recurrence without a date starts today, all day', () => {
    expect(p('stretch daily')).toMatchObject({ rrule: 'FREQ=DAILY', allDay: true, dueAt: '2026-09-16T00:00:00.000Z', title: 'stretch' });
  });

  it('every <weekday> anchors to that weekday with the given time', () => {
    const r = p('team sync every friday 3pm');
    expect(r.rrule).toBe('FREQ=WEEKLY;BYDAY=FR');
    expect(r.dueAt).toBe('2026-09-18T15:00:00.000Z');
    expect(r.title).toBe('team sync');
  });

  it('invalid timezone falls back to UTC', () => {
    expect(p('x tomorrow 5pm', 'Not/AZone').dueAt).toBe('2026-09-17T17:00:00.000Z');
  });

  it('combines everything', () => {
    expect(p('pay rent tomorrow 9am !3 #bills @Home')).toMatchObject({
      title: 'pay rent', priority: 3, tags: ['bills'], listName: 'Home', dueAt: '2026-09-17T09:00:00.000Z',
    });
  });

  it('uses the local date, not the UTC date, near midnight', () => {
    // 23:30Z on the 16th is already the 17th in Tokyo, so "tomorrow 8am" is the 18th 08:00 JST.
    const r = parseQuickAdd('x tomorrow 8am', { now: new Date('2026-09-16T23:30:00.000Z'), timezone: 'Asia/Tokyo' });
    expect(r.dueAt).toBe('2026-09-17T23:00:00.000Z');
  });
});
