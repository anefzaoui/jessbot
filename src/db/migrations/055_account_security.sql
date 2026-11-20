-- Account security (decision #230, issue #6): optional two-step sign-in (TOTP), one-time recovery codes, the pending
-- second step of a sign-in, and admin-made password reset links.
-- totp_secret / totp_pending are sealed with JESSBOT_SECRET (lib/secrets.js), like mail passwords: a copied database
-- alone doesn't reveal them. totp_last_step: the last 30-second step a code was accepted for (a code works once).
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_pending TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;

-- Recovery codes: only a SHA-256 of each (60 random bits), shown to the person once.
CREATE TABLE recovery_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

-- The password was right; the second step is pending. Only the token's SHA-256 is stored; it lasts 10 minutes.
CREATE TABLE login_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  next TEXT,
  expires_at TEXT NOT NULL
) WITHOUT ROWID;

-- A one-time link an admin makes for someone who forgot their password (or the owner, from the command line).
CREATE TABLE password_resets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX password_resets_user ON password_resets(user_id);
