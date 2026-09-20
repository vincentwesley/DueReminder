# Reminder System Architecture

## System Overview

The Reminder System is a Google-connected reminder PWA with optional two-way Calendar sync. It consists of:

- **Browser PWA** (React, IndexedDB cache, service worker) on port 5173
- **Fastify API** (TypeScript, SQLite) on port 4000
- **Mock Google Server** (standalone, in-memory) on port 4010 for demo testing

```
┌─────────────────────────────────┐
│  Browser PWA (React + Vite)     │
│  - IndexedDB cache              │
│  - Mutation queue (offline)     │
│  - Service worker               │
│  - Notifications API            │
└──────────────┬──────────────────┘
               │
               ├── Vite proxy /api to :4000
               │   (dev: port 5173)
               │   (prod: API serves static)
               │
       ┌───────▼───────────────────┐
       │  Fastify API              │
       │  - Session cookies        │
       │  - SQLite database        │
       │  - Reminder/list/tag CRUD │
       │  - Quick-add NLP parsing  │
       │  - OAuth flow             │
       │  - Sync engine            │
       │  - Outbox worker          │
       └───────┬───────────────────┘
               │
        ┌──────▼────────────────────────────┐
        │  Google Calendar                  │
        │  - Real: https://googleapis.com   │
        │  - Demo: http://localhost:4010    │
        │  (config-driven via env)          │
        └───────────────────────────────────┘
```

## Data Model (SQLite)

### Core Tables

- **users** — Account info (email, Google sub, name, picture, demo flag)
- **sessions** — Active sessions (user_id, expiry)
- **lists** — Reminder containers (name, color, sort order, soft-delete)
- **tags** — Categories (name per user, color)
- **reminders** — Tasks with optional due date, recurrence, priority, notes
  - `status`: `'todo'` | `'done'`
  - `rrule`: RFC 5545 recurrence rule (e.g., `FREQ=DAILY;COUNT=5`)
  - `calendar_sync`: boolean (sync this reminder to Google Calendar)
  - `google_event_id`, `google_etag`: Links to Google Calendar event
  - `version`: Optimistic concurrency (prevents mid-flight edit conflicts)
