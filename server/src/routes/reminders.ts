import { Hono } from 'hono';
import type { ReminderCreate, ReminderPatch } from '../../../shared/types.js';
import { QuickAddSchema, ReminderCreateSchema, ReminderPatchSchema, ReminderQuerySchema, SnoozeSchema, SubtaskInputSchema, SubtaskPatchSchema } from '../../../shared/schemas.js';
import { badRequest } from '../errors.js';
import { on } from '../util.js';
import { idParam, uidOf } from '../http/auth.js';
import type { HonoEnv } from '../http/types.js';
import { parseQuickAdd } from '../nlp/quickAdd.js';
import { createList, findListByName, findOrCreateTag } from '../services/lists.js';
import {
  completeReminder, createReminder, deleteReminder, dueNotifications, editSubtasks, getReminder, listReminders, snoozeReminder,
  subtaskOps, uncompleteReminder, updateReminder,
} from '../services/reminders.js';
import { isValidTz } from '../services/tz.js';

export function reminderRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get('/reminders', async (c) => {
    const q = ReminderQuerySchema.parse(c.req.query());
    return c.json(await listReminders(c.var.ctx, uidOf(c), { ...q, tz: q.tz ?? c.req.header('x-timezone') }));
  });

  // Registered before /reminders/:id so "quick-add" and "due" never match :id.
  app.post('/reminders/quick-add', async (c) => {
    const { ctx } = c.var;
    const body = QuickAddSchema.parse(c.var.body);
    const preview = c.req.query('preview');
    const timezone = body.timezone ?? ctx.config.defaultTimezone;
    if (!isValidTz(timezone)) throw badRequest('Invalid timezone');
    const parsed = parseQuickAdd(body.text, { now: body.now ? new Date(body.now) : new Date(), timezone });
    if (on(preview)) return c.json({ parsed });
    const userId = uidOf(c);
    let listId: string | undefined;
    if (parsed.listName) listId = ((await findListByName(ctx, userId, parsed.listName)) ?? (await createList(ctx, userId, { name: parsed.listName }))).id;
    const tagIds: string[] = [];
    for (const t of parsed.tags) tagIds.push((await findOrCreateTag(ctx, userId, t)).id);
    const input: ReminderCreate = {
      title: parsed.title, dueAt: parsed.dueAt, allDay: parsed.allDay, rrule: parsed.rrule, priority: parsed.priority, tagIds, timezone,
      ...(listId ? { listId } : {}),
    };
    return c.json({ parsed, reminder: await createReminder(ctx, userId, input) }, 201);
  });

  app.get('/reminders/due', async (c) => {
    const since = c.req.query('since');
    const now = new Date();
    const s = since ? new Date(since) : new Date(now.getTime() - 3600_000);
    if (Number.isNaN(s.getTime())) throw badRequest('Invalid since');
    return c.json({ now: now.toISOString(), items: await dueNotifications(c.var.ctx, uidOf(c), s, now) });
  });

  app.get('/reminders/:id', async (c) => c.json(await getReminder(c.var.ctx, uidOf(c), idParam(c))));

  app.post('/reminders', async (c) => c.json(await createReminder(c.var.ctx, uidOf(c), ReminderCreateSchema.parse(c.var.body) as ReminderCreate), 201));

  app.patch('/reminders/:id', async (c) => c.json(await updateReminder(c.var.ctx, uidOf(c), idParam(c), ReminderPatchSchema.parse(c.var.body) as ReminderPatch)));
  app.post('/reminders/:id/complete', async (c) => c.json(await completeReminder(c.var.ctx, uidOf(c), idParam(c))));
  app.post('/reminders/:id/uncomplete', async (c) => c.json(await uncompleteReminder(c.var.ctx, uidOf(c), idParam(c))));
  app.post('/reminders/:id/snooze', async (c) => c.json(await snoozeReminder(c.var.ctx, uidOf(c), idParam(c), SnoozeSchema.parse(c.var.body))));
  app.post('/reminders/:id/subtasks', async (c) => {
    const body = SubtaskInputSchema.parse(c.var.body);
    return c.json(await editSubtasks(c.var.ctx, uidOf(c), idParam(c), (db) => subtaskOps.addSubtask(db, idParam(c), body)), 201);
  });
  app.patch('/reminders/:id/subtasks/:sid', async (c) => {
    const body = SubtaskPatchSchema.parse(c.var.body);
    const sid = c.req.param('sid');
    return c.json(await editSubtasks(c.var.ctx, uidOf(c), idParam(c), (db) => subtaskOps.patchSubtask(db, idParam(c), sid, body)));
  });
  app.delete('/reminders/:id/subtasks/:sid', async (c) => {
    const sid = c.req.param('sid');
    return c.json(await editSubtasks(c.var.ctx, uidOf(c), idParam(c), (db) => subtaskOps.removeSubtask(db, idParam(c), sid)));
  });
  app.delete('/reminders/:id', async (c) => {
    await deleteReminder(c.var.ctx, uidOf(c), idParam(c));
    return c.body(null, 204);
  });

  return app;
}
