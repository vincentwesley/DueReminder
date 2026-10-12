// Playwright's app server: builds the UI, applies migrations to a throwaway local D1, then runs `wrangler dev` in demo mode.
// Ports are isolated from `npm run dev`. State lives in test-results/ (gitignored) and is wiped on every start.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { killTree, migrateLocal, root, wrangler } from './lib.mjs';

process.chdir(root);
const APP = process.env.E2E_APP_PORT ?? '4100';
const MOCK = process.env.E2E_MOCK_PORT ?? '4110';
const state = join(root, 'test-results', 'wrangler-e2e');
const node = process.execPath;
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const must = (r) => { if (r.status !== 0) process.exit(r.status ?? 1); };
must(spawnSync(node, [vite, 'build', '--config', 'web/vite.config.ts'], { stdio: 'inherit' }));
rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });
must(migrateLocal(state));

const vars = {
  NODE_ENV: 'development',
  DEMO_MODE: '1',
  DEMO_PRELINK: '0',
  INSECURE_COOKIES: '1',
  AUTH_RATE_LIMIT: '10000',
  SESSION_SECRET: 'e2e-session-secret-0123456789abcdef',
  DEFAULT_TIMEZONE: 'UTC',
  GOOGLE_CLIENT_ID: 'mock-client-id',
  GOOGLE_CLIENT_SECRET: 'mock-client-secret',
  GOOGLE_AUTH_BASE: `http://localhost:${MOCK}`,
  GOOGLE_API_BASE: `http://localhost:${MOCK}`,
  OAUTH_REDIRECT_URI: `http://localhost:${APP}/api/auth/callback`,
  POST_LOGIN_REDIRECT: '/',
};
const args = [wrangler, 'dev', '--port', APP, '--ip', 'localhost', '--persist-to', state, ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
const child = spawn(node, args, { stdio: ['ignore', 'inherit', 'inherit'] });
child.on('exit', (code) => process.exit(code ?? 0));
const stop = () => {
  killTree(child);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
