import type { FastifyInstance } from 'fastify';
import { TemplateCreateSchema, TemplatePatchSchema, TemplateUseSchema } from '../../../shared/schemas.js';
import { idParam, uidOf } from '../http/auth.js';
import type { Ctx } from '../services/reminders.js';
import { createFromTemplate, createTemplate, deleteTemplate, getTemplate, listTemplates, updateTemplate } from '../services/templates.js';

export function templateRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/templates', async (req) => listTemplates(ctx, uidOf(req)));
  app.post('/templates', async (req, reply) => reply.code(201).send(createTemplate(ctx, uidOf(req), TemplateCreateSchema.parse(req.body) as never)));
  app.get('/templates/:id', async (req) => getTemplate(ctx, uidOf(req), idParam(req)));
  app.patch('/templates/:id', async (req) => updateTemplate(ctx, uidOf(req), idParam(req), TemplatePatchSchema.parse(req.body) as never));
  app.delete('/templates/:id', async (req, reply) => { deleteTemplate(ctx, uidOf(req), idParam(req)); return reply.code(204).send(); });
  app.post('/templates/:id/create', async (req, reply) => reply.code(201).send(createFromTemplate(ctx, uidOf(req), idParam(req), TemplateUseSchema.parse(req.body))));
}
