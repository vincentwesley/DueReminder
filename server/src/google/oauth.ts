import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authorizeUrl, OAUTH_COOKIE, SCOPES, userinfoUrl, type GoogleCtx } from './config';
import { nonceFor, verifyIdToken, type IdClaims } from './idtoken';
import { codeChallengeS256, generateCodeVerifier, generateState } from './pkce';
import { clearCookie, createSession, parseCookies, sessionUserId, setCookie } from './session';
import { doFetch, postForm, storeTokens, type TokenResponse } from './tokens';
import { encryptToken } from './crypto';
import { enqueueSync } from './outbox';

const STATE_TTL_MS = 10 * 60_000;

export const apiError = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

/** GET /api/auth/login: create state + PKCE verifier, redirect to Google's authorize endpoint. */
export function startLogin(ctx: GoogleCtx, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const { db, config: c } = ctx;
  if (!c.clientId) return apiError(reply, 500, 'internal', 'GOOGLE_CLIENT_ID is not configured. See SETUP_GOOGLE.md.');
  db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(Date.now() - STATE_TTL_MS);
  const state = generateState();
  const verifier = generateCodeVerifier();
  db.prepare('INSERT INTO oauth_states (state, code_verifier, created_at, user_id) VALUES (?,?,?,?)').run(state, verifier, Date.now(), sessionUserId(db, req));

  const url = new URL(authorizeUrl(c));
  const q: Record<string, string> = {
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    nonce: nonceFor(state),
    code_challenge: codeChallengeS256(verifier),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  };
  if (c.demoMode) {
    q.auto = '1'; // mock only: skip the fake consent page
    const hint = (req.query as { email?: string }).email;
    if (hint) q.login_hint = hint;
  }
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  setCookie(reply, c, OAUTH_COOKIE, state, STATE_TTL_MS / 1000);
  return reply.redirect(url.toString());
}

function upsertUser(ctx: GoogleCtx, claims: IdClaims, linkUserId: string | null): string {
  const { db, config } = ctx;
  let id: string | undefined = linkUserId ?? undefined;
  if (!id) {
    id = (db.prepare('SELECT id FROM users WHERE google_sub = ?').get(claims.sub) as { id: string } | undefined)?.id;
  }
  if (!id && claims.email) {
    id = (db.prepare('SELECT id FROM users WHERE email = ?').get(claims.email) as { id: string } | undefined)?.id;
  }
  if (id) {
    db.prepare('UPDATE users SET google_sub = COALESCE(google_sub, ?), name = COALESCE(NULLIF(name, \'\'), ?), picture_url = COALESCE(picture_url, ?) WHERE id = ?')
      .run(claims.sub, claims.name ?? null, claims.picture || null, id);
    return id;
  }
  id = randomUUID();
  db.prepare('INSERT INTO users (id, email, google_sub, name, picture_url, demo, created_at) VALUES (?,?,?,?,?,?,?)').run(
    id, claims.email ?? `${claims.sub}@unknown.invalid`, claims.sub, claims.name ?? claims.email ?? 'User', claims.picture || null, config.demoMode ? 1 : 0, new Date().toISOString(),
  );
  config.onUserCreated?.(db, id); // default list is created lazily by the core services
  return id;
}

