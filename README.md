# Reminder System

A responsive PWA for managing reminders with two-way Google Calendar sync, recurrence, natural-language quick-add, and offline support.

## Features

- **Reminders**: Create, edit, complete reminders with notes, priorities, and due dates
- **Lists & Tags**: Organize reminders across multiple lists and tag-based collections
- **Views**: Today, Upcoming, Overdue, All, and Done views with count badges
- **Recurrence**: Repeat reminders using natural language ("every monday at 9am", "daily", "weekly") with RRULE
- **Quick-Add**: Natural-language input with live parsing preview (`"call mom tomorrow 5pm !high #family @work"`)
  - Date parsing: "tomorrow 5pm", "next friday", etc. (via chrono-node)
  - Priority: `!1..!3` or `!high|!med|!low`
  - Tags: `#tagname`
  - Lists: `@listname`
- **Notifications**: Browser notifications for due reminders with permission request
- **Google Calendar Sync**: Two-way sync of dated reminders (optional, requires credentials)
  - Sync reminders to Google Calendar events and pull changes back
  - All-day reminders → all-day events; timed → 15-minute events
  - Handles conflicts and rate limits with exponential backoff
- **Light/Dark Mode**: Theme toggle with auto option
- **Keyboard Shortcuts**: Navigation and common actions via keyboard
- **Offline**: Works offline with IndexedDB cache; changes auto-sync when back online
- **PWA**: Installable on desktop and mobile; runs standalone with service worker
- **Demo Mode**: Sample data and mock Google account for testing without credentials

## Prerequisites

- **Node.js**: 24 (see `.nvmrc`)
- **npm**
- A Cloudflare account only if you deploy (the app runs on Cloudflare Workers + D1; local dev needs no account)

## Quick Start

```bash
npm install
npm run dev
```

Opens <http://localhost:5173> (web, Vite), <http://localhost:4000> (the Worker via `wrangler dev`, with a local D1 database) and <http://localhost:4010> (mock Google). The first run creates `.dev.vars` (gitignored) with a random `SESSION_SECRET` and applies the migrations to the local database.

In demo mode (default), click "Demo" to log in with sample data. No credentials needed.

## Demo Mode vs. Real Google

**Demo mode** (default):
- Sample reminders, lists, and tags
- Mock Google Calendar server at `http://localhost:4010`
- No real credentials required
- `DEMO_MODE=1` in `.dev.vars`

**Real Google Calendar**:
1. Follow [SETUP_GOOGLE.md](./SETUP_GOOGLE.md) to create OAuth credentials
2. Paste client ID/secret into `.dev.vars` and set `GOOGLE_AUTH_BASE=https://accounts.google.com`, `GOOGLE_API_BASE=https://www.googleapis.com`
3. Set `DEMO_MODE=0`
4. Restart `npm run dev`, sign in with Google, then open the sync menu and click "Connect Google Calendar" (a second, optional consent step)

## Deploy to Cloudflare

1. `npx wrangler d1 create due-reminder`, then paste the printed `database_id` into `wrangler.jsonc` (the committed value is a placeholder; keep your real id out of git, or use a private fork).
2. `npm run db:migrate:remote` applies `migrations/*.sql`.
3. Set secrets: `npx wrangler secret put SESSION_SECRET` (32+ random characters; it derives the Google token encryption key), `npx wrangler secret put GOOGLE_CLIENT_ID`, `npx wrangler secret put GOOGLE_CLIENT_SECRET`.
4. Set `OAUTH_REDIRECT_URI` (`wrangler.jsonc` vars, or leave it empty to use `<origin>/api/auth/callback`) and add that URL to the Google OAuth client. `NODE_ENV=production`, `DEMO_MODE=0` and the real Google endpoints are already the `wrangler.jsonc` defaults.
5. `npm run deploy` builds the UI and runs `wrangler deploy`. A cron trigger (every minute) syncs Google Calendar for users with a live session.

The Worker refuses to serve with a weak `SESSION_SECRET`, and refuses `DEMO_MODE=1` when `NODE_ENV=production`. Changing the secret later makes stored Google tokens undecryptable, so accounts show "Reconnect needed".

## Testing

```bash
# Unit and integration tests (Vitest). Integration tests run the Hono app in Node against a real local D1
# (wrangler's getPlatformProxy) and the mock Google server.
npm test

# End-to-end tests (Playwright, headless): builds the UI, then starts `wrangler dev` (fresh local D1, DEMO_MODE=1) + mock Google
npm run test:e2e
```

## Project Structure

```
shared/types.ts           Contract types (shared between client and server)
shared/schemas.ts         Zod schemas matching types
migrations/               D1 schema (wrangler d1 migrations)
wrangler.jsonc            Worker, D1 binding, static assets, cron trigger

server/src/
  worker.ts               Worker entry (fetch + scheduled)
  app.ts                  Hono app: middleware, security headers, static assets
  scheduled.ts            Cron job: Google sync for active users, pruning
  config.ts               Env bindings and validated config
  db/                     D1 helpers
  routes/                 API endpoints (lists, tags, reminders, quick-add, templates)
  services/               Business logic (complete, snooze, recurring)
  nlp/                    Natural language parsing (quick-add, dates, rrule)
  google/                 OAuth, Google Calendar client, sync engine

web/src/
  App.tsx                 Main layout and keyboard shortcuts
  views.ts                Route/filter logic
  store.ts                Client state store
  api.ts                  Client API wrapper
  notifications.ts        Web Notifications API
  theme.ts                Light/dark mode
  components/             React components (QuickAdd, ReminderItem, Editor, etc.)
  public/                 PWA manifest, service worker

mock-google/
  server.ts               Standalone mock OAuth/Calendar server (Node, dev and tests only)

tests/                    Unit and integration tests
e2e/                      Playwright E2E tests

docs/                     Documentation
```

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `n` | New reminder |
| `/` | Focus search |
| `a` | Focus quick-add input |
| `j` / `k` | Next / previous reminder |
| `e` | Edit selected reminder |
| `x` | Complete selected reminder |
| `?` | Show help dialog |
| `Esc` | Close dialog |

