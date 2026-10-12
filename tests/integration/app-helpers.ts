import { one } from '../../server/src/db/index';
import type { Env } from '../../server/src/config';
import { freshDb, makeTestApp } from './harness';

export type TestApp = Awaited<ReturnType<typeof makeApp>>;

/** Fresh DB + app with a logged-in demo user. */
export async function makeApp(over: Partial<Env> = {}) {
  const db = await freshDb();
  const app = makeTestApp(db, over);
  const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: { 'x-requested-with': 'fetch' } });
  const sid = String(([] as string[]).concat(login.headers['set-cookie'] as string[]).find((c) => c.startsWith('rs_session='))).split(';')[0]!;
  const headers = { cookie: sid, 'x-requested-with': 'fetch' };
  const call = async (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) => {
    const res = await app.inject({ method, url: '/api' + url, headers: { ...headers, ...extra }, payload });
    let body: any;
    try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body, headers: res.headers, raw: res.body };
  };
  const userId = (await one<{ id: string }>(db, 'SELECT id FROM users'))!.id;
  return { app, call, headers, userId, db, close: async () => { await app.settle(); } };
}
