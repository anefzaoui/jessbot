-- Phase 12 (decision #85): browsers and installed PWAs register for Web Push ('webpush'); FCM is not used (a Google
-- account on the server would be needed). SQLite can't change a CHECK, so the table is rebuilt with its rows.
CREATE TABLE devices_new (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'other')),
  name         TEXT,
  push_kind    TEXT CHECK (push_kind IN ('webpush', 'unifiedpush', 'ntfy')),
  push_token   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, push_token)
);
INSERT INTO devices_new (id, user_id, session_id, platform, name, push_kind, push_token, created_at, last_seen_at)
  SELECT id, user_id, session_id, platform, name, CASE WHEN push_kind = 'fcm' THEN NULL ELSE push_kind END, push_token, created_at, last_seen_at FROM devices;
DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;
