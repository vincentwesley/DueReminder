import type { SyncState, SyncStatus } from '@shared/types';
import { batch, exec, many, one, q } from '../db/index.js';
import { backoffDelayMs, isRetryableStatus, MAX_ATTEMPTS } from './backoff';
import { deleteEvent, getEvent, insertEvent, listEvents, patchEvent, type GEvent } from './client';
import type { GoogleCtx } from './config';
import { GoogleHttpError, NetworkError, ReauthRequiredError } from './errors';
import { fromEvent, toEvent, type ReminderRow } from './mapping';
import { enqueueSync, outboxCounts, retryFailedOps } from './outbox';
import { getAccount, revokeTokens, type AccountRow } from './tokens';

interface OutboxRow { id: number; user_id: string; reminder_id: string; op: 'upsert' | 'delete'; event_id: string | null; attempts: number; next_attempt_at: number }

const nowIso = () => new Date().toISOString();

export async function getSyncState(ctx: GoogleCtx, userId: string): Promise<SyncState> {
  const a = await getAccount(ctx, userId);
  if (!a) {
    return { status: 'disconnected', connected: false, googleEmail: null, calendarId: 'primary', lastSyncAt: null, lastError: null, pendingOps: 0, conflictsResolved: 0, failedOps: 0 };
  }
  const { pending, failed } = await outboxCounts(ctx.db, userId);
  return {
    status: a.status as SyncStatus,
    connected: true,
    googleEmail: a.email,
    calendarId: a.calendar_id,
    lastSyncAt: a.last_sync_at,
    lastError: a.last_error,
    pendingOps: pending,
    conflictsResolved: a.conflicts_resolved,
    failedOps: failed,
  };
}

const setStatus = (ctx: GoogleCtx, userId: string, status: SyncStatus, err?: string | null) =>
  exec(ctx.db, 'UPDATE google_accounts SET status = ?, last_error = ? WHERE user_id = ?', status, err ?? null, userId);

const getReminder = (ctx: GoogleCtx, userId: string, id: string) =>
  one<ReminderRow>(ctx.db, 'SELECT * FROM reminders WHERE id = ? AND user_id = ?', id, userId);

const setLink = (ctx: GoogleCtx, id: string, eventId: string | null, etag: string | null) =>
  exec(ctx.db, 'UPDATE reminders SET google_event_id = ?, google_etag = ? WHERE id = ?', eventId, etag, id);

const bumpConflicts = (ctx: GoogleCtx, userId: string) =>
  exec(ctx.db, 'UPDATE google_accounts SET conflicts_resolved = conflicts_resolved + 1 WHERE user_id = ?', userId);

// ---------------------------------------------------------------- pull

/** Apply one remote event to local state using last-writer-wins (done-wins for completion). Returns true when a conflict was counted. */
export async function applyRemoteEvent(ctx: GoogleCtx, userId: string, ev: GEvent): Promise<boolean> {
  const rid = ev.extendedProperties?.private?.reminderId;
  if (!rid || !ev.id) return false; // events not created by us are ignored in v1
  const r = await getReminder(ctx, userId, rid);
  if (!r || !r.calendar_sync) return false;
  if (r.google_event_id && r.google_event_id !== ev.id) return false; // stale/duplicate event

  const pending = (await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM outbox WHERE user_id = ? AND reminder_id = ?', userId, rid))!;
  const hasPending = pending.n > 0;

  if (ev.status === 'cancelled') {
    if (r.deleted_at || r.google_event_id !== ev.id) return false;
    if (!hasPending && Date.parse(ev.updated ?? nowIso()) >= Date.parse(r.updated_at)) {
      await exec(ctx.db, 'UPDATE reminders SET deleted_at = ?, updated_at = ?, version = version + 1, google_event_id = NULL, google_etag = NULL WHERE id = ?',
        nowIso(), ev.updated ?? nowIso(), rid);
    } else {
      // local edit is newer than the remote deletion: recreate the event
      await setLink(ctx, rid, null, null);
      await bumpConflicts(ctx, userId);
      await enqueueSync(ctx.db, userId, rid, 'upsert');
      return true;
    }
    return false;
  }

  if (r.deleted_at) return false; // pending local delete wins
  if (ev.etag && ev.etag === r.google_etag) return false; // echo of our own write

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
    await exec(ctx.db,
      `UPDATE reminders SET title=?, notes=?, due_at=?, all_day=?, timezone=?, rrule=?, status=?, completed_at=?,
       google_event_id=?, google_etag=?, updated_at=?, version=version+1 WHERE id=?`,
      remote.title, remote.notes, remote.due_at, remote.all_day, remote.timezone, remote.rrule, done ? 'done' : 'open', completedAt, ev.id, ev.etag ?? null, ev.updated ?? nowIso(), rid);
    if (hasPending) {
      await exec(ctx.db, 'DELETE FROM outbox WHERE user_id = ? AND reminder_id = ?', userId, rid);
      await bumpConflicts(ctx, userId);
    }
    if (done !== remote.done) await enqueueSync(ctx.db, userId, rid, 'upsert'); // local completion must reach Google
    return hasPending;
  }

  // Local is newer (or equal): keep local, adopt the etag so the next patch succeeds.
  if (!differs) {
    await setLink(ctx, rid, ev.id, ev.etag ?? null);
    return false;
  }
  if (remote.done && !localDone) {
    await exec(ctx.db, 'UPDATE reminders SET status = ?, completed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?', 'done', completedAt, nowIso(), rid);
  }
  await setLink(ctx, rid, ev.id, ev.etag ?? null);
  if (hasPending) await bumpConflicts(ctx, userId);
  await enqueueSync(ctx.db, userId, rid, 'upsert');
  return hasPending;
}

