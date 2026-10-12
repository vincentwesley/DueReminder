import { useSyncExternalStore } from 'react';
import type { List, Priority, QuickAddParse, Reminder, ReminderCreate, ReminderPatch, SyncState, Tag, User } from '@shared/types';
import { api, ApiFail, NetworkFail, request } from './api';
import { processQueue } from './flush';
import { cacheClear, cacheGet, cacheSet, newKey, queueAdd, queueAll, queueRemove } from './offline';

export interface ToastAction { label: string; run: () => void }
export interface Toast { id: number; text: string; kind: 'info' | 'error' | 'success'; action?: ToastAction }
export type Editing = { id: string; defaults?: undefined } | { id: 'new'; defaults?: Partial<ReminderCreate> } | null;

export interface State {
  user: User | null | undefined; // undefined = still checking the session
  demoMode: boolean;
  reminders: Reminder[];
  lists: List[];
  tags: Tag[];
  sync: SyncState | null;
  loaded: boolean;
  online: boolean;
  pending: number;
  toasts: Toast[];
  editing: Editing;
  selectedId: string | null;
  search: string;
  helpOpen: boolean;
  syncOpen: boolean;
  syncBusy: boolean;
  bootError: string | null;
  paletteOpen: boolean;
  tourOpen: boolean;
  notifOpen: boolean;
  selectMode: boolean;
  selection: string[];
  dragId: string | null;
}

let state: State = {
  user: undefined, demoMode: false, reminders: [], lists: [], tags: [], sync: null, loaded: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine, pending: 0, toasts: [], editing: null,
  selectedId: null, search: '', helpOpen: false, syncOpen: false, syncBusy: false, bootError: null,
  paletteOpen: false, tourOpen: false, notifOpen: false, selectMode: false, selection: [], dragId: null,
};
const listeners = new Set<() => void>();
export const getState = () => state;
export function setState(p: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof p === 'function' ? p(state) : p) };
  listeners.forEach((l) => l());
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => sel(state),
  );
}

let toastId = 1;
export function toast(text: string, kind: Toast['kind'] = 'info', action?: ToastAction) {
  const id = toastId++;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind, action }] }));
  setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : action ? 8000 : 4000);
}
export const dismissToast = (id: number) => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
const mergeById = (a: Reminder[]) => [...new Map(a.map((r) => [r.id, r])).values()];

/* ---------- boot / auth ---------- */

export async function boot() {
  try {
    const h = await api.health();
    setState({ demoMode: !!h.demo });
  } catch { /* offline: fall through to cached session */ }
  try {
    const user = await api.me();
    setState({ user });
    void cacheSet('user', user);
    await loadAll();
    void refreshSync();
    void flushQueue();
  } catch (e) {
    if (e instanceof ApiFail && e.status === 401) {
      setState({ user: null, loaded: true });
    } else if (e instanceof NetworkFail) {
      const cached = await cacheGet<User>('user');
      if (cached) {
        setState({ user: cached, online: false });
        await loadAll();
      } else setState({ user: null, loaded: true, bootError: 'The server is not reachable. Check your connection and try again.' });
    } else setState({ user: null, loaded: true, bootError: errText(e) });
  }
}

export async function demoLogin() {
  try {
    const user = await api.demoLogin();
    setState({ user, bootError: null });
    void cacheSet('user', user);
    await loadAll();
    void refreshSync();
    void flushQueue();
  } catch (e) {
    toast(`Could not start the demo: ${errText(e)}`, 'error');
  }
}

export async function logout() {
  if (state.pending > 0 && typeof window !== 'undefined' && !window.confirm(`${state.pending} offline change${state.pending === 1 ? ' has' : 's have'} not synced yet and will be lost if you sign out. Sign out anyway?`)) return;
  try { await api.logout(); } catch { /* still clear local state */ }
  await cacheClear();
  setState({ user: null, reminders: [], lists: [], tags: [], sync: null, editing: null, syncOpen: false, pending: 0 });
}

/* ---------- loading ---------- */

async function fetchAll(): Promise<Reminder[]> {
  const out: Reminder[] = [];
  for (const filter of ['all', 'done'] as const) {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await api.reminders(filter, cursor);
      out.push(...res.items);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
  }
  return mergeById(out).filter((r) => !r.deletedAt);
}

