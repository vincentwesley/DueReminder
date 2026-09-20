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

- **Node.js**: `>=20.17` (Node 22+ recommended; better-sqlite3 v13 requires Node 22)
- **npm**: 10.8.2+

## Quick Start

```bash
npm install
npm run dev
```

Opens <http://localhost:5173> (web), <http://localhost:4000> (API), <http://localhost:4010> (mock Google).

In demo mode (default), click "Demo" to log in with sample data. No credentials needed.

## Demo Mode vs. Real Google

**Demo mode** (default):
- Sample reminders, lists, and tags
- Mock Google Calendar server at `http://localhost:4010`
- No real credentials required
- `DEMO_MODE=1` in `.env`

**Real Google Calendar**:
1. Follow [SETUP_GOOGLE.md](./SETUP_GOOGLE.md) to create OAuth credentials
2. Paste client ID/secret into `.env`
3. Set `DEMO_MODE=0`
4. Restart `npm run dev` and click "Connect Google"

## Going Live

To deploy with real Google Calendar:
1. Set up OAuth credentials (see [SETUP_GOOGLE.md](./SETUP_GOOGLE.md))
2. Update `.env` with:
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_AUTH_BASE=https://accounts.google.com`
   - `GOOGLE_API_BASE=https://www.googleapis.com`
   - `OAUTH_REDIRECT_URI=https://yourdomain.com/api/auth/callback`
   - `SESSION_SECRET=<32+ random characters>`
   - `DEMO_MODE=0`
3. Deploy the app and database

## Production Build and Start

```bash
npm run build
npm start
```

The API serves the built web assets on `http://localhost:4000`.

## Testing

```bash
# Unit and integration tests (Vitest)
npm test

# End-to-end tests (Playwright, starts full stack)
npm run test:e2e
```

Tests run in demo mode against the mock Google server.

## Project Structure

```
shared/types.ts           Contract types (shared between client and server)
shared/schemas.ts         Zod schemas matching types

server/src/
  app.ts                  Fastify app setup
  index.ts                Server entry point
  db/                     SQLite schema and migrations
  routes/                 API endpoints (lists, tags, reminders, quick-add)
  services/               Business logic (complete, snooze, recurring)
  nlp/                    Natural language parsing (quick-add, dates, rrule)
  google/                 OAuth, Google Calendar client, sync engine

web/src/
  App.tsx                 Main layout and keyboard shortcuts
  views.ts                Route/filter logic
  store.ts                Zustand state store
  api.ts                  Client API wrapper
  notifications.ts        Web Notifications API
  theme.ts                Light/dark mode
  components/             React components (QuickAdd, ReminderItem, Editor, etc.)
  public/                 PWA manifest, service worker

mock-google/
  server.ts               Standalone mock OAuth/Calendar server

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

Copy `.env.example` to `.env` and configure:

```env
# Demo mode: 1 = use mock Google, 0 = real Google
DEMO_MODE=1

# Google OAuth (for real Google; mock server ignores these)
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_AUTH_BASE=http://localhost:4010      # Demo
GOOGLE_API_BASE=http://localhost:4010       # Demo

# Session encryption
SESSION_SECRET=your-32+-character-secret

# Ports
WEB_PORT=5173
API_PORT=4000
MOCK_GOOGLE_PORT=4010

# Database
DB_PATH=./data/reminders.db
```

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
If ports 5173, 4000, or 4010 are in use, update `.env`:
```env
WEB_PORT=3000
API_PORT=3001
MOCK_GOOGLE_PORT=3002
```
Then restart `npm run dev`.

### "DEMO_MODE=1 but GOOGLE_AUTH_BASE points at real Google"
The server refuses this for safety. Either:
- Set `DEMO_MODE=0` (use real Google), or
- Point both `GOOGLE_AUTH_BASE` and `GOOGLE_API_BASE` at `http://localhost:4010`

## More Information

- **Detailed Setup**: [SETUP_GOOGLE.md](./SETUP_GOOGLE.md)
- **Architecture & Design Decisions**: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- **Planning & API Contract**: [PLAN.md](./PLAN.md)
- **Tech Stack Justification**: [DECISIONS.md](./DECISIONS.md)
