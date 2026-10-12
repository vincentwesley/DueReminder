-- Cron fairness: last_attempt_at is set on every sync attempt (success or not); pull_resume holds the
-- page cursor when a capped cycle ends early. One Google identity maps to at most one user.
ALTER TABLE google_accounts ADD COLUMN last_attempt_at TEXT;
ALTER TABLE google_accounts ADD COLUMN pull_resume TEXT;
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
