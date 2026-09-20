import { defineConfig, devices } from '@playwright/test';

// Isolated ports so E2E never collides with `npm run dev`.
const APP = 4100;
const MOCK = 4110;

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1, // one shared in-memory server + mock
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${APP}`,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'UTC',
    locale: 'en-US',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx mock-google/server.ts',
      url: `http://localhost:${MOCK}/health`,
      env: { MOCK_GOOGLE_PORT: String(MOCK) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npx vite build --config web/vite.config.ts && npx tsx server/src/index.ts',
      url: `http://localhost:${APP}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        API_PORT: String(APP),
        WEB_PORT: String(APP),
        DEMO_MODE: '1',
        DEMO_PRELINK: '0',
        AUTH_RATE_LIMIT: '10000',
        DB_PATH: ':memory:',
        LOG: '0',
        SESSION_SECRET: 'e2e-session-secret-0123456789abcdef',
        DEFAULT_TIMEZONE: 'UTC',
        GOOGLE_AUTH_BASE: `http://localhost:${MOCK}`,
        GOOGLE_API_BASE: `http://localhost:${MOCK}`,
        OAUTH_REDIRECT_URI: `http://localhost:${APP}/api/auth/callback`,
        POST_LOGIN_REDIRECT: '/',
      },
    },
  ],
});
