-- Phase 2: accounts, sessions, invites, groups, per-subject instructions (versioned), audit log.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  call_me       TEXT,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  password_hash TEXT,                              -- argon2id$v=19$m=…,t=…,p=…$salt$hash
  hue           INTEGER NOT NULL DEFAULT 250,      -- avatar colour
  timezone      TEXT,
  about         TEXT,                              -- "anything I should always keep in mind"
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT
);

-- Opaque bearer tokens (web cookie or app Authorization header). Only the SHA-256 is stored.
CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL DEFAULT 'web' CHECK (kind IN ('web', 'app')),
  device       TEXT,
  ip           TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE groups (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- e.g. Family, Company
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE invites (
  id               INTEGER PRIMARY KEY,
  token_hash       TEXT NOT NULL UNIQUE,
  email            TEXT COLLATE NOCASE,
  name             TEXT,
  role             TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  group_id         INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  invited_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT NOT NULL,
  accepted_at      TEXT,
  accepted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_at       TEXT
);

-- "How Jessbot should respond to …" — append-only versions; the current one is the newest per subject.
CREATE TABLE instructions (
  id           INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('global', 'group', 'user')),
  subject_id   INTEGER,                          -- NULL for global
  body         TEXT NOT NULL,
  author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX instructions_subject ON instructions(subject_type, subject_id, id);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,                     -- e.g. user.invite, session.revoke, setup.complete
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,                              -- JSON
  ip          TEXT
);
CREATE INDEX audit_at ON audit_log(at);
