// CLI entry: `npx tsx mock-google/server.ts` (port from MOCK_GOOGLE_PORT, default 4010).
import { startMockGoogle } from './index';

const h = await startMockGoogle({ port: Number(process.env.MOCK_GOOGLE_PORT ?? 4010), logger: process.env.MOCK_LOG === '1' });
console.log(`mock-google listening on ${h.url}`);
const stop = () => { void h.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
