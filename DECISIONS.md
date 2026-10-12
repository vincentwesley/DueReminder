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
- Backend: Fastify 5 + zod 4 validation. Chosen over Express for typed schemas and speed.
- DB: SQLite via better-sqlite3 12 (sync API, prebuilt binary on Win). Client caches in IndexedDB for offline (WP-F).
- NLP quick-add: chrono-node. Recurrence: rrule (RFC5545).
- Tests: Vitest (unit/integration, Fastify inject) + Playwright (E2E) against mock Google.
- Dev orchestration: concurrently 9, tsx for running TS.

## Environment note
The user's global ~/.npmrc sets a dead proxy (proxy.example.com:8080), which breaks npm. A local, gitignored project `.npmrc` overrides it (`proxy=null`, `https-proxy=null`). Global config was not modified.

## 2026-09-20 - Vitest 3.2 -> 4.1.11
`npm audit` flagged vitest/@vitest/mocker (path traversal, GHSA-82fw-gwwq-j7x9; dev-only). Upgraded to vitest 4.1.11 (engines ^20 || ^22 || >=24, fine on Node 20.17; 5.x needs Node 22 so not used). All tests green, audit reports 0 vulnerabilities.

## 2026-10-12 - Node 24, build tooling bump
Pinned Node 24 (`.nvmrc`, `engines.node >=24`). Vite 6 -> 8.3.4 (Rolldown: `manualChunks` is now a function), vite-plugin-pwa 2.0.0, Vitest 4.1.11 -> 5.0.3, @types/node 24. @vitejs/plugin-react stays on 5.2.0: 6.x's optional babel peer conflicts with workbox's Babel 7 (ERESOLVE). better-sqlite3 stays on 12 (rebuild native module after switching Node).
