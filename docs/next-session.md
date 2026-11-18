> Update at the end of any session that changed state. Keep it lean.

Continue work on **Reminder System** (repo `vincentwesley/DueReminder`, not deployed).
v1 verified in demo mode; all checks green on Node 24. Only do what the owner asks.

## Before anything
1. Work in `C:\Coding Projects\reminder-system`; read `DECISIONS.md`, `PLAN.md`, `docs/ARCHITECTURE.md`.
2. `eval "$(fnm env)" && fnm use 24`.
3. Run `bash "/c/Coding Projects/_house/check-identity.sh"` before any push.

## How to work here
- Commit as `vincentwesley` noreply only. Do not push or change visibility without an OK.
- Checks: `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `npx playwright test` (headless only; starts `wrangler dev`).
- `CLAUDE.md`, `graphify-out/` and `.claude/` are gitignored; keep them untracked.

## Current state
- Backend ported to Cloudflare Workers + D1 (Hono); verified locally in demo mode (React PWA, mock Google for e2e). Not deployed: `wrangler.jsonc` has a placeholder D1 id (README, Deploy to Cloudflare). Undo for complete/delete/snooze shipped.
- Done: house reskin; two-step Google OAuth (sign-in = `openid email profile`; `/api/auth/google/calendar` adds `calendar.events`; mock models both); `DELETE /api/account` + `GET /api/account/export` + Settings UI; static `/privacy` and `/terms` (`web/public/`); strict CSP/headers (`web/public/_headers` + app.ts; the inline-script hash normalises CRLF); axe e2e (`e2e/a11y.spec.ts`).
- Before deploy: privacy/terms contact is the GitHub issues URL; Google verification is needed for the sensitive calendar scope outside Testing mode.
- Live Google has never been tested.

- Brand: draggable Vin's Atelier logo in the credits sign-off (`web/src/brand/`, `BrandLogo.tsx`); radios in Settings; pre-paint via external `web/public/logo-init.js`; spec `e2e/logo.spec.ts`.
- Fixed 2026-11-17: foreground `loadAll` refetches when a local write landed mid-fetch (boot race lost quick-add/offline-create items). Visual-check 375/1280 dark+light: axe clean on login, app, privacy; credits sign-off OK.

## Known gaps / ideas
1. Live Google OAuth and Calendar sync untested against the real API.
2. @vitejs/plugin-react pinned to 5.x (6.x peer conflict with workbox's Babel 7).
3. Report outcomes in a line or two.
4. Rate limiter and sync/token single-flight are per isolate (needs a D1 lease, Durable Object or ratelimit binding).
5. INSECURE_COOKIES flag: derive from request scheme instead.
6. CSP inline-script hashing runs at request time (memoised per ETag); move to build time.
7. N+1 queries in sync pull (sync.ts applyRemoteEvent loop, pull page fetch).
8. enqueueSync issues 5 sequential statements; batch them.
- 2026-11-17: logo spec waits for the --logo-x transition before measuring (15s polls).
- 2026-11-17: re-copied kit tokens.css per UPGRADING.md (credits.css still older kit; needs markup change). Known: e2e/a11y.spec.ts fails label-content-name-mismatch on .account (aria-label vs visible name), predates the re-copy.
- 2026-11-18: fixed label-content-name-mismatch (account chip name = visible name, avatar initial via CSS; More button label starts with "More"); a11y spec green.
