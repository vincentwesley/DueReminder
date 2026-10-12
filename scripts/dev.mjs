// One-command dev: mock Google + the Worker (`wrangler dev`, local D1 + static assets) + Vite frontend (proxies /api to the Worker).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

// .dev.vars (gitignored) feeds wrangler dev. Create it from the example with a random SESSION_SECRET on first run.
if (!existsSync('.dev.vars')) {
  copyFileSync('.dev.vars.example', '.dev.vars');
  writeFileSync('.dev.vars', readFileSync('.dev.vars', 'utf8').replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${randomBytes(32).toString('hex')}`));
  console.log('[dev] created .dev.vars with a random SESSION_SECRET');
}

const env = { ...process.env };
env.API_PORT ??= '4000';
env.WEB_PORT ??= '5173';
env.MOCK_GOOGLE_PORT ??= '4010';
env.API_URL ??= `http://localhost:${env.API_PORT}`; // read by web/vite.config.ts

const node = process.execPath;
const bin = (...p) => join(root, 'node_modules', ...p);
const tsx = bin('tsx', 'dist', 'cli.mjs');
const vite = bin('vite', 'bin', 'vite.js');
const wrangler = bin('wrangler', 'bin', 'wrangler.js');

mkdirSync(join(root, 'web', 'dist'), { recursive: true }); // wrangler needs the assets directory to exist (Vite serves the UI in dev)
spawnSync(node, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local'], { cwd: root, stdio: 'inherit' });

const procs = [];
function run(name, color, args, extraEnv = {}) {
  const child = spawn(node, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(tag + l + '\n');
    });
  }
  child.on('exit', (code) => console.log(`${tag}exited (${code})`));
  procs.push(child);
}

if (existsSync(join(root, 'mock-google', 'server.ts'))) run('mock-google', 35, [tsx, 'watch', 'mock-google/server.ts'], { MOCK_GOOGLE_PORT: env.MOCK_GOOGLE_PORT });
run('worker', 36, [wrangler, 'dev', '--port', env.API_PORT, '--ip', 'localhost', '--test-scheduled']);
if (existsSync(join(root, 'web', 'index.html')) && existsSync(vite)) run('web', 33, [vite, 'web', '--port', env.WEB_PORT, '--host', 'localhost']);

console.log(`[dev] worker http://localhost:${env.API_PORT}  web http://localhost:${env.WEB_PORT}  (cron: curl "http://localhost:${env.API_PORT}/__scheduled")`);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) {
    if (p.exitCode !== null || !p.pid) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else p.kill('SIGTERM');
  }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', stop);
