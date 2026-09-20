import type { SyncState, SyncStatus } from '@shared/types';
import { backoffDelayMs, isRetryableStatus, MAX_ATTEMPTS } from './backoff';
import { deleteEvent, getEvent, insertEvent, listEvents, patchEvent, type GEvent } from './client';
import type { GoogleCtx } from './config';
import { GoogleHttpError, NetworkError, ReauthRequiredError } from './errors';
import { fromEvent, toEvent, type ReminderRow } from './mapping';
import { enqueueSync, failedOps, pendingOps, retryFailedOps } from './outbox';
import { getAccount, revokeTokens, type AccountRow } from './tokens';

interface OutboxRow { id: number; user_id: string; reminder_id: string; op: 'upsert' | 'delete'; event_id: string | null; attempts: number; next_attempt_at: number }

const nowIso = () => new Date().toISOString();

export function getSyncState(ctx: GoogleCtx, userId: string): SyncState {
  const a = getAccount(ctx, userId);
  if (!a) {
    return { status: 'disconnected', connected: false, googleEmail: null, calendarId: 'primary', lastSyncAt: null, lastError: null, pendingOps: 0, conflictsResolved: 0, failedOps: 0 };
  }
  return {
    status: a.status as SyncStatus,
    connected: true,
    googleEmail: a.email,
    calendarId: a.calendar_id,
    lastSyncAt: a.last_sync_at,
    lastError: a.last_error,
    pendingOps: pendingOps(ctx.db, userId),
    conflictsResolved: a.conflicts_resolved,
    failedOps: failedOps(ctx.db, userId),
  };
}

function setStatus(ctx: GoogleCtx, userId: string, status: SyncStatus, err?: string | null): void {
  ctx.db.prepare('UPDATE google_accounts SET status = ?, last_error = ? WHERE user_id = ?').run(status, err ?? null, userId);
}

const getReminder = (ctx: GoogleCtx, userId: string, id: string) =>
  ctx.db.prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ?').get(id, userId) as ReminderRow | undefined;

const setLink = (ctx: GoogleCtx, id: string, eventId: string | null, etag: string | null) =>
  ctx.db.prepare('UPDATE reminders SET google_event_id = ?, google_etag = ? WHERE id = ?').run(eventId, etag, id);

const bumpConflicts = (ctx: GoogleCtx, userId: string) =>
  ctx.db.prepare('UPDATE google_accounts SET conflicts_resolved = conflicts_resolved + 1 WHERE user_id = ?').run(userId);

// ---------------------------------------------------------------- pull

