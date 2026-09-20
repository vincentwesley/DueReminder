import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '../../shared/types.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';

export const SESSION_COOKIE = 'rs_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export interface AuthUser extends User { }

interface UserRow { id: string; email: string; name: string; picture_url: string | null; demo: number }
const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, ...(r.picture_url ? { pictureUrl: r.picture_url } : {}), demo: !!r.demo });

export function getUserById(db: Db, id: string): User | null {
  const r = db.prepare('SELECT id, email, name, picture_url, demo FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return r ? toUser(r) : null;
}

/** Upsert a user by google_sub (or email). Exported for WP-O's OAuth callback. */
export function upsertUser(db: Db, u: { email: string; name?: string; googleSub?: string | null; pictureUrl?: string | null; demo?: boolean }): User {
  const ex = db.prepare('SELECT id FROM users WHERE (google_sub IS NOT NULL AND google_sub = ?) OR email = ?').get(u.googleSub ?? null, u.email) as { id: string } | undefined;
  if (ex) {
    db.prepare('UPDATE users SET name = COALESCE(?, name), picture_url = COALESCE(?, picture_url), google_sub = COALESCE(?, google_sub) WHERE id = ?')
      .run(u.name ?? null, u.pictureUrl ?? null, u.googleSub ?? null, ex.id);
    return getUserById(db, ex.id)!;
  }
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, email, google_sub, name, picture_url, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, u.email, u.googleSub ?? null, u.name ?? u.email.split('@')[0], u.pictureUrl ?? null, u.demo ? 1 : 0, new Date().toISOString());
  return getUserById(db, id)!;
}

/** Creates a session row and sets the rs_session cookie. Exported for WP-O's OAuth callback. */
export function startSession(db: Db, config: AppConfig, reply: FastifyReply, userId: string): void {
  const id = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expires.toISOString());
  reply.setCookie(SESSION_COOKIE, id, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production', expires });
}

export function endSession(db: Db, req: FastifyRequest, reply: FastifyReply): void {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function userFromRequest(db: Db, req: FastifyRequest): User | null {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return null;
  const r = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(sid) as { user_id: string; expires_at: string } | undefined;
  if (!r) return null;
  if (r.expires_at < new Date().toISOString()) { db.prepare('DELETE FROM sessions WHERE id = ?').run(sid); return null; }
  return getUserById(db, r.user_id);
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated user (set by the global auth hook); null when anonymous. WP-O routes may rely on this. */
    user: User | null;
  }
}
