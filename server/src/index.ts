import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

if (existsSync('.env')) {
  try { process.loadEnvFile('.env'); } catch { /* ignore malformed .env */ }
}

const config = loadConfig();
const app = await buildApp(config);
try {
  await app.listen({ port: config.port, host: config.host });
} catch (err: any) {
  if (config.host === '::' && (err?.code === 'EAFNOSUPPORT' || err?.code === 'EADDRNOTAVAIL')) {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } else {
    app.log.error(err);
    console.error(err);
    process.exit(1);
  }
}
console.log(`API listening on :${config.port} (demo=${config.demoMode})`);
const stop = () => { app.close().finally(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
