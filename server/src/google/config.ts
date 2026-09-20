import type { Database } from 'better-sqlite3';
import { isStrict, sessionSecretProblem } from '../config.js';

export const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.events'];
export { SESSION_COOKIE } from '../http/auth.js';
export const OAUTH_COOKIE = 'rs_oauth';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  demoMode: boolean;
  /** e.g. http://localhost:4010 (mock) or https://accounts.google.com */
  authBase: string;
  /** e.g. http://localhost:4010 (mock) or https://www.googleapis.com */
  apiBase: string;
  redirectUri: string;
  tokenUrl: string;
  revokeUrl: string;
  /** Where to send the browser after login. */
  postLoginRedirect: string;
  secureCookies: boolean;
  /** Background poll interval; 0 disables the poller. */
  pollMs: number;
  /** Debounce after local writes; 0 disables auto-sync on write. */
  debounceMs: number;
  /** Verify id_token signature via JWKS (real Google only). */
  verifyIdTokenSignature: boolean;
  requestTimeoutMs: number;
  /** Optional hook to create the default list or seed data for a newly created user. */
  onUserCreated?: (db: Database, userId: string) => void;
  fetch?: typeof fetch;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** Merge explicit config over environment defaults. Accepts extra keys (the app config may be a superset). */
export function resolveGoogleConfig(partial: Partial<GoogleConfig> | Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): GoogleConfig {
  const raw = partial as Partial<GoogleConfig> & Record<string, unknown>;
  // Accept the app config naming (googleClientId, oauthRedirectUri, ...) as well as the Google module's own.
  const p: Partial<GoogleConfig> = {
    ...raw,
    clientId: raw.clientId ?? (raw.googleClientId as string | undefined),
    clientSecret: raw.clientSecret ?? (raw.googleClientSecret as string | undefined),
    authBase: raw.authBase ?? (raw.googleAuthBase as string | undefined),
    apiBase: raw.apiBase ?? (raw.googleApiBase as string | undefined),
    redirectUri: raw.redirectUri ?? (raw.oauthRedirectUri as string | undefined),
    secureCookies: raw.secureCookies ?? (raw.nodeEnv === undefined ? undefined : raw.nodeEnv === 'production'),
  };
  const demoMode = p.demoMode ?? (env.DEMO_MODE === '1' || env.DEMO_MODE === 'true');
  const mockPort = env.MOCK_GOOGLE_PORT ?? '4010';
  const authBase = trimSlash(p.authBase ?? env.GOOGLE_AUTH_BASE ?? `http://localhost:${mockPort}`);
  const apiBase = trimSlash(p.apiBase ?? env.GOOGLE_API_BASE ?? `http://localhost:${mockPort}`);
  const realGoogle = /(^|\/\/)accounts\.google\.com$/.test(authBase);
  if (demoMode && realGoogle) {
    throw new Error('DEMO_MODE=1 must not point GOOGLE_AUTH_BASE at real Google. Use the mock or set DEMO_MODE=0.');
  }
  const nodeEnv = (raw.nodeEnv as string | undefined) ?? env.NODE_ENV ?? 'development';
  if (!demoMode && !realGoogle) {
    throw new Error('DEMO_MODE=0 requires GOOGLE_AUTH_BASE=https://accounts.google.com; a non-Google auth base is only allowed in demo mode against the local mock.');
  }
  const sessionSecret = p.sessionSecret ?? env.SESSION_SECRET ?? '';
  const problem = sessionSecretProblem(sessionSecret);
  if (problem && (isStrict({ nodeEnv, demoMode }) || sessionSecret.length < 16)) {
    throw new Error(`SESSION_SECRET ${problem} (32+ random characters required) - it derives the token encryption key.`);
  }
  // Unsigned id_tokens are accepted only from the local mock in demo mode; everything else is verified against JWKS.
  const localMock = demoMode && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(authBase);
  const verifyIdTokenSignature = p.verifyIdTokenSignature ?? !localMock;
  if (!verifyIdTokenSignature && !localMock) {
    throw new Error('id_token signature verification can only be disabled for the local mock in demo mode.');
  }
  return {
    clientId: p.clientId ?? env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: p.clientSecret ?? env.GOOGLE_CLIENT_SECRET ?? '',
    sessionSecret,
    demoMode,
    authBase,
    apiBase,
    redirectUri: p.redirectUri ?? env.OAUTH_REDIRECT_URI ?? `http://localhost:${env.API_PORT ?? '4000'}/api/auth/callback`,
    tokenUrl: p.tokenUrl ?? env.GOOGLE_TOKEN_URL ?? (realGoogle ? 'https://oauth2.googleapis.com/token' : `${authBase}/token`),
    revokeUrl: p.revokeUrl ?? env.GOOGLE_REVOKE_URL ?? (realGoogle ? 'https://oauth2.googleapis.com/revoke' : `${authBase}/revoke`),
    postLoginRedirect: p.postLoginRedirect ?? env.POST_LOGIN_REDIRECT ?? '/',
    secureCookies: p.secureCookies ?? env.NODE_ENV === 'production',
    pollMs: p.pollMs ?? 60_000,
    debounceMs: p.debounceMs ?? 2_000,
    verifyIdTokenSignature,
    requestTimeoutMs: p.requestTimeoutMs ?? 15_000,
    onUserCreated: p.onUserCreated,
    fetch: p.fetch,
  };
}

export interface GoogleCtx {
  db: Database;
  config: GoogleConfig;
  log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export const authorizeUrl = (c: GoogleConfig) => `${c.authBase}/o/oauth2/v2/auth`;
export const userinfoUrl = (c: GoogleConfig) => `${c.apiBase}/oauth2/v3/userinfo`;
export const certsUrl = (c: GoogleConfig) => `${c.apiBase}/oauth2/v3/certs`;
export const calendarBase = (c: GoogleConfig) => `${c.apiBase}/calendar/v3`;
