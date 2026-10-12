import type { User } from '../../shared/types.js';
import { batch, exec, one, q, type Db } from './db/index.js';
import { MAX_SESSIONS_PER_USER, SESSION_TTL_MS, cookieName, dropCookie, putCookie, sessionIdFromRequest, userIdForSession } from './http/auth.js';
import type { C } from './http/types.js';
import { randomHex } from './util.js';

interface UserRow { id: string; email: string; name: string; picture_url: string | null; demo: number }
const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, ...(r.picture_url ? { pictureUrl: r.picture_url } : {}), demo: !!r.demo });

export async function getUserById(db: Db, id: string): Promise<User | null> {
  const r = await one<UserRow>(db, 'SELECT id, email, name, picture_url, demo FROM users WHERE id = ?', id);
  return r ? toUser(r) : null;
}

/** Upsert a user by google_sub (or email). */
export async function upsertUser(db: Db, u: { email: string; name?: string; googleSub?: string | null; pictureUrl?: string | null; demo?: boolean }): Promise<User> {
  const ex = await one<{ id: string }>(db, 'SELECT id FROM users WHERE (google_sub IS NOT NULL AND google_sub = ?) OR email = ?', u.googleSub ?? null, u.email);
  if (ex) {
    await exec(db, 'UPDATE users SET name = COALESCE(?, name), picture_url = COALESCE(?, picture_url), google_sub = COALESCE(?, google_sub) WHERE id = ?',
      u.name ?? null, u.pictureUrl ?? null, u.googleSub ?? null, ex.id);
    return (await getUserById(db, ex.id))!;
  }
  const id = crypto.randomUUID();
  await exec(db, 'INSERT INTO users (id, email, google_sub, name, picture_url, demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, u.email, u.googleSub ?? null, u.name ?? u.email.split('@')[0], u.pictureUrl ?? null, u.demo ? 1 : 0, new Date().toISOString());
  return (await getUserById(db, id))!;
}

/** Creates a session row and sets the session cookie, rotating the session the browser arrived with. */
export async function startSession(c: C, userId: string): Promise<void> {
  const { db } = c.var.ctx;
  const prior = sessionIdFromRequest(c);
  const id = randomHex(32);
  const stmts = [];
  if (prior) stmts.push(q(db, 'DELETE FROM sessions WHERE id = ?', prior));
  stmts.push(
    q(db, 'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', id, userId, new Date(Date.now() + SESSION_TTL_MS).toISOString()),
    // Keep the number of live sessions per user bounded.
    q(db, 'DELETE FROM sessions WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT ?)', userId, userId, MAX_SESSIONS_PER_USER),
  );
  await batch(db, stmts);
  putCookie(c, cookieName(c.var.ctx.config, 'rs_session'), id, SESSION_TTL_MS / 1000);
}

export async function endSession(c: C): Promise<void> {
  const sid = sessionIdFromRequest(c);
  if (sid) await exec(c.var.ctx.db, 'DELETE FROM sessions WHERE id = ?', sid);
  dropCookie(c, cookieName(c.var.ctx.config, 'rs_session'));
}

export async function userFromRequest(c: C): Promise<User | null> {
  const uid = await userIdForSession(c.var.ctx.db, sessionIdFromRequest(c));
  return uid ? getUserById(c.var.ctx.db, uid) : null;
}
