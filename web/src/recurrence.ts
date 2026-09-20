export type Freq = 'none' | 'daily' | 'weekly' | 'monthly' | 'custom';
export interface Recurrence { freq: Freq; interval: number; days: string[]; raw: string }

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export const WEEKDAY_NAMES: Record<string, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };

export function parseRrule(rrule: string | null): Recurrence {
  if (!rrule) return { freq: 'none', interval: 1, days: [], raw: '' };
  const parts: Record<string, string> = {};
  for (const p of rrule.replace(/^RRULE:/, '').split(';')) {
    const [k, v] = p.split('=');
    if (k && v !== undefined) parts[k] = v;
  }
  const extra = Object.keys(parts).filter((k) => !['FREQ', 'INTERVAL', 'BYDAY'].includes(k));
  const interval = Math.max(1, Number(parts.INTERVAL ?? 1) || 1);
  const days = parts.BYDAY ? parts.BYDAY.split(',') : [];
  const f = parts.FREQ;
  const simple = extra.length === 0;
  if (simple && f === 'DAILY' && days.length === 0) return { freq: 'daily', interval, days, raw: rrule };
  if (simple && f === 'WEEKLY' && days.every((d) => (WEEKDAYS as readonly string[]).includes(d))) return { freq: 'weekly', interval, days, raw: rrule };
  if (simple && f === 'MONTHLY' && days.length === 0) return { freq: 'monthly', interval, days, raw: rrule };
  return { freq: 'custom', interval, days, raw: rrule };
}

export function buildRrule(r: Recurrence): string | null {
  if (r.freq === 'none') return null;
  if (r.freq === 'custom') return r.raw.trim().replace(/^RRULE:/, '') || null;
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === 'weekly' && r.days.length) parts.push(`BYDAY=${WEEKDAYS.filter((d) => r.days.includes(d)).join(',')}`);
  return parts.join(';');
}

export function describeRrule(rrule: string | null): string {
  const r = parseRrule(rrule);
  if (r.freq === 'none') return '';
  if (r.freq === 'custom') return 'Custom repeat';
  const unit = { daily: 'day', weekly: 'week', monthly: 'month' }[r.freq];
  const base = r.interval > 1 ? `Every ${r.interval} ${unit}s` : { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[r.freq];
  if (r.freq === 'weekly' && r.days.length) return `${base} on ${r.days.map((d) => (WEEKDAY_NAMES[d] ?? d).slice(0, 3)).join(', ')}`;
  return base;
}
