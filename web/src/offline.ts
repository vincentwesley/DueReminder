import { openDB, type IDBPDatabase } from 'idb';

export interface QueuedOp { id?: number; key: string; method: string; path: string; body?: unknown; at: number }

let dbp: Promise<IDBPDatabase> | null = null;
function db() {
  dbp ??= openDB('reminder-cache', 1, {
    upgrade(d) {
      d.createObjectStore('kv');
      d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    },
  });
  return dbp;
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

export const cacheGet = <T,>(key: string) => safe(async () => (await (await db()).get('kv', key)) as T | undefined, undefined);
export const cacheSet = (key: string, value: unknown) => safe(async () => { await (await db()).put('kv', value, key); return true; }, false);
export const cacheClear = () => safe(async () => { const d = await db(); await d.clear('kv'); await d.clear('queue'); return true; }, false);

export const queueAdd = (op: Omit<QueuedOp, 'id'>) => safe(async () => { await (await db()).add('queue', op); return true; }, false);
export const queueAll = () => safe(async () => (await (await db()).getAll('queue')) as QueuedOp[], [] as QueuedOp[]);
export const queueRemove = (id: number) => safe(async () => { await (await db()).delete('queue', id); return true; }, false);

export const newKey = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
