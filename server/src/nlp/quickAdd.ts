import * as chrono from 'chrono-node';
import type { Priority, QuickAddParse } from '../../../shared/types.js';
import { isValidTz, startOfDay, wallOf, wallToInstant } from '../services/tz.js';

const DAYS: Record<string, string> = {
  mon: 'MO', monday: 'MO', tue: 'TU', tues: 'TU', tuesday: 'TU', wed: 'WE', weds: 'WE', wednesday: 'WE',
  thu: 'TH', thur: 'TH', thurs: 'TH', thursday: 'TH', fri: 'FR', friday: 'FR', sat: 'SA', saturday: 'SA', sun: 'SU', sunday: 'SU',
};
const dayAlt = Object.keys(DAYS).sort((a, b) => b.length - a.length).join('|');
const UNIT: Record<string, string> = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };

/** hint = text handed to the date parser in place of the recurrence phrase (e.g. the weekday name). */
interface Recur { rrule: string; hint: string }

function extractRecurrence(s: string): { text: string; rec: Recur | null } {
  const rules: Array<[RegExp, (m: RegExpMatchArray) => Recur]> = [
    [/\bevery\s+(\d+)\s+(day|week|month|year)s?\b/i, (m) => ({ rrule: `FREQ=${UNIT[m[2]!.toLowerCase()]};INTERVAL=${m[1]}`, hint: '' })],
    [/\b(?:every\s+weekday|weekdays)\b/i, () => ({ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', hint: '' })],
    [new RegExp(`\\bevery\\s+(${dayAlt})\\b`, 'i'), (m) => ({ rrule: `FREQ=WEEKLY;BYDAY=${DAYS[m[1]!.toLowerCase()]}`, hint: m[1]! })],
    [/\b(?:every\s+day|daily)\b/i, () => ({ rrule: 'FREQ=DAILY', hint: '' })],
    [/\b(?:every\s+week|weekly)\b/i, () => ({ rrule: 'FREQ=WEEKLY', hint: '' })],
    [/\b(?:every\s+month|monthly)\b/i, () => ({ rrule: 'FREQ=MONTHLY', hint: '' })],
    [/\b(?:every\s+year|yearly|annually)\b/i, () => ({ rrule: 'FREQ=YEARLY', hint: '' })],
  ];
  for (const [re, mk] of rules) {
    const m = s.match(re);
    if (m) {
      const rec = mk(m);
      return { text: s.replace(re, ` ${rec.hint} `), rec };
    }
  }
  return { text: s, rec: null };
}

export interface QuickAddOptions { now?: Date; timezone?: string }

export function parseQuickAdd(input: string, opts: QuickAddOptions = {}): QuickAddParse {
  const now = opts.now ?? new Date();
  const tz = opts.timezone && isValidTz(opts.timezone) ? opts.timezone : 'UTC';
  let s = ` ${input} `;

  let priority: Priority = 0;
  s = s.replace(/(\s)!(1|2|3|high|medium|med|low)(?=\s)/i, (_m, sp: string, p: string) => {
    const k = p.toLowerCase();
    priority = (k === '3' || k === 'high' ? 3 : k === '2' || k === 'med' || k === 'medium' ? 2 : 1) as Priority;
    return sp;
  });
  const tags: string[] = [];
  s = s.replace(/(\s)#([\w-]+)(?=\s|[.,;!?]|$)/g, (_m, sp: string, t: string) => {
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
    return sp;
  });
  let listName: string | null = null;
  s = s.replace(/(\s)@([\w-]+)(?=\s|[.,;!?]|$)/, (_m, sp: string, l: string) => {
    listName = l;
    return sp;
  });

  const { text: afterRec, rec } = extractRecurrence(s);
  s = afterRec;

  // chrono reads the reference as process-local wall time, so hand it the wall clock of `tz`.
  const w = wallOf(tz, now.getTime());
  const ref = new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const hit = chrono.parse(s, ref, { forwardDate: true })[0] ?? null;

  let dueAt: string | null = null;
  let allDay = false;
  if (hit) {
    const st = hit.start;
    const timed = st.isCertain('hour');
    const ms = wallToInstant(
      tz, st.get('year')!, st.get('month')!, st.get('day')!,
      timed ? st.get('hour')! : 0, timed ? (st.get('minute') ?? 0) : 0, 0,
    );
    dueAt = new Date(ms).toISOString();
    allDay = !timed;
    s = s.slice(0, hit.index) + ' ' + s.slice(hit.index + hit.text.length);
  } else if (rec) {
    dueAt = new Date(startOfDay(tz, now.getTime())).toISOString();
    allDay = true;
  }

  let title = s.replace(/\s+/g, ' ').trim().replace(/\s+(?:at|on|by|for|from|until|due)$/i, '').trim();
  if (!title) title = input.replace(/\s+/g, ' ').trim();
  return { title, dueAt, allDay, rrule: rec?.rrule ?? null, priority, tags, listName };
}
