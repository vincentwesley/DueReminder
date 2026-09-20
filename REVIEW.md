# Review findings

Scope: read-only audit of the committed tree (server, mock-google, web, shared, config). vitest 69 / playwright 22 were green before the review. Screenshots are in `review-shots/` (gitignored): login, app and editor views at 390/768/1280 in light and dark, plus 320 wide.

Counts: **High 3, Medium 8, Low 10.** (Verified means I ran it or read the exact lines.)

## Clean results

- No secrets in the tree or in `git log -p` (only the `.env.example` placeholder). `.env` and `.env.*` are ignored; `.env.example` is the only tracked env file.
- Google tokens are AES-256-GCM encrypted at rest (`server/src/google/crypto.ts`). They are never in any API response: `SyncState` exposes only email, calendar id, status and error.
- OAuth: state is 32 random bytes, single use, 10 minute TTL, and bound to the browser via the `rs_oauth` cookie (`oauth.ts:415-421`). PKCE S256 is used. Nonce is checked. No open redirect: the post-login target comes from config only, and the `auth_error` value is URL-encoded.
- Cookies are HttpOnly and SameSite=Lax, and Secure when `NODE_ENV=production` (verified with inject).
- The CSRF guard (`X-Requested-With: fetch`) is a global `onRequest` hook on every non-GET `/api` call (`app.ts:71`). It is also repeated in the Google routes.
- SQL: every value is parameterised. Dynamic fragments are built only from constants (`services/reminders.ts:138,204-222`), and LIKE is escaped.
- XSS: no `dangerouslySetInnerHTML` or `innerHTML` anywhere in `web/src`. Google event titles render as React text and as Notification text.
- `/api/demo/login` returns 404 when `DEMO_MODE` is off. `/api/demo/reset` returns 401 without a session, and 404 for a non-demo user or when demo is off (verified).
- The service worker denies `/api/*` navigation fallback and has no runtime API cache, so authenticated data is not cached by the SW.
- `npm audit`: 2 moderate, both dev-only (vitest via @vitest/mocker path traversal, GHSA-82fw-gwwq-j7x9). The fix is vitest 4.x, which is a breaking bump. It is not a production risk. The mock server binds to 127.0.0.1.
- Accessibility: axe-core reported 0 violations on the login page and the app view at all 3 widths in both themes, including colour contrast. On the editor dialog it reported 2 moderate landmark issues (see L9). There is no horizontal overflow at 320, 390, 768 or 1280. Shortcuts `? n / a j e x` all work (verified). The dialog traps Tab and Escape closes it. Focus rings are 3px solid. `prefers-reduced-motion` collapses transitions (verified 1e-6s).

## High

**H1. Insecure default `SESSION_SECRET`, silently accepted in production.**
`server/src/config.ts:148` falls back to `'dev-insecure-session-secret-change-me'`. `google/config.ts:59` only checks the length is at least 16, and the fallback is longer than that. The `.env.example` placeholder `change-me-to-32+-random-chars` also passes.
- Verified: `buildApp({nodeEnv:'production'})` with no secret starts normally.
- Why it matters: the token-encryption key becomes a publicly known constant, so a leaked DB exposes Google refresh tokens.
- Fix: throw at startup when `NODE_ENV=production` and the secret is unset, shorter than 32 characters, or matches a known placeholder. Also use a per-deployment random salt or HKDF in `crypto.ts:9`.

**H2. Live mode with a non-Google `GOOGLE_AUTH_BASE` accepts unsigned id_tokens.**
`google/config.ts:297` sets `verifyIdTokenSignature = !demoMode && realGoogle`. `idtoken.ts:33-44` skips signature verification otherwise, and the nonce is only checked if present.
- Why it matters: `DEMO_MODE=0` with the default mock base, or a typo or proxy in `GOOGLE_AUTH_BASE`, lets anyone who can reach the token endpoint forge identity. `oauth.ts:366-369` also links to existing accounts by email.
- Fix: require signature verification whenever `demoMode` is false, and refuse to start when `demoMode` is false and the base is not Google. Require `nonce` and `email_verified === true` before email-linking (`oauth.ts:368`, `idtoken.ts`).