/** Apply one remote event to local state using last-writer-wins (done-wins for completion). */
export function applyRemoteEvent(ctx: GoogleCtx, userId: string, ev: GEvent): void {
  const rid = ev.extendedProperties?.private?.reminderId;
  if (!rid || !ev.id) return; // events not created by us are ignored in v1
  const r = getReminder(ctx, userId, rid);
  if (!r || !r.calendar_sync) return;
  if (r.google_event_id && r.google_event_id !== ev.id) return; // stale/duplicate event

  const pending = ctx.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE user_id = ? AND reminder_id = ?').get(userId, rid) as { n: number };
  const hasPending = pending.n > 0;

  if (ev.status === 'cancelled') {
    if (r.deleted_at || r.google_event_id !== ev.id) return;
    if (!hasPending && Date.parse(ev.updated ?? nowIso()) >= Date.parse(r.updated_at)) {
      ctx.db.prepare('UPDATE reminders SET deleted_at = ?, updated_at = ?, version = version + 1, google_event_id = NULL, google_etag = NULL WHERE id = ?')
        .run(nowIso(), ev.updated ?? nowIso(), rid);
    } else {
      // local edit is newer than the remote deletion: recreate the event
      setLink(ctx, rid, null, null);
      bumpConflicts(ctx, userId);
      enqueueSync(ctx.db, userId, rid, 'upsert');
    }
    return;
  }

  if (r.deleted_at) return; // pending local delete wins
  if (ev.etag && ev.etag === r.google_etag) return; // echo of our own write

  const remote = fromEvent(ev, r);
  const remoteUpdated = Date.parse(ev.updated ?? '') || 0;
  const localUpdated = Date.parse(r.updated_at) || 0;
  const localDone = r.status === 'done';
  const differs =
    remote.title !== r.title || remote.notes !== (r.notes ?? '') || remote.due_at !== r.due_at || remote.all_day !== r.all_day ||
    (remote.rrule ?? null) !== (r.rrule ?? null) || remote.done !== localDone;
  const done = remote.done || localDone; // completion is done-wins
  const completedAt = done ? r.completed_at ?? ev.updated ?? nowIso() : null;

  if (remoteUpdated > localUpdated) {
    ctx.db.prepare(
      `UPDATE reminders SET title=?, notes=?, due_at=?, all_day=?, timezone=?, rrule=?, status=?, completed_at=?,
       google_event_id=?, google_etag=?, updated_at=?, version=version+1 WHERE id=?`,
    ).run(remote.title, remote.notes, remote.due_at, remote.all_day, remote.timezone, remote.rrule, done ? 'done' : 'open', completedAt, ev.id, ev.etag ?? null, ev.updated ?? nowIso(), rid);
    if (hasPending) {
      ctx.db.prepare('DELETE FROM outbox WHERE user_id = ? AND reminder_id = ?').run(userId, rid);
      bumpConflicts(ctx, userId);
    }
    if (done !== remote.done) enqueueSync(ctx.db, userId, rid, 'upsert'); // local completion must reach Google
    return;
  }

  // Local is newer (or equal): keep local, adopt the etag so the next patch succeeds.
  if (!differs) {
    setLink(ctx, rid, ev.id, ev.etag ?? null);
    return;
  }
  if (remote.done && !localDone) {
    ctx.db.prepare('UPDATE reminders SET status = ?, completed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?').run('done', completedAt, nowIso(), rid);
  }
  setLink(ctx, rid, ev.id, ev.etag ?? null);
  if (hasPending) bumpConflicts(ctx, userId);
  enqueueSync(ctx.db, userId, rid, 'upsert');
}

