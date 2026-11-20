-- Phase 12 (decision #84): which skills an admin approved — and exactly which version of each file. A skill whose file
-- changed since (a git pull, an edit) no longer matches approved_checksum and waits for review again.
CREATE TABLE skills (
  name               TEXT PRIMARY KEY,
  enabled            INTEGER NOT NULL DEFAULT 0,
  approved_checksum  TEXT,
  approved_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at        TEXT
);
