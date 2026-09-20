import rrulePkg from 'rrule';
import { fromFloating, toFloating, wallOf } from './tz.js';

const { RRule } = rrulePkg;

/** Strips an optional "RRULE:" prefix and validates; throws on invalid input. */
export function normalizeRrule(input: string): string {
  const s = input.trim().replace(/^RRULE:/i, '');
  const opts = RRule.parseString(s);
  if (opts.freq === undefined) throw new Error('RRULE requires FREQ');
  // Google Calendar rejects sub-daily rules, and the reminder UI has no use for them.
  if (opts.freq === RRule.SECONDLY || opts.freq === RRule.MINUTELY || opts.freq === RRule.HOURLY) {
    throw new Error('FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY');
  }
  return s;
}

export function isValidRrule(input: string): boolean {
  try { normalizeRrule(input); return true; } catch { return false; }
}

export interface NextOccurrence { dueAt: string; rrule: string }

const pad = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock time "HH:MM:SS" of an instant in `tz`. */
export function wallClock(tz: string, iso: string): string {
  const w = wallOf(tz, Date.parse(iso));
  return `${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
}

export interface NextOptions {
  /** Local wall-clock time "HH:MM:SS" the series is anchored to (survives a DST gap that shifted the stored due time). */
  anchor?: string;
  /** When set, skip occurrences that are not after this instant (ms), so completing an overdue item lands in the future. */
  now?: number;
}

/**
 * Next occurrence strictly after `dueAt` (and after `opts.now`), computed in wall-clock time of `tz`
 * so a daily 9am reminder stays 9am across DST. Returns null when the series is exhausted.
 * COUNT is reduced in the returned rule by every occurrence consumed (the completed one plus any skipped),
 * because the series restarts from the new dueAt.
 */
export function nextOccurrence(rruleStr: string, dueAt: string, tz: string, options: NextOptions = {}): NextOccurrence | null {
  const rule = rruleStr.replace(/^RRULE:/i, '');
  const opts = RRule.parseString(rule);
  if (opts.count != null && opts.count <= 1) return null;
  const w = wallOf(tz, Date.parse(dueAt));
  const m = options.anchor ? /^(\d{2}):(\d{2}):(\d{2})$/.exec(options.anchor) : null;
  const startFloat = new Date(Date.UTC(w.y, w.mo - 1, w.d, m ? +m[1]! : w.h, m ? +m[2]! : w.mi, m ? +m[3]! : w.s));
  // UNTIL is a UTC instant but the series is computed in floating local time.
  if (opts.until) opts.until = new Date(toFloating(tz, opts.until.getTime()));
  const r = new RRule({ ...opts, dtstart: startFloat });
  const threshold = options.now != null ? new Date(Math.max(startFloat.getTime(), toFloating(tz, options.now))) : startFloat;
  const next = r.after(threshold, false);
  if (!next) return null;
  let newRule = rule;
  if (opts.count != null) {
    const consumed = 1 + r.between(startFloat, next, false).length;
    if (consumed >= opts.count) return null;
    newRule = rule.replace(/COUNT=\d+/i, `COUNT=${opts.count - consumed}`);
  }
  return { dueAt: new Date(fromFloating(tz, next.getTime())).toISOString(), rrule: newRule };
}
