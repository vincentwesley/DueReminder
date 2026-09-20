import { buildApp } from '../../server/src/app';

export type TestApp = Awaited<ReturnType<typeof buildApp>>;

/** In-memory app with a logged-in demo user. */
export async function makeApp(over: Record<string, unknown> = {}) {
  const app = await buildApp({ dbPath: ':memory:', demoMode: true, logger: false, ...over } as never);
  const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: { 'x-requested-with': 'fetch' } });
  const sid = String(([] as string[]).concat(login.headers['set-cookie'] as string[]).find((c) => c.startsWith('rs_session='))).split(';')[0]!;
  const headers = { cookie: sid, 'x-requested-with': 'fetch' };
  const call = async (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) => {
    const res = await app.inject({ method: method as never, url: '/api' + url, headers: { ...headers, ...extra }, payload: payload as never });
    let body: any;
    try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body, headers: res.headers, raw: res.body };
  };
  const userId = (app as any).db.prepare('SELECT id FROM users').get().id as string;
  return { app, call, headers, userId, db: (app as any).db, close: () => app.close() };
}
