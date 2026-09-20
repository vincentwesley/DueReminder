import type { Database } from 'better-sqlite3';

type Trigger = (userId: string) => void;
let trigger: Trigger | null = null;

/** Set by the plugin so local writes schedule a debounced sync. */
export function setSyncTrigger(fn: Trigger | null): void {
  trigger = fn;
}

/**
 * Queue a Google push for a reminder. Call after every write to a calendarSync reminder
 * (op 'delete' for tombstones / hard deletes). No-op when the user has no linked Google account.
 * Collapses earlier pending rows for the same reminder (last op wins).
 */
export function enqueueSync(db: Database, userId: string, reminderId: string, op: 'upsert' | 'delete'): void {
  const acct = db.prepare('SELECT status FROM google_accounts WHERE user_id = ?').get(userId) as { status: string } | undefined;
  if (!acct) return;
  let eventId: string | null = null;
  try {
    const r = db.prepare('SELECT google_event_id FROM reminders WHERE id = ? AND user_id = ?').get(reminderId, userId) as { google_event_id: string | null } | undefined;
    eventId = r?.google_event_id ?? null;
  } catch {
    /* reminders table may not exist in isolated tests */
  }
  const prev = db.prepare('SELECT event_id FROM outbox WHERE user_id = ? AND reminder_id = ? ORDER BY id DESC LIMIT 1').get(userId, reminderId) as { event_id: string | null } | undefined;
  db.prepare('DELETE FROM outbox WHERE user_id = ? AND reminder_id = ?').run(userId, reminderId);
  db.prepare('INSERT INTO outbox (user_id, reminder_id, op, event_id, attempts, next_attempt_at, created_at) VALUES (?,?,?,?,0,0,?)').run(
    userId, reminderId, op, eventId ?? prev?.event_id ?? null, new Date().toISOString(),
  );
  trigger?.(userId);
}

export const pendingOps = (db: Database, userId: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE user_id = ?').get(userId) as { n: number }).n;
