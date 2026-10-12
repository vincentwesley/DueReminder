import type { Context } from 'hono';
import type { User } from '../../../shared/types.js';
import type { Env } from '../config.js';
import type { Ctx } from '../ctx.js';

export type HonoEnv = { Bindings: Env; Variables: { ctx: Ctx; user: User | null; body: unknown } };
export type C = Context<HonoEnv>;
