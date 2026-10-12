import { Hono } from 'hono';
import { batch, many, q } from '../db/index.js';
import { AppError } from '../errors.js';
import { cookieName, dropCookie, uidOf } from '../http/auth.js';
import type { HonoEnv } from '../http/types.js';
import { getSyncState, purgeGoogleData } from '../google/sync';

// Child rows first. Explicit (not only ON DELETE CASCADE) so the result never depends on the foreign_keys pragma.
const WIPE = [
  'DELETE FROM reminder_tags WHERE reminder_id IN (SELECT id FROM reminders WHERE user_id = ?)',
  'DELETE FROM subtasks WHERE reminder_id IN (SELECT id FROM reminders WHERE user_id = ?)',
  'DELETE FROM reminders WHERE user_id = ?',
  'DELETE FROM lists WHERE user_id = ?',
  'DELETE FROM tags WHERE user_id = ?',
  'DELETE FROM templates WHERE user_id = ?',
  'DELETE FROM outbox WHERE user_id = ?',
  'DELETE FROM idempotency_keys WHERE user_id = ?',
  'DELETE FROM oauth_states WHERE user_id = ?',
  'DELETE FROM google_accounts WHERE user_id = ?',
  'DELETE FROM sessions WHERE user_id = ?',
  'DELETE FROM users WHERE id = ?',
];

export function accountRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  /** The user's data as a JSON download. Never includes tokens (the Google link is reduced to email + calendar id). */
  app.get('/account/export', async (c) => {
    const { db, google } = c.var.ctx;
    const id = uidOf(c);
    const rows = (sql: string) => many<Record<string, unknown>>(db, sql, id);
    const [lists, tags, reminders, templates] = await Promise.all([
      rows('SELECT id, name, color, sort_order, is_default, created_at, updated_at, deleted_at FROM lists WHERE user_id = ?'),
      rows('SELECT id, name, color FROM tags WHERE user_id = ?'),
      rows('SELECT id, list_id, title, notes, status, priority, due_at, all_day, timezone, rrule, snoozed_until, completed_at, calendar_sync, created_at, updated_at, deleted_at FROM reminders WHERE user_id = ?'),
      rows('SELECT id, name, title, notes, list_id, priority, all_day, timezone, rrule, tag_ids, subtasks, due_offset_minutes, time_of_day, created_at, updated_at FROM templates WHERE user_id = ?'),
    ]);
    const subtasks = await rows('SELECT s.id, s.reminder_id, s.title, s.done, s.position FROM subtasks s JOIN reminders r ON r.id = s.reminder_id WHERE r.user_id = ?');
    const reminderTags = await rows('SELECT rt.reminder_id, rt.tag_id FROM reminder_tags rt JOIN reminders r ON r.id = rt.reminder_id WHERE r.user_id = ?');
    const sync = await getSyncState(google, id);
    const body = {
      exportedAt: new Date().toISOString(),
      user: { id, email: c.var.user!.email, name: c.var.user!.name },
      googleCalendar: { connected: sync.connected, googleEmail: sync.googleEmail, calendarId: sync.calendarId },
      lists, tags, reminders, subtasks, reminderTags, templates,
    };
    c.header('content-disposition', 'attachment; filename="due-reminder-export.json"');
    return c.json(body);
  });

  /** Hard-deletes the account. CSRF header is enforced globally; the body must re-send {confirm:"delete"}. */
  app.delete('/account', async (c) => {
    const confirm = (c.var.body as { confirm?: unknown } | undefined)?.confirm;
    if (confirm !== 'delete') throw new AppError(400, 'bad_request', 'Send {"confirm":"delete"} to delete your account');
    const { db, google } = c.var.ctx;
    const id = uidOf(c);
    await purgeGoogleData(google, id);
    await batch(db, WIPE.map((sql) => q(db, sql, id)));
    dropCookie(c, cookieName(c.var.ctx.config, 'rs_session'));
    return c.body(null, 204);
  });

  return app;
}
