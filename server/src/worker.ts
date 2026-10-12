import type { ExecutionContext } from 'hono';
import { createApp } from './app.js';
import type { Env } from './config.js';
import { runScheduled } from './scheduled.js';

const app = createApp();

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  scheduled: (_event: unknown, env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>) => { ctx.waitUntil(runScheduled(env)); },
};