/** `quiet` = background refetch: no toast on failure, and dropped if a local edit landed while it was in flight. */
export async function loadAll(quiet = false) {
  const before = state.reminders;
  try {
    const [reminders, lists, tags] = await Promise.all([fetchAll(), api.lists(), api.tags()]);
    if (quiet && state.reminders !== before) return;
    setState({ reminders, lists: lists.filter((l) => !l.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder), tags, loaded: true, online: true });
    void cacheSet('data', { reminders, lists, tags });
  } catch (e) {
    if (e instanceof ApiFail && e.status === 401) { setState({ user: null, loaded: true }); return; }
    if (quiet) return;
    const cached = await cacheGet<{ reminders: Reminder[]; lists: List[]; tags: Tag[] }>('data');
    if (cached) setState({ ...cached, loaded: true, online: false });
    else setState({ loaded: true, online: e instanceof NetworkFail ? false : state.online });
    if (!(e instanceof NetworkFail)) toast(`Could not load reminders: ${errText(e)}`, 'error');
  }
}

export async function refreshSync() {
  try {
    const prev = state.sync?.lastSyncAt;
    const sync = await api.syncState();
    setState({ sync, online: true });
    // The server syncs on its own (cron + after writes): a newer lastSyncAt means Google changes may have landed.
    if (prev && sync.lastSyncAt && sync.lastSyncAt !== prev) void loadAll(true);
  } catch (e) {
    if (e instanceof NetworkFail) setState({ online: false });
  }
}

export async function syncNow() {
  setState({ syncBusy: true });
  try {
    setState({ sync: await api.syncRun() });
    await loadAll();
  } catch (e) {
    toast(e instanceof NetworkFail ? 'You are offline. Sync will resume when you reconnect.' : `Sync failed: ${errText(e)}`, 'error');
  } finally {
    setState({ syncBusy: false });
  }
}

export async function disconnectGoogle() {
  try {
    setState({ sync: await api.syncDisconnect() });
    toast('Google Calendar disconnected', 'success');
  } catch (e) {
    toast(`Could not disconnect: ${errText(e)}`, 'error');
  }
}

export async function setCalendarId(calendarId: string) {
  try {
    setState({ sync: await api.syncSettings({ calendarId }) });
    toast('Calendar updated', 'success');
  } catch (e) {
    toast(`Could not update calendar: ${errText(e)}`, 'error');
  }
}

/* ---------- offline queue ---------- */

let flushing = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
export async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    const ops = await queueAll();
    setState({ pending: ops.length });
    if (ops.length === 0) return;
    const res = await processQueue(ops, {
      send: (op, body, key) => request(op.method, op.path, body, { 'Idempotency-Key': key }),
      remove: queueRemove,
    });
    setState({ pending: (await queueAll()).length });
    if (res.halted === 'network') setState({ online: false });
    if (res.halted === 'auth') {
      // Keep every queued change; they replay after the next sign-in.
      setState({ user: null });
      toast('Your session expired. Sign in again and your saved offline changes will sync.', 'error');
    }
    if (res.halted === 'retry') {
      toast('The server is busy. Your offline changes are kept and will retry shortly.', 'info');
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void flushQueue(), 30_000);
    }
    for (const msg of res.dropped) toast(`A queued change was rejected: ${msg}`, 'error');
    if (res.rebased > 0) toast(`${res.rebased} offline edit${res.rebased === 1 ? ' was' : 's were'} applied on top of newer changes made elsewhere.`, 'info');
    if (res.sent > 0) {
      await loadAll();
      toast(`Synced ${res.sent} offline change${res.sent === 1 ? '' : 's'}`, 'success');
      void refreshSync();
    }
  } finally {
    flushing = false;
  }
}

async function enqueue(method: string, path: string, body: unknown, key: string) {
  await queueAdd({ key, method, path, body, at: Date.now() });
  setState({ pending: (await queueAll()).length, online: false });
  toast('Saved offline. It will sync when you reconnect.', 'info');
}

const replace = (r: Reminder) => setState((s) => ({ reminders: s.reminders.some((x) => x.id === r.id) ? s.reminders.map((x) => (x.id === r.id ? r : x)) : [r, ...s.reminders] }));

