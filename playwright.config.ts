import { defineConfig, devices } from '@playwright/test';

// Isolated ports so E2E never collides with `npm run dev`.
const APP = 4100;
const MOCK = 4110;

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1, // one shared local-D1 server + mock
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
      // wrangler dev (local D1, DEMO_MODE=1) serving API + built UI; see scripts/e2e-server.mjs for the vars.
      command: 'node scripts/e2e-server.mjs',
      url: `http://localhost:${APP}/api/health`,
      env: { E2E_APP_PORT: String(APP), E2E_MOCK_PORT: String(MOCK) },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
