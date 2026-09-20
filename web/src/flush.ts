import { ApiFail, NetworkFail } from './api';
import type { QueuedOp } from './offline';

/** Why replay stopped early: no connection, expired session, or the server is throttling or failing. */
export type Halt = 'network' | 'auth' | 'retry' | null;

export interface FlushResult {
  /** Ops the server accepted. */
  sent: number;
  /** Ops the server rejected for good (validation, not found); each entry is a user-facing message. */
  dropped: string[];
  /** Queued edits replayed on top of a newer server version. */
  rebased: number;
  halted: Halt;
}

export interface FlushDeps {
  send(op: QueuedOp, body: unknown, key: string): Promise<unknown>;
  remove(id: number): Promise<unknown>;
}

const MAX_REBASES = 3;
const idOfPath = (path: string) => /^\/reminders\/([^/]+)$/.exec(path)?.[1];
const asVersioned = (x: unknown): { id?: string; version: number } | null =>
  x && typeof x === 'object' && typeof (x as { version?: unknown }).version === 'number' ? (x as { id?: string; version: number }) : null;

/**
 * Replays queued writes in order.
 * - A PATCH carries the version it was based on. Earlier replays bump the server version, so each PATCH is rewritten
 *   with the latest version the server has reported, and on a 409 it is rebased onto the returned latest version and
 *   resent (the queued fields win, as they were the user's newest intent) instead of being dropped.
 * - Network errors, 401 and 429/5xx stop replay and keep the op (and everything after it) queued.
 * - Only errors that can never succeed (other 4xx) drop an op, and they are reported.
 */
export async function processQueue(ops: QueuedOp[], deps: FlushDeps): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, dropped: [], rebased: 0, halted: null };
  const versions = new Map<string, number>();

  for (const op of ops) {
    const target = idOfPath(op.path);
    const versioned = op.method === 'PATCH' && !!op.body && typeof op.body === 'object' && 'version' in (op.body as object);
    let done = false;

    for (let attempt = 0; attempt <= MAX_REBASES && !done; attempt++) {
      let body = op.body;
      if (versioned && target && versions.has(target)) body = { ...(body as object), version: versions.get(target) };
      try {
        const res = await deps.send(op, body, attempt === 0 ? op.key : `${op.key}:r${attempt}`);
        const v = asVersioned(res);
        if (v?.id) versions.set(v.id, v.version);
        result.sent++;
        done = true;
      } catch (e) {
        if (e instanceof NetworkFail) { result.halted = 'network'; return result; }
        if (!(e instanceof ApiFail)) { result.halted = 'retry'; return result; }
        if (e.status === 401) { result.halted = 'auth'; return result; }
        if (e.status === 429 || e.status >= 500) { result.halted = 'retry'; return result; }
        const latest = asVersioned(e.details);
        if (e.status === 409 && versioned && target && latest && attempt < MAX_REBASES) {
          versions.set(target, latest.version);
          result.rebased++;
          continue;
        }
        result.dropped.push(e.message);
        done = true;
      }
    }
    if (op.id !== undefined) await deps.remove(op.id);
  }
  return result;
}
