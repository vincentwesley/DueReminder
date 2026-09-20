// One-command dev: mock Google (if present) + API (tsx watch) + Vite frontend (if present).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (existsSync('.env')) {
  try { process.loadEnvFile('.env'); } catch { /* ignore */ }
}
const env = { ...process.env };
env.API_PORT ??= '4000';
env.WEB_PORT ??= '5173';
env.MOCK_GOOGLE_PORT ??= '4010';
env.DEMO_MODE ??= '1';

const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const firstExisting = (...c) => c.find((p) => existsSync(join(root, p)));

const procs = [];
function run(name, color, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
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

const mockEntry = firstExisting('mock-google/index.ts', 'mock-google/server.ts', 'mock-google/main.ts', 'mock-google/src/index.ts', 'mock-google/src/server.ts', 'mock-google/src/main.ts');
if (mockEntry) run('mock-google', 35, [tsx, 'watch', mockEntry], { PORT: env.MOCK_GOOGLE_PORT });
else console.log('[dev] mock-google/ entry not found, skipping');

run('api', 36, [tsx, 'watch', '--clear-screen=false', 'server/src/index.ts']);

if (existsSync(join(root, 'web', 'index.html')) && existsSync(vite)) {
  run('web', 33, [vite, 'web', '--port', env.WEB_PORT, '--host', 'localhost'], { API_PORT: env.API_PORT });
} else console.log('[dev] web/ not found, skipping frontend');

console.log(`[dev] api http://localhost:${env.API_PORT}  web http://localhost:${env.WEB_PORT}  demo=${env.DEMO_MODE}`);

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
