// Standalone in-memory fake of Google OAuth + Calendar v3 (subset). See PLAN.md section 8.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface MockGoogleOptions {
  port?: number;
  host?: string;
  /** Verify client credentials only when provided. */
  clientId?: string;
  clientSecret?: string;
  tokenTtlSec?: number;
  logger?: boolean;
}

interface MockEvent {
  id: string;
  etag: string;
  status: 'confirmed' | 'cancelled';
  created: string;
  updated: string;
  seq: number;
  [k: string]: unknown;
}

interface MockConfig {
  failNext: { status: number; count: number; target: 'calendar' | 'token' | 'all'; retryAfterSec?: number } | null;
  latencyMs: number;
  tokenTtlSec: number;
  expireSyncToken: boolean;
}

export interface MockGoogleHandle {
  app: FastifyInstance;
  port: number;
  url: string;
  close(): Promise<void>;
  reset(): void;
}

const gerr = (reply: FastifyReply, code: number, message: string, reason: string) =>
  reply.code(code).send({ error: { code, message, errors: [{ message, domain: 'global', reason }] } });

export async function startMockGoogle(opts: MockGoogleOptions = {}): Promise<MockGoogleHandle> {
  const app = Fastify({ logger: opts.logger ?? false });
  const defaultConfig = (): MockConfig => ({
    failNext: null,
    latencyMs: 0,
    tokenTtlSec: opts.tokenTtlSec ?? 3600,
    expireSyncToken: false,
  });
  let config = defaultConfig();
  let seq = 0;
  let epoch = Date.now().toString(36);
  let events = new Map<string, Map<string, MockEvent>>();
  let codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; method: string; email: string; scope: string; nonce?: string }>();
  let accessTokens = new Map<string, { email: string; expiresAt: number; scope: string }>();
  let refreshTokens = new Map<string, { email: string; scope: string }>();
  let requestLog: Array<{ method: string; url: string }> = [];

  const reset = () => {
    config = defaultConfig();
    seq = 0;
    epoch = Date.now().toString(36) + randomBytes(2).toString('hex');
    events = new Map();
    codes = new Map();
    accessTokens = new Map();
    refreshTokens = new Map();
    requestLog = [];
  };

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  // Tolerate empty JSON bodies (e.g. DELETE / POST without payload).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const s = (body as string).trim();
    if (!s) return done(null, {});
    try { done(null, JSON.parse(s)); } catch (e) { done(e as Error, undefined); }
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/__mock')) requestLog.push({ method: req.method, url: req.url });
    if (config.latencyMs > 0) await new Promise((r) => setTimeout(r, config.latencyMs));
  });

  const cal = (id: string) => {
    let m = events.get(id);
    if (!m) { m = new Map(); events.set(id, m); }
    return m;
  };
  const stamp = (ev: MockEvent, updated?: string) => {
    seq += 1;
    ev.seq = seq;
    ev.etag = `"${epoch}-${seq}"`;
    ev.updated = updated ?? new Date().toISOString();
  };
  const publicEvent = (ev: MockEvent) => {
    const { seq: _s, ...rest } = ev;
    return { kind: 'calendar#event', ...rest };
  };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

  // Applies forced failures; returns true if the request was answered.
  const forcedFailure = (target: 'calendar' | 'token', reply: FastifyReply): boolean => {
    const f = config.failNext;
    if (!f || f.count <= 0 || (f.target !== 'all' && f.target !== target)) return false;
    f.count -= 1;
    if (f.count <= 0) config.failNext = null;
    if (f.retryAfterSec !== undefined) reply.header('retry-after', String(f.retryAfterSec));
    if (target === 'token') { reply.code(f.status).send({ error: 'server_error', error_description: 'forced failure' }); return true; }
    gerr(reply, f.status, 'forced failure', f.status === 429 ? 'rateLimitExceeded' : f.status === 401 ? 'authError' : 'backendError');
    return true;
  };

  // ---- OAuth ----
  app.get('/o/oauth2/v2/auth', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!q.client_id || (opts.clientId && q.client_id !== opts.clientId)) return reply.code(400).type('text/plain').send('Error 401: invalid_client');
    if (!q.redirect_uri) return reply.code(400).type('text/plain').send('Error 400: redirect_uri_mismatch');
    if (q.response_type !== 'code') return reply.code(400).type('text/plain').send('Error 400: unsupported_response_type');
    if (!q.code_challenge || (q.code_challenge_method && q.code_challenge_method !== 'S256')) {
      return reply.code(400).type('text/plain').send('Error 400: invalid_request (PKCE S256 code_challenge required)');
    }
    const email = q.login_hint && q.login_hint.includes('@') ? q.login_hint : 'demo@example.com';
    if (q.auto === '1' || q.approve === '1') {
      const code = 'mock-code-' + randomBytes(12).toString('hex');
      codes.set(code, {
        clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge,
        method: q.code_challenge_method ?? 'S256', email, scope: q.scope ?? '', nonce: q.nonce,
      });
      const u = new URL(q.redirect_uri);
      u.searchParams.set('code', code);
      if (q.state) u.searchParams.set('state', q.state);
      return reply.redirect(u.toString());
    }
    const u = new URL(req.url, 'http://mock.local');
    u.searchParams.set('auto', '1');
    const href = (u.pathname + u.search).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return reply.type('text/html').send(
      `<!doctype html><title>Mock Google</title><body style="font-family:sans-serif;max-width:420px;margin:60px auto">` +
      `<h2>Mock Google sign-in</h2><p>Reminder System wants access to your calendar events.</p>` +
      `<a id="approve" href="${href}" style="display:inline-block;padding:10px 16px;background:#1a73e8;color:#fff;border-radius:4px;text-decoration:none">Approve as ${email}</a></body>`,
    );
  });

  const issue = (email: string, scope: string, existingRefresh?: string, nonce?: string, aud?: string) => {
    const at = 'mock-at-' + randomBytes(16).toString('hex');
    accessTokens.set(at, { email, scope, expiresAt: Date.now() + config.tokenTtlSec * 1000 });
    let rt = existingRefresh;
    if (!rt) { rt = 'mock-rt-' + randomBytes(16).toString('hex'); refreshTokens.set(rt, { email, scope }); }
    const now = Math.floor(Date.now() / 1000);
    const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      iss: 'https://accounts.google.com', aud: aud ?? opts.clientId ?? 'mock-client-id', sub: 'mock-sub-' + email,
      email, email_verified: true, name: email.split('@')[0], picture: '', iat: now, exp: now + config.tokenTtlSec,
      ...(nonce ? { nonce } : {}),
    })}.`;
    return { access_token: at, expires_in: config.tokenTtlSec, refresh_token: rt, scope, token_type: 'Bearer', id_token: idToken };
  };

  app.post('/token', async (req, reply) => {
    if (forcedFailure('token', reply)) return reply;
    const b = (req.body ?? {}) as Record<string, string>;
    const bad = (error: string, desc: string) => reply.code(400).send({ error, error_description: desc });
    if (opts.clientId && b.client_id !== opts.clientId) return reply.code(401).send({ error: 'invalid_client' });
    if (opts.clientSecret && b.client_secret !== opts.clientSecret) return reply.code(401).send({ error: 'invalid_client' });
    if (b.grant_type === 'authorization_code') {
      const c = b.code ? codes.get(b.code) : undefined;
      if (!c) return bad('invalid_grant', 'Bad Request');
      codes.delete(b.code!); // single use
      if (b.redirect_uri !== c.redirectUri) return bad('invalid_grant', 'redirect_uri mismatch');
      if (!b.code_verifier) return bad('invalid_grant', 'code_verifier required');
      const challenge = createHash('sha256').update(b.code_verifier).digest('base64url');
      if (challenge !== c.challenge) return bad('invalid_grant', 'PKCE verification failed');
      return issue(c.email, c.scope, undefined, c.nonce, c.clientId);
    }
    if (b.grant_type === 'refresh_token') {
      const r = b.refresh_token ? refreshTokens.get(b.refresh_token) : undefined;
      if (!r) return bad('invalid_grant', 'Token has been expired or revoked.');
      const { refresh_token: _rt, id_token: _i, ...out } = issue(r.email, r.scope, b.refresh_token);
      return out;
    }
    return bad('unsupported_grant_type', 'unsupported grant_type');
  });

  app.post('/revoke', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const t = b.token ?? '';
    if (refreshTokens.delete(t) || accessTokens.delete(t)) return reply.code(200).send({});
    return reply.code(400).send({ error: 'invalid_token' });
  });

  const bearer = (req: FastifyRequest): { email: string; scope: string } | null => {
    const h = req.headers.authorization ?? '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    const rec = accessTokens.get(t);
    if (!rec || rec.expiresAt <= Date.now()) return null;
    return rec;
  };

  app.get('/oauth2/v3/userinfo', async (req, reply) => {
    const u = bearer(req);
    if (!u) return gerr(reply, 401, 'Invalid Credentials', 'authError');
    return { sub: 'mock-sub-' + u.email, email: u.email, email_verified: true, name: u.email.split('@')[0], picture: '' };
  });

  // ---- Calendar v3 ----
  await app.register(async (c) => {
    c.addHook('preHandler', async (req, reply) => {
      if (forcedFailure('calendar', reply)) return reply;
      if (!bearer(req)) return gerr(reply, 401, 'Invalid Credentials', 'authError');
    });

    c.get('/calendar/v3/calendars/:cal/events', async (req, reply) => {
      const { cal: calId } = req.params as { cal: string };
      const q = req.query as Record<string, string>;
      const store = cal(calId);
      let list = [...store.values()];
      if (q.syncToken) {
        const m = /^st-(.+)-(\d+)$/.exec(q.syncToken);
        if (!m || m[1] !== epoch || config.expireSyncToken) return gerr(reply, 410, 'Sync token is no longer valid, a full sync is required.', 'fullSyncRequired');
        const since = Number(m[2]);
        list = list.filter((e) => e.seq > since);
      } else {
        if (q.showDeleted !== 'true') list = list.filter((e) => e.status !== 'cancelled');
        if (q.timeMin) {
          const min = Date.parse(q.timeMin);
          list = list.filter((e) => {
            const end = e.end as { dateTime?: string; date?: string } | undefined;
            const t = Date.parse(end?.dateTime ?? end?.date ?? '');
            return e.status === 'cancelled' || Number.isNaN(t) || t >= min;
          });
        }
      }
      if (q.updatedMin) { const min = Date.parse(q.updatedMin); list = list.filter((e) => Date.parse(e.updated) >= min); }
      if (q.q) list = list.filter((e) => String(e.summary ?? '').toLowerCase().includes(q.q!.toLowerCase()));
      list.sort((a, b) => a.seq - b.seq);
      const max = Math.min(Number(q.maxResults) || 250, 2500);
      const offset = q.pageToken ? Number(q.pageToken) || 0 : 0;
      const page = list.slice(offset, offset + max);
      const last = offset + max >= list.length;
      return {
        kind: 'calendar#events', etag: `"${epoch}-${seq}"`, summary: calId, items: page.map(publicEvent),
        ...(last ? { nextSyncToken: `st-${epoch}-${seq}` } : { nextPageToken: String(offset + max) }),
      };
    });

    c.post('/calendar/v3/calendars/:cal/events', async (req, reply) => {
      const { cal: calId } = req.params as { cal: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const store = cal(calId);
      const id = typeof body.id === 'string' && body.id ? body.id : randomUUID().replace(/-/g, '');
      if (store.has(id)) return gerr(reply, 409, 'The requested identifier already exists.', 'duplicate');
      if (!body.start || !body.end) return gerr(reply, 400, 'Missing start/end', 'required');
      const now = new Date().toISOString();
      const ev: MockEvent = { ...body, id, status: 'confirmed', created: now, updated: now, etag: '', seq: 0 };
      stamp(ev);
      store.set(id, ev);
      return reply.code(200).send(publicEvent(ev));
    });

    c.get('/calendar/v3/calendars/:cal/events/:id', async (req, reply) => {
      const { cal: calId, id } = req.params as { cal: string; id: string };
      const ev = cal(calId).get(id);
      if (!ev) return gerr(reply, 404, 'Not Found', 'notFound');
      return publicEvent(ev);
    });

    const patch = async (req: FastifyRequest, reply: FastifyReply) => {
      const { cal: calId, id } = req.params as { cal: string; id: string };
      const ev = cal(calId).get(id);
      if (!ev) return gerr(reply, 404, 'Not Found', 'notFound');
      const ifMatch = req.headers['if-match'];
      if (ifMatch && ifMatch !== ev.etag) return gerr(reply, 412, 'Precondition Failed', 'conditionNotMet');
      const body = (req.body ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) {
        if (['id', 'etag', 'updated', 'created', 'seq'].includes(k)) continue;
        if (v === null) delete ev[k]; else ev[k] = v;
      }
      if (ev.status === 'cancelled' && body.status === undefined) ev.status = 'confirmed';
      stamp(ev);
      return publicEvent(ev);
    };
    c.patch('/calendar/v3/calendars/:cal/events/:id', patch);
    c.put('/calendar/v3/calendars/:cal/events/:id', patch);

    c.delete('/calendar/v3/calendars/:cal/events/:id', async (req, reply) => {
      const { cal: calId, id } = req.params as { cal: string; id: string };
      const ev = cal(calId).get(id);
      if (!ev) return gerr(reply, 404, 'Not Found', 'notFound');
      if (ev.status === 'cancelled') return gerr(reply, 410, 'Resource has been deleted', 'deleted');
      const ifMatch = req.headers['if-match'];
      if (ifMatch && ifMatch !== ev.etag) return gerr(reply, 412, 'Precondition Failed', 'conditionNotMet');
      ev.status = 'cancelled';
      stamp(ev);
      return reply.code(204).send();
    });
  });

  // ---- Test controls ----
  app.post('/__mock/config', async (req) => {
    const b = (req.body ?? {}) as Partial<{ failNext: { status: number; count?: number; target?: 'calendar' | 'token' | 'all'; retryAfterSec?: number } | null; latencyMs: number; tokenTtlSec: number; expireSyncToken: boolean }>;
    if ('failNext' in b) {
      config.failNext = b.failNext ? { status: b.failNext.status, count: b.failNext.count ?? 1, target: b.failNext.target ?? 'calendar', retryAfterSec: b.failNext.retryAfterSec } : null;
    }
    if (b.latencyMs !== undefined) config.latencyMs = b.latencyMs;
    if (b.tokenTtlSec !== undefined) config.tokenTtlSec = b.tokenTtlSec;
    if (b.expireSyncToken !== undefined) config.expireSyncToken = b.expireSyncToken;
    return config;
  });

  // Simulate an edit made in the Google Calendar UI: create, patch (by id) or delete.
  app.post('/__mock/events', async (req, reply) => {
    const b = (req.body ?? {}) as { calendarId?: string; id?: string; event?: Record<string, unknown>; delete?: boolean; updated?: string };
    const store = cal(b.calendarId ?? 'primary');
    if (b.id && store.has(b.id)) {
      const ev = store.get(b.id)!;
      if (b.delete) { ev.status = 'cancelled'; stamp(ev, b.updated); }
      else {
        for (const [k, v] of Object.entries(b.event ?? {})) { if (v === null) delete ev[k]; else ev[k] = v; }
        ev.status = 'confirmed';
        stamp(ev, b.updated);
      }
      return publicEvent(ev);
    }
    if (b.delete) return reply.code(404).send({ error: 'not found' });
    const id = b.id ?? randomUUID().replace(/-/g, '');
    const now = new Date().toISOString();
    const ev: MockEvent = { ...(b.event ?? {}), id, status: 'confirmed', created: now, updated: now, etag: '', seq: 0 };
    stamp(ev, b.updated);
    store.set(id, ev);
    return publicEvent(ev);
  });

  // Issue tokens without the browser flow (used to pre-link the demo account).
  app.post('/__mock/issue-token', async (req) => {
    const b = (req.body ?? {}) as { email?: string; scope?: string };
    return issue(b.email ?? 'demo@example.com', b.scope ?? 'openid email profile https://www.googleapis.com/auth/calendar.events');
  });

  // Invalidate every refresh/access token (simulates the user revoking access -> invalid_grant).
  app.post('/__mock/revoke-all', async () => {
    const n = refreshTokens.size;
    refreshTokens.clear();
    accessTokens.clear();
    return { revoked: n };
  });

  // Invalidate only access tokens (forces a refresh on next call).
  app.post('/__mock/expire-access', async () => {
    const n = accessTokens.size;
    accessTokens.clear();
    return { expired: n };
  });

  app.post('/__mock/reset', async () => { reset(); return { ok: true }; });
  app.get('/__mock/state', async () => ({
    config,
    seq,
    calendars: Object.fromEntries([...events.entries()].map(([k, v]) => [k, [...v.values()].map(publicEvent)])),
    accessTokens: accessTokens.size,
    refreshTokens: refreshTokens.size,
    requests: requestLog,
  }));
  app.get('/health', async () => ({ ok: true, mock: true }));

  const port = opts.port ?? Number(process.env.MOCK_GOOGLE_PORT ?? 4010);
  await app.listen({ port, host: opts.host ?? '127.0.0.1' });
  const addr = app.server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  return { app, port: actual, url: `http://localhost:${actual}`, close: () => app.close(), reset };
}
