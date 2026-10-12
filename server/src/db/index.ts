// Minimal structural types for the D1 binding (avoids pulling workers-types into the Node/DOM tsconfig),
// plus thin helpers. D1 rejects `undefined` binds, so every bind goes through `q`, which maps it to null.
export interface D1Meta { changes: number; last_row_id: number }
export interface D1Result<T = unknown> { results: T[]; success: boolean; meta: D1Meta }
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
export type Db = D1Database;
export type Stmt = D1PreparedStatement;

/** A bound statement (use directly inside `batch`). */
export const q = (db: Db, sql: string, ...args: unknown[]): Stmt => db.prepare(sql).bind(...args.map((v) => (v === undefined ? null : v)));
/** First row or undefined. */
export const one = async <T>(db: Db, sql: string, ...args: unknown[]): Promise<T | undefined> => (await q(db, sql, ...args).first<T>()) ?? undefined;
export const many = async <T>(db: Db, sql: string, ...args: unknown[]): Promise<T[]> => (await q(db, sql, ...args).all<T>()).results;
/** Runs a write; returns the number of rows changed. */
export const exec = async (db: Db, sql: string, ...args: unknown[]): Promise<number> => (await q(db, sql, ...args).run()).meta.changes;
/** Atomic multi-statement write (D1 runs a batch in one transaction). */
export const batch = async (db: Db, stmts: Stmt[]): Promise<void> => { if (stmts.length) await db.batch(stmts); };
