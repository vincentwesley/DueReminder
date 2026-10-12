# Connecting real Google Calendar

The app runs fully offline in demo mode against a local fake Google (`mock-google`, port 4010). Follow these steps only when you want to sync with your real Google Calendar.

Scopes are requested in two steps. **Sign-in** asks only for `openid email profile`. **Calendar sync**, a separate opt-in step from the sync menu, asks for `https://www.googleapis.com/auth/calendar.events` (create/edit/delete events; the app only ever touches events it created) using incremental authorization (`include_granted_scopes`). Tokens stay on the server, encrypted at rest (AES-256-GCM, key derived from `SESSION_SECRET`); the browser only ever holds an HttpOnly session cookie.

## Steps

1. **Create a Cloud project.** Open <https://console.cloud.google.com/projectcreate>, name it (for example `reminder-system`) and click Create. Make sure it is selected in the project picker.
2. **Enable the Calendar API.** Go to <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com> and click Enable.
3. **Configure the OAuth consent screen.** Go to APIs & Services > OAuth consent screen (in the newer console: Google Auth Platform > Branding / Audience).
   - User type: External (Internal only if you have a Google Workspace org).
   - App name: `Reminder System`; set your email as user support and developer contact.
   - Data access / Scopes: add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` and `https://www.googleapis.com/auth/calendar.events`.
   - Audience / Publishing status: keep it in **Testing** while you try it out. In Testing, only accounts listed under **Test users** can sign in (add yours, up to 100), and refresh tokens expire after 7 days (the UI then shows "Reconnect needed"). Moving to Production needs Google verification because of the sensitive calendar scope.
   - Privacy policy / terms links (needed for verification): `https://<app>.workers.dev/privacy` and `https://<app>.workers.dev/terms`.
4. **Create credentials.** APIs & Services > Credentials > Create credentials > OAuth client ID.
   - Application type: **Web application**.
   - Authorized redirect URIs: add both of these (each must match the redirect the app sends character for character, no trailing slash). One URI serves sign-in and the calendar step.
     - Local dev: `http://localhost:5173/api/auth/callback` (the Vite dev origin; Vite proxies `/api` to the Worker on :4000, and `OAUTH_REDIRECT_URI` in `.dev.vars` must equal it).
     - Deployed Worker: `https://<app>.workers.dev/api/auth/callback` (your real workers.dev subdomain, or a custom domain). Leave `OAUTH_REDIRECT_URI` empty in production to use `<origin>/api/auth/callback`.
   - Click Create and copy the Client ID and Client secret.
5. **Paste keys into `.dev.vars`** (created by `npm run dev`, or copy `.dev.vars.example`). When deployed, store the three secrets with Wrangler instead; each command prompts for the value and nothing goes in git:
   ```
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET
   ```
   Local `.dev.vars`:
   ```
   GOOGLE_CLIENT_ID=<your client id>.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=<your client secret>
   SESSION_SECRET=<32+ random characters, e.g. output of: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   GOOGLE_AUTH_BASE=https://accounts.google.com
   GOOGLE_API_BASE=https://www.googleapis.com
   OAUTH_REDIRECT_URI=http://localhost:5173/api/auth/callback
   ```
   The Worker refuses to serve in production, or with `DEMO_MODE=0`, if `SESSION_SECRET` is missing, shorter than 32 characters or an example value. Changing it later makes stored tokens undecryptable; the account then shows "reconnect needed" and you reconnect.
6. **Switch demo mode off.** Set `DEMO_MODE=0` in `.dev.vars`. The Worker refuses to run with `DEMO_MODE=1` while `GOOGLE_AUTH_BASE` points at real Google, so demo data can never talk to the real API.
7. **Restart** (`npm run dev`) and open <http://localhost:5173>. Click Sign in with Google (`/api/auth/google/start`) and approve the basic profile. Then open the sync menu and click Connect Google Calendar (`/api/auth/google/calendar`) and approve the calendar permission. Declining the second step keeps you signed in with sync off. If you see "Google hasn't verified this app", choose Advanced > Continue (expected for your own Testing-mode project).
8. **Verify.** In the app, toggle "Sync to Google Calendar" on a reminder that has a due date. A 15-minute event (all-day if the reminder is all-day) appears in your primary calendar within a couple of seconds; edit the event in Google Calendar and click Sync now to see the change locally.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `redirect_uri_mismatch` | Redirect URI in step 4 differs from `OAUTH_REDIRECT_URI`. |
| `access_denied` / "app not verified" | Add your account under Test users (step 3). |
| Status "reauth required" | Refresh token revoked or expired (Testing mode: 7 days). Click Reconnect Google. |
| No refresh token | The app requests `access_type=offline&prompt=consent`; if you removed a previous grant at <https://myaccount.google.com/permissions>, reconnect. |
| Sync shows "offline" | Network to Google unreachable; queued changes are retried automatically and when the browser comes online. |
| "N changes could not be pushed to Google" | A push failed permanently or exhausted its 8 retries. It stays flagged; fix the cause and press Sync now, or edit the reminder to re-queue it. |
| 429 / rate limit | Handled automatically with exponential backoff (1s doubling, 5 min cap, honours `Retry-After`). |

## Going back to the demo

Set `DEMO_MODE=1`, point `GOOGLE_AUTH_BASE` and `GOOGLE_API_BASE` at `http://localhost:4010`, and restart. Test client id/secret `mock-client-id` / `mock-client-secret` are fine.