/** Write (or refresh) the google_accounts row with encrypted tokens. */
export function saveAccount(ctx: GoogleCtx, userId: string, sub: string, email: string, tok: TokenResponse): void {
  const { db, config } = ctx;
  const prev = db.prepare('SELECT google_sub, calendar_id, sync_token, refresh_token_enc FROM google_accounts WHERE user_id = ?').get(userId) as
    | { google_sub: string; calendar_id: string; sync_token: string | null; refresh_token_enc: string | null }
    | undefined;
  const same = prev?.google_sub === sub;
  const refreshEnc = tok.refresh_token ? encryptToken(tok.refresh_token, config.sessionSecret) : same ? prev?.refresh_token_enc ?? null : null;
  db.prepare('DELETE FROM google_accounts WHERE user_id = ?').run(userId);
  db.prepare(
    `INSERT INTO google_accounts (user_id, google_sub, email, access_token_enc, refresh_token_enc, expires_at, scope, calendar_id, sync_token, status, last_error)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
  ).run(userId, sub, email, encryptToken(tok.access_token, config.sessionSecret), refreshEnc, Date.now() + tok.expires_in * 1000, tok.scope ?? SCOPES.join(' '),
    same ? prev!.calendar_id : 'primary', same ? prev!.sync_token : null, 'idle');
  if (!same) db.prepare('UPDATE reminders SET google_event_id = NULL, google_etag = NULL WHERE user_id = ?').run(userId);
  queueExistingReminders(db, userId);
}

function queueExistingReminders(db: Database, userId: string): void {
  try {
    const rows = db.prepare('SELECT id FROM reminders WHERE user_id = ? AND calendar_sync = 1 AND deleted_at IS NULL AND due_at IS NOT NULL AND google_event_id IS NULL').all(userId) as { id: string }[];
    for (const r of rows) enqueueSync(db, userId, r.id, 'upsert');
  } catch { /* reminders table not present (isolated use) */ }
}

/** GET /api/auth/callback. Returns the linked user id, or replies with an error and returns null. */
export async function handleCallback(ctx: GoogleCtx, req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const { db, config: c } = ctx;
  const q = req.query as { code?: string; state?: string; error?: string };
  const fail = (status: number, message: string) => { clearCookie(reply, c, OAUTH_COOKIE); apiError(reply, status, 'bad_request', message); return null; };

  if (!q.state) return fail(400, 'Missing state');
  const row = db.prepare('SELECT code_verifier, created_at, user_id FROM oauth_states WHERE state = ?').get(q.state) as
    | { code_verifier: string; created_at: number; user_id: string | null }
    | undefined;
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(q.state); // single use
  if (!row || Date.now() - row.created_at > STATE_TTL_MS) return fail(400, 'Invalid or expired state');
  if (parseCookies(req.headers.cookie)[OAUTH_COOKIE] !== q.state) return fail(400, 'State does not match this browser session');
  clearCookie(reply, c, OAUTH_COOKIE);
  if (q.error) { reply.redirect(`${c.postLoginRedirect}?auth_error=${encodeURIComponent(q.error)}`); return null; }
  if (!q.code) return fail(400, 'Missing authorization code');

  const res = await postForm(ctx, c.tokenUrl, {
    grant_type: 'authorization_code',
    code: q.code,
    code_verifier: row.code_verifier,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: c.redirectUri,
  }).catch((e: Error) => e);
  if (res instanceof Error) { apiError(reply, 502, 'internal', 'Could not reach Google token endpoint'); return null; }
  if (!res.ok) {
    ctx.log?.warn({ status: res.status }, 'google token exchange failed');
    reply.redirect(`${c.postLoginRedirect}?auth_error=token_exchange_failed`);
    return null;
  }
  const tok = (await res.json()) as TokenResponse;

  let claims: IdClaims;
  try {
    if (tok.id_token) claims = await verifyIdToken(ctx, tok.id_token, q.state);
    else throw new Error('missing id_token');
  } catch (e) {
    ctx.log?.warn({ err: (e as Error).message }, 'id_token rejected');
    reply.redirect(`${c.postLoginRedirect}?auth_error=invalid_id_token`);
    return null;
  }
  if (!claims.email) {
    const ui = await doFetch(ctx, userinfoUrl(c), { headers: { authorization: `Bearer ${tok.access_token}` } }).catch(() => null);
    if (ui?.ok) { const j = (await ui.json()) as { email?: string; name?: string; picture?: string }; claims = { ...claims, ...j }; }
  }
  if (!claims.email) { reply.redirect(`${c.postLoginRedirect}?auth_error=no_email`); return null; }

  const userId = db.transaction(() => {
    const id = upsertUser(ctx, claims, row.user_id);
    saveAccount(ctx, id, claims.sub, claims.email!, tok);
    return id;
  })();

  if (sessionUserId(db, req) !== userId) createSession(db, c, reply, userId);
  reply.redirect(c.postLoginRedirect);
  return userId;
}

export { storeTokens };
