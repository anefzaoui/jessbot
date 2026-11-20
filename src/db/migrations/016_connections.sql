-- Phase 10 (decisions #77/#78): a person's own mail and calendar accounts. Settings as JSON (servers, ports, username,
-- which calendars); the password sealed with the install's key (src/lib/secrets.js) — never stored in the clear.
CREATE TABLE connections (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('email', 'calendar')),
  label        TEXT NOT NULL,                       -- "Work mail", "iCloud calendar"
  provider     TEXT,                                -- gmail | icloud | yahoo | fastmail | outlook | nextcloud | custom
  config       TEXT NOT NULL DEFAULT '{}',
  secret       TEXT,                                -- sealed password / app password
  status       TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  last_error   TEXT,
  last_ok_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX connections_user ON connections(user_id, kind);

-- Calendar events seen on the person's calendars (refreshed every 15 min and after changes): the prompt's "coming up"
-- and the Upcoming page read this, so neither waits on a server.
CREATE TABLE calendar_events (
  id             INTEGER PRIMARY KEY,
  connection_id  INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar_url   TEXT NOT NULL,
  calendar_name  TEXT,
  uid            TEXT NOT NULL,
  href           TEXT,                              -- the event object's URL (for updates / deletes)
  etag           TEXT,
  title          TEXT NOT NULL,
  location       TEXT,
  description    TEXT,
  starts_at      TEXT NOT NULL,                     -- ISO UTC (an occurrence, for recurring events)
  ends_at        TEXT,
  all_day        INTEGER NOT NULL DEFAULT 0,
  recurring      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (connection_id, uid, starts_at)
);
CREATE INDEX calendar_events_user_start ON calendar_events(user_id, starts_at);
