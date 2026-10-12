import type { Ctx } from '../ctx.js';
import { one } from '../db/index.js';
import { onDemoSeed } from '../google/index';
import { createList, findOrCreateTag } from './lists.js';
import { completeReminder, createReminder, defaultListId } from './reminders.js';
import { startOfDay } from './tz.js';

/** Seeds sample data (overdue, today, upcoming, recurring, completed) when the user has no reminders. */
export async function seedDemoData(ctx: Ctx, userId: string): Promise<void> {
  const count = (await one<{ c: number }>(ctx.db, 'SELECT COUNT(*) AS c FROM reminders WHERE user_id = ?', userId))!.c;
  if (count === 0) {
    const tz = ctx.config.defaultTimezone;
    const inbox = await defaultListId(ctx.db, userId);
    const work = (await createList(ctx, userId, { name: 'Work', color: '#3b82f6' })).id;
    const home = (await createList(ctx, userId, { name: 'Personal', color: '#10b981' })).id;
    const urgent = (await findOrCreateTag(ctx, userId, 'urgent', '#ef4444')).id;
    const errands = (await findOrCreateTag(ctx, userId, 'errands', '#f59e0b')).id;
    const now = Date.now();
    const day = (n: number, h = 9) => new Date(startOfDay(tz, now, n) + h * 3600_000).toISOString();
    const at = (min: number) => new Date(now + min * 60_000).toISOString();
    const mk = (title: string, extra: Record<string, unknown> = {}) => createReminder(ctx, userId, { title, listId: inbox, timezone: tz, ...extra } as never);
    await mk('Submit expense report', { listId: work, priority: 3, dueAt: day(-2, 17), tagIds: [urgent] });
    await mk('Call the dentist', { listId: home, priority: 2, dueAt: day(-1, 10) });
    await mk('Team standup', { listId: work, dueAt: at(90), rrule: 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', calendarSync: true });
    await mk('Buy groceries', { listId: home, priority: 1, dueAt: at(240), tagIds: [errands] });
    await mk('Plan the weekend trip', { listId: home, dueAt: day(3, 12), notes: 'Check train times and book a hotel.' });
    await mk('Quarterly review prep', { listId: work, priority: 2, dueAt: day(7, 9), calendarSync: true });
    await mk('Water the plants', { dueAt: day(0, 8), rrule: 'FREQ=WEEKLY;BYDAY=SU', allDay: false });
    await mk('Read a book chapter');
    const done = await mk('Renew passport', { listId: home, dueAt: day(-3, 9) });
    await completeReminder(ctx, userId, done.id);
  }
  await onDemoSeed(ctx, userId);
}
