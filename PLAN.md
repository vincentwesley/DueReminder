# Reminder System - Plan

## 1. Overview
Responsive PWA reminder app (lists, tags, priorities, due dates, recurrence, natural-language quick-add) with optional two-way sync of dated reminders to Google Calendar. Everything runs and is tested with no real credentials via a mock Google server and demo mode. Stack: see DECISIONS.md. Shared contract types: `shared/types.ts` (import as `@shared/types`).

## 2. Architecture
```
Browser PWA (React, IndexedDB cache, SW) --/api (cookie session)--> Cloudflare Worker (Hono) <--> D1 (SQLite)
                                                                      |  cron (every minute): Google sync
                                                                      |  OAuth + Calendar HTTP (fetch)
                                                                      v
                                                   Google (real)  OR  mock-google (:4010, Node, dev/tests only)
```
One Worker serves `/api/*` (Hono) and the built UI (`web/dist` via the Workers Assets binding, SPA fallback; the Worker runs first so it can add CSP/security headers). In dev, `wrangler dev` (:4000, local D1) is proxied by the Vite dev server (:5173) at `/api`. Google base URLs come from vars (`GOOGLE_AUTH_BASE`, `GOOGLE_API_BASE`), so mock <-> real is config only. The Worker exports `fetch` and `scheduled`; there is no long-lived process, so syncing is cron-driven (plus a `waitUntil` kick after local writes) and the client refetches on focus and every 60s instead of holding an SSE stream.

## 3. Folder layout and ownership
```
shared/types.ts                      contract types (planner-owned; change only with PLAN.md update)
shared/schemas.ts                    zod schemas mirroring types (WP-B)
migrations/*.sql                     D1 schema (wrangler d1 migrations)
wrangler.jsonc                       Worker, D1 binding (placeholder id), assets, cron, production vars
server/src/                          WP-B backend (worker.ts, app.ts, scheduled.ts, config.ts, db/, routes/, services/, nlp/)
server/src/google/                   WP-O oauth, Google client, sync engine (WebCrypto token crypto)
mock-google/                         WP-O mock server (Node, Fastify; dev tool, unchanged by the Workers port)
web/                                 WP-F frontend (index.html, vite.config.ts, src/, public/)
tests/unit, tests/integration        WP-T (integration = Hono app in Node + real local D1 + mock-google)
e2e/, playwright.config.ts, vitest.config.ts   WP-T
docs/, README.md                     WP-D
scripts/dev.mjs, scripts/e2e-server.mjs   dev stack and the Playwright app server
```
Root files (package.json, tsconfig.json, .dev.vars.example) belong to the orchestrator; agents needing a new dependency request it or add only their own deps and report it.

## 4. Data model (D1 / SQLite; schema in migrations/0001_init.sql; mirrors shared/types.ts)
- users(id, email UNIQUE, google_sub, name, picture_url, demo INT, created_at)
- sessions(id, user_id, expires_at)
- lists(id, user_id, name, color, sort_order, created_at, updated_at, deleted_at)
- tags(id, user_id, name UNIQUE per user, color)
- reminders(id, user_id, list_id, title, notes, status, priority, due_at, all_day, timezone, rrule, snoozed_until, completed_at, calendar_sync, google_event_id, google_etag, created_at, updated_at, deleted_at, version)
- reminder_tags(reminder_id, tag_id)
- google_accounts(user_id PK, google_sub, email, access_token_enc, refresh_token_enc, expires_at, scope, calendar_id, sync_token, last_sync_at, status, last_error)
- outbox(id, user_id, reminder_id, op 'upsert'|'delete', attempts, next_attempt_at, last_error, created_at)
- oauth_states(state PK, code_verifier, created_at) - 10 min TTL, single use
- idempotency_keys(key PK, user_id, response_json, created_at) - 24h TTL
- Tokens encrypted at rest with AES-256-GCM (WebCrypto), key derived from SESSION_SECRET with HKDF-SHA-256. Soft deletes so deletions sync.
- Recurring reminders: one row holds the RRULE; completing advances `dueAt` to the next occurrence (server computes via rrule). `status=done` and `completedAt` are set only when the series has no further occurrence.

