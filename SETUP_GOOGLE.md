# Connecting real Google Calendar

The app runs fully offline in demo mode against a local fake Google (`mock-google`, port 4010). Follow these steps only when you want to sync with your real Google Calendar.

Scope requested: `openid email profile https://www.googleapis.com/auth/calendar.events` (create/edit/delete events only; no access to calendar settings or other calendars' ACLs). Tokens stay on the server, encrypted at rest (AES-256-GCM, key derived from `SESSION_SECRET`); the browser only ever holds an HttpOnly session cookie.

## Steps

1. **Create a Cloud project.** Open <https://console.cloud.google.com/projectcreate>, name it (for example `reminder-system`) and click Create. Make sure it is selected in the project picker.
2. **Enable the Calendar API.** Go to <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com> and click Enable.
3. **Configure the OAuth consent screen.** Go to APIs & Services > OAuth consent screen (in the newer console: Google Auth Platform > Branding / Audience).
   - User type: External (Internal only if you have a Google Workspace org).
   - App name: `Reminder System`; set your email as user support and developer contact.
   - Data access / Scopes: add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` and `https://www.googleapis.com/auth/calendar.events`.
   - Audience / Test users: while the app is in "Testing", add the Google account(s) you will sign in with. Only listed test users can connect. (Testing-mode refresh tokens expire after 7 days; publish to Production, or just reconnect when the UI shows "reauth required".)
4. **Create credentials.** APIs & Services > Credentials > Create credentials > OAuth client ID.
   - Application type: **Web application**.
   - Authorized redirect URIs: add exactly `http://localhost:4000/api/auth/callback` (must match `OAUTH_REDIRECT_URI` character for character, including port and no trailing slash). For a deployed host use its `https://` URL, for example `https://reminders.example.com/api/auth/callback`.
   - Click Create and copy the Client ID and Client secret.
5. **Paste keys into `.env`** (copy `.env.example` to `.env` if you have not yet):
   ```
   GOOGLE_CLIENT_ID=<your client id>.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=<your client secret>
   SESSION_SECRET=<32+ random characters, e.g. output of: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   GOOGLE_AUTH_BASE=https://accounts.google.com
   GOOGLE_API_BASE=https://www.googleapis.com
   OAUTH_REDIRECT_URI=http://localhost:4000/api/auth/callback
   ```
   Changing `SESSION_SECRET` later makes stored tokens undecryptable; you would have to reconnect.
6. **Switch demo mode off.** Set `DEMO_MODE=0` in `.env`. The server refuses to start with `DEMO_MODE=1` while `GOOGLE_AUTH_BASE` points at real Google, so demo data can never talk to the real API.
7. **Restart** (`npm run dev`) and open <http://localhost:5173>. Click Connect Google (start URL: `/api/auth/google/start`), pick your account, and approve the calendar permission. If you see "Google hasn't verified this app", choose Advanced > Continue (expected for your own Testing-mode project).
8. **Verify.** In the app, toggle "Sync to Google Calendar" on a reminder that has a due date. A 15-minute event (all-day if the reminder is all-day) appears in your primary calendar within a couple of seconds; edit the event in Google Calendar and click Sync now to see the change locally.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `redirect_uri_mismatch` | Redirect URI in step 4 differs from `OAUTH_REDIRECT_URI`. |
| `access_denied` / "app not verified" | Add your account under Test users (step 3). |
| Status "reauth required" | Refresh token revoked or expired (Testing mode: 7 days). Click Connect Google again. |
| No refresh token | The app requests `access_type=offline&prompt=consent`; if you removed a previous grant at <https://myaccount.google.com/permissions>, reconnect. |
| Sync shows "offline" | Network to Google unreachable; queued changes are retried automatically and when the browser comes online. |
| 429 / rate limit | Handled automatically with exponential backoff (1s doubling, 5 min cap, honours `Retry-After`). |

## Going back to the demo

Set `DEMO_MODE=1`, point `GOOGLE_AUTH_BASE` and `GOOGLE_API_BASE` at `http://localhost:4010`, and restart. Test client id/secret `mock-client-id` / `mock-client-secret` are fine.
