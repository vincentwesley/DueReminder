import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '../../shared/types.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import { MAX_SESSIONS_PER_USER, SESSION_COOKIE, SESSION_TTL_MS, sessionIdFromRequest, userIdForSession } from './http/auth.js';

export { MAX_SESSIONS_PER_USER, SESSION_COOKIE };

export interface AuthUser extends User { }

interface UserRow { id: string; email: string; name: string; picture_url: string | null; demo: number }
const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, ...(r.picture_url ? { pictureUrl: r.picture_url } : {}), demo: !!r.demo });

export function getUserById(db: Db, id: string): User | null {
  const r = db.prepare('SELECT id, email, name, picture_url, demo FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return r ? toUser(r) : null;
}

/** Upsert a user by google_sub (or email). Exported for reuse by the OAuth callback. */
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

/** Creates a session row and sets the rs_session cookie. Exported for reuse by the OAuth callback. */
export function startSession(db: Db, config: AppConfig, reply: FastifyReply, userId: string, req?: FastifyRequest): void {
  // Rotate: drop the session the browser arrived with, and keep the number of live sessions per user bounded.
  const prior = req && sessionIdFromRequest(req);
  if (prior) db.prepare('DELETE FROM sessions WHERE id = ?').run(prior);
  const id = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expires.toISOString());
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT ?)').run(userId, userId, MAX_SESSIONS_PER_USER);
  reply.setCookie(SESSION_COOKIE, id, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production', expires });
}

export function endSession(db: Db, req: FastifyRequest, reply: FastifyReply): void {
  const sid = sessionIdFromRequest(req);
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function userFromRequest(db: Db, req: FastifyRequest): User | null {
  const uid = userIdForSession(db, sessionIdFromRequest(req));
  return uid ? getUserById(db, uid) : null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated user (set by the global auth hook); null when anonymous. */
    user: User | null;
  }
}
