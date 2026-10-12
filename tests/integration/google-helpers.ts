import { startMockGoogle, type MockGoogleHandle } from '../../mock-google/index';
import { ctxFactory } from '../../server/src/app';
import type { Env } from '../../server/src/config';
import { exec, one, type Db } from '../../server/src/db/index';
import { getSyncState, runSync } from '../../server/src/google/sync';
import type { GoogleCtx } from '../../server/src/google/config';
import { freshDb, makeInject, testEnv } from './harness';
import { createApp } from '../../server/src/app';

export interface Harness {
  mock: MockGoogleHandle;
  db: Db;
  app: ReturnType<typeof makeInject>;
  google: { ctx: GoogleCtx; runSync: (userId: string) => ReturnType<typeof runSync>; getSyncState: (userId: string) => ReturnType<typeof getSyncState> };
  net: { offline: boolean };
  mockCtl: (path: string, body?: unknown) => Promise<any>;
  mockState: () => Promise<any>;
  close: () => Promise<void>;
}

export async function makeHarness(over: { fetch?: typeof fetch; env?: Partial<Env> } = {}): Promise<Harness> {
  const mock = await startMockGoogle({ port: 0 });
  const db = await freshDb();
  const net = { offline: false };
  const base = over.fetch ?? fetch;
  const deps = { fetch: ((...a: Parameters<typeof fetch>) => (net.offline ? Promise.reject(new TypeError('fetch failed')) : base(...a))) as typeof fetch };
  const env = testEnv(db, { GOOGLE_AUTH_BASE: mock.url, GOOGLE_API_BASE: mock.url, AUTH_RATE_LIMIT: '100000', ...over.env });
  const app = makeInject(createApp(deps), env);
  const ctx = ctxFactory(deps)(env);
  const google = { ctx: ctx.google, runSync: (uid: string) => runSync(ctx.google, uid), getSyncState: (uid: string) => getSyncState(ctx.google, uid) };
  const mockCtl = async (path: string, body?: unknown) =>
    (await fetch(mock.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
  const mockState = async () => (await fetch(mock.url + '/__mock/state')).json();
  return { mock, db, app, google, net, mockCtl, mockState, close: async () => { await app.settle(); await mock.close(); } };
}

/** Drives a started OAuth flow (the /api/auth/... redirect) through the mock and the callback; returns the callback response. */
export async function followOAuth(h: Harness, start: { headers: Record<string, any> }, cookie = ''): Promise<{ res: Awaited<ReturnType<Harness['app']['inject']>>; location: URL }> {
  const oauth = cookieOf(start.headers['set-cookie'], 'rs_oauth');
  const authRes = await fetch(String(start.headers.location), { redirect: 'manual' });
  const location = new URL(authRes.headers.get('location')!);
  const res = await h.app.inject({ method: 'GET', url: location.pathname + location.search, headers: { cookie: [cookie, `rs_oauth=${oauth}`].filter(Boolean).join('; ') } });
  return { res, location };
}

/** Step 1 only: sign in with Google (identity scopes). No calendar tokens exist afterwards. */
export async function signInViaMock(h: Harness, email?: string): Promise<{ cookie: string; userId: string }> {
  const login = await h.app.inject({ method: 'GET', url: '/api/auth/login' + (email ? `?email=${encodeURIComponent(email)}` : '') });
  if (login.statusCode !== 302) throw new Error('login did not redirect: ' + login.body);
  const { res } = await followOAuth(h, login);
  if (res.statusCode !== 302) throw new Error('callback failed: ' + res.body);
  const sid = cookieOf(res.headers['set-cookie'], 'rs_session');
  const row = (await one<{ user_id: string }>(h.db, 'SELECT user_id FROM sessions WHERE id = ?', sid))!;
  return { cookie: `rs_session=${sid}`, userId: row.user_id };
}

/** Step 2: the signed-in user connects Google Calendar. */
export async function connectCalendarViaMock(h: Harness, cookie: string) {
  const start = await h.app.inject({ method: 'GET', url: '/api/auth/google/calendar', headers: { cookie } });
  if (start.statusCode !== 302) throw new Error('calendar start did not redirect: ' + start.body);
  return followOAuth(h, start, cookie);
}

/** Both steps: sign in, then connect the calendar. Returns the session cookie. */
export async function loginViaMock(h: Harness, email?: string): Promise<{ cookie: string; userId: string }> {
  const s = await signInViaMock(h, email);
  const { res } = await connectCalendarViaMock(h, s.cookie);
  if (res.statusCode !== 302) throw new Error('calendar callback failed: ' + res.body);
  return s;
}

export function cookieOf(setCookie: string | string[] | number | undefined, name: string): string {
  const list = Array.isArray(setCookie) ? setCookie : [String(setCookie ?? '')];
  for (const c of list) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  return '';
}

export async function addReminder(db: Db, userId: string, o: Partial<Record<string, unknown>> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const r: Record<string, unknown> = {
    id, user_id: userId, list_id: 'list-1', title: 'Pay rent', notes: '', status: 'open', priority: 0,
    due_at: new Date(Date.now() + 86_400_000).toISOString(), all_day: 0, timezone: 'UTC', rrule: null, calendar_sync: 1,
    created_at: now, updated_at: now, version: 1, ...o,
  };
  const cols = ['id', 'user_id', 'list_id', 'title', 'notes', 'status', 'priority', 'due_at', 'all_day', 'timezone', 'rrule', 'calendar_sync', 'created_at', 'updated_at', 'version'];
  await exec(db, `INSERT INTO reminders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => r[c]));
  return id;
}

export const reminder = (db: Db, id: string) => one<any>(db, 'SELECT * FROM reminders WHERE id = ?', id);
export const auth = (cookie: string) => ({ cookie, 'x-requested-with': 'fetch' });
