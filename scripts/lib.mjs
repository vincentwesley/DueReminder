// Shared by dev.mjs and e2e-server.mjs.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** Apply D1 migrations to the local DB (`persistTo` for an isolated one). Returns the spawnSync result. */
export const migrateLocal = (persistTo) =>
  spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', ...(persistTo ? ['--persist-to', persistTo] : [])], { cwd: root, stdio: 'inherit' });

/** Kill a child and its process tree (taskkill on Windows, SIGTERM elsewhere). */
export function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}