- **reminder_tags** — Many-to-many join
- **google_accounts** — OAuth tokens and sync metadata (encrypted at rest, AES-256-GCM)
  - `access_token_enc`, `refresh_token_enc`: Encrypted tokens
  - `sync_token`: For incremental Calendar pull (Google's syncToken)
  - `last_sync_at`: Timestamp of last successful sync
  - `status`: `'idle'` | `'syncing'` | `'offline'` | `'error'` | `'reauth_required'`
- **outbox** — Push queue for Google Calendar changes
  - `op`: `'upsert'` | `'delete'`
  - `attempts`, `next_attempt_at`: Retry backoff (exponential, 1s base, 5 min cap, 8 max)
  - `last_error`: Debug info
- **oauth_states** — Transient PKCE/state for OAuth (10 min TTL)
- **idempotency_keys** — Deduplication for offline mutations (24h TTL)

## API Contract (JSON, `/api` prefix)

All requests include session cookie `rs_session` (HttpOnly, SameSite=Lax, Secure in prod).
State-changing calls require `X-Requested-With: fetch` header.

### Authentication
- `GET /health` → `{ok:true, demo:boolean}` (no auth)
- `POST /demo/login` → `User` (sets cookie; demo mode only)
- `GET /auth/google/start` → 302 to Google authorize
- `GET /auth/callback?code&state` → 302 to `/` after creating session
- `POST /auth/logout` → 204

### Reminders
- `GET /reminders?filter=today|upcoming|overdue|all|done&listId&tagId&q&cursor&limit`
  → `{items: Reminder[], cursor?: string}`
- `POST /reminders` ← `ReminderCreate` → `Reminder` 201
- `PATCH /reminders/:id` ← `ReminderPatch` → `Reminder`; stale `version` → 409 with current in `details`
- `DELETE /reminders/:id` → 204
- `POST /reminders/:id/complete` → `Reminder` (recurring: advances to next)
- `POST /reminders/:id/uncomplete` → `Reminder`
- `POST /reminders/:id/snooze` ← `{until:ISODateTime}|{minutes:number}` → `Reminder`
- `POST /reminders/quick-add` ← `{text, now?, timezone?}` → `{parsed:QuickAddParse, reminder?:Reminder}`
  - Add `?preview=1` to parse without creating

### Lists & Tags
- `GET /lists`, `POST /lists`, `PATCH /lists/:id`, `DELETE /lists/:id` (soft)
- `GET /tags`, `POST /tags`, `DELETE /tags/:id`

### Google Calendar Sync
- `GET /sync/state` → `SyncState` (sync status, connected, last sync, conflicts)
- `POST /sync/run` → `SyncState` (manual sync trigger)
- `POST /sync/disconnect` → `SyncState` (revoke token, clear link)
- `PATCH /sync/settings` ← `{calendarId?:string}` → `SyncState`

## Quick-Add Parsing

Natural language input is parsed into a reminder:

```
"call mom tomorrow 5pm !high #family @work"
│       │           │      │      │       │
└─title─┴─due date──┴─time─┘      │       └─ list
                                  └─ priority and tags
```

### Grammar
- **Dates**: "tomorrow 5pm", "next friday", "in 3 days" (via chrono-node)
- **Recurrence**: "every monday 9am", "daily", "weekly" → RRULE
- **Priority**: `!1`, `!2`, `!3` or `!high`, `!med`, `!low`
- **Tags**: `#tagname`
- **Lists**: `@listname`

## OAuth Flow (Authorization Code + PKCE)

1. `GET /auth/google/start`:
   - Generate 32-byte random `state` and PKCE `code_verifier`
   - Store in `oauth_states` table (10 min TTL, single-use)
   - Redirect to `${GOOGLE_AUTH_BASE}/o/oauth2/v2/auth` with code_challenge (S256)

2. User approves on Google consent screen

3. `GET /auth/callback?code&state`:
   - Validate `state` (single-use)
   - POST to `${GOOGLE_AUTH_BASE}/token` with code, verifier, client id/secret
   - Validate id_token claims (iss, aud, exp; signature via JWKS for real Google)
   - Upsert `users` by `sub` (Google's subject)
   - Encrypt and store access/refresh tokens in `google_accounts`
   - Set session cookie
   - Redirect to `/`

4. **Token refresh**: Before any Google API call, if `expires_at - 60s < now`, refresh once.
   - `invalid_grant` → status becomes `reauth_required`, sync halts, UI surfaces reconnect link

## Two-Way Google Calendar Sync

### Mapping

A reminder with `calendarSync=true` and a `dueAt`:
- **Timed reminder** (time specified) → 15-minute Google Calendar event
- **All-day reminder** → all-day Google Calendar event
- **Recurrence**: RRULE transferred as-is to `recurrence: ["RRULE:..."]`
- **Links**: Stored in:
  - Local: `reminder.google_event_id`, `reminder.google_etag`
  - Google: `extendedProperties.private.reminderId` (lookup key)
- **Done**: Prefixes title with a check mark (✓) and sets `transparency: transparent`. Only the title marker is read back as completion; a user switching an event to "Free" in Google does not complete the reminder. Remote titles and notes are clamped to the API limits (500 and 20000 characters).

### Push (local → Google)

1. User edits/completes a reminder with `calendarSync=true`
2. Server enqueues an `outbox` row (`op='upsert'` or `'delete'`)
3. Worker drains outbox:
   - **Insert/patch**: POST/PATCH with `If-Match: etag`
   - **Delete**: Issue DELETE (soft-delete locally first)
   - **Idempotent**: Via `reminderId` in `extendedProperties`
4. On **412 Precondition Failed** (ETag mismatch):
   - Refetch event from Google
   - Apply last-writer-wins (compare `updatedAt` vs Google's `updated`)
   - Bump `conflictsResolved` counter

### Pull (Google → local)

1. `POST /sync/run` or triggered by 60s poll / local write + 2s debounce
2. Query `events.list` with `syncToken` from `google_accounts`
3. **First run**: Full list (timeMin 30 days ago); store `nextSyncToken`
4. **Incremental**: Use saved `nextSyncToken`; HTTP 410 → discard token, full resync
5. **Cancelled events**: Soft-delete local reminders without an rrule; mark recurring as done if no next occurrence
6. **Unknown events** (no `reminderId`): Ignored in v1
7. **Conflicts**: Last-writer-wins comparing `updatedAt` vs Google's `updated`

### Retry & Error Handling

- **Rate limits** (403, 429) and **5xx**: Exponential backoff (1s base, ×2, 5 min cap, max 8 attempts, honour `Retry-After`)
- **Exhausted or permanently rejected pushes** are never dropped: the outbox row is kept with `failed = 1`, the sync state reports `status: error`, `failedOps` and a persistent message, and the row is retried by **Sync now** or re-queued by the next edit of that reminder
- **401 Unauthorized**: Refresh token once, then `reauth_required`
- **Network offline**: Keep outbox, retry on browser `online` event
- **Status field**: `idle`, `syncing`, `offline`, `error`, `reauth_required`

## Offline Support

1. **Write** (add/edit/complete reminder):
   - Client adds to IndexedDB mutation queue with `Idempotency-Key` header (UUID)
   - Optimistically update UI
   - Offline badge shown to user

2. **Sync when online**:
   - Browser `online` event triggers `flushQueue()`
   - Replay mutations with same `Idempotency-Key`
   - Server deduplicates via `idempotency_keys` table (24h TTL)
   - UI updates with server's response

3. **Concurrent offline & online**:
   - Each queued PATCH is rewritten with the latest version the server reported during replay, so consecutive offline edits of one reminder all apply
   - On `409` the PATCH is rebased onto the returned latest version and resent with a fresh idempotency key (the queued fields win, and the user is told); it is dropped only after repeated conflicts
   - `401`, `429` and `5xx` stop replay and keep every queued change (401 also asks the user to sign in again; 429/5xx retry after 30s). Only other 4xx errors drop an operation, with a toast
   - Signing out with unsynced changes asks for confirmation

## Demo Mode

`DEMO_MODE=1` activates:
- `POST /demo/login` endpoint (normally 404)
- Seeds sample data (lists, tags, reminders with various due dates and recurrence)
- Pre-links mock Google account (if `DEMO_PRELINK=1`)
- Mock Google server listens on port 4010
- `DB_PATH=:memory:` allowed (in-memory SQLite)

The mock server implements OAuth (with `?auto=1` auto-approve) and Calendar v3 subset with:
- In-memory event store
- ETag + `If-Match` validation
- `syncToken` / `nextSyncToken` for incremental pulls
- Test controls: `POST /__mock/config`, `POST /__mock/events`, `POST /__mock/reset`

## Session & Security

- **Session cookie**: `rs_session`, HttpOnly, SameSite=Lax, Secure (prod only). The session id is rotated on every login (demo and Google), at most 10 sessions are kept per user, and expired sessions and OAuth states are pruned every 10 minutes
- **Startup checks**: with `NODE_ENV=production` or `DEMO_MODE=0` the server refuses to start unless `SESSION_SECRET` is 32+ characters and not an example value. `DEMO_MODE=1` is refused in production, and `DEMO_MODE=0` requires `GOOGLE_AUTH_BASE=https://accounts.google.com`. In development without a secret, a random one is generated into `data/.session-secret` (gitignored)
- **ID tokens**: signature (JWKS), issuer, audience, expiry and nonce are always verified. Only the local mock in demo mode skips the signature. Accounts are matched by Google subject, or by email only when `email_verified` is true and the local account is not bound to another subject
- **Headers**: CSP (`default-src 'self'`, inline scripts allowed only by hash, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS in production, `no-store` on API responses, immutable caching only for hashed assets
- **Rate limiting**: `/api/auth/*` (login, callback) and `/api/demo/*` are limited per client IP (`AUTH_RATE_LIMIT`, default 30 per minute; set `TRUST_PROXY=1` behind a reverse proxy so the real client IP is used)
- **Idempotency keys** are scoped to user, method, path and body, and only successful responses are cached
- **CSRF**: State-changing calls require `X-Requested-With: fetch` header
- **Token encryption**: AES-256-GCM, key derived from `SESSION_SECRET` (scrypt)
- **Token storage**: Never exposed to client; only HttpOnly cookie sent

## Frontend State Management

**Zustand store** (`web/src/store.ts`):
- `user`: Current authenticated user
- `reminders`: Array of reminder objects (from server + local mutations)
- `lists`, `tags`: Collections
- `selectedId`: Currently selected reminder (for keyboard nav)
- `search`: Search query string
- `editing`: Edit mode (reminder id or 'new')
- `sync`: Google Calendar sync state
- `online`: Boolean (from `navigator.onLine` + events)
- `pending`: Count of mutations awaiting sync
- `toasts`: Notification messages

**IndexedDB cache** (`web/src/api.ts`):
- Stores reminders, lists, tags locally
- Mutation queue (pending writes while offline)
- Replayed on reconnect with idempotency keys

## Project Ownership (Work Packages)

| Module | Owns | Depends on |
|---|---|---|
| **Backend (WP-B)** | `server/src/**` (except google/), `shared/schemas.ts`, `scripts/dev.mjs` | `shared/types.ts` |
| **OAuth & Sync (WP-O)** | `server/src/google/**`, `mock-google/**` | `shared/types.ts` |
| **Frontend (WP-F)** | `web/**` | API contract (section 5 above) |
| **Testing (WP-T)** | `tests/**`, `e2e/**`, `vitest.config.ts`, `playwright.config.ts` | All modules' public contracts |
| **Docs (WP-D)** | `README.md`, `docs/**` | All modules |

## Tech Stack

- **Frontend**: React 19, Vite 6, vite-plugin-pwa (service worker + manifest)
- **Backend**: Fastify 5, Zod 4 (schema validation)
- **Database**: SQLite (better-sqlite3 12; Node 20.17 compatible)
- **Dates & Recurrence**: chrono-node (parsing), rrule (RFC 5545)
- **Testing**: Vitest 3 (unit/integration), Playwright 1.50 (E2E)
- **Dev orchestration**: concurrently 9, tsx (TypeScript runner)

## Further Reading

- **Feature Planning & API Details**: [PLAN.md](../PLAN.md)
- **Stack & Tool Choices**: [DECISIONS.md](../DECISIONS.md)
- **Google OAuth Setup**: [SETUP_GOOGLE.md](../SETUP_GOOGLE.md)
