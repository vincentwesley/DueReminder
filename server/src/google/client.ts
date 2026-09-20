import { calendarBase, type GoogleCtx } from './config';
import { GoogleHttpError, ReauthRequiredError } from './errors';
import { parseRetryAfter } from './backoff';
import { doFetch, getAccessToken, markReauth } from './tokens';

export interface GEvent {
  id?: string;
  etag?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  recurrence?: string[];
  transparency?: 'opaque' | 'transparent';
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
}

export interface EventsPage { items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string }

export interface CallOpts {
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Authenticated Calendar call. On 401 refreshes the token once and retries; a second 401 marks the
 * account reauth_required. Non-2xx statuses throw GoogleHttpError, connectivity failures NetworkError.
 */
export async function calendarCall<T = unknown>(ctx: GoogleCtx, userId: string, method: string, path: string, o: CallOpts = {}): Promise<T> {
  const url = new URL(calendarBase(ctx.config) + path);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(ctx, userId, { force: attempt > 0 });
    const res = await doFetch(ctx, url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...o.headers,
      },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    if (res.status === 401) {
      if (attempt === 0) continue;
      markReauth(ctx, userId, 'Google rejected credentials after refresh; reconnect required');
      throw new ReauthRequiredError();
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as { error?: { message?: string; errors?: Array<{ reason?: string }> } } | undefined;
      const reasons = (body?.error?.errors ?? []).map((e) => e.reason ?? '').filter(Boolean);
      throw new GoogleHttpError(res.status, body?.error?.message ?? `Google API ${res.status}`, reasons, parseRetryAfter(res.headers.get('retry-after')), body);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  throw new ReauthRequiredError();
}

const cal = (id: string) => `/calendars/${encodeURIComponent(id)}/events`;

export const listEvents = (ctx: GoogleCtx, userId: string, calendarId: string, query: Record<string, string | undefined>) =>
  calendarCall<EventsPage>(ctx, userId, 'GET', cal(calendarId), { query });
export const getEvent = (ctx: GoogleCtx, userId: string, calendarId: string, id: string) =>
  calendarCall<GEvent>(ctx, userId, 'GET', `${cal(calendarId)}/${encodeURIComponent(id)}`);
export const insertEvent = (ctx: GoogleCtx, userId: string, calendarId: string, ev: GEvent) =>
  calendarCall<GEvent>(ctx, userId, 'POST', cal(calendarId), { body: ev });
export const patchEvent = (ctx: GoogleCtx, userId: string, calendarId: string, id: string, ev: GEvent, etag?: string | null) =>
  calendarCall<GEvent>(ctx, userId, 'PATCH', `${cal(calendarId)}/${encodeURIComponent(id)}`, {
    body: ev,
    headers: etag ? { 'if-match': etag } : undefined,
  });
export const deleteEvent = (ctx: GoogleCtx, userId: string, calendarId: string, id: string) =>
  calendarCall<void>(ctx, userId, 'DELETE', `${cal(calendarId)}/${encodeURIComponent(id)}`);
