export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 8;

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  /** Server-provided Retry-After, honoured as a lower bound. */
  retryAfterMs?: number;
  random?: () => number;
}

/** Exponential backoff with full jitter. `attempt` is 1-based (the attempt that just failed). */
export function backoffDelayMs(attempt: number, o: BackoffOptions = {}): number {
  const base = o.baseMs ?? BACKOFF_BASE_MS;
  const cap = o.capMs ?? BACKOFF_CAP_MS;
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor((o.random ?? Math.random)() * ceiling);
  return Math.max(jittered, o.retryAfterMs ?? 0);
}

export function parseRetryAfter(h: string | null | undefined, now = Date.now()): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'backendError']);

/** 429, 5xx and 403 rate-limit reasons are retryable. */
export function isRetryableStatus(status: number, reasons: string[] = []): boolean {
  if (status === 429 || status >= 500) return true;
  return status === 403 && reasons.some((r) => RATE_REASONS.has(r));
}
