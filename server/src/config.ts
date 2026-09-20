import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AppConfig {
  port: number;
  host: string;
  webPort: number;
  demoMode: boolean;
  dbPath: string;
  sessionSecret: string;
  nodeEnv: string;
  defaultTimezone: string;
  webDist: string;
  googleClientId: string;
  googleClientSecret: string;
  googleAuthBase: string;
  googleApiBase: string;
  oauthRedirectUri: string;
  logger: boolean;
}

const WEAK_SECRET = /change[-_ ]?me|dev-insecure|placeholder|your[-_ ]secret|replace[-_ ]me/i;

/** Why a SESSION_SECRET is unacceptable for production, or null when it is fine. */
export function sessionSecretProblem(secret: string | undefined | null): string | null {
  if (!secret) return 'is not set';
  if (WEAK_SECRET.test(secret)) return 'looks like a placeholder value';
  if (secret.length < 32) return 'is shorter than 32 characters';
  return null;
}

let ephemeralSecret: string | undefined;

/**
 * Development-only secret: random, persisted next to the database in a gitignored file so encrypted
 * tokens survive restarts. In-memory databases get a per-process random secret.
 */
function localDevSecret(dbPath: string): string {
  if (dbPath === ':memory:') return (ephemeralSecret ??= randomBytes(32).toString('hex'));
  const file = join(dirname(dbPath), '.session-secret');
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim();
      if (!sessionSecretProblem(existing)) return existing;
    }
    mkdirSync(dirname(file), { recursive: true });
    const fresh = randomBytes(32).toString('hex');
    writeFileSync(file, `${fresh}\n`, { mode: 0o600 });
    return fresh;
  } catch {
    return (ephemeralSecret ??= randomBytes(32).toString('hex'));
  }
}

/** Production, or any deployment with demo mode off (real accounts), must not run on a weak secret. */
export const isStrict = (c: { nodeEnv: string; demoMode: boolean }) => c.nodeEnv === 'production' || !c.demoMode;

export function loadConfig(overrides: Partial<AppConfig> = {}, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.API_PORT ?? 4000);
  const cfg = buildConfig(port, overrides, env);
  if (cfg.nodeEnv === 'production' && cfg.demoMode) {
    throw new Error('DEMO_MODE must be off when NODE_ENV=production: demo login creates unauthenticated sessions.');
  }
  const problem = sessionSecretProblem(cfg.sessionSecret);
  if (problem) {
    if (isStrict(cfg)) {
      throw new Error(`SESSION_SECRET ${problem}. Set SESSION_SECRET to 32+ random characters, e.g. node -e "console.log(require('crypto').randomBytes(32).toString('hex'))". It derives the Google token encryption key.`);
    }
    cfg.sessionSecret = localDevSecret(cfg.dbPath);
  }
  return cfg;
}

function buildConfig(port: number, overrides: Partial<AppConfig>, env: NodeJS.ProcessEnv): AppConfig {
  return {
    port,
    host: env.API_HOST ?? '::',
    webPort: Number(env.WEB_PORT ?? 5173),
    demoMode: env.DEMO_MODE === '1' || env.DEMO_MODE === 'true',
    dbPath: env.DB_PATH ?? './data/reminders.db',
    sessionSecret: env.SESSION_SECRET ?? '',
    nodeEnv: env.NODE_ENV ?? 'development',
    defaultTimezone: env.DEFAULT_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    webDist: env.WEB_DIST ?? 'web/dist',
    googleClientId: env.GOOGLE_CLIENT_ID ?? 'mock-client-id',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? 'mock-client-secret',
    googleAuthBase: env.GOOGLE_AUTH_BASE ?? 'http://localhost:4010',
    googleApiBase: env.GOOGLE_API_BASE ?? 'http://localhost:4010',
    oauthRedirectUri: env.OAUTH_REDIRECT_URI ?? `http://localhost:${port}/api/auth/callback`,
    logger: env.LOG !== '0' && env.NODE_ENV !== 'test' && !env.VITEST,
    ...overrides,
  };
}
