import type { Db } from './db/index.js';
import { randomHex } from './util.js';
import { resolveGoogleConfig, type GoogleConfig } from './google/config.js';

/** Worker bindings and vars. Everything except DB is optional text (see .dev.vars.example). */
export interface Env {
  DB: Db;
  /** Static assets binding (web/dist); absent in unit tests. */
  ASSETS?: { fetch(req: Request): Promise<Response> };
  SESSION_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_AUTH_BASE?: string;
  GOOGLE_API_BASE?: string;
  GOOGLE_TOKEN_URL?: string;
  GOOGLE_REVOKE_URL?: string;
  OAUTH_REDIRECT_URI?: string;
  POST_LOGIN_REDIRECT?: string;
  DEMO_MODE?: string;
  DEMO_PRELINK?: string;
  NODE_ENV?: string;
  DEFAULT_TIMEZONE?: string;
  AUTH_RATE_LIMIT?: string;
  BODY_LIMIT_BYTES?: string;
  /** 1 = plain `rs_session` cookie without Secure (http://localhost dev); default is `__Host-rs_session`. */
  INSECURE_COOKIES?: string;
  /** 0 = do not kick a sync after local writes (cron still syncs). */
  AUTO_SYNC?: string;
}

export interface AppConfig {
  demoMode: boolean;
  sessionSecret: string;
  nodeEnv: string;
  defaultTimezone: string;
  /** Max requests per minute per client IP on login/callback/demo routes. */
  authRateLimit: number;
  /** Max request body size in bytes. */
  bodyLimitBytes: number;
  insecureCookies: boolean;
  autoSync: boolean;
  demoPrelink: boolean;
  google: GoogleConfig;
}

const WEAK_SECRET = /change[-_ ]?me|dev-insecure|example[-_ ]value|your[-_ ]secret|replace[-_ ]me/i;

/** Why a SESSION_SECRET is unacceptable for production, or null when it is fine. */
export function sessionSecretProblem(secret: string | undefined | null): string | null {
  if (!secret) return 'is not set';
  if (WEAK_SECRET.test(secret)) return 'looks like an example value';
  if (secret.length < 32) return 'is shorter than 32 characters';
  return null;
}

/** Production, or any deployment with demo mode off (real accounts), must not run on a weak secret. */
export const isStrict = (c: { nodeEnv: string; demoMode: boolean }) => c.nodeEnv === 'production' || !c.demoMode;

const on = (v: string | undefined) => v === '1' || v === 'true';
// ponytail: per-isolate random secret for demo/dev only (never strict deployments); tokens saved under it need a reconnect after an isolate restart. Set SESSION_SECRET in .dev.vars to avoid.
let ephemeralSecret: string | undefined;

type Vars = Partial<Omit<Env, 'DB' | 'ASSETS'>>;

export function loadConfig(env: Vars = {}, overrides: { fetch?: typeof fetch } = {}): AppConfig {
  const demoMode = on(env.DEMO_MODE);
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production' && demoMode) {
    throw new Error('DEMO_MODE must be off when NODE_ENV=production: demo login creates unauthenticated sessions.');
  }
  let sessionSecret = env.SESSION_SECRET ?? '';
  const problem = sessionSecretProblem(sessionSecret);
  if (problem) {
    if (isStrict({ nodeEnv, demoMode })) {
      throw new Error(`SESSION_SECRET ${problem}. Set SESSION_SECRET to 32+ random characters (wrangler secret put SESSION_SECRET). It derives the Google token encryption key.`);
    }
    sessionSecret = ephemeralSecret ??= randomHex(32);
  }
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    demoMode,
    sessionSecret,
    nodeEnv,
    defaultTimezone: env.DEFAULT_TIMEZONE ?? 'UTC',
    authRateLimit: num(env.AUTH_RATE_LIMIT, 30),
    bodyLimitBytes: num(env.BODY_LIMIT_BYTES, 262_144),
    insecureCookies: on(env.INSECURE_COOKIES),
    autoSync: env.AUTO_SYNC !== '0',
    demoPrelink: env.DEMO_PRELINK === '1',
    google: resolveGoogleConfig({ demoMode, sessionSecret, nodeEnv, fetch: overrides.fetch }, env),
  };
}
