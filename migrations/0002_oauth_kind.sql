-- Two-step OAuth: 'signin' (identity scopes) or 'calendar' (incremental calendar.events consent).
ALTER TABLE oauth_states ADD COLUMN kind TEXT NOT NULL DEFAULT 'signin';
