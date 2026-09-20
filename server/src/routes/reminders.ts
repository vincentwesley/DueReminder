import type { FastifyInstance } from 'fastify';
import type { ReminderCreate, ReminderPatch } from '../../../shared/types.js';
import { QuickAddSchema, ReminderCreateSchema, ReminderPatchSchema, ReminderQuerySchema, SnoozeSchema, SubtaskInputSchema, SubtaskPatchSchema } from '../../../shared/schemas.js';
import { parseQuickAdd } from '../nlp/quickAdd.js';
import { createList, findListByName, findOrCreateTag } from '../services/lists.js';
import {
  completeReminder, createReminder, deleteReminder, dueNotifications, getReminder, listReminders, snoozeReminder,
  editSubtasks, subtaskOps, uncompleteReminder, updateReminder, type Ctx,
} from '../services/reminders.js';
import { isValidTz } from '../services/tz.js';
import { AppError, badRequest } from '../errors.js';
import { idParam, uidOf } from '../http/auth.js';

export function reminderRoutes(app: FastifyInstance, ctx: Ctx) {
  const uid = uidOf;
  const idOf = idParam;

  app.get('/reminders', async (req) => {
    const q = ReminderQuerySchema.parse(req.query);
    return listReminders(ctx, uid(req), { ...q, tz: q.tz ?? (req.headers['x-timezone'] as string | undefined) });
  });

  // Registered before /reminders/:id so "quick-add" and "due" never match :id.
  app.post('/reminders/quick-add', async (req, reply) => {
    const body = QuickAddSchema.parse(req.body);
    const preview = (req.query as { preview?: string }).preview;
    const timezone = body.timezone ?? ctx.config.defaultTimezone;
    if (!isValidTz(timezone)) throw badRequest('Invalid timezone');
    const parsed = parseQuickAdd(body.text, { now: body.now ? new Date(body.now) : new Date(), timezone });
    if (preview === '1' || preview === 'true') return { parsed };
    const userId = uid(req);
    let listId: string | undefined;
    if (parsed.listName) listId = (findListByName(ctx, userId, parsed.listName) ?? createList(ctx, userId, { name: parsed.listName })).id;
    const tagIds = parsed.tags.map((t) => findOrCreateTag(ctx, userId, t).id);
    const input: ReminderCreate = {
      title: parsed.title, dueAt: parsed.dueAt, allDay: parsed.allDay, rrule: parsed.rrule, priority: parsed.priority, tagIds, timezone,
      ...(listId ? { listId } : {}),
    };
    const reminder = createReminder(ctx, userId, input);
    return reply.code(201).send({ parsed, reminder });
  });

  app.get('/reminders/due', async (req) => {
    const { since } = req.query as { since?: string };
    const now = new Date();
    const s = since ? new Date(since) : new Date(now.getTime() - 3600_000);
    if (Number.isNaN(s.getTime())) throw badRequest('Invalid since');
    return { now: now.toISOString(), items: dueNotifications(ctx, uid(req), s, now) };
  });

  app.get('/reminders/:id', async (req) => getReminder(ctx, uid(req), idOf(req)));

  app.post('/reminders', async (req, reply) => {
    const body = ReminderCreateSchema.parse(req.body) as ReminderCreate;
    return reply.code(201).send(createReminder(ctx, uid(req), body));
  });

  app.patch('/reminders/:id', async (req) => updateReminder(ctx, uid(req), idOf(req), ReminderPatchSchema.parse(req.body) as ReminderPatch));
  app.post('/reminders/:id/complete', async (req) => completeReminder(ctx, uid(req), idOf(req)));
  app.post('/reminders/:id/uncomplete', async (req) => uncompleteReminder(ctx, uid(req), idOf(req)));
  app.post('/reminders/:id/snooze', async (req) => snoozeReminder(ctx, uid(req), idOf(req), SnoozeSchema.parse(req.body)));
  app.post('/reminders/:id/subtasks', async (req, reply) => {
    const body = SubtaskInputSchema.parse(req.body);
    return reply.code(201).send(editSubtasks(ctx, uid(req), idOf(req), (db) => subtaskOps.addSubtask(db, idOf(req), body)));
  });
  app.patch('/reminders/:id/subtasks/:sid', async (req) => {
    const body = SubtaskPatchSchema.parse(req.body);
    const sid = (req.params as { sid: string }).sid;
    return editSubtasks(ctx, uid(req), idOf(req), (db) => subtaskOps.patchSubtask(db, idOf(req), sid, body));
  });
  app.delete('/reminders/:id/subtasks/:sid', async (req) => {
    const sid = (req.params as { sid: string }).sid;
    return editSubtasks(ctx, uid(req), idOf(req), (db) => subtaskOps.removeSubtask(db, idOf(req), sid));
  });
  app.delete('/reminders/:id', async (req, reply) => {
    deleteReminder(ctx, uid(req), idOf(req));
    return reply.code(204).send();
  });

  // SSE stream of due reminders: `event: due` with a Reminder JSON; a `: ping` comment every 25s.
  const streams = new Map<string, number>();
  app.get('/notifications/stream', (req, reply) => {
    const userId = uid(req);
    const open = streams.get(userId) ?? 0;
    if (open >= ctx.config.maxStreamsPerUser) throw new AppError(429, 'rate_limited', 'Too many open notification streams');
    streams.set(userId, open + 1);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let last = new Date();
    let ticks = 0;
    const tick = () => {
      const now = new Date();
      try {
        for (const r of dueNotifications(ctx, userId, last, now)) res.write(`event: due\ndata: ${JSON.stringify(r)}\n\n`);
        if (++ticks % 5 === 0) res.write(': ping\n\n');
      } catch { /* db closed during shutdown */ }
      last = now;
    };
    res.write(': connected\n\n');
    const timer = setInterval(tick, 5000);
    req.raw.on('close', () => {
      clearInterval(timer);
      const n = (streams.get(userId) ?? 1) - 1;
      if (n <= 0) streams.delete(userId); else streams.set(userId, n);
    });
  });
}
