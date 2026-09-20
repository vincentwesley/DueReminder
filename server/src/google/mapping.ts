import type { GEvent } from './client';

export interface ReminderRow {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  status: 'open' | 'done';
  priority: number;
  due_at: string | null;
  all_day: number;
  timezone: string | null;
  rrule: string | null;
  completed_at: string | null;
  calendar_sync: number;
  google_event_id: string | null;
  google_etag: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

export const DONE_PREFIX = '✓ ';
const EVENT_MINUTES = 15;

function tzParts(ts: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ts))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

function safeTz(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}

/** YYYY-MM-DD of an instant in the given zone. */
export function dateInZone(iso: string, tz: string | null): string {
  const p = tzParts(Date.parse(iso), safeTz(tz));
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** UTC ISO of local midnight for YYYY-MM-DD in the given zone. */
export function midnightInZoneToUtc(date: string, tz: string | null): string {
  const zone = safeTz(tz);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const off = (ts: number) => {
    const p = tzParts(ts, zone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
  };
  let ts = guess - off(guess);
  ts = guess - off(ts);
  return new Date(ts).toISOString();
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** reminder -> Google event body (PLAN.md section 7). */
export function toEvent(r: ReminderRow): GEvent {
  const done = r.status === 'done';
  const tz = safeTz(r.timezone);
  const ev: GEvent = {
    summary: (done ? DONE_PREFIX : '') + r.title,
    description: r.notes ?? '',
    transparency: done ? 'transparent' : 'opaque',
    extendedProperties: { private: { reminderId: r.id } },
    status: 'confirmed',
  };
  const due = r.due_at as string;
  if (r.all_day) {
    const d = dateInZone(due, tz);
    ev.start = { date: d };
    ev.end = { date: addDays(d, 1) };
  } else {
    ev.start = { dateTime: new Date(due).toISOString(), timeZone: tz };
    ev.end = { dateTime: new Date(Date.parse(due) + EVENT_MINUTES * 60_000).toISOString(), timeZone: tz };
  }
  ev.recurrence = r.rrule ? [`RRULE:${r.rrule.replace(/^RRULE:/i, '')}`] : [];
  return ev;
}

export interface RemoteFields {
  title: string;
  notes: string;
  due_at: string | null;
  all_day: number;
  timezone: string;
  rrule: string | null;
  done: boolean;
}

/** Google event -> reminder fields. */
export function fromEvent(ev: GEvent, current: Pick<ReminderRow, 'timezone'>): RemoteFields {
  const summary = ev.summary ?? '';
  const doneByTitle = summary.startsWith(DONE_PREFIX) || summary.startsWith('✓');
  const title = summary.startsWith(DONE_PREFIX) ? summary.slice(DONE_PREFIX.length) : doneByTitle ? summary.slice(1).trimStart() : summary;
  const tz = ev.start?.timeZone ?? current.timezone ?? 'UTC';
  let due: string | null = null;
  let allDay = 0;
  if (ev.start?.date) {
    allDay = 1;
    due = midnightInZoneToUtc(ev.start.date, tz);
  } else if (ev.start?.dateTime) {
    due = new Date(ev.start.dateTime).toISOString();
  }
  const rr = (ev.recurrence ?? []).find((x) => /^RRULE:/i.test(x));
  return {
    title: title || '(untitled)',
    notes: ev.description ?? '',
    due_at: due,
    all_day: allDay,
    timezone: safeTz(tz),
    rrule: rr ? rr.replace(/^RRULE:/i, '') : null,
    done: doneByTitle || ev.transparency === 'transparent',
  };
}
