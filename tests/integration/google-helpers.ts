import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { startMockGoogle, type MockGoogleHandle } from '../../mock-google/index';
import { openDb, type Db } from '../../server/src/db/index';
import { registerGoogle, type GoogleApi } from '../../server/src/google/index';
import type { GoogleConfig } from '../../server/src/google/config';

export interface Harness {
  mock: MockGoogleHandle;
  db: Db;
  app: FastifyInstance;
  google: GoogleApi;
  net: { offline: boolean };
  mockCtl: (path: string, body?: unknown) => Promise<any>;
  mockState: () => Promise<any>;
  close: () => Promise<void>;
}

export async function makeHarness(over: Partial<GoogleConfig> = {}): Promise<Harness> {
  const mock = await startMockGoogle({ port: 0 });
  const db = openDb(':memory:');
  const app = Fastify();
  const net = { offline: false };
  const google = await registerGoogle(app, {
    db,
    config: {
      clientId: 'mock-client-id',
      clientSecret: 'mock-client-secret',
      sessionSecret: 'test-secret-test-secret-test-secret-0123',
      demoMode: true,
      authBase: mock.url,
      apiBase: mock.url,
      redirectUri: 'http://localhost:4000/api/auth/callback',
      pollMs: 0,
      debounceMs: 0,
      fetch: ((...a: Parameters<typeof fetch>) => (net.offline ? Promise.reject(new TypeError('fetch failed')) : fetch(...a))) as typeof fetch,
      ...over,
    },
  });
  await app.ready();
  const mockCtl = async (path: string, body?: unknown) =>
    (await fetch(mock.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
  const mockState = async () => (await fetch(mock.url + '/__mock/state')).json();
  return { mock, db, app, google, net, mockCtl, mockState, close: async () => { await app.close(); await mock.close(); db.close(); } };
}

/** Runs the full browser-style login: /login -> mock authorize -> /callback. Returns the session cookie header. */
export async function loginViaMock(h: Harness, email?: string): Promise<{ cookie: string; userId: string }> {
  const login = await h.app.inject({ method: 'GET', url: '/api/auth/login' + (email ? `?email=${encodeURIComponent(email)}` : '') });
  if (login.statusCode !== 302) throw new Error('login did not redirect: ' + login.body);
  const oauthCookie = cookieOf(login.headers['set-cookie'], 'rs_oauth');
  const authRes = await fetch(String(login.headers.location), { redirect: 'manual' });
  const cb = new URL(authRes.headers.get('location')!);
  const res = await h.app.inject({ method: 'GET', url: cb.pathname + cb.search, headers: { cookie: `rs_oauth=${oauthCookie}` } });
  if (res.statusCode !== 302) throw new Error('callback failed: ' + res.body);
  const sid = cookieOf(res.headers['set-cookie'], 'rs_session');
  const row = h.db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sid) as { user_id: string };
  return { cookie: `rs_session=${sid}`, userId: row.user_id };
}

export function cookieOf(setCookie: string | string[] | number | undefined, name: string): string {
  const list = Array.isArray(setCookie) ? setCookie : [String(setCookie ?? '')];
  for (const c of list) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  return '';
}

export function addReminder(db: Db, userId: string, o: Partial<Record<string, unknown>> = {}): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const r = {
    id, user_id: userId, list_id: 'list-1', title: 'Pay rent', notes: '', status: 'open', priority: 0,
    due_at: new Date(Date.now() + 86_400_000).toISOString(), all_day: 0, timezone: 'UTC', rrule: null, calendar_sync: 1,
    created_at: now, updated_at: now, version: 1, ...o,
  };
  db.prepare(
    `INSERT INTO reminders (id,user_id,list_id,title,notes,status,priority,due_at,all_day,timezone,rrule,calendar_sync,created_at,updated_at,version)
     VALUES (@id,@user_id,@list_id,@title,@notes,@status,@priority,@due_at,@all_day,@timezone,@rrule,@calendar_sync,@created_at,@updated_at,@version)`,
  ).run(r);
  return id;
}

export const reminder = (db: Db, id: string) => db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as any;
export const auth = (cookie: string) => ({ cookie, 'x-requested-with': 'fetch' });
