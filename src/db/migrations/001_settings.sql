-- Phase 0: key/value settings (setup state, bot identity, UI defaults).
-- Later phases add their own numbered migrations; never edit an applied one.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,            -- JSON-encoded
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
