# Decisions

## Form factor
| Option | Pros | Cons |
|---|---|---|
| Responsive PWA | One codebase for desktop+phone, installable, offline via service worker, Web Push/Notifications, easiest OAuth redirect flow, best Playwright testability | Notification reliability on iOS/background limited |
| Desktop (Electron/Tauri) | Native tray/notifications | Heavy packaging, per-OS builds, slower to test, OAuth loopback complexity |
| CLI | Fast to build | Poor UX for reminders, no visual polish, weak notifications |

**Choice: responsive PWA** with a small Node backend.

## Stack (versions verified to install on Node 20.17.0 / npm 10.8.2)
- TypeScript 5, single npm package (no workspaces; top-level dirs own code). Simpler tooling, ownership by directory.
- Frontend: React 19 + Vite 6 + vite-plugin-pwa (service worker, manifest). Vite 8/vitest 5 need Node >=20.19/22, so we pin Vite 6 / Vitest 3.
- Backend: Fastify 5 + zod 4 validation. Chosen over Express for typed schemas and speed.
- DB: SQLite via better-sqlite3 12 (sync API, prebuilt binary works on Win/Node 20; v13 requires Node 22). Client caches in IndexedDB for offline (WP-F).
- NLP quick-add: chrono-node. Recurrence: rrule (RFC5545).
- Tests: Vitest (unit/integration, Fastify inject) + Playwright (E2E) against mock Google.
- Dev orchestration: concurrently 9, tsx for running TS.

## Environment note
The user's global ~/.npmrc sets a dead proxy (proxy.example.com:8080), which breaks npm. A local, gitignored project `.npmrc` overrides it (`proxy=null`, `https-proxy=null`). Global config was not modified.
