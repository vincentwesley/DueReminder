# Decisions

## Form factor
| Option | Pros | Cons |
|---|---|---|
| Responsive PWA | One codebase for desktop+phone, installable, offline via service worker, Web Push/Notifications, easiest OAuth redirect flow, best Playwright testability | Notification reliability on iOS/background limited |
| Desktop (Electron/Tauri) | Native tray/notifications | Heavy packaging, per-OS builds, slower to test, OAuth loopback complexity |
| CLI | Fast to build | Poor UX for reminders, no visual polish, weak notifications |

**Choice: responsive PWA** with a small Node backend.

## Stack
- TypeScript 5, single npm package (no workspaces; top-level dirs own code). Simpler tooling, ownership by directory.
- Frontend: React 19 + Vite + vite-plugin-pwa (service worker, manifest).
- Backend: Hono 4 on Cloudflare Workers + zod 4 validation (was Fastify 5; see the 2026-10-12 Workers entry).
- DB: Cloudflare D1 (SQLite; was better-sqlite3). Client caches in IndexedDB for offline (WP-F).
- NLP quick-add: chrono-node. Recurrence: rrule (RFC5545).
- Tests: Vitest (unit; integration runs the Hono app in Node against a real local D1) + Playwright (E2E against `wrangler dev`) with mock Google.
- Dev orchestration: scripts/dev.mjs (wrangler dev + Vite + mock Google), tsx for the mock server.

## Environment note
The user's global ~/.npmrc sets a dead proxy (proxy.example.com:8080), which breaks npm. A local, gitignored project `.npmrc` overrides it (`proxy=null`, `https-proxy=null`). Global config was not modified.

## 2026-09-20 - Vitest 3.2 -> 4.1.11
`npm audit` flagged vitest/@vitest/mocker (path traversal, GHSA-82fw-gwwq-j7x9; dev-only). Upgraded to vitest 4.1.11 (engines ^20 || ^22 || >=24, fine on Node 20.17; 5.x needs Node 22 so not used). All tests green, audit reports 0 vulnerabilities.

## 2026-10-12 - Node 24, build tooling bump
Pinned Node 24 (`.nvmrc`, `engines.node >=24`). Vite 6 -> 8.3.4 (Rolldown: `manualChunks` is now a function), vite-plugin-pwa 2.0.0, Vitest 4.1.11 -> 5.0.3, @types/node 24. @vitejs/plugin-react stays on 5.2.0: 6.x's optional babel peer conflicts with workbox's Babel 7 (ERESOLVE). better-sqlite3 stays on 12 (rebuild native module after switching Node).

## 2026-10-12 - Port to Cloudflare Workers + D1 (Hono)
Fastify + better-sqlite3 became a Hono Worker + D1 (`wrangler.jsonc`, `migrations/`). Choices and changed behaviour:
- Crypto via WebCrypto only: AES-256-GCM tokens with an HKDF-derived key (ciphertext prefix `v2:`, so v1 scrypt tokens would need a reconnect; nothing was deployed), RS256 id_token verification via `crypto.subtle`, ids/state/PKCE via `crypto.getRandomValues`. No `nodejs_compat`.
- Sync runs from the `scheduled` handler (every minute, users with a live session, 10 per run, oldest-synced first) plus a `waitUntil` kick after local writes instead of the 2s debounce. In-flight de-duplication is per isolate (noted `ponytail:`; add a D1 lease if duplicate events appear).
- The auth rate limiter is an in-memory per-isolate map (noted `ponytail:`; upgrade to a `ratelimits` binding). `run_worker_first` keeps the CSP-with-script-hashes behaviour for the SPA shell.
- Dropped: per-user SSE stream and its connection-cap test and config (the client never used it; it refetches on focus and every 60s), CORS (dev is same-origin through the Vite proxy), the dev-secret file (`data/.session-secret`; demo/dev falls back to a per-isolate random secret, `npm run dev` writes a random one into `.dev.vars`), Fastify socket timeouts and `TRUST_PROXY` (client IP comes from `cf-connecting-ip`).
- Cookie is `__Host-rs_session` (and `__Host-rs_oauth`); `INSECURE_COOKIES=1` selects the plain names for http://localhost.
- `@cloudflare/vitest-pool-workers` 0.23 needs Vitest ^4.1 and the repo runs Vitest 5, so integration tests use Node + wrangler's `getPlatformProxy` (a real local D1). `miniflare` is not a direct dependency (wrangler 4.149 pins an alpha 5.x with a different constructor API).
- `fastify` stays as a devDependency only because `mock-google/` (unchanged dev tool) is built on it. D1 limits (100 bound parameters, no interactive transactions) are handled by chunking `IN (...)` lists and `batch()`.