async function pull(ctx: GoogleCtx, userId: string): Promise<void> {
  let acct = getAccount(ctx, userId) as AccountRow;
  let syncToken = acct.sync_token;
  let retriedFull = false;
  let pageToken: string | undefined;
  for (;;) {
    try {
      const page = await listEvents(ctx, userId, acct.calendar_id, {
        showDeleted: 'true',
        maxResults: '250',
        pageToken,
        ...(syncToken ? { syncToken } : { timeMin: new Date(Date.now() - 30 * 86_400_000).toISOString() }),
      });
      for (const ev of page.items ?? []) applyRemoteEvent(ctx, userId, ev);
      if (page.nextPageToken) { pageToken = page.nextPageToken; continue; }
      if (page.nextSyncToken) ctx.db.prepare('UPDATE google_accounts SET sync_token = ? WHERE user_id = ?').run(page.nextSyncToken, userId);
      return;
    } catch (e) {
      if (e instanceof GoogleHttpError && e.status === 410 && !retriedFull) {
        retriedFull = true; // sync token expired: discard and do a full resync
        ctx.db.prepare('UPDATE google_accounts SET sync_token = NULL WHERE user_id = ?').run(userId);
        syncToken = null;
        pageToken = undefined;
        acct = getAccount(ctx, userId) as AccountRow;
        continue;
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- push

async function pushRow(ctx: GoogleCtx, userId: string, calendarId: string, row: OutboxRow): Promise<void> {
  const r = getReminder(ctx, userId, row.reminder_id);
  const eventId = r?.google_event_id ?? row.event_id;
  const shouldExist = !!r && !r.deleted_at && !!r.calendar_sync && !!r.due_at;

  if (!shouldExist) {
    if (eventId) {
      try { await deleteEvent(ctx, userId, calendarId, eventId); }
      catch (e) { if (!(e instanceof GoogleHttpError && (e.status === 404 || e.status === 410))) throw e; }
    }
    if (r) setLink(ctx, r.id, null, null);
    return;
  }

  const body = toEvent(r);
  const insert = async () => {
    const created = await insertEvent(ctx, userId, calendarId, body);
    setLink(ctx, r.id, created.id ?? null, created.etag ?? null);
  };
  if (!r.google_event_id) return insert();
  try {
    const updated = await patchEvent(ctx, userId, calendarId, r.google_event_id, body, r.google_etag);
    setLink(ctx, r.id, r.google_event_id, updated.etag ?? null);
  } catch (e) {
    if (!(e instanceof GoogleHttpError)) throw e;
    if (e.status === 404 || e.status === 410) { setLink(ctx, r.id, null, null); return insert(); }
    if (e.status === 412) {
      // Remote changed since our etag: refetch and resolve by last-writer-wins.
      const remote = await getEvent(ctx, userId, calendarId, r.google_event_id);
      ctx.db.prepare('UPDATE reminders SET google_etag = NULL WHERE id = ?').run(r.id); // force apply path to treat as non-echo
      ctx.db.prepare('DELETE FROM outbox WHERE id = ?').run(row.id);
      const before = (getAccount(ctx, userId) as AccountRow).conflicts_resolved;
      applyRemoteEvent(ctx, userId, remote);
      const after = (getAccount(ctx, userId) as AccountRow).conflicts_resolved;
      if (after === before) bumpConflicts(ctx, userId); // row was dropped above, so applyRemote saw no pending op
      return;
    }
    throw e;
  }
}

async function push(ctx: GoogleCtx, userId: string, calendarId: string): Promise<string | null> {
  let lastErr: string | null = null;
  for (let pass = 0; pass < 3; pass++) {
    const rows = ctx.db
      .prepare('SELECT * FROM outbox WHERE user_id = ? AND failed = 0 AND next_attempt_at <= ? ORDER BY id')
      .all(userId, Date.now()) as OutboxRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        await pushRow(ctx, userId, calendarId, row);
        ctx.db.prepare('DELETE FROM outbox WHERE id = ?').run(row.id);
      } catch (e) {
        if (e instanceof NetworkError || e instanceof ReauthRequiredError) throw e; // keep outbox, stop cycle
        if (e instanceof GoogleHttpError) {
          if (isRetryableStatus(e.status, e.reasons)) {
            const attempts = row.attempts + 1;
            if (attempts >= MAX_ATTEMPTS) {
              ctx.db.prepare('UPDATE outbox SET attempts = ?, failed = 1, last_error = ? WHERE id = ?').run(attempts, e.message, row.id);
              lastErr = `Gave up pushing a reminder after ${MAX_ATTEMPTS} attempts: ${e.message}`;
            } else {
              ctx.db.prepare('UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
                .run(attempts, Date.now() + backoffDelayMs(attempts, { retryAfterMs: e.retryAfterMs }), e.message, row.id);
            }
            throw e; // provider is throttling: stop this cycle, resume on a later tick
          }
          ctx.db.prepare('UPDATE outbox SET failed = 1, last_error = ? WHERE id = ?').run(e.message, row.id); // permanent client error: keep visible as failed
          lastErr = `Google rejected a reminder update (${e.status}): ${e.message}`;
          continue;
        }
        throw e;
      }
    }
  }
  return lastErr;
}

/** Persistent message for pushes that gave up; null when nothing is flagged failed. */
function failedSummary(ctx: GoogleCtx, userId: string): string | null {
  const failed = failedOps(ctx.db, userId);
  if (failed === 0) return null;
  const last = (ctx.db.prepare('SELECT last_error FROM outbox WHERE user_id = ? AND failed = 1 ORDER BY id DESC LIMIT 1').get(userId) as { last_error: string | null }).last_error;
  return `${failed} change${failed === 1 ? '' : 's'} could not be pushed to Google (${last ?? 'unknown error'}). Use Sync now to retry.`;
}

// ---------------------------------------------------------------- orchestration

const running = new Map<string, Promise<SyncState>>();
const queued = new Map<string, Promise<SyncState>>();

async function cycle(ctx: GoogleCtx, userId: string): Promise<SyncState> {
  const acct = getAccount(ctx, userId);
  if (!acct || acct.status === 'reauth_required') return getSyncState(ctx, userId);
  setStatus(ctx, userId, 'syncing', null);
  try {
    const softErr = await push(ctx, userId, acct.calendar_id);
    await pull(ctx, userId);
    // Failed pushes stay flagged until the user edits the reminder or retries; they are never silently dropped.
    const failedErr = failedSummary(ctx, userId);
    ctx.db.prepare('UPDATE google_accounts SET status = ?, last_error = ?, last_sync_at = ? WHERE user_id = ?').run(failedErr ? 'error' : 'idle', softErr ?? failedErr, nowIso(), userId);
  } catch (e) {
    if (e instanceof ReauthRequiredError) { /* status already set by token layer */ }
    else if (e instanceof NetworkError) setStatus(ctx, userId, 'offline', e.message);
    else setStatus(ctx, userId, 'error', failedSummary(ctx, userId) ?? (e as Error).message);
    ctx.log?.warn({ err: (e as Error).message }, 'google sync cycle failed');
  }
  return getSyncState(ctx, userId);
}

/**
 * One sync cycle (push outbox, then pull). If a cycle is already running, a single follow-up cycle is queued
 * (so writes enqueued mid-run are not missed) and all concurrent callers share it.
 */
export function runSync(ctx: GoogleCtx, userId: string, opts: { retryFailed?: boolean } = {}): Promise<SyncState> {
  if (opts.retryFailed) retryFailedOps(ctx.db, userId);
  const active = running.get(userId);
  if (!active) {
    const p: Promise<SyncState> = cycle(ctx, userId).finally(() => { if (running.get(userId) === p) running.delete(userId); });
    running.set(userId, p);
    return p;
  }
  let next = queued.get(userId);
  if (!next) {
    const n: Promise<SyncState> = active
      .catch(() => undefined)
      .then(() => {
        queued.delete(userId);
        return cycle(ctx, userId);
      })
      .finally(() => { if (running.get(userId) === n) running.delete(userId); });
    next = n;
    queued.set(userId, n);
    running.set(userId, n);
  }
  return next;
}

/** Resolves when no sync cycle is in flight (used on shutdown). */
export async function settleSyncs(): Promise<void> {
  await Promise.allSettled([...running.values()]);
}

/** Revoke at Google, forget tokens/links locally. */
export async function disconnectAccount(ctx: GoogleCtx, userId: string): Promise<SyncState> {
  await revokeTokens(ctx, userId);
  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM google_accounts WHERE user_id = ?').run(userId);
    ctx.db.prepare('DELETE FROM outbox WHERE user_id = ?').run(userId);
    ctx.db.prepare('UPDATE reminders SET google_event_id = NULL, google_etag = NULL WHERE user_id = ?').run(userId);
  })();
  return getSyncState(ctx, userId);
}

/** Switch target calendar: reset the sync cursor and re-push every synced reminder. */
export function changeCalendar(ctx: GoogleCtx, userId: string, calendarId: string): SyncState {
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE google_accounts SET calendar_id = ?, sync_token = NULL WHERE user_id = ?').run(calendarId, userId);
    ctx.db.prepare('UPDATE reminders SET google_event_id = NULL, google_etag = NULL WHERE user_id = ?').run(userId);
    const ids = ctx.db.prepare('SELECT id FROM reminders WHERE user_id = ? AND calendar_sync = 1 AND deleted_at IS NULL AND due_at IS NOT NULL').all(userId) as { id: string }[];
    for (const { id } of ids) enqueueSync(ctx.db, userId, id, 'upsert');
  })();
  return getSyncState(ctx, userId);
}
