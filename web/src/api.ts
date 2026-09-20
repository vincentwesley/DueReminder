import type { ApiError, List, ListReminders, QuickAddParse, Reminder, ReminderCreate, ReminderFilter, ReminderPatch, SyncState, Tag, User } from '@shared/types';
import { TZ } from './dates';

export class ApiFail extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
/** Thrown when the server could not be reached at all. */
export class NetworkFail extends Error {}

export async function request<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'fetch', ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new NetworkFail('Cannot reach the server');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = (data as ApiError | undefined)?.error;
    if (res.status >= 502 && res.status <= 504 && !e) throw new NetworkFail('Server unavailable');
    throw new ApiFail(res.status, e?.code ?? 'internal', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

const qs = (p: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') s.set(k, String(v));
  const t = s.toString();
  return t ? `?${t}` : '';
};

export const api = {
  health: () => request<{ ok: boolean; demo: boolean }>('GET', '/health'),
  me: () => request<User>('GET', '/me'),
  demoLogin: () => request<User>('POST', '/demo/login'),
  logout: () => request<void>('POST', '/auth/logout'),
  lists: () => request<List[]>('GET', '/lists'),
  createList: (b: { name: string; color?: string }) => request<List>('POST', '/lists', b),
  deleteList: (id: string) => request<void>('DELETE', `/lists/${id}`),
  tags: () => request<Tag[]>('GET', '/tags'),
  createTag: (b: { name: string; color?: string }) => request<Tag>('POST', '/tags', b),
  deleteTag: (id: string) => request<void>('DELETE', `/tags/${id}`),
  reminders: (filter: ReminderFilter, cursor?: string) => request<ListReminders>('GET', `/reminders${qs({ filter, cursor, limit: 200 })}`),
  create: (b: ReminderCreate) => request<Reminder>('POST', '/reminders', b),
  patch: (id: string, b: ReminderPatch) => request<Reminder>('PATCH', `/reminders/${id}`, b),
  complete: (id: string) => request<Reminder>('POST', `/reminders/${id}/complete`),
  uncomplete: (id: string) => request<Reminder>('POST', `/reminders/${id}/uncomplete`),
  snooze: (id: string, minutes: number) => request<Reminder>('POST', `/reminders/${id}/snooze`, { minutes }),
  remove: (id: string) => request<void>('DELETE', `/reminders/${id}`),
  preview: (text: string) => request<{ parsed: QuickAddParse }>('POST', '/reminders/quick-add?preview=1', { text, now: new Date().toISOString(), timezone: TZ }),
  quickAdd: (text: string, key?: string) =>
    request<{ parsed: QuickAddParse; reminder?: Reminder }>('POST', '/reminders/quick-add', { text, now: new Date().toISOString(), timezone: TZ }, key ? { 'Idempotency-Key': key } : {}),
  syncState: () => request<SyncState>('GET', '/sync/state'),
  syncRun: () => request<SyncState>('POST', '/sync/run'),
  syncDisconnect: () => request<SyncState>('POST', '/sync/disconnect'),
  syncSettings: (b: { calendarId?: string }) => request<SyncState>('PATCH', '/sync/settings', b),
};