/** Per-cycle caps so one user cannot exhaust a cron tick's subrequest budget; leftovers carry to the next tick. */
export const MAX_PULL_PAGES = 3;
export const MAX_PUSH_ROWS = 50;

async function pull(ctx: GoogleCtx, userId: string): Promise<void> {
  let acct = (await getAccount(ctx, userId)) as AccountRow;
  let syncToken = acct.sync_token;
  let retriedFull = false;
  const resume = acct.pull_resume ? (JSON.parse(acct.pull_resume) as { pageToken: string; timeMin?: string }) : null;
  let pageToken: string | undefined = resume?.pageToken;
  const timeMin = resume?.timeMin ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  let pages = 0;
  for (;;) {
    try {
      const page = await listEvents(ctx, userId, acct.calendar_id, {
        showDeleted: 'true',
        maxResults: '250',
        pageToken,
        ...(syncToken ? { syncToken } : { timeMin }),
      });
      for (const ev of page.items ?? []) await applyRemoteEvent(ctx, userId, ev);
      if (page.nextPageToken) {
        pageToken = page.nextPageToken;
        if (++pages >= MAX_PULL_PAGES) { // keep the old sync token; the cursor resumes this walk next tick
          await exec(ctx.db, 'UPDATE google_accounts SET pull_resume = ? WHERE user_id = ?', JSON.stringify({ pageToken, ...(syncToken ? {} : { timeMin }) }), userId);
          return;
        }
        continue;
      }
      await exec(ctx.db, 'UPDATE google_accounts SET sync_token = COALESCE(?, sync_token), pull_resume = NULL WHERE user_id = ?', page.nextSyncToken ?? null, userId);
      return;
    } catch (e) {
      if (e instanceof GoogleHttpError && e.status === 410 && !retriedFull) {
        retriedFull = true; // sync token expired: discard and do a full resync
        await exec(ctx.db, 'UPDATE google_accounts SET sync_token = NULL, pull_resume = NULL WHERE user_id = ?', userId);
        syncToken = null;
        pageToken = undefined;
        acct = (await getAccount(ctx, userId)) as AccountRow;
        continue;
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- push

async function pushRow(ctx: GoogleCtx, userId: string, calendarId: string, row: OutboxRow): Promise<void> {
  const r = await getReminder(ctx, userId, row.reminder_id);
  const eventId = r?.google_event_id ?? row.event_id;
  const shouldExist = !!r && !r.deleted_at && !!r.calendar_sync && !!r.due_at;

  if (!shouldExist) {
    if (eventId) {
      try { await deleteEvent(ctx, userId, calendarId, eventId); }
      catch (e) { if (!(e instanceof GoogleHttpError && (e.status === 404 || e.status === 410))) throw e; }
    }
    if (r) await setLink(ctx, r.id, null, null);
    return;
  }

  const body = toEvent(r);
  const insert = async () => {
    const created = await insertEvent(ctx, userId, calendarId, body);
    await setLink(ctx, r.id, created.id ?? null, created.etag ?? null);
  };
  if (!r.google_event_id) return insert();
  try {
    const updated = await patchEvent(ctx, userId, calendarId, r.google_event_id, body, r.google_etag);
    await setLink(ctx, r.id, r.google_event_id, updated.etag ?? null);
  } catch (e) {
    if (!(e instanceof GoogleHttpError)) throw e;
    if (e.status === 404 || e.status === 410) { await setLink(ctx, r.id, null, null); return insert(); }
    if (e.status === 412) {
      // Remote changed since our etag: refetch and resolve by last-writer-wins.
      const remote = await getEvent(ctx, userId, calendarId, r.google_event_id);
      await exec(ctx.db, 'UPDATE reminders SET google_etag = NULL WHERE id = ?', r.id); // force apply path to treat as non-echo
      await exec(ctx.db, 'DELETE FROM outbox WHERE id = ?', row.id);
      if (!(await applyRemoteEvent(ctx, userId, remote))) await bumpConflicts(ctx, userId); // row was dropped above, so applyRemote saw no pending op
      return;
    }
    throw e;
  }
}

async function push(ctx: GoogleCtx, userId: string, calendarId: string): Promise<string | null> {
  let lastErr: string | null = null;
  let budget = MAX_PUSH_ROWS;
  for (let pass = 0; pass < 3 && budget > 0; pass++) {
    const rows = await many<OutboxRow>(ctx.db, 'SELECT * FROM outbox WHERE user_id = ? AND failed = 0 AND next_attempt_at <= ? ORDER BY id LIMIT ?', userId, Date.now(), budget);
    if (rows.length === 0) break;
    budget -= rows.length;
    for (const row of rows) {
      try {
        await pushRow(ctx, userId, calendarId, row);
        await exec(ctx.db, 'DELETE FROM outbox WHERE id = ?', row.id);
      } catch (e) {
        if (e instanceof NetworkError || e instanceof ReauthRequiredError) throw e; // keep outbox, stop cycle
        if (e instanceof GoogleHttpError) {
          if (isRetryableStatus(e.status, e.reasons)) {
            const attempts = row.attempts + 1;
            if (attempts >= MAX_ATTEMPTS) {
              await exec(ctx.db, 'UPDATE outbox SET attempts = ?, failed = 1, last_error = ? WHERE id = ?', attempts, e.message, row.id);
              lastErr = `Gave up pushing a reminder after ${MAX_ATTEMPTS} attempts: ${e.message}`;
            } else {
              await exec(ctx.db, 'UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?',
                attempts, Date.now() + backoffDelayMs(attempts, { retryAfterMs: e.retryAfterMs }), e.message, row.id);
            }
            throw e; // provider is throttling: stop this cycle, resume on a later tick
          }
          await exec(ctx.db, 'UPDATE outbox SET failed = 1, last_error = ? WHERE id = ?', e.message, row.id); // permanent client error: keep visible as failed
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
async function failedSummary(ctx: GoogleCtx, userId: string): Promise<string | null> {
  const { failed } = await outboxCounts(ctx.db, userId);
  if (failed === 0) return null;
  const last = (await one<{ last_error: string | null }>(ctx.db, 'SELECT last_error FROM outbox WHERE user_id = ? AND failed = 1 ORDER BY id DESC LIMIT 1', userId))?.last_error;
  return `${failed} change${failed === 1 ? '' : 's'} could not be pushed to Google (${last ?? 'unknown error'}). Use Sync now to retry.`;
}

// ---------------------------------------------------------------- orchestration

// ponytail: de-duplication is per isolate; the cron and a request on different isolates can overlap for one user. Add a D1 lease column if duplicate events ever show up.
const running = new Map<string, Promise<SyncState>>();
const queued = new Map<string, Promise<SyncState>>();

async function cycle(ctx: GoogleCtx, userId: string): Promise<SyncState> {
  const acct = await getAccount(ctx, userId);
  if (!acct || acct.status === 'reauth_required') return getSyncState(ctx, userId);
  await exec(ctx.db, "UPDATE google_accounts SET status = 'syncing', last_error = NULL, last_attempt_at = ? WHERE user_id = ?", nowIso(), userId); // attempt recorded even if the cycle fails
  try {
    const softErr = await push(ctx, userId, acct.calendar_id);
    await pull(ctx, userId);
    // Failed pushes stay flagged until the user edits the reminder or retries; they are never silently dropped.
    const failedErr = await failedSummary(ctx, userId);
    await exec(ctx.db, 'UPDATE google_accounts SET status = ?, last_error = ?, last_sync_at = ? WHERE user_id = ?', failedErr ? 'error' : 'idle', softErr ?? failedErr, nowIso(), userId);
  } catch (e) {
    if (e instanceof ReauthRequiredError) { /* status already set by token layer */ }
    else if (e instanceof NetworkError) await setStatus(ctx, userId, 'offline', e.message);
    else await setStatus(ctx, userId, 'error', (await failedSummary(ctx, userId)) ?? (e as Error).message);
    ctx.log?.warn({ err: (e as Error).message }, 'google sync cycle failed');
  }
  return getSyncState(ctx, userId);
}

/**
 * One sync cycle (push outbox, then pull). If a cycle is already running, a single follow-up cycle is queued
 * (so writes enqueued mid-run are not missed) and all concurrent callers share it.
 */
export async function runSync(ctx: GoogleCtx, userId: string, opts: { retryFailed?: boolean } = {}): Promise<SyncState> {
  if (opts.retryFailed) await retryFailedOps(ctx.db, userId);
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

/** Revoke at Google, forget tokens/links locally. */
export async function disconnectAccount(ctx: GoogleCtx, userId: string): Promise<SyncState> {
  await revokeTokens(ctx, userId);
  await batch(ctx.db, [
    q(ctx.db, 'DELETE FROM google_accounts WHERE user_id = ?', userId),
    q(ctx.db, 'DELETE FROM outbox WHERE user_id = ?', userId),
    q(ctx.db, 'UPDATE reminders SET google_event_id = NULL, google_etag = NULL WHERE user_id = ?', userId),
  ]);
  return getSyncState(ctx, userId);
}

const PURGE_MAX_EVENTS = 40; // stays inside the Workers subrequest budget
const PURGE_BUDGET_MS = 10_000;

/** Best-effort, bounded removal of the events this app created on a calendar. Never throws. */
async function deleteAppEvents(ctx: GoogleCtx, userId: string, calendarId: string): Promise<void> {
  const ids = (await many<{ id: string }>(ctx.db,
    `SELECT google_event_id AS id FROM reminders WHERE user_id = ? AND google_event_id IS NOT NULL
     UNION SELECT event_id FROM outbox WHERE user_id = ? AND op = 'delete' AND event_id IS NOT NULL`, userId, userId)).map((r) => r.id).slice(0, PURGE_MAX_EVENTS);
  const stop = Date.now() + PURGE_BUDGET_MS;
  for (const id of ids) {
    if (Date.now() > stop) break;
    try { await deleteEvent(ctx, userId, calendarId, id); }
    catch (e) {
      if (e instanceof GoogleHttpError) continue; // already gone or rejected: move on
      break; // network or re-auth problem: give up on the rest
    }
  }
}

/** Account deletion: remove the events this app created (bounded), then revoke the grant. Never throws. */
export async function purgeGoogleData(ctx: GoogleCtx, userId: string): Promise<void> {
  const acct = await getAccount(ctx, userId);
  if (!acct) return;
  await deleteAppEvents(ctx, userId, acct.calendar_id);
  await revokeTokens(ctx, userId);
}

/** Switch target calendar: reset the sync cursor and re-push every synced reminder. */
export async function changeCalendar(ctx: GoogleCtx, userId: string, calendarId: string): Promise<SyncState> {
  const acct = await getAccount(ctx, userId);
  if (acct) await deleteAppEvents(ctx, userId, acct.calendar_id); // otherwise the old calendar keeps orphaned events
  await batch(ctx.db, [
    q(ctx.db, 'UPDATE google_accounts SET calendar_id = ?, sync_token = NULL, pull_resume = NULL WHERE user_id = ?', calendarId, userId),
    q(ctx.db, 'UPDATE reminders SET google_event_id = NULL, google_etag = NULL WHERE user_id = ?', userId),
  ]);
  const ids = await many<{ id: string }>(ctx.db, 'SELECT id FROM reminders WHERE user_id = ? AND calendar_sync = 1 AND deleted_at IS NULL AND due_at IS NOT NULL', userId);
  for (const { id } of ids) await enqueueSync(ctx.db, userId, id, 'upsert');
  return getSyncState(ctx, userId);
}
