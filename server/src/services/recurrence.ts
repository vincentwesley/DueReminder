import rrulePkg from 'rrule';
import { fromFloating, toFloating } from './tz.js';

const { RRule } = rrulePkg;

/** Strips an optional "RRULE:" prefix and validates; throws on invalid input. */
export function normalizeRrule(input: string): string {
  const s = input.trim().replace(/^RRULE:/i, '');
  const opts = RRule.parseString(s);
  if (opts.freq === undefined) throw new Error('RRULE requires FREQ');
  return s;
}

export function isValidRrule(input: string): boolean {
  try { normalizeRrule(input); return true; } catch { return false; }
}

export interface NextOccurrence { dueAt: string; rrule: string }

/**
 * Next occurrence strictly after `dueAt`, computed in wall-clock time of `tz`
 * so a daily 9am reminder stays 9am across DST. Returns null when the series is exhausted.
 * COUNT is decremented in the returned rule because the series restarts from the new dueAt.
 */
export function nextOccurrence(rruleStr: string, dueAt: string, tz: string): NextOccurrence | null {
  const rule = rruleStr.replace(/^RRULE:/i, '');
  const opts = RRule.parseString(rule);
  if (opts.count != null && opts.count <= 1) return null;
  const startFloat = new Date(toFloating(tz, Date.parse(dueAt)));
  const r = new RRule({ ...opts, dtstart: startFloat });
  const next = r.after(startFloat, false);
  if (!next) return null;
  const newRule = opts.count != null ? rule.replace(/COUNT=\d+/i, `COUNT=${opts.count - 1}`) : rule;
  return { dueAt: new Date(fromFloating(tz, next.getTime())).toISOString(), rrule: newRule };
}
