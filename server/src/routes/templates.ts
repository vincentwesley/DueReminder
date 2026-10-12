import { Hono } from 'hono';
import { TemplateCreateSchema, TemplatePatchSchema, TemplateUseSchema } from '../../../shared/schemas.js';
import { idParam, uidOf } from '../http/auth.js';
import type { HonoEnv } from '../http/types.js';
import { createFromTemplate, createTemplate, deleteTemplate, getTemplate, listTemplates, updateTemplate } from '../services/templates.js';

export function templateRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.get('/templates', async (c) => c.json(await listTemplates(c.var.ctx, uidOf(c))));
  app.post('/templates', async (c) => c.json(await createTemplate(c.var.ctx, uidOf(c), TemplateCreateSchema.parse(c.var.body) as never), 201));
  app.get('/templates/:id', async (c) => c.json(await getTemplate(c.var.ctx, uidOf(c), idParam(c))));
  app.patch('/templates/:id', async (c) => c.json(await updateTemplate(c.var.ctx, uidOf(c), idParam(c), TemplatePatchSchema.parse(c.var.body) as never)));
  app.delete('/templates/:id', async (c) => { await deleteTemplate(c.var.ctx, uidOf(c), idParam(c)); return c.body(null, 204); });
  app.post('/templates/:id/create', async (c) => c.json(await createFromTemplate(c.var.ctx, uidOf(c), idParam(c), TemplateUseSchema.parse(c.var.body)), 201));
  return app;
}
