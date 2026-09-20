import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, google_sub TEXT, name TEXT NOT NULL DEFAULT '',
  picture_url TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE, color TEXT NOT NULL, UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, list_id TEXT NOT NULL,
  title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', priority INTEGER NOT NULL DEFAULT 0,
  due_at TEXT, all_day INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL DEFAULT 'UTC', rrule TEXT,
  snoozed_until TEXT, completed_at TEXT, calendar_sync INTEGER NOT NULL DEFAULT 0, google_event_id TEXT, google_etag TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_reminders_user_due ON reminders(user_id, deleted_at, status, due_at);
CREATE TABLE IF NOT EXISTS reminder_tags (
  reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (reminder_id, tag_id)
);
CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_subtasks_reminder ON subtasks(reminder_id, position);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', list_id TEXT, priority INTEGER NOT NULL DEFAULT 0,
  all_day INTEGER NOT NULL DEFAULT 0, timezone TEXT, rrule TEXT, tag_ids TEXT NOT NULL DEFAULT '[]', subtasks TEXT NOT NULL DEFAULT '[]',
  due_offset_minutes INTEGER, time_of_day TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id, name);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY, user_id TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
`;

/** Opens the DB and applies core migrations. the Google tables are created by google/schema.ts migrate(db), which buildApp calls afterwards. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const cols = (db.prepare('PRAGMA table_info(reminders)').all() as { name: string }[]).map((c) => c.name);
  // Wall-clock anchor of a recurring series, valid only while due_at still equals rrule_anchor_due.
  if (!cols.includes('rrule_anchor')) db.exec('ALTER TABLE reminders ADD COLUMN rrule_anchor TEXT');
  if (!cols.includes('rrule_anchor_due')) db.exec('ALTER TABLE reminders ADD COLUMN rrule_anchor_due TEXT');
  return db;
}