## Architecture

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for system design, data model, API contract, and sync flow.

## Configuration

`npm run dev` copies `.dev.vars.example` to `.dev.vars` (gitignored) on first run. Names (values live only in `.dev.vars` or Cloudflare secrets):

```env
DEMO_MODE=1                 # 1 = seed demo data + mock Google, 0 = real Google
NODE_ENV=development        # production refuses DEMO_MODE=1
INSECURE_COOKIES=1          # local http only: plain `rs_session` cookie instead of Secure `__Host-rs_session`
SESSION_SECRET=             # 32+ random characters; derives the Google token encryption key
GOOGLE_CLIENT_ID= / GOOGLE_CLIENT_SECRET=
GOOGLE_AUTH_BASE= / GOOGLE_API_BASE=      # mock (http://localhost:4010) or real Google
OAUTH_REDIRECT_URI= / POST_LOGIN_REDIRECT=
```

Optional: `DEFAULT_TIMEZONE`, `DEMO_PRELINK`, `AUTO_SYNC` (0 = no sync kick after writes; cron still syncs), `AUTH_RATE_LIMIT`, `BODY_LIMIT_BYTES`. Dev ports (`API_PORT`, `WEB_PORT`, `MOCK_GOOGLE_PORT`) are read by `npm run dev` from the environment.

## Troubleshooting

### npm install fails with proxy error
The global `~/.npmrc` may have a stale proxy. The project `.npmrc` overrides it. If `npm install` fails:
```bash
# Recreate project .npmrc
cat > .npmrc << 'EOF'
proxy=null
https-proxy=null
EOF
```

### Port conflicts
If ports 5173, 4000, or 4010 are in use, set `WEB_PORT`, `API_PORT` or `MOCK_GOOGLE_PORT` in the shell before `npm run dev` (and match `OAUTH_REDIRECT_URI` / `POST_LOGIN_REDIRECT` in `.dev.vars`).

### Reset the local database
Delete the `.wrangler/` folder (gitignored) and run `npm run db:migrate:local` (or just `npm run dev`).

### Trigger the cron locally
With `wrangler dev` running: `curl "http://localhost:4000/cdn-cgi/local/scheduled"`.

### "SESSION_SECRET is not set / looks like an example value"
The Worker will not serve in production, or with `DEMO_MODE=0`, without a strong secret. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Changing it later makes stored Google tokens undecryptable, so the account shows "Reconnect needed".

### "DEMO_MODE=1 but GOOGLE_AUTH_BASE points at real Google"
The Worker refuses this for safety. Either:
- Set `DEMO_MODE=0` (use real Google), or
- Point both `GOOGLE_AUTH_BASE` and `GOOGLE_API_BASE` at `http://localhost:4010`

## More Information

- **Detailed Setup**: [SETUP_GOOGLE.md](./SETUP_GOOGLE.md)
- **Architecture & Design Decisions**: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- **Planning & API Contract**: [PLAN.md](./PLAN.md)
- **Tech Stack Justification**: [DECISIONS.md](./DECISIONS.md)

## Data, network and privacy

Provided "as is", without warranty of any kind. The deployed app serves its own policies at `/privacy` and `/terms` (`web/public/`).

- **What is stored** (Cloudflare D1; locally a SQLite file under `.wrangler/`, gitignored): the user's email, name, picture URL and Google account ID; reminders, subtasks, lists, tags, templates; session ids; and, only if the user turns on calendar sync, Google tokens encrypted with AES-256-GCM (key derived from `SESSION_SECRET`). Reminders are also cached in the browser's IndexedDB. Sign-in alone stores no Google tokens.
- **Secrets needed**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` (32+ random characters). Put them in `.dev.vars` (local, gitignored; `.dev.vars.example` lists names only) or `wrangler secret put` (deployed). Never commit them. Setup: [SETUP_GOOGLE.md](./SETUP_GOOGLE.md).
- **Network calls**: in demo mode (default) everything stays on `localhost`. With `DEMO_MODE=0` the server talks only to Google (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`) for sign-in and, if enabled, Calendar sync (only events the app created are changed). The browser loads nothing from third-party hosts (fonts and code are self-hosted); no analytics or trackers. The CSP is strict: self only, no inline scripts except hashed ones.
- **Export and delete**: in the app, account menu > Settings > "Export my data" (JSON, no tokens) or "Delete account". Delete removes every row for the user, deletes the Google events the app created (best effort, up to the 40 most recent at once; any remainder can be removed from Google Calendar manually, the events carry the app's private marker) and revokes the Google grant. API: `GET /api/account/export`, and `DELETE /api/account` with body `{"confirm":"delete"}` plus the `X-Requested-With: fetch` header. Users can also revoke access at <https://myaccount.google.com/permissions>.
- **Contact for data requests**: open an issue at <https://github.com/vincentwesley/DueReminder/issues> (no personal details in the issue).

## License

MIT, see [LICENSE](./LICENSE). Copyright (c) 2026 Vincent Wesley. Provided "as is", without warranty of any kind; use at your own risk. See [SECURITY.md](./SECURITY.md) to report a vulnerability.
