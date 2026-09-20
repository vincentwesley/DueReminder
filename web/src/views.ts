import { useEffect, useState } from 'react';
import type { Reminder } from '@shared/types';
import { dayKey, dayLabel, effectiveDue, endOfDay, isOverdue, startOfDay } from './dates';

export type Route =
  | { kind: 'view'; view: 'today' | 'upcoming' | 'overdue' | 'all' | 'done' }
  | { kind: 'list'; id: string }
  | { kind: 'tag'; id: string };

export const VIEW_TITLES: Record<string, string> = { today: 'Today', upcoming: 'Upcoming', overdue: 'Overdue', all: 'All reminders', done: 'Completed' };

export function parseHash(hash: string): Route {
  const [, kind, id] = hash.replace(/^#/, '').split('/');
  if (kind === 'list' && id) return { kind: 'list', id: decodeURIComponent(id) };
  if (kind === 'tag' && id) return { kind: 'tag', id: decodeURIComponent(id) };
  if (kind === 'upcoming' || kind === 'overdue' || kind === 'all' || kind === 'done') return { kind: 'view', view: kind };
  return { kind: 'view', view: 'today' };
}

export const routeHref = (r: Route) => (r.kind === 'view' ? `#/${r.view}` : `#/${r.kind}/${encodeURIComponent(r.id)}`);

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parseHash(hash);
}

export interface Filters { priority: 0 | 1 | 2 | 3 | -1; sort: 'due' | 'priority' | 'created'; hasDate: boolean }
export const DEFAULT_FILTERS: Filters = { priority: -1, sort: 'due', hasDate: false };

export function matchesRoute(r: Reminder, route: Route, now = new Date()): boolean {
  if (route.kind === 'list') return r.listId === route.id && r.status === 'open';
  if (route.kind === 'tag') return r.tagIds.includes(route.id) && r.status === 'open';
  switch (route.view) {
    case 'done': return r.status === 'done';
    case 'all': return r.status === 'open';
    case 'overdue': return isOverdue(r, now);
    case 'today': {
      if (r.status !== 'open') return false;
      const d = effectiveDue(r, now.getTime());
      return !!d && d < endOfDay(now); // today plus anything still overdue
    }
    case 'upcoming': {
      if (r.status !== 'open') return false;
      const d = effectiveDue(r, now.getTime());
      return !!d && d >= endOfDay(now);
    }
  }
}

export function applyFilters(items: Reminder[], q: string, f: Filters, route: Route): Reminder[] {
  const needle = q.trim().toLowerCase();
  let out = items.filter((r) => {
    if (f.priority !== -1 && r.priority !== f.priority) return false;
    if (f.hasDate && !r.dueAt) return false;
    if (needle && !(r.title.toLowerCase().includes(needle) || r.notes.toLowerCase().includes(needle))) return false;
    return true;
  });
  const due = (r: Reminder) => effectiveDue(r)?.getTime() ?? Infinity;
  const cmp: Record<Filters['sort'], (a: Reminder, b: Reminder) => number> = {
    due: (a, b) => due(a) - due(b) || b.priority - a.priority,
    priority: (a, b) => b.priority - a.priority || due(a) - due(b),
    created: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  };
  out = [...out].sort(route.kind === 'view' && route.view === 'done' ? (a, b) => Date.parse(b.completedAt ?? b.updatedAt) - Date.parse(a.completedAt ?? a.updatedAt) : cmp[f.sort]);
  return out;
}

export interface Group { key: string; label: string; items: Reminder[] }

export function groupReminders(items: Reminder[], route: Route, now = new Date()): Group[] {
  if (!(route.kind === 'view' && (route.view === 'upcoming' || route.view === 'today'))) return [{ key: 'all', label: '', items }];
  const groups = new Map<string, Group>();
  for (const r of items) {
    const d = effectiveDue(r, now.getTime());
    let key = 'none', label = 'No date';
    if (d) {
      if (isOverdue(r, now)) { key = '0-overdue'; label = 'Overdue'; }
      else { key = `1-${dayKey(d)}`; label = dayLabel(d, now); }
    }
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key)!.items.push(r);
  }
  const arr = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  if (route.kind === 'view' && route.view === 'today' && arr.length === 1) arr[0]!.label = '';
  return arr;
}

export function counts(reminders: Reminder[], now = new Date()) {
  const open = reminders.filter((r) => r.status === 'open');
  const c = { today: 0, upcoming: 0, overdue: 0, all: open.length, done: reminders.length - open.length };
  for (const r of open) {
    const d = effectiveDue(r, now.getTime());
    if (isOverdue(r, now)) c.overdue++;
    if (d && d < endOfDay(now)) c.today++;
    else if (d && d >= startOfDay(endOfDay(now))) c.upcoming++;
  }
  return c;
}
