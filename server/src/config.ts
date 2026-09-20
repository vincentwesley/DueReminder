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

export function loadConfig(overrides: Partial<AppConfig> = {}, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.API_PORT ?? 4000);
  return {
    port,
    host: env.API_HOST ?? '::',
    webPort: Number(env.WEB_PORT ?? 5173),
    demoMode: env.DEMO_MODE === '1' || env.DEMO_MODE === 'true',
    dbPath: env.DB_PATH ?? './data/reminders.db',
    sessionSecret: env.SESSION_SECRET ?? 'dev-insecure-session-secret-change-me',
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
