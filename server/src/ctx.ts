import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import type { GoogleCtx } from './google/config';

/** Per-request services bundle handed to routes and services. */
export interface Ctx {
  db: Db;
  config: AppConfig;
  google: GoogleCtx;
  /** Start a background sync for this user after a local write (no-op when AUTO_SYNC=0). */
  kick(userId: string): void;
}
