import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';

/**
 * Integration points for WP-O's Google sync. Every member is optional: the backend works without it.
 * WP-O supplies them from server/src/google/{index,outbox,schema}.ts (see loadGoogle).
 */
export interface SyncHooks {
  /** Called after every write touching a calendarSync reminder (or one that was synced before). */
  enqueueSync(db: Db, userId: string, reminderId: string, op: 'upsert' | 'delete'): void;
  /** Called after demo user seeding so the mock Google account can be pre-linked. */
  onDemoSeed?(db: Db, userId: string): void | Promise<void>;
}

export interface GoogleModule {
  registerGoogle?: (app: FastifyInstance, deps: { db: Db; config: AppConfig }) => void | Promise<void>;
  migrate?: (db: Db) => void;
  hooks: SyncHooks;
  present: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const googleDir = join(here, '..', 'google');
const has = (f: string) => existsSync(join(googleDir, `${f}.ts`)) || existsSync(join(googleDir, `${f}.js`));

async function tryImport(spec: string): Promise<Record<string, any> | null> {
  // Variable specifier keeps tsc from requiring the module to exist.
  return (await import(/* @vite-ignore */ spec)) as Record<string, any>;
}

export async function loadGoogle(): Promise<GoogleModule> {
  const hooks: SyncHooks = { enqueueSync: () => {} };
  const mod: GoogleModule = { hooks, present: false };
  if (has('schema')) mod.migrate = (await tryImport('../google/schema.js'))?.migrate;
  if (has('outbox')) {
    const o = await tryImport('../google/outbox.js');
    if (typeof o?.enqueueSync === 'function') hooks.enqueueSync = o.enqueueSync;
  }
  if (has('index')) {
    const g = await tryImport('../google/index.js');
    mod.registerGoogle = g?.registerGoogle;
    if (typeof g?.onDemoSeed === 'function') hooks.onDemoSeed = g.onDemoSeed;
    mod.present = typeof g?.registerGoogle === 'function';
  }
  return mod;
}
