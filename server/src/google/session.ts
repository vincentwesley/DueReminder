import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@shared/types';
import { SESSION_COOKIE, type GoogleConfig } from './config';

export const SESSION_TTL_MS = 30 * 86_400_000;

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

export function setCookie(reply: FastifyReply, cfg: GoogleConfig, name: string, value: string, maxAgeSec: number): void {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (cfg.secureCookies) attrs.push('Secure');
  const prev = reply.getHeader('set-cookie');
  const list = Array.isArray(prev) ? prev.map(String) : prev ? [String(prev)] : [];
  reply.header('set-cookie', [...list, attrs.join('; ')]);
}

export const clearCookie = (reply: FastifyReply, cfg: GoogleConfig, name: string) => setCookie(reply, cfg, name, '', 0);

export function createSession(db: Database, cfg: GoogleConfig, reply: FastifyReply, userId: string): string {
  const id = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)').run(id, userId, new Date(Date.now() + SESSION_TTL_MS).toISOString());
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT 10)').run(userId, userId);
  setCookie(reply, cfg, SESSION_COOKIE, id, SESSION_TTL_MS / 1000);
  return id;
}

/** Resolve the logged-in user id from the rs_session cookie (null if absent/expired). */
export function sessionUserId(db: Database, req: FastifyRequest): string | null {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sid) return null;
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(sid) as { user_id: string; expires_at: string | number } | undefined;
  if (!row) return null;
  const exp = typeof row.expires_at === 'number' ? (row.expires_at < 1e12 ? row.expires_at * 1000 : row.expires_at) : Date.parse(row.expires_at);
  return exp > Date.now() ? row.user_id : null;
}

export function loadUser(db: Database, userId: string): User | null {
  const u = db.prepare('SELECT id, email, name, picture_url, demo FROM users WHERE id = ?').get(userId) as
    | { id: string; email: string; name: string | null; picture_url: string | null; demo: number }
    | undefined;
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name ?? u.email, ...(u.picture_url ? { pictureUrl: u.picture_url } : {}), demo: !!u.demo };
}
