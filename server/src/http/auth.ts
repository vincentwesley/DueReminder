import type { Database } from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'rs_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const MAX_SESSIONS_PER_USER = 10;

/** Unauthenticated /api paths (everything else under /api requires a session). */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/api/health', '/api/demo/login', '/api/auth/login', '/api/auth/google/start', '/api/auth/callback', '/api/auth/me']);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
    }
  }
  return out;
}

/** Session id from the request cookie: uses @fastify/cookie when registered, else parses the header. */
export function sessionIdFromRequest(req: Pick<FastifyRequest, 'headers'> & { cookies?: Record<string, string | undefined> }): string | undefined {
  return req.cookies?.[SESSION_COOKIE] ?? parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

const expiryMs = (v: string | number): number => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));

/** User id for a live session id; expired rows are deleted and yield null. */
export function userIdForSession(db: Database, sid: string | undefined): string | null {
  if (!sid) return null;
  const r = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(sid) as { user_id: string; expires_at: string | number } | undefined;
  if (!r) return null;
  if (!(expiryMs(r.expires_at) > Date.now())) { db.prepare('DELETE FROM sessions WHERE id = ?').run(sid); return null; }
  return r.user_id;
}

export const sessionUserId = (db: Database, req: Pick<FastifyRequest, 'headers'> & { cookies?: Record<string, string | undefined> }): string | null =>
  userIdForSession(db, sessionIdFromRequest(req));

/** Handler helpers for authenticated routes (the global hook guarantees req.user). */
export const uidOf = (req: { user: { id: string } | null }): string => req.user!.id;
export const idParam = (req: { params: unknown }): string => (req.params as { id: string }).id;