## 5. API contract (JSON, prefix `/api`, cookie session `__Host-rs_session`, errors = `ApiError`)
| Method Path | Request | Response |
|---|---|---|
| GET /health | - | `{ok:true, demo:boolean}` |
| GET /me | - | `User` or 401 |
| POST /demo/login | - | `User` (sets cookie; seeds sample data if empty; only when DEMO_MODE=1, else 404) |
| POST /auth/logout | - | 204 |
| GET /auth/google/start | - | 302 to Google authorize URL (state + PKCE stored server side) |
| GET /auth/callback?code&state | - | 302 to `/` after creating session + google_accounts |
| GET /lists | - | `List[]` |
| POST /lists | `{name,color?}` | `List` 201 |
| PATCH /lists/:id | `{name?,color?,sortOrder?}` | `List` |
| DELETE /lists/:id | - | 204 (soft; reminders move to default list) |
| GET /tags; POST /tags `{name,color?}`; DELETE /tags/:id | | `Tag[]`; `Tag` 201; 204 |
| GET /reminders?filter=today\|upcoming\|overdue\|all\|done&listId&tagId&q&cursor&limit(<=200) | | `ListReminders` |
| GET /reminders/:id | | `Reminder` |
| POST /reminders | `ReminderCreate` | `Reminder` 201 |
| PATCH /reminders/:id | `ReminderPatch`; stale `version` -> 409 `conflict` with current `Reminder` in `details` | `Reminder` |
| POST /reminders/:id/complete and /uncomplete | - | `Reminder` (recurring advances) |
| POST /reminders/:id/snooze | `{until: ISODateTime}` or `{minutes:number}` | `Reminder` |
| DELETE /reminders/:id | - | 204 |
| POST /reminders/quick-add | `{text, now?, timezone?}` (`?preview=1` = parse only) | `{parsed:QuickAddParse, reminder?:Reminder}` |
| GET /sync/state | - | `SyncState` |
| POST /sync/run | - | `SyncState` (returns after one sync cycle) |
| POST /sync/disconnect | - | `SyncState` (revokes token, clears link) |
| PATCH /sync/settings | `{calendarId?:string}` | `SyncState` |

Quick-add grammar: chrono-node for dates ("tomorrow 5pm"), "every monday 9am" / "daily" / "weekly" mapped to RRULE, `!1..!3` or `!high|!med|!low` priority, `#tag`, `@list`.
Offline: client writes go to an IndexedDB mutation queue and replay with an `Idempotency-Key` header (server dedupes 24h); UI shows an offline badge.
Session cookie: `__Host-rs_session` (HttpOnly, Secure, SameSite=Lax, Path=/); local http dev sets `INSECURE_COOKIES=1` for plain `rs_session`. CSRF: state-changing calls require header `X-Requested-With: fetch`.
List defaults: every user has a default list named "Inbox" (created on first login).

## 6. OAuth flow (Authorization Code + PKCE)
Scopes: `openid email profile https://www.googleapis.com/auth/calendar.events`; `access_type=offline`, `prompt=consent` on first link.
1. `/auth/google/start`: create `state` (32 random bytes) and PKCE `code_verifier`; store in `oauth_states`; redirect to `${GOOGLE_AUTH_BASE}/o/oauth2/v2/auth` with S256 `code_challenge`.
2. `/auth/callback`: validate state (single-use), POST `${GOOGLE_AUTH_BASE}/token` with code, verifier, client id/secret, redirect uri. Validate `id_token` claims (iss, aud, exp; signature via JWKS for real Google; skipped for the mock).
3. Upsert user by `sub`, encrypt and store tokens, set session cookie, redirect `/`.
4. Refresh: before each Google call, if `expires_at - 60s < now`, refresh (single-flight per user). `invalid_grant` -> status `reauth_required`, stop sync, surface in UI.

## 7. Two-way Google Calendar sync
- Mapping: reminder with `calendarSync && dueAt` <-> event on `calendarId` (default `primary`). `extendedProperties.private.reminderId` links events; `googleEventId` + `googleEtag` stored. Timed reminder = 15-minute event; allDay = all-day event. RRULE -> `recurrence: ["RRULE:..."]`. Done = title prefixed with a check mark and `transparency: transparent`.
- Push (local -> Google): each write to a synced reminder enqueues an outbox row; worker drains it: insert/patch (`If-Match: etag`), delete for tombstones. Idempotent via reminderId.
- Pull (Google -> local): `events.list` with `syncToken`; first run is a full list (timeMin 30 days ago), then stores `nextSyncToken`. HTTP 410 -> discard token, full resync. Cancelled events -> soft-delete local. Events lacking reminderId are ignored in v1.
- Triggers: `POST /sync/run`, after local writes (`waitUntil`), and the cron (every minute; users with a live session, oldest-synced first, bounded batch per run). No webhooks.
- Conflicts: last-writer-wins comparing Google `updated` vs local `updatedAt`; on 412 refetch event, apply LWW, bump `conflictsResolved`. Completion is done-wins.
- Rate limits/errors: 403 rate-limit reasons, 429, 5xx -> exponential backoff with full jitter (base 1s, x2, cap 5 min, max 8 attempts, honour `Retry-After`), stored in `outbox.next_attempt_at`. 401 -> refresh once, then `reauth_required`. Network failure -> `offline`, outbox retained, retry next tick and on browser `online`.

