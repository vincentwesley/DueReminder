// Timezone helpers built on Intl (no extra deps).
const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    cache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }

export function wallOf(tz: string, ms: number): Wall {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year!, mo: o.month!, d: o.day!, h: o.hour!, mi: o.minute!, s: o.second! };
}

export function offsetMs(tz: string, ms: number): number {
  const w = wallOf(tz, ms);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** Real instant (ms) whose wall-clock time in tz equals the given fields. */
export function wallToInstant(tz: string, y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const matches = (t: number) => toFloating(tz, t) === guess;
  const t1 = guess - offsetMs(tz, guess);
  if (matches(t1)) return t1;
  const t2 = guess - offsetMs(tz, t1);
  if (matches(t2)) return t2;
  // The wall time falls in a DST gap and does not exist: move forward (02:30 becomes 03:30), like Google Calendar.
  return Math.max(t1, t2);
}

export function startOfDay(tz: string, ms: number, plusDays = 0): number {
  const w = wallOf(tz, ms);
  return wallToInstant(tz, w.y, w.mo, w.d + plusDays);
}

/** Wall-clock fields of an instant encoded as a "floating" UTC timestamp. */
export function toFloating(tz: string, ms: number): number {
  const w = wallOf(tz, ms);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
}
export function fromFloating(tz: string, floating: number): number {
  const f = new Date(floating);
  return wallToInstant(tz, f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate(), f.getUTCHours(), f.getUTCMinutes(), f.getUTCSeconds());
}
