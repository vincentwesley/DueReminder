// Zod schemas mirroring shared/types.ts.
import { z } from 'zod';

export const isoDateTime = z.iso.datetime({ offset: true });
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #RRGGBB');
export const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

export const SubtaskInputSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(200),
  done: z.boolean().optional(),
});
export const SubtaskPatchSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), done: z.boolean().optional() });

const reminderFields = z
  .object({
    listId: z.string().min(1),
    notes: z.string().max(20000),
    status: z.enum(['open', 'done']),
    priority: prioritySchema,
    dueAt: isoDateTime.nullable(),
    allDay: z.boolean(),
    timezone: z.string().min(1).max(100),
    rrule: z.string().max(500).nullable(),
    snoozedUntil: isoDateTime.nullable(),
    tagIds: z.array(z.string()).max(50),
    calendarSync: z.boolean(),
    subtasks: z.array(SubtaskInputSchema).max(100),
  })
  .partial();

export const ReminderCreateSchema = z.object({ title: z.string().trim().min(1).max(500) }).extend(reminderFields.shape);
export const ReminderPatchSchema = ReminderCreateSchema.partial().extend({ version: z.number().int().optional() });

export const ListCreateSchema = z.object({ name: z.string().trim().min(1).max(100), color: colorSchema.optional() });
export const ListPatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  color: colorSchema.optional(),
  sortOrder: z.number().int().optional(),
});
export const TagCreateSchema = z.object({ name: z.string().trim().min(1).max(50), color: colorSchema.optional() });

export const SnoozeSchema = z.union([
  z.object({ until: isoDateTime }),
  z.object({ minutes: z.number().positive().max(60 * 24 * 365) }),
]);

export const QuickAddSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  now: isoDateTime.optional(),
  timezone: z.string().optional(),
});

export const ReminderQuerySchema = z.object({
  filter: z.enum(['today', 'upcoming', 'overdue', 'all', 'done']).default('all'),
  listId: z.string().optional(),
  tagId: z.string().optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  tz: z.string().optional(),
});