## 8. Mock Google server (`mock-google/`, port 4010)
Standalone in-memory server, also importable as `startMockGoogle({port})` for integration tests.
- `GET /o/oauth2/v2/auth`: fake consent page ("Approve as demo@example.com"; `?auto=1` auto-approves); validates client_id, redirect_uri, code_challenge; redirects with `code`+`state`.
- `POST /token`: `authorization_code` (verifies PKCE, else `invalid_grant`) and `refresh_token`; returns access_token (configurable ttl), refresh_token, unsigned id_token, expires_in.
- `GET /oauth2/v3/userinfo`, `POST /revoke`.
- Calendar v3 subset: `GET/POST /calendar/v3/calendars/:cal/events`, `GET/PATCH/DELETE .../events/:id`; `syncToken`/`nextSyncToken`, `updatedMin`, ETag + `If-Match` (412), `showDeleted`, 410 for expired sync tokens. Bearer token required (401 when expired).
- Test controls: `POST /__mock/config {failNext:{status,count}, latencyMs, tokenTtlSec, expireSyncToken}`, `POST /__mock/events` (simulate an edit in Google UI), `POST /__mock/reset`, `GET /__mock/state`.

## 9. Demo mode
`DEMO_MODE=1`: `POST /demo/login` creates a demo user with seeded lists/tags/reminders (overdue, today, recurring, completed) and pre-links the mock Google account. UI shows a Demo banner. Default in `.dev.vars.example`, so a fresh clone works with `npm run dev`.

## 10. Frontend scope (WP-F)
Sidebar (Today/Upcoming/Overdue/All/Done, lists, tags), reminder list with inline complete, quick-add bar with live parse preview, detail drawer (date, repeat, list, tags, priority, notes, calendar toggle), sync/settings panel (connect/disconnect, status, last sync, conflicts), keyboard shortcuts, light/dark, mobile bottom nav, PWA manifest + service worker, Notification API for due reminders, IndexedDB cache + mutation queue. Required `data-testid`s: `quick-add-input`, `reminder-item`, `complete-btn`, `sync-status`, `demo-login`, `sync-connect`, `offline-badge`.

## 11. Work packages (parallel, disjoint ownership)
| WP | Scope | Owns | Depends on |
|---|---|---|---|
| WP-B Backend | API, DB, migrations, quick-add NLP, recurrence, dev script | `server/src/**` except `server/src/google/**`; `shared/schemas.ts`; `scripts/dev.mjs` | `shared/types.ts` |
| WP-O OAuth + Google + Mock | OAuth routes, token store/refresh, Calendar client, sync engine, mock server | `server/src/google/**`, `mock-google/**` | `shared/types.ts` |
| WP-F Frontend | PWA UI | `web/**` | section 5 contract; runs against real backend/mock |
| WP-T Testing | Vitest unit + integration, Playwright E2E, fixtures | `tests/**`, `e2e/**`, `playwright.config.ts`, `vitest.config.ts` | others' contracts |
| WP-D Docs | README, setup, architecture, troubleshooting | `README.md`, `docs/**` | all |

Interface agreements:
- DB handle: the D1 binding `env.DB` (structural `Db` type in `server/src/db/index.ts`, helpers `q/one/many/exec/batch`; multi-statement writes use `batch`). Google tables live in the same migration.
- WP-O exports `googleRoutes()` (Hono sub-app: auth + sync routes) from `server/src/google/index.ts` and `enqueueSync(db, userId, reminderId, op)` from `server/src/google/outbox.ts`. WP-B services call `enqueueSync` after every write to a `calendarSync` reminder and then `ctx.kick(userId)`.
- WP-B exports `createApp(deps?)` (Hono app) from `server/src/app.ts` and `runScheduled(env)` from `server/src/scheduled.ts`; `server/src/worker.ts` is the entry (`fetch` + `scheduled`).
- Order: B, O, F start together; T begins with unit tests (quick-add, recurrence, backoff, PKCE), then integration once B+O land; D last.

## 12. Dev and scripts
`npm run dev` (`scripts/dev.mjs`) creates `.dev.vars` (random SESSION_SECRET) if missing, applies local D1 migrations, and starts mock-google (4010), `wrangler dev` (4000, local D1 under `.wrangler/`) and Vite (5173, proxies `/api`). `npm run build` = typecheck + Vite build. `npm run deploy` = build + `wrangler deploy` (create the D1 database first, see README). `npm run db:migrate:local` / `db:migrate:remote` apply `migrations/`. `npm test` = Vitest (integration tests start an in-memory local D1 through wrangler's `getPlatformProxy`; @cloudflare/vitest-pool-workers was not used because it requires Vitest 4 and the repo is on 5). `npm run test:e2e` = Playwright (headless; `scripts/e2e-server.mjs` builds the UI, migrates a fresh local D1 and runs `wrangler dev` with DEMO_MODE=1, plus mock Google).
Environment note: global `~/.npmrc` has a dead proxy; project `.npmrc` (gitignored) overrides it. Recreate with `proxy=null` / `https-proxy=null` if missing.

## 13. Definition of done
Typecheck clean; unit + integration tests pass; Playwright covers: demo login, quick-add, complete, recurring advance, connect mock Google, edit-in-mock appears locally, offline queue replay, reauth flow.
