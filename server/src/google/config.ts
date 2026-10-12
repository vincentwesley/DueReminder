import { isStrict, sessionSecretProblem } from '../config.js';
import type { Db } from '../db/index.js';

/** Step 1 (sign-in): identity only. */
export const SIGNIN_SCOPES = ['openid', 'email', 'profile'];
/** Step 2 (opt-in, signed-in users): calendar access, requested only when the user turns sync on. */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  demoMode: boolean;
  /** e.g. http://localhost:4010 (mock) or https://accounts.google.com */
  authBase: string;
  /** e.g. http://localhost:4010 (mock) or https://www.googleapis.com */
  apiBase: string;
  /** Empty = derive `<request origin>/api/auth/callback`. */
  redirectUri: string;
  tokenUrl: string;
  revokeUrl: string;
  /** Where to send the browser after login. */
  postLoginRedirect: string;
  /** Verify id_token signature via JWKS (real Google only). */
  verifyIdTokenSignature: boolean;
  requestTimeoutMs: number;
  fetch?: typeof fetch;
}

/** Subset of the Worker env this module reads. */
export type GoogleEnv = Partial<Record<'GOOGLE_AUTH_BASE' | 'GOOGLE_API_BASE' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'GOOGLE_TOKEN_URL' | 'GOOGLE_REVOKE_URL' | 'OAUTH_REDIRECT_URI' | 'POST_LOGIN_REDIRECT' | 'SESSION_SECRET' | 'DEMO_MODE' | 'NODE_ENV', string>>;

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** Merge explicit config over environment defaults. */
export function resolveGoogleConfig(p: Partial<GoogleConfig> & { nodeEnv?: string }, env: GoogleEnv = {}): GoogleConfig {
  const demoMode = p.demoMode ?? (env.DEMO_MODE === '1' || env.DEMO_MODE === 'true');
  const authBase = trimSlash(p.authBase ?? env.GOOGLE_AUTH_BASE ?? 'http://localhost:4010');
  const apiBase = trimSlash(p.apiBase ?? env.GOOGLE_API_BASE ?? 'http://localhost:4010');
  const realGoogle = /(^|\/\/)accounts\.google\.com$/.test(authBase);
  if (demoMode && realGoogle) {
    throw new Error('DEMO_MODE=1 must not point GOOGLE_AUTH_BASE at real Google. Use the mock or set DEMO_MODE=0.');
  }
  const nodeEnv = p.nodeEnv ?? env.NODE_ENV ?? 'development';
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
    redirectUri: p.redirectUri ?? env.OAUTH_REDIRECT_URI ?? '',
    tokenUrl: p.tokenUrl ?? env.GOOGLE_TOKEN_URL ?? (realGoogle ? 'https://oauth2.googleapis.com/token' : `${authBase}/token`),
    revokeUrl: p.revokeUrl ?? env.GOOGLE_REVOKE_URL ?? (realGoogle ? 'https://oauth2.googleapis.com/revoke' : `${authBase}/revoke`),
    postLoginRedirect: p.postLoginRedirect ?? env.POST_LOGIN_REDIRECT ?? '/',
    verifyIdTokenSignature,
    requestTimeoutMs: p.requestTimeoutMs ?? 15_000,
    fetch: p.fetch,
  };
}

export interface GoogleCtx {
  db: Db;
  config: GoogleConfig;
  log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export const authorizeUrl = (c: GoogleConfig) => `${c.authBase}/o/oauth2/v2/auth`;
export const userinfoUrl = (c: GoogleConfig) => `${c.apiBase}/oauth2/v3/userinfo`;
export const certsUrl = (c: GoogleConfig) => `${c.apiBase}/oauth2/v3/certs`;
export const calendarBase = (c: GoogleConfig) => `${c.apiBase}/calendar/v3`;
