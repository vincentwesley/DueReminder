import { useEffect, useState } from 'react';
import { effectiveDue } from './dates';
import { getState, toast } from './store';

export type NotifState = NotificationPermission | 'unsupported';
const supported = () => typeof window !== 'undefined' && 'Notification' in window;

export function notifState(): NotifState {
  return supported() ? Notification.permission : 'unsupported';
}

export function useNotifState() {
  const [s, setS] = useState<NotifState>(notifState);
  useEffect(() => {
    const t = setInterval(() => setS(notifState()), 2000);
    return () => clearInterval(t);
  }, []);
  return [s, setS] as const;
}

export async function requestNotifications(): Promise<NotifState> {
  if (!supported()) return 'unsupported';
  try {
    const p = await Notification.requestPermission();
    if (p === 'denied') toast('Notifications are blocked. You can enable them in your browser site settings.', 'error');
    return p;
  } catch {
    return notifState();
  }
}

const SEEN_KEY = 'rs.notified';
function seen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]); } catch { return new Set(); }
}
function remember(s: Set<string>) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-300))); } catch { /* storage unavailable */ }
}

async function show(title: string, body: string, tag: string) {
  const opts: NotificationOptions = { body, tag, icon: '/icon-192.png' };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, opts); return; }
  } catch { /* fall back to page notification */ }
  new Notification(title, opts);
}

/** Checks every 30s for due, unnotified reminders. Falls back to in-app toasts without permission. */
export function startDueWatcher(): () => void {
  const tick = () => {
    const { reminders, user } = getState();
    if (!user) return;
    const done = seen();
    const nowMs = Date.now();
    let changed = false;
    for (const r of reminders) {
      if (r.status !== 'open' || r.allDay) continue;
      const d = effectiveDue(r, nowMs);
      if (!d) continue;
      const ms = d.getTime();
      if (ms > nowMs || nowMs - ms > 6 * 3600_000) continue; // not yet due, or stale
      const key = `${r.id}@${ms}`;
      if (done.has(key)) continue;
      done.add(key);
      changed = true;
      if (notifState() === 'granted') void show(r.title, r.notes || 'Reminder is due', r.id);
      else toast(`Due now: ${r.title}`, 'info');
    }
    if (changed) remember(done);
  };
  tick();
  const t = setInterval(tick, 30_000);
  return () => clearInterval(t);
}