**H3. Two consecutive offline edits of the same reminder lose the second edit.**
`store.ts:295` stamps each queued PATCH with `version: cur.version`, and optimistic updates never bump the version. On replay the first PATCH bumps the server version, so the second gets 409. `store.ts:186-190` then treats every non-network error as permanent, toasts and drops it.
- Why it matters: silent data loss on the core offline promise.
- Fix: on flush, rewrite queued versions from each PATCH response, or send offline patches without `version` (last-writer-wins) and only use it for online edits. Also see M6 (401 and 5xx are dropped the same way).

## Medium

**M1. Completing an overdue recurring reminder advances only one occurrence.**
`recurrence.ts:265-275` computes the next occurrence after `dueAt`, not after now. A daily reminder 50 days overdue completes to yesterday and stays overdue (verified: 2026-08-01 -> 2026-08-02).
- Fix: loop `after()` until the result is greater than now, or advance to the first occurrence after `max(dueAt, now)`.

**M2. A DST gap permanently shifts the series by one hour.**
Verified for a daily 02:30 America/New_York reminder: Mar 7 07:30Z -> Mar 8 06:30Z (01:30 EST, because 02:30 does not exist) -> Mar 9 05:30Z (01:30 EDT). It never returns to 02:30. Cause: the next occurrence is derived from the already-shifted `due_at` (`recurrence.ts:269`, `tz.ts:308-315`). Fall-back is fine.
- Fix: store the anchor wall time (or DTSTART) in the series, or apply the gap resolution only to the displayed instance.

**M3. Session and OAuth-state growth, with no rate limiting.**
`/api/demo/login` (public) inserts a session row on every call (verified: 2 calls, 2 rows), and sessions are only deleted when read after expiry. `/api/auth/login` inserts an `oauth_states` row per call, pruned only on the next login. There is no `@fastify/rate-limit` and no body-size or connection cap.
- Fix: prune expired sessions on an interval, reuse or replace an existing session on login, cap per-IP creates, and add rate limiting on the `/auth/*` and `/demo/*` routes.

**M4. Session fixation and rotation.**
`oauth.ts:463` keeps the existing session id when it already maps to the same user, so a pre-login session id survives authentication. Rotate the session on every successful login and delete the old row.

**M5. No security headers on the static and API server.**
The response headers on `/api/health` are only vary, content-type and date (verified). There is no CSP, `X-Frame-Options` or `frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy` or HSTS. The app is frameable, which is a clickjacking risk for the one-click "complete/delete" UI.
- Fix: add `@fastify/helmet` or an `onSend` hook with a tight CSP (`default-src 'self'; img-src 'self' https://*.googleusercontent.com data:`).

**M6. Offline replay drops ops on 401 and 5xx.**
`store.ts:186-190` removes the op for every non-network error, including 401 (session expired) and 500, and still counts it in "Synced N". Keep the op on 401, 429 and 5xx, and drop it only on 4xx validation or conflict errors. `logout` (`store.ts:99`) also clears the queue without warning.

**M7. Google-side "Free" status marks the reminder done.**
`mapping.ts:451` sets `done: doneByTitle || ev.transparency === 'transparent'`. A user toggling "Show me as: Free" in Google Calendar completes the reminder locally, and completion is done-wins (`sync.ts:81`), so it can never be reopened from Google. Use only the `✓` title prefix, or track the transparency we wrote.

**M8. Retryable push error exhausted after 8 attempts silently deletes the local change.**
`sync.ts:200-207` deletes the outbox row at `MAX_ATTEMPTS`, then throws. `lastErr` is discarded, so the UI shows a generic error and the reminder is never re-pushed until edited. Keep the row in a `failed` state, or re-enqueue on the next local edit and show a persistent "N changes failed" state.

## Low