/** Optimistic write with rollback, conflict handling and offline queueing. */
async function write<T>(opts: {
  method: string; path: string; body?: unknown; optimistic?: () => void;
  call: (key: string) => Promise<T>; done?: (res: T) => void; queueable?: boolean;
}) {
  const key = newKey();
  const before = state.reminders;
  opts.optimistic?.();
  try {
    const res = await opts.call(key);
    opts.done?.(res);
    setState({ online: true });
    if (state.sync?.connected) setTimeout(() => void refreshSync(), 2500);
    return true;
  } catch (e) {
    if (e instanceof NetworkFail && opts.queueable !== false) {
      await enqueue(opts.method, opts.path, opts.body, key);
      return true;
    }
    setState({ reminders: before });
    if (e instanceof ApiFail && e.status === 409 && e.details && typeof e.details === 'object') {
      replace(e.details as Reminder);
      toast('This reminder was changed elsewhere. Showing the latest version.', 'error');
    } else if (e instanceof ApiFail && e.status === 401) {
      setState({ user: null });
    } else toast(errText(e), 'error');
    return false;
  }
}

/* ---------- reminder actions ---------- */

const now = () => new Date().toISOString();
const isTemp = (id: string) => id.startsWith('tmp-');

export function draftReminder(c: ReminderCreate): Reminder {
  const t = now();
  return {
    id: `tmp-${newKey()}`, listId: c.listId ?? state.lists[0]?.id ?? '', title: c.title, notes: c.notes ?? '', status: 'open',
    priority: c.priority ?? 0, dueAt: c.dueAt ?? null, allDay: c.allDay ?? false, timezone: c.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    rrule: c.rrule ?? null, snoozedUntil: null, completedAt: null, tagIds: c.tagIds ?? [], calendarSync: c.calendarSync ?? false,
    googleEventId: null, googleEtag: null, createdAt: t, updatedAt: t, deletedAt: null, version: 0,
  };
}

export function createReminder(c: ReminderCreate, onCreated?: (r: Reminder) => void) {
  const tmp = draftReminder(c);
  return write<Reminder>({
    method: 'POST', path: '/reminders', body: c,
    optimistic: () => setState((s) => ({ reminders: [tmp, ...s.reminders] })),
    call: (key) => request<Reminder>('POST', '/reminders', c, { 'Idempotency-Key': key }),
    done: (r) => { setState((s) => ({ reminders: s.reminders.map((x) => (x.id === tmp.id ? r : x)) })); onCreated?.(r); },
  });
}

export async function quickAdd(text: string, parsed: QuickAddParse | null) {
  const key = newKey();
  const before = state.reminders;
  try {
    const res = await api.quickAdd(text, key);
    if (res.reminder) replace(res.reminder);
    else await loadAll();
    setState({ online: true });
    return true;
  } catch (e) {
    if (e instanceof NetworkFail) {
      // Offline: fall back to a plain reminder using the last parse (or the raw text).
      const c: ReminderCreate = parsed
        ? { title: parsed.title || text, dueAt: parsed.dueAt, allDay: parsed.allDay, rrule: parsed.rrule, priority: parsed.priority }
        : { title: text };
      const tmp = draftReminder(c);
      setState({ reminders: [tmp, ...before] });
      await enqueue('POST', '/reminders', c, key);
      return true;
    }
    toast(`Quick add failed: ${errText(e)}`, 'error');
    return false;
  }
}

export async function updateReminder(id: string, patch: ReminderPatch) {
  if (isTemp(id)) { toast('This reminder is still waiting to sync.', 'info'); return false; }
  const cur = state.reminders.find((r) => r.id === id);
  const body = { ...patch, version: patch.version ?? cur?.version };
  return write<Reminder>({
    method: 'PATCH', path: `/reminders/${id}`, body,
    optimistic: () => setState((s) => ({ reminders: s.reminders.map((r) => (r.id === id ? ({ ...r, ...patch } as Reminder) : r)) })),
    call: (key) => request<Reminder>('PATCH', `/reminders/${id}`, body, { 'Idempotency-Key': key }),
    done: replace,
  });
}

const latest = (id: string) => state.reminders.find((x) => x.id === id);

