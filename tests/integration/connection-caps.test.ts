import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../server/src/app';
import { loadConfig } from '../../server/src/config';
import { cookieOf } from './google-helpers';

const H = { 'x-requested-with': 'fetch' };

describe('connection caps', () => {
  it('has safe defaults and env overrides', () => {
    const c = loadConfig({ demoMode: true, dbPath: ':memory:' }, { DEMO_MODE: '1' });
    expect(c.requestTimeoutMs).toBe(30_000);
    expect(c.bodyLimitBytes).toBe(262_144);
    expect(c.maxStreamsPerUser).toBe(5);
    expect(loadConfig({ demoMode: true, dbPath: ':memory:' }, { DEMO_MODE: '1', MAX_STREAMS_PER_USER: '2' }).maxStreamsPerUser).toBe(2);
  });

  it('rejects oversized bodies', async () => {
    const app = await buildApp({ dbPath: ':memory:', demoMode: true, logger: false, bodyLimitBytes: 1024 });
    const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const res = await app.inject({ method: 'POST', url: '/api/reminders', headers: { ...H, cookie: 'rs_session=' + cookieOf(login.headers['set-cookie'], 'rs_session'), 'content-type': 'application/json' }, payload: JSON.stringify({ title: 'x'.repeat(5000) }) });
    expect(res.statusCode).toBe(413);
    await app.close();
  });

  it('caps concurrent notification streams per user with 429 and frees slots on close', async () => {
    const app = await buildApp({ dbPath: ':memory:', demoMode: true, logger: false, maxStreamsPerUser: 2 });
    const login = await app.inject({ method: 'POST', url: '/api/demo/login', headers: H });
    const cookie = 'rs_session=' + cookieOf(login.headers['set-cookie'], 'rs_session');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const open = () => new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/notifications/stream', headers: { cookie }, agent: false }, resolve).on('error', reject);
    });
    const a = await open();
    const b = await open();
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const c = await open();
    expect(c.statusCode).toBe(429);
    c.resume();
    a.destroy();
    await new Promise((r) => setTimeout(r, 200));
    const d = await open();
    expect(d.statusCode).toBe(200);
    b.destroy(); d.destroy();
    await app.close();
  });
});
