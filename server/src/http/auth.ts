import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppConfig } from '../config.js';
import { one, exec, type Db } from '../db/index.js';
import type { C } from './types.js';

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const MAX_SESSIONS_PER_USER = 10;
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** Unauthenticated /api paths (everything else under /api requires a session). */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/api/health', '/api/demo/login', '/api/auth/login', '/api/auth/google/start', '/api/auth/callback', '/api/auth/me']);

/** `__Host-` cookies need Secure + Path=/ (https). Local dev over http://localhost opts out with INSECURE_COOKIES=1. */
export const cookieName = (cfg: AppConfig, base: 'rs_session' | 'rs_oauth'): string => (cfg.insecureCookies ? base : `__Host-${base}`);

export function putCookie(c: C, name: string, value: string, maxAgeSec: number): void {
  setCookie(c, name, value, { path: '/', httpOnly: true, sameSite: 'Lax', secure: !c.var.ctx.config.insecureCookies, maxAge: maxAgeSec });
}
export const dropCookie = (c: C, name: string): void => { deleteCookie(c, name, { path: '/', secure: !c.var.ctx.config.insecureCookies }); };

export const sessionIdFromRequest = (c: C): string | undefined => getCookie(c, cookieName(c.var.ctx.config, 'rs_session'));

/** User id for a live session id; expired rows are deleted and yield null. */
export async function userIdForSession(db: Db, sid: string | undefined): Promise<string | null> {
  if (!sid) return null;
  const r = await one<{ user_id: string; expires_at: string }>(db, 'SELECT user_id, expires_at FROM sessions WHERE id = ?', sid);
  if (!r) return null;
  if (!(Date.parse(r.expires_at) > Date.now())) { await exec(db, 'DELETE FROM sessions WHERE id = ?', sid); return null; }
  return r.user_id;
}

/** Handler helpers for authenticated routes (the global hook guarantees c.var.user). */
export const uidOf = (c: C): string => c.var.user!.id;
export const idParam = (c: C): string => c.req.param('id')!;
