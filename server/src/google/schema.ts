import type { Database } from 'better-sqlite3';

/** Creates the Google-related tables (idempotent). Called at startup after the core migrations. */
export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_accounts (
      user_id TEXT PRIMARY KEY,
      google_sub TEXT NOT NULL,
      email TEXT NOT NULL,
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      expires_at INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT '',
      calendar_id TEXT NOT NULL DEFAULT 'primary',
      sync_token TEXT,
      last_sync_at TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      conflicts_resolved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      reminder_id TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
      event_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_user ON outbox(user_id, next_attempt_at);
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      user_id TEXT
    );
  `);
  // Rows that exhausted their retries stay visible (failed = 1) instead of being dropped.
  const cols = (db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('failed')) db.exec('ALTER TABLE outbox ADD COLUMN failed INTEGER NOT NULL DEFAULT 0');
}
