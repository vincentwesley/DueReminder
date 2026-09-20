import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Generous timeouts: buildApp/mock-server setup can exceed the 5s default when the CPU is loaded
  // (e.g. build + playwright running concurrently).
  test: { include: ['tests/**/*.test.ts'], exclude: ['e2e/**', 'node_modules/**'], testTimeout: 30_000, hookTimeout: 30_000 },
});
