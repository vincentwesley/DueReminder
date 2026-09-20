import { describe, expect, it } from 'vitest';
import { ApiFail, NetworkFail } from '../../web/src/api';
import { processQueue } from '../../web/src/flush';
import type { QueuedOp } from '../../web/src/offline';

interface Server { version: number; title: string; notes: string }

/** A tiny in-memory server with optimistic concurrency, mirroring PATCH /reminders/:id. */
function fakeServer(initial: Server, fail?: (op: QueuedOp) => Error | null) {
  const state = { ...initial };
  const calls: Array<{ body: any; key: string }> = [];
  const removed: number[] = [];
  const deps = {
    remove: async (id: number) => { removed.push(id); },
    send: async (op: QueuedOp, body: any, key: string) => {
      calls.push({ body, key });
      const err = fail?.(op);
      if (err) throw err;
      if (body?.version !== undefined && body.version !== state.version) {
        throw new ApiFail(409, 'conflict', 'Reminder was modified elsewhere', { id: 'r1', ...state });
      }
      const { version: _v, ...fields } = body ?? {};
      Object.assign(state, fields);
      state.version += 1;
      return { id: 'r1', ...state };
    },
  };
  return { state, calls, removed, deps };
}

const patch = (id: number, fields: object, version = 1): QueuedOp => ({ id, key: `k${id}`, method: 'PATCH', path: '/reminders/r1', body: { ...fields, version }, at: id });

describe('offline queue replay (H3)', () => {
  it('two consecutive offline edits of the same reminder both apply', async () => {
    const s = fakeServer({ version: 1, title: 'a', notes: '' });
    const res = await processQueue([patch(1, { title: 'first' }), patch(2, { notes: 'second' })], s.deps);
    expect(res).toMatchObject({ sent: 2, dropped: [], halted: null });
    expect(s.state).toMatchObject({ title: 'first', notes: 'second', version: 3 });
    expect(s.removed).toEqual([1, 2]);
  });

  it('rebases onto the latest server version on 409 instead of dropping', async () => {
    const s = fakeServer({ version: 5, title: 'server', notes: 'kept' });
    const res = await processQueue([patch(1, { title: 'mine' }, 1)], s.deps);
    expect(res).toMatchObject({ sent: 1, dropped: [], rebased: 1 });
    expect(s.state).toMatchObject({ title: 'mine', notes: 'kept', version: 6 });
    // the retry uses a fresh idempotency key because 4xx replies are cached per key
    expect(s.calls.map((c) => c.key)).toEqual(['k1', 'k1:r1']);
    expect(s.calls[1]!.body.version).toBe(5);
  });

  it('gives up on a conflict that keeps recurring and reports it', async () => {
    const deps = {
      remove: async () => undefined,
      send: async () => { throw new ApiFail(409, 'conflict', 'busy', { id: 'r1', version: 9 }); },
    };
    const res = await processQueue([patch(1, { title: 'x' })], deps);
    expect(res.sent).toBe(0);
    expect(res.dropped).toEqual(['busy']);
  });
});

describe('offline queue keeps ops it cannot deliver (M6)', () => {
  const ops = [patch(1, { title: 'one' }), patch(2, { title: 'two' })];
  it.each([
    ['401', new ApiFail(401, 'unauthorized', 'Not signed in'), 'auth'],
    ['429', new ApiFail(429, 'rate_limited', 'slow down'), 'retry'],
    ['500', new ApiFail(500, 'internal', 'boom'), 'retry'],
    ['503', new ApiFail(503, 'internal', 'down'), 'retry'],
    ['network', new NetworkFail('offline'), 'network'],
  ])('%s halts replay and removes nothing', async (_n, err, halted) => {
    const s = fakeServer({ version: 1, title: 'a', notes: '' }, () => err as Error);
    const res = await processQueue(ops, s.deps);
    expect(res).toMatchObject({ sent: 0, dropped: [], halted });
    expect(s.removed).toEqual([]);
    expect(s.calls).toHaveLength(1); // stops at the first failure to preserve ordering
  });

  it('drops only permanent 4xx errors, and continues with the rest', async () => {
    const s = fakeServer({ version: 1, title: 'a', notes: '' }, (op) => (op.id === 1 ? new ApiFail(404, 'not_found', 'Reminder not found') : null));
    const res = await processQueue([patch(1, { title: 'gone' }), patch(2, { title: 'ok' })], s.deps);
    expect(res).toMatchObject({ sent: 1, halted: null });
    expect(res.dropped).toEqual(['Reminder not found']);
    expect(s.removed).toEqual([1, 2]);
  });

  it('a later successful pass replays what a failed pass kept', async () => {
    let down = true;
    const s = fakeServer({ version: 1, title: 'a', notes: '' }, () => (down ? new ApiFail(503, 'internal', 'down') : null));
    const queue = [patch(1, { title: 'first' }), patch(2, { notes: 'second' })];
    expect((await processQueue(queue, s.deps)).halted).toBe('retry');
    down = false;
    const again = await processQueue(queue.filter((o) => !s.removed.includes(o.id!)), s.deps);
    expect(again).toMatchObject({ sent: 2, halted: null });
    expect(s.state).toMatchObject({ title: 'first', notes: 'second' });
  });
});
