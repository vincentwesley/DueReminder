import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MAX_SESSIONS_PER_USER, SESSION_COOKIE, SESSION_TTL_MS, parseCookies, sessionUserId } from '../http/auth.js';
import type { GoogleConfig } from './config';

export { parseCookies, sessionUserId, SESSION_TTL_MS };

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
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT ?)').run(userId, userId, MAX_SESSIONS_PER_USER);
  setCookie(reply, cfg, SESSION_COOKIE, id, SESSION_TTL_MS / 1000);
  return id;
}
