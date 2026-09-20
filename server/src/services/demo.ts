import type { Ctx } from './reminders.js';
import { createReminder, defaultListId, completeReminder } from './reminders.js';
import { createList, findOrCreateTag } from './lists.js';
import { startOfDay } from './tz.js';

/** Seeds sample data (overdue, today, upcoming, recurring, completed) when the user has no reminders. */
export async function seedDemoData(ctx: Ctx, userId: string): Promise<void> {
  const count = (ctx.db.prepare('SELECT COUNT(*) AS c FROM reminders WHERE user_id = ?').get(userId) as { c: number }).c;
  if (count === 0) {
    const tz = ctx.config.defaultTimezone;
    const inbox = defaultListId(ctx.db, userId);
    const work = createList(ctx, userId, { name: 'Work', color: '#3b82f6' }).id;
    const home = createList(ctx, userId, { name: 'Personal', color: '#10b981' }).id;
    const urgent = findOrCreateTag(ctx, userId, 'urgent', '#ef4444').id;
    const errands = findOrCreateTag(ctx, userId, 'errands', '#f59e0b').id;
    const now = Date.now();
    const day = (n: number, h = 9) => new Date(startOfDay(tz, now, n) + h * 3600_000).toISOString();
    const at = (min: number) => new Date(now + min * 60_000).toISOString();
    const mk = (title: string, extra: Record<string, unknown> = {}) => createReminder(ctx, userId, { title, listId: inbox, timezone: tz, ...extra } as never);
    mk('Submit expense report', { listId: work, priority: 3, dueAt: day(-2, 17), tagIds: [urgent] });
    mk('Call the dentist', { listId: home, priority: 2, dueAt: day(-1, 10) });
    mk('Team standup', { listId: work, dueAt: at(90), rrule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', calendarSync: true });
    mk('Buy groceries', { listId: home, priority: 1, dueAt: at(240), tagIds: [errands] });
    mk('Plan the weekend trip', { listId: home, dueAt: day(3, 12), notes: 'Check train times and book a hotel.' });
    mk('Quarterly review prep', { listId: work, priority: 2, dueAt: day(7, 9), calendarSync: true });
    mk('Water the plants', { dueAt: day(0, 8), rrule: 'FREQ=WEEKLY;BYDAY=SU', allDay: false });
    mk('Read a book chapter');
    const done = mk('Renew passport', { listId: home, dueAt: day(-3, 9) });
    completeReminder(ctx, userId, done.id);
  }
  await ctx.hooks.onDemoSeed?.(ctx.db, userId);
}
