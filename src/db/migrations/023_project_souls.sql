-- The project soul (docs/PROJECTS.md, decision #93): Jess's expertise inside one project. Structured fields; the text the
-- model reads is assembled by code (the safety block comes from code, by the project's field, and can't be edited).
-- Every save is a version (history, restore, compare with the first); the active one is projects.soul_version.
CREATE TABLE project_souls (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  fields      TEXT NOT NULL,                     -- JSON { stance, person, anchors[], askFirst[], checkWork[], format, glossary[], learned[] }
  created_by  TEXT NOT NULL CHECK (created_by IN ('draft', 'user', 'jess', 'ai')),
  note        TEXT,                              -- why this version exists ("Accepted Jess's proposal: …", "Restored v2")
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, version)
);
ALTER TABLE projects ADD COLUMN soul_version INTEGER;

-- Changes to the soul that Jess (from the conversation) or "Improve with AI" suggests; nothing changes until accepted.
CREATE TABLE project_soul_proposals (
  id                INTEGER PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  base_version      INTEGER,                     -- the version it was written against
  fields            TEXT NOT NULL,               -- JSON: the full proposed fields
  reason            TEXT NOT NULL,
  quote             TEXT,                        -- the person's own words that prompted it (Jess's proposals)
  source            TEXT NOT NULL CHECK (source IN ('jess', 'ai')),
  run_id            INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'stale')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at        TEXT
);
CREATE INDEX project_soul_proposals_open ON project_soul_proposals(project_id, status);
