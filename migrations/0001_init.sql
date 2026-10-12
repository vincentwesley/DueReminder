-- Reminder System schema (D1 / SQLite). Apply: npm run db:migrate:local | db:migrate:remote
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, google_sub TEXT, name TEXT NOT NULL DEFAULT '',
  picture_url TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE lists (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
-- At most one default list per user, even when two first requests race.
CREATE UNIQUE INDEX idx_lists_default ON lists(user_id) WHERE is_default = 1 AND deleted_at IS NULL;
CREATE TABLE tags (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE, color TEXT NOT NULL, UNIQUE (user_id, name)
);
CREATE TABLE reminders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, list_id TEXT NOT NULL,
  title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', priority INTEGER NOT NULL DEFAULT 0,
  due_at TEXT, all_day INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL DEFAULT 'UTC', rrule TEXT,
  snoozed_until TEXT, completed_at TEXT, calendar_sync INTEGER NOT NULL DEFAULT 0, google_event_id TEXT, google_etag TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1,
  -- Wall-clock anchor of a recurring series, valid only while due_at still equals rrule_anchor_due.
  rrule_anchor TEXT, rrule_anchor_due TEXT
);
CREATE INDEX idx_reminders_user_due ON reminders(user_id, deleted_at, status, due_at);
CREATE TABLE reminder_tags (
  reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (reminder_id, tag_id)
);
CREATE TABLE subtasks (
  id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_subtasks_reminder ON subtasks(reminder_id, position);
CREATE TABLE templates (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', list_id TEXT, priority INTEGER NOT NULL DEFAULT 0,
  all_day INTEGER NOT NULL DEFAULT 0, timezone TEXT, rrule TEXT, tag_ids TEXT NOT NULL DEFAULT '[]', subtasks TEXT NOT NULL DEFAULT '[]',
  due_offset_minutes INTEGER, time_of_day TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_templates_user ON templates(user_id, name);
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY, user_id TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);

-- Google Calendar sync. Tokens are AES-256-GCM encrypted (key derived from SESSION_SECRET).
CREATE TABLE google_accounts (
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
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  reminder_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  event_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  failed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_outbox_user ON outbox(user_id, next_attempt_at);
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  user_id TEXT
);
