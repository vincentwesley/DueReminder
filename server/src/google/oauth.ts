import { getCookie } from 'hono/cookie';
import { batch, exec, many, one, q, type Db } from '../db/index.js';
import { OAUTH_STATE_TTL_MS, cookieName, dropCookie, putCookie, userIdForSession, sessionIdFromRequest } from '../http/auth.js';
import type { C } from '../http/types.js';
import { startSession } from '../session.js';
import { authorizeUrl, CALENDAR_SCOPE, SIGNIN_SCOPES, userinfoUrl, type GoogleCtx } from './config';
import { nonceFor, verifyIdToken, type IdClaims } from './idtoken';
import { codeChallengeS256, generateCodeVerifier, generateState } from './pkce';
import { doFetch, postForm, type TokenResponse } from './tokens';
import { encryptToken } from './crypto';
import { enqueueSync } from './outbox';

export const apiError = (c: C, status: 400 | 401 | 500 | 502, code: string, message: string) =>
  c.json({ error: { code, message } }, status);

const redirectUriOf = (ctx: GoogleCtx, c: C) => ctx.config.redirectUri || `${new URL(c.req.url).origin}/api/auth/callback`;

/**
 * Create state + PKCE verifier and redirect to Google's authorize endpoint.
 * 'signin' asks for identity scopes only; 'calendar' (signed-in users) adds calendar.events incrementally.
 */
