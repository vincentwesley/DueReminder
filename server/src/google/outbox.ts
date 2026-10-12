import { exec, one, type Db } from '../db/index.js';

/**
 * Queue a Google push for a reminder. Call after every write to a calendarSync reminder
 * (op 'delete' for tombstones / hard deletes). No-op when the user has no linked Google account.
 * Collapses earlier pending rows for the same reminder (last op wins).
 */
export async function enqueueSync(db: Db, userId: string, reminderId: string, op: 'upsert' | 'delete'): Promise<boolean> {
  const acct = await one<{ status: string }>(db, 'SELECT status FROM google_accounts WHERE user_id = ?', userId);
  if (!acct) return false;
  const r = await one<{ google_event_id: string | null }>(db, 'SELECT google_event_id FROM reminders WHERE id = ? AND user_id = ?', reminderId, userId);
  const prev = await one<{ event_id: string | null }>(db, 'SELECT event_id FROM outbox WHERE user_id = ? AND reminder_id = ? ORDER BY id DESC LIMIT 1', userId, reminderId);
  await exec(db, 'DELETE FROM outbox WHERE user_id = ? AND reminder_id = ?', userId, reminderId);
  await exec(db, 'INSERT INTO outbox (user_id, reminder_id, op, event_id, attempts, next_attempt_at, created_at) VALUES (?,?,?,?,0,0,?)',
    userId, reminderId, op, r?.google_event_id ?? prev?.event_id ?? null, new Date().toISOString());
  return true;
}

/** Ops still waiting to be pushed (excludes ones that exhausted their retries). */
export const pendingOps = async (db: Db, userId: string): Promise<number> =>
  (await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM outbox WHERE user_id = ? AND failed = 0', userId))!.n;

/** Ops that could not be pushed after all retries; they stay until edited again or retried with Sync now. */
export const failedOps = async (db: Db, userId: string): Promise<number> =>
  (await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM outbox WHERE user_id = ? AND failed = 1', userId))!.n;

export const retryFailedOps = async (db: Db, userId: string): Promise<void> => {
  await exec(db, 'UPDATE outbox SET failed = 0, attempts = 0, next_attempt_at = 0 WHERE user_id = ? AND failed = 1', userId);
};
