import type { Reminder } from '@shared/types';

export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

/** The moment a reminder should next surface: a future snooze wins over the due date. */
export function effectiveDue(r: Reminder, now = Date.now()): Date | null {
  if (r.snoozedUntil && Date.parse(r.snoozedUntil) > now) return new Date(r.snoozedUntil);
  return r.dueAt ? new Date(r.dueAt) : null;
}

export function isOverdue(r: Reminder, now = new Date()): boolean {
  if (r.status !== 'open') return false;
  const d = effectiveDue(r, now.getTime());
  if (!d) return false;
  return r.allDay ? d < startOfDay(now) : d < now;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dayYearFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const longDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

export function dayLabel(d: Date, now = new Date()): string {
  const diff = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return (d.getFullYear() === now.getFullYear() ? dayFmt : dayYearFmt).format(d);
}

export function longDay(d: Date) {
  return longDayFmt.format(d);
}

export function formatDue(iso: string | null, allDay: boolean, now = new Date()): string {
  if (!iso) return 'No date';
  const d = new Date(iso);
  return allDay ? dayLabel(d, now) : `${dayLabel(d, now)}, ${timeFmt.format(d)}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** ISO -> value for <input type="datetime-local"> or <input type="date">. */
export function toInputValue(iso: string | null, allDay: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  const day = dayKey(d);
  return allDay ? day : `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromInputValue(v: string, allDay: boolean): string | null {
  if (!v) return null;
  const d = allDay ? new Date(`${v}T00:00:00`) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
