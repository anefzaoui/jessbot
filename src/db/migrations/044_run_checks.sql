-- Phase 19 part B (decisions #176–#181): replies that are checked before they count, breakers on spend and loops, the
-- model fallback chain, sources per run and the wish log.
-- What a run searched and read on the web (decision #180): JSON [{ url, host, title, kind: 'search' | 'read', date, at }],
-- addresses in normal form (browser/read.js normalizeUrl). The citation check and the trust chip read it.
ALTER TABLE runs ADD COLUMN sources TEXT;
-- A call answered by a model from the fallback chain rather than the one asked for (decision #179): Admin → Usage counts them.
ALTER TABLE usage_events ADD COLUMN fallback INTEGER NOT NULL DEFAULT 0;
CREATE INDEX usage_run ON usage_events(run_id) WHERE run_id IS NOT NULL;   -- the per-task spend cap sums a run's calls
-- The per-task spend cap (decision #178), per layer like the weekly budget: NULL = inherit (default min($0.50, weekly × 0.25)),
-- 0 = no cap for one task.
ALTER TABLE policies ADD COLUMN task_budget_usd REAL;

-- The wish log (decision #181): things people asked for that Jess has no tool for, one row per person and wish, counted
-- when it comes back (deduplicated by words). For the owner (Admin → System, Phase 25).
CREATE TABLE wishes (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,                       -- the request, one clean line (≤ 240 chars)
  count       INTEGER NOT NULL DEFAULT 1,
  run_id      INTEGER REFERENCES runs(id) ON DELETE SET NULL,   -- the latest task that asked
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX wishes_user ON wishes(user_id, last_seen);
CREATE VIRTUAL TABLE wishes_fts USING fts5(text, content='wishes', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER wishes_ai AFTER INSERT ON wishes BEGIN
  INSERT INTO wishes_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER wishes_ad AFTER DELETE ON wishes BEGIN
  INSERT INTO wishes_fts(wishes_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