export async function toggleComplete(r: Reminder, rec = true) {
  if (isTemp(r.id)) return false;
  const completing = r.status === 'open';
  const action = completing ? 'complete' : 'uncomplete';
  let advanced = false; // recurring reminders roll forward to the next occurrence instead of closing
  const ok = await write<Reminder>({
    method: 'POST', path: `/reminders/${r.id}/${action}`,
    // Recurring reminders advance on the server, so only mark one-off items done optimistically.
    optimistic: () => { if (!completing || !r.rrule) setState((s) => ({ reminders: s.reminders.map((x) => (x.id === r.id ? { ...x, status: completing ? 'done' : 'open', completedAt: completing ? now() : null } : x)) })); },
    call: (key) => request<Reminder>('POST', `/reminders/${r.id}/${action}`, undefined, { 'Idempotency-Key': key }),
    done: (res) => {
      replace(res);
      advanced = completing && !!r.rrule && res.status === 'open';
    },
  });
  if (ok && rec) {
    const label = completing ? (advanced ? 'Done. Next occurrence scheduled.' : 'Marked complete') : 'Marked not done';
    record({
      label,
      undo: () => { const c = latest(r.id); return advanced ? updateReminder(r.id, { dueAt: r.dueAt }) : c ? toggleComplete(c, false) : Promise.resolve(false); },
      redo: () => { const c = latest(r.id); return c ? toggleComplete(c, false) : Promise.resolve(false); },
    });
  }
  return ok;
}

export async function snoozeReminder(r: Reminder, minutes: number, rec = true) {
  if (isTemp(r.id)) return false;
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  const ok = await write<Reminder>({
    method: 'POST', path: `/reminders/${r.id}/snooze`, body: { minutes },
    optimistic: () => setState((s) => ({ reminders: s.reminders.map((x) => (x.id === r.id ? { ...x, snoozedUntil: until } : x)) })),
    call: (key) => request<Reminder>('POST', `/reminders/${r.id}/snooze`, { minutes }, { 'Idempotency-Key': key }),
    done: replace,
  });
  if (ok && rec) {
    const after = latest(r.id)?.snoozedUntil ?? until;
    record({
      label: 'Snoozed',
      undo: () => updateReminder(r.id, { snoozedUntil: r.snoozedUntil ?? null }),
      redo: () => updateReminder(r.id, { snoozedUntil: after }),
    });
  }
  return ok;
}

function restorable(r: Reminder): ReminderCreate {
  return { title: r.title, notes: r.notes, listId: r.listId, priority: r.priority, dueAt: r.dueAt, allDay: r.allDay, timezone: r.timezone, rrule: r.rrule, tagIds: r.tagIds, calendarSync: r.calendarSync };
}

export async function deleteReminder(r: Reminder, rec = true) {
  if (isTemp(r.id)) { setState((s) => ({ reminders: s.reminders.filter((x) => x.id !== r.id) })); return true; }
  const ok = await write<void>({
    method: 'DELETE', path: `/reminders/${r.id}`,
    optimistic: () => setState((s) => ({ reminders: s.reminders.filter((x) => x.id !== r.id), editing: s.editing?.id === r.id ? null : s.editing })),
    call: (key) => request<void>('DELETE', `/reminders/${r.id}`, undefined, { 'Idempotency-Key': key }),
  });
  if (ok && rec) {
    let curId = r.id; // undoing a delete re-creates the reminder under a new id
    record({
      label: 'Reminder deleted',
      undo: async () => { const id = await restoreReminder(r); if (id) curId = id; return !!id; },
      redo: () => { const c = latest(curId); return c ? deleteReminder(c, false) : Promise.resolve(false); },
    });
  }
  return ok;
}

/** Re-creates a deleted reminder (the API has no undelete) and returns its new id. */
export async function restoreReminder(r: Reminder): Promise<string | null> {
  let id: string | null = null;
  const ok = await createReminder(restorable(r), (x) => { id = x.id; });
  if (ok && id && r.status === 'done') { const n = latest(id); if (n) await toggleComplete(n, false); }
  return ok ? id : null;
}

export async function moveReminder(r: Reminder, listId: string, rec = true) {
  if (r.listId === listId) return true;
  const ok = await updateReminder(r.id, { listId });
  if (ok && rec) {
    const name = state.lists.find((l) => l.id === listId)?.name ?? 'list';
    record({ label: `Moved to ${name}`, undo: () => updateReminder(r.id, { listId: r.listId }), redo: () => updateReminder(r.id, { listId }) });
  }
  return ok;
}