- **L1. Idempotency keys are not scoped to method, path or body** (`app.ts:79-101`). Reusing a key on a different request replays the wrong cached response. It also caches 4xx responses for 24h, and the prune `DELETE` runs on every mutation without an index on `created_at`. Hash `method + path + body` into the key and add the index.
- **L2. `serveStatic` calls `decodeURIComponent` unguarded** (`app.ts:116`). Not exploitable (it returns 400 via the error handler, verified), but wrap it in try/catch. No `cache-control` is set, so hashed assets are not cached and `sw.js` is not marked no-cache.
- **L3. Dead demo pre-link and duplicate implementations.**
  - Two `session.ts` implementations: `server/src/session.ts` and `google/session.ts`.
  - Two `PUBLIC` route lists and two CSRF guards.
  - Duplicate `SESSION_COOKIE` constants.
  - `fallbackSyncRoutes` (`routes/misc.ts:64`) and the `loadGoogle` optional-module machinery (`services/hooks.ts`) are unreachable now that Google is always present.
  - `/api/auth/login` and `/api/auth/google/start` are the same handler.
- **L4. Stale work-package comments** (`WP-B`, `WP-O` in `db/index.ts:41`, `google/config.ts:29,39`, `google/index.ts:18`, `hooks.ts:9-10`, `session.ts:20,34,59`, `shared/schemas.ts:1`). Reword them as ordinary docs. No TODO or FIXME markers were found.
- **L5. Remote events are stored without a length clamp** (`mapping.ts:445-446`). The title can exceed the 500-character API limit and notes the 20000 limit. Clamp on ingest.
- **L6. `SECONDLY`, `MINUTELY` and `HOURLY` rules are accepted** (`recurrence.ts:247-252`, `ReminderCreateSchema`). Google rejects them and the push then fails permanently. Also, `UNTIL` is UTC while the series is computed in floating local time, so the final occurrence can be off by the zone offset. Restrict FREQ to DAILY, WEEKLY, MONTHLY and YEARLY.
- **L7. Sync poller runs when any session row exists** (`google/index.ts:139`), including expired ones, because sessions are never pruned. See M3.
- **L8. `decrypt` failure after a `SESSION_SECRET` rotation is uncaught** (`tokens.ts:74`). The status becomes `error` forever instead of `reauth_required`. Catch the failure and mark reauth.
- **L9. Axe: duplicate banner and unlabeled landmarks while a dialog is open.** The dialog `<header>` and `.topbar` both count as banner landmarks. Use a `<div>` for the dialog head, or set `role="presentation"`. Also note the dialog sets `aria-modal` but the background is not `inert`.
- **L10. Small touch targets on mobile.** The complete checkbox is 24x24, and the priority filter, sort, "Add" and sync chip are 34-36px high at 390 wide. This meets WCAG 2.2 AA (24px minimum) but not the 44px comfort guideline. Consider a larger hit area on the complete button and on the sync chip (35x23).

## Live-mode config path (read from code)

Going live needs only `.env` changes, but several are mandatory and only some are validated:

- `DEMO_MODE=0`
- `GOOGLE_AUTH_BASE=https://accounts.google.com`
- `GOOGLE_API_BASE=https://www.googleapis.com`
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `OAUTH_REDIRECT_URI=https://<host>/api/auth/callback`
- `POST_LOGIN_REDIRECT=/`
- `SESSION_SECRET` (32+ random characters)
- `NODE_ENV=production`

The derived URLs are correct (token `oauth2.googleapis.com/token`, JWKS `googleapis.com/oauth2/v3/certs`, authorize `/o/oauth2/v2/auth`, `verifyIdTokenSignature` auto-on). Gaps: H1 and H2 (no production validation), `host` defaults to `::` (all interfaces), `prompt=consent` is sent on every login (the plan said first link only), and the CORS allow-list is localhost only, which is fine for same-origin production.

## Correctness notes (no defect found)

- Token refresh is single-flight per user (`tokens.ts:102-107`). Not race-safe across multiple processes, which is fine for a single SQLite instance.
- 412 handling refetches, applies last-writer-wins and counts the conflict.
- `saveAccount` (`oauth.ts:392`) delete-then-insert resets `conflicts_resolved` and `last_sync_at` on reconnect, and does not clean up events in the old calendar or the outbox when a different Google account is linked.
- The offline idempotency key is reused when a quick-add falls back to `POST /reminders`. This dedups correctly only because keys are path-agnostic, which is also L1.
