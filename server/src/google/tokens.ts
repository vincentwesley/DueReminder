import { exec, one } from '../db/index.js';
import type { GoogleCtx } from './config';
import { decryptToken, encryptToken } from './crypto';
import { GoogleHttpError, NetworkError, ReauthRequiredError } from './errors';
import { parseRetryAfter } from './backoff';

export interface AccountRow {
  user_id: string;
  google_sub: string;
  email: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: number;
  scope: string;
  calendar_id: string;
  sync_token: string | null;
  last_sync_at: string | null;
  status: string;
  last_error: string | null;
  conflicts_resolved: number;
}

export const getAccount = (ctx: GoogleCtx, userId: string): Promise<AccountRow | undefined> =>
  one<AccountRow>(ctx.db, 'SELECT * FROM google_accounts WHERE user_id = ?', userId);

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
  token_type?: string;
}

export async function doFetch(ctx: GoogleCtx, url: string, init: RequestInit = {}): Promise<Response> {
  const f = ctx.config.fetch;
  const withTimeout = { ...init, signal: AbortSignal.timeout(ctx.config.requestTimeoutMs) };
  try {
    return await (f ? f(url, withTimeout) : fetch(url, withTimeout));
  } catch (e) {
    throw new NetworkError(`Network error calling ${new URL(url).host}: ${(e as Error).message}`);
  }
}

export async function postForm(ctx: GoogleCtx, url: string, form: Record<string, string>): Promise<Response> {
  return doFetch(ctx, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
}

// ponytail: single-flight is per isolate; two isolates refreshing at once just both get a valid token.
const inflight = new Map<string, Promise<string>>();

/** Persist tokens for a user (encrypted). Keeps the existing refresh token if none is returned. */
export async function storeTokens(ctx: GoogleCtx, userId: string, t: TokenResponse): Promise<void> {
  const s = ctx.config.sessionSecret;
  const row = await getAccount(ctx, userId);
  const refreshEnc = t.refresh_token ? await encryptToken(t.refresh_token, s) : row?.refresh_token_enc ?? null;
  await exec(ctx.db, 'UPDATE google_accounts SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, scope = COALESCE(?, scope) WHERE user_id = ?',
    await encryptToken(t.access_token, s), refreshEnc, Date.now() + t.expires_in * 1000, t.scope ?? null, userId);
}

export async function markReauth(ctx: GoogleCtx, userId: string, msg: string): Promise<void> {
  await exec(ctx.db, "UPDATE google_accounts SET status = 'reauth_required', last_error = ?, access_token_enc = NULL WHERE user_id = ?", msg, userId);
}

async function refresh(ctx: GoogleCtx, userId: string): Promise<string> {
  const acct = await getAccount(ctx, userId);
  if (!acct) throw new ReauthRequiredError('No Google account linked');
  if (!acct.refresh_token_enc) {
    await markReauth(ctx, userId, 'No refresh token stored; reconnect Google');
    throw new ReauthRequiredError();
  }
  let rt: string;
  try { rt = await decryptToken(acct.refresh_token_enc, ctx.config.sessionSecret); }
  catch {
    await markReauth(ctx, userId, 'Stored Google tokens cannot be decrypted (SESSION_SECRET changed); reconnect required');
    throw new ReauthRequiredError();
  }
  const res = await postForm(ctx, ctx.config.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: rt,
    client_id: ctx.config.clientId,
    client_secret: ctx.config.clientSecret,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    if (body.error === 'invalid_grant' || res.status === 401 || body.error === 'invalid_client') {
      await markReauth(ctx, userId, 'Google authorization expired or was revoked; reconnect required');
      throw new ReauthRequiredError();
    }
    throw new GoogleHttpError(res.status, `Token refresh failed: ${body.error ?? res.status}`, [], parseRetryAfter(res.headers.get('retry-after')), body);
  }
  const tok = (await res.json()) as TokenResponse;
  await storeTokens(ctx, userId, tok);
  return tok.access_token;
}

/** Returns a valid access token, refreshing (single-flight per user) when it expires within 60s. */
export async function getAccessToken(ctx: GoogleCtx, userId: string, opts: { force?: boolean } = {}): Promise<string> {
  const acct = await getAccount(ctx, userId);
  if (!acct) throw new ReauthRequiredError('No Google account linked');
  if (acct.status === 'reauth_required') throw new ReauthRequiredError();
  if (!opts.force && acct.access_token_enc && acct.expires_at - 60_000 > Date.now()) {
    try { return await decryptToken(acct.access_token_enc, ctx.config.sessionSecret); } catch { /* fall through to refresh, which reports reauth */ }
  }
  let p = inflight.get(userId);
  if (!p) {
    p = refresh(ctx, userId).finally(() => inflight.delete(userId));
    inflight.set(userId, p);
  }
  return p;
}

/** Best-effort revoke at Google (refresh token revokes the grant). Never throws. */
export async function revokeTokens(ctx: GoogleCtx, userId: string): Promise<boolean> {
  const acct = await getAccount(ctx, userId);
  if (!acct) return false;
  const enc = acct.refresh_token_enc ?? acct.access_token_enc;
  if (!enc) return false;
  try {
    const res = await postForm(ctx, ctx.config.revokeUrl, { token: await decryptToken(enc, ctx.config.sessionSecret) });
    return res.ok;
  } catch (e) {
    ctx.log?.warn({ err: (e as Error).message }, 'google revoke failed');
    return false;
  }
}