export async function startOAuth(ctx: GoogleCtx, c: C, kind: 'signin' | 'calendar'): Promise<Response> {
  const { db, config: cfg } = ctx;
  if (!cfg.clientId) return apiError(c, 500, 'internal', 'GOOGLE_CLIENT_ID is not configured. See SETUP_GOOGLE.md.');
  const sessionUser = await userIdForSession(db, sessionIdFromRequest(c));
  if (kind === 'calendar' && !sessionUser) return apiError(c, 401, 'unauthorized', 'Sign in first');
  await exec(db, 'DELETE FROM oauth_states WHERE created_at < ?', Date.now() - OAUTH_STATE_TTL_MS);
  const state = generateState();
  const verifier = generateCodeVerifier();
  await exec(db, 'INSERT INTO oauth_states (state, code_verifier, created_at, user_id, kind) VALUES (?,?,?,?,?)',
    state, verifier, Date.now(), sessionUser, kind);

  const url = new URL(authorizeUrl(cfg));
  const params: Record<string, string> = {
    client_id: cfg.clientId,
    redirect_uri: redirectUriOf(ctx, c),
    response_type: 'code',
    scope: kind === 'calendar' ? CALENDAR_SCOPE : SIGNIN_SCOPES.join(' '),
    state,
    nonce: await nonceFor(state),
    code_challenge: await codeChallengeS256(verifier),
    code_challenge_method: 'S256',
    ...(kind === 'calendar' ? { include_granted_scopes: 'true', access_type: 'offline', prompt: 'consent' } : {}),
  };
  if (kind === 'calendar') { // steer Google (and the mock) to the account that is signed in here
    const hint = (await one<{ email: string }>(db, 'SELECT email FROM users WHERE id = ?', sessionUser))?.email;
    if (hint && !hint.endsWith('@unknown.invalid')) params.login_hint = hint;
  }
  if (cfg.demoMode) {
    params.auto = '1'; // mock only: skip the fake consent page
    const hint = c.req.query('email');
    if (hint) params.login_hint = hint;
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  putCookie(c, cookieName(c.var.ctx.config, 'rs_oauth'), state, OAUTH_STATE_TTL_MS / 1000);
  return c.redirect(url.toString(), 302);
}

/** Existing user id for this Google identity (or linked session / verified email), else a new user. Returns [id, isNew]. */
async function upsertUser(ctx: GoogleCtx, claims: IdClaims, linkUserId: string | null): Promise<string> {
  const { db, config } = ctx;
  let id: string | undefined = linkUserId ?? undefined;
  if (!id) id = (await one<{ id: string }>(db, 'SELECT id FROM users WHERE google_sub = ?', claims.sub))?.id;
  if (!id && claims.email && claims.email_verified === true) {
    // Link by email only for a verified address on an account that is not already bound to another Google identity.
    id = (await one<{ id: string }>(db, 'SELECT id FROM users WHERE email = ? AND (google_sub IS NULL OR google_sub = ?)', claims.email, claims.sub))?.id;
  }
  if (id) {
    await exec(db, "UPDATE users SET google_sub = COALESCE(google_sub, ?), name = COALESCE(NULLIF(name, ''), ?), picture_url = COALESCE(picture_url, ?) WHERE id = ?",
      claims.sub, claims.name ?? null, claims.picture || null, id);
    return id;
  }
  id = crypto.randomUUID();
  await exec(db, 'INSERT INTO users (id, email, google_sub, name, picture_url, demo, created_at) VALUES (?,?,?,?,?,?,?)',
    id, claims.email ?? `${claims.sub}@unknown.invalid`, claims.sub, claims.name ?? claims.email ?? 'User', claims.picture || null, config.demoMode ? 1 : 0, new Date().toISOString());
  return id; // the default list is created lazily by the core services
}

/** Write (or refresh) the google_accounts row with encrypted tokens. */
export async function saveAccount(ctx: GoogleCtx, userId: string, sub: string, email: string, tok: TokenResponse): Promise<void> {
  const { db, config } = ctx;
  const prev = await one<{ google_sub: string; calendar_id: string; sync_token: string | null; refresh_token_enc: string | null }>(
    db, 'SELECT google_sub, calendar_id, sync_token, refresh_token_enc FROM google_accounts WHERE user_id = ?', userId);
  const same = prev?.google_sub === sub;
  const refreshEnc = tok.refresh_token ? await encryptToken(tok.refresh_token, config.sessionSecret) : same ? prev?.refresh_token_enc ?? null : null;
  const stmts = [
    q(db, 'DELETE FROM google_accounts WHERE user_id = ?', userId),
    q(db,
      `INSERT INTO google_accounts (user_id, google_sub, email, access_token_enc, refresh_token_enc, expires_at, scope, calendar_id, sync_token, status, last_error)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
      userId, sub, email, await encryptToken(tok.access_token, config.sessionSecret), refreshEnc, Date.now() + tok.expires_in * 1000, tok.scope ?? CALENDAR_SCOPE,
      same ? prev!.calendar_id : 'primary', same ? prev!.sync_token : null, 'idle'),
  ];
  if (!same) stmts.push(q(db, 'UPDATE reminders SET google_event_id = NULL, google_etag = NULL WHERE user_id = ?', userId));
  await batch(db, stmts);
  await queueExistingReminders(db, userId);
}

async function queueExistingReminders(db: Db, userId: string): Promise<void> {
  const rows = await many<{ id: string }>(db, 'SELECT id FROM reminders WHERE user_id = ? AND calendar_sync = 1 AND deleted_at IS NULL AND due_at IS NOT NULL AND google_event_id IS NULL', userId);
  for (const r of rows) await enqueueSync(db, userId, r.id, 'upsert');
}

/** GET /api/auth/callback. Returns the Response plus the linked user id (null on any failure). */
export async function handleCallback(ctx: GoogleCtx, c: C): Promise<{ res: Response; userId: string | null }> {
  const { db, config: cfg } = ctx;
  const oauthCookie = cookieName(c.var.ctx.config, 'rs_oauth');
  const fail = (status: 400 | 502, message: string) => { dropCookie(c, oauthCookie); return { res: apiError(c, status, status === 400 ? 'bad_request' : 'internal', message), userId: null }; };
  let kind: 'signin' | 'calendar' = 'signin';
  // Calendar-step failures keep the user signed in and use their own query keys so the UI can say what happened.
  const goto = (qs: string) => ({ res: c.redirect(`${cfg.postLoginRedirect}?${kind === 'calendar' ? qs.replace('auth_error=', 'calendar_error=') : qs}`, 302), userId: null });

  const state = c.req.query('state');
  const code = c.req.query('code');
  if (!state) return fail(400, 'Missing state');
  const row = await one<{ code_verifier: string; created_at: number; user_id: string | null; kind: string }>(db, 'SELECT code_verifier, created_at, user_id, kind FROM oauth_states WHERE state = ?', state);
  await exec(db, 'DELETE FROM oauth_states WHERE state = ?', state); // single use
  if (!row || Date.now() - row.created_at > OAUTH_STATE_TTL_MS) return fail(400, 'Invalid or expired state');
  if (getCookie(c, oauthCookie) !== state) return fail(400, 'State does not match this browser session');
  dropCookie(c, oauthCookie);
  kind = row.kind === 'calendar' ? 'calendar' : 'signin';
  if (kind === 'calendar' && (!row.user_id || (await userIdForSession(db, sessionIdFromRequest(c))) !== row.user_id)) return fail(400, 'Calendar connection must finish in the browser session that started it');
  const err = c.req.query('error');
  if (err) return goto(`auth_error=${encodeURIComponent(err)}`);
  if (!code) return fail(400, 'Missing authorization code');

  const res = await postForm(ctx, cfg.tokenUrl, {
    grant_type: 'authorization_code',
    code,
    code_verifier: row.code_verifier,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUriOf(ctx, c),
  }).catch((e: Error) => e);
  if (res instanceof Error) return { res: apiError(c, 502, 'internal', 'Could not reach Google token endpoint'), userId: null };
  if (!res.ok) {
    ctx.log?.warn({ status: res.status }, 'google token exchange failed');
    return goto('auth_error=token_exchange_failed');
  }
  const tok = (await res.json()) as TokenResponse;

  if (kind === 'calendar') {
    // Granular consent: the user may have signed in again without ticking the calendar box.
    if (!(tok.scope ?? '').split(' ').includes(CALENDAR_SCOPE)) return goto('auth_error=calendar_denied');
    const user = (await one<{ google_sub: string | null; email: string }>(db, 'SELECT google_sub, email FROM users WHERE id = ?', row.user_id!))!;
    let sub: string | undefined;
    if (tok.id_token) {
      try { sub = (await verifyIdToken(ctx, tok.id_token, state)).sub; }
      catch (e) { ctx.log?.warn({ err: (e as Error).message }, 'id_token rejected'); return goto('auth_error=invalid_id_token'); }
    }
    if (sub && user.google_sub && sub !== user.google_sub) return goto('auth_error=account_mismatch'); // a different Google account than the one signed in
    await saveAccount(ctx, row.user_id!, user.google_sub ?? sub ?? row.user_id!, user.email, tok);
    return { res: c.redirect(`${cfg.postLoginRedirect}?calendar=connected`, 302), userId: row.user_id };
  }

  let claims: IdClaims;
  try {
    if (tok.id_token) claims = await verifyIdToken(ctx, tok.id_token, state);
    else throw new Error('missing id_token');
  } catch (e) {
    ctx.log?.warn({ err: (e as Error).message }, 'id_token rejected');
    return goto('auth_error=invalid_id_token');
  }
  if (!claims.email) {
    const ui = await doFetch(ctx, userinfoUrl(cfg), { headers: { authorization: `Bearer ${tok.access_token}` } }).catch(() => null);
    if (ui?.ok) { const j = (await ui.json()) as { email?: string; email_verified?: boolean; name?: string; picture?: string }; claims = { ...claims, ...j }; }
  }
  if (!claims.email) return goto('auth_error=no_email');
  if (claims.email_verified !== true) return goto('auth_error=email_unverified');

  // Sign-in only: the user exists, but no Google tokens are kept (calendar tokens come from the separate calendar step).
  let userId: string;
  try {
    userId = await upsertUser(ctx, claims, row.user_id);
  } catch (e) {
    if (/constraint/i.test((e as Error).message)) return goto('auth_error=account_conflict');
    throw e;
  }

  // Rotate on every login so a session id planted before authentication never becomes authenticated.
  await startSession(c, userId);
  return { res: c.redirect(cfg.postLoginRedirect, 302), userId };
}