/** Changes only the calendar day, keeping the time of day (all-day items stay all-day). */
export function rescheduledIso(r: Reminder, day: Date): string {
  const cur = r.dueAt ? new Date(r.dueAt) : null;
  const h = r.allDay ? 0 : cur ? cur.getHours() : 9;
  const m = r.allDay || !cur ? 0 : cur.getMinutes();
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).toISOString();
}

export async function rescheduleReminder(r: Reminder, day: Date, rec = true) {
  const dueAt = rescheduledIso(r, day);
  const ok = await updateReminder(r.id, { dueAt });
  if (ok && rec) record({ label: 'Rescheduled', undo: () => updateReminder(r.id, { dueAt: r.dueAt }), redo: () => updateReminder(r.id, { dueAt }) });
  return ok;
}

export async function setPriority(r: Reminder, priority: Priority, rec = true) {
  if (r.priority === priority) return true;
  const ok = await updateReminder(r.id, { priority });
  if (ok && rec) record({ label: `Priority set to ${PRIORITY_LABEL[priority]}`, undo: () => updateReminder(r.id, { priority: r.priority }), redo: () => updateReminder(r.id, { priority }) });
  return ok;
}

/* ---------- undo / redo history ---------- */

export interface HistoryEntry { label: string; undo: () => Promise<boolean>; redo: () => Promise<boolean> }
const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];

/** Registers an undoable action and shows a toast with an Undo button. */
export function record(e: HistoryEntry) {
  undoStack.push(e);
  if (undoStack.length > 50) undoStack.shift();
  redoStack.length = 0;
  toast(e.label, 'success', { label: 'Undo', run: () => void undoEntry(e) });
}

async function undoEntry(e: HistoryEntry) {
  const i = undoStack.indexOf(e);
  if (i < 0) return;
  undoStack.splice(i, 1);
  if (await e.undo()) {
    redoStack.push(e);
    toast(`Undone: ${e.label}`, 'info', { label: 'Redo', run: () => void redoEntry(e) });
  } else toast('Could not undo that change.', 'error');
}

async function redoEntry(e: HistoryEntry) {
  const i = redoStack.indexOf(e);
  if (i < 0) return;
  redoStack.splice(i, 1);
  if (await e.redo()) {
    undoStack.push(e);
    toast(`Redone: ${e.label}`, 'info', { label: 'Undo', run: () => void undoEntry(e) });
  } else toast('Could not redo that change.', 'error');
}

export async function undo() {
  const e = undoStack[undoStack.length - 1];
  if (!e) { toast('Nothing to undo', 'info'); return; }
  await undoEntry(e);
}
export async function redo() {
  const e = redoStack[redoStack.length - 1];
  if (!e) { toast('Nothing to redo', 'info'); return; }
  await redoEntry(e);
}

/* ---------- lists / tags ---------- */

export async function addList(name: string) {
  try {
    const l = await api.createList({ name });
    setState((s) => ({ lists: [...s.lists, l] }));
    return l;
  } catch (e) { toast(`Could not create list: ${errText(e)}`, 'error'); return null; }
}

export async function removeList(id: string) {
  try {
    await api.deleteList(id);
    await loadAll();
    toast('List deleted. Its reminders moved to the default list.', 'success');
    return true;
  } catch (e) { toast(`Could not delete list: ${errText(e)}`, 'error'); return false; }
}

export async function addTag(name: string) {
  try {
    const t = await api.createTag({ name: name.replace(/^#/, '') });
    setState((s) => ({ tags: s.tags.some((x) => x.id === t.id) ? s.tags : [...s.tags, t] }));
    return t;
  } catch (e) { toast(`Could not create tag: ${errText(e)}`, 'error'); return null; }
}

export const PRIORITY_LABEL: Record<Priority, string> = { 0: 'None', 1: 'Low', 2: 'Medium', 3: 'High' };

// No push channel: refetch when the tab regains focus and every 60s while it is visible.
if (typeof window !== 'undefined') {
  const refetch = () => { if (document.visibilityState === 'visible' && navigator.onLine && state.user && state.loaded && !state.pending) void loadAll(true); };
  window.addEventListener('focus', refetch);
  document.addEventListener('visibilitychange', refetch);
  setInterval(refetch, 60_000);
}
