-- Projects (docs/PROJECTS.md, decision #91): a labelled, continuous chat with its own brief and files.
-- The chat is an ordinary thread (kind 'side') owned by the project; the rail lists it under Projects, not side chats.
CREATE TABLE projects (
  id               INTEGER PRIMARY KEY,
  public_id        TEXT NOT NULL UNIQUE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id        INTEGER NOT NULL UNIQUE REFERENCES threads(id),
  name             TEXT NOT NULL,
  icon             TEXT NOT NULL DEFAULT 'folder',         -- a Lucide name from services/projects.js ICONS
  hue              INTEGER NOT NULL DEFAULT 250,           -- 0–359, the project's colour
  field            TEXT NOT NULL DEFAULT 'general',        -- general | code | workshop | health | finance | legal | learning | creative | home
  about            TEXT NOT NULL DEFAULT '',               -- one line: what it is and what "done" looks like
  intake           TEXT,                                   -- JSON [{ question, answer }] from the creation interview
  -- draft: proposed in a chat, waiting for Create · active · paused · done · archived (hidden from Main's index)
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'paused', 'done', 'archived')),
  created_run_id   INTEGER REFERENCES runs(id) ON DELETE SET NULL,   -- the reply that proposed it (its card lives there)
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at       TEXT
);
CREATE INDEX projects_user ON projects(user_id, deleted_at, status);

-- The brief: small structured rows, each from a message, patched (never rewritten) so it can't drift.
-- created_by 'user' rows are the person's own and are never changed by Jess.
CREATE TABLE project_items (
  id                INTEGER PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('goal', 'status', 'decision', 'question', 'next', 'constraint', 'number', 'note')),
  text              TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'superseded')),
  created_by        TEXT NOT NULL DEFAULT 'jess' CHECK (created_by IN ('jess', 'user')),
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  supersedes_id     INTEGER REFERENCES project_items(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at         TEXT
);
CREATE INDEX project_items_open ON project_items(project_id, state, kind);

-- Files and goals that belong to a project.
ALTER TABLE library_items ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX library_items_project ON library_items(project_id, deleted_at);
ALTER TABLE goals ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;

-- Project tools are on for everyone by default — they only touch the person's own projects. An admin's own choice is kept.
UPDATE policies SET toolsets = json_set(toolsets, '$.projects', 'allow'), updated_at = datetime('now')
 WHERE subject_type = 'global' AND json_extract(toolsets, '$.projects') IS NULL;
