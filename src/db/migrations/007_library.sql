-- Phase 6: the Library — everything Jess makes for a person (docs, interactive HTML artifacts, later PDFs/office files).
-- Files live in data/artifacts/<owner_id>/<public_id>/v<N>.<ext>; every update is a new version (old ones kept).

CREATE TABLE library_items (
  id           INTEGER PRIMARY KEY,
  public_id    TEXT NOT NULL UNIQUE,                                   -- unguessable id used in URLs
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('html', 'md', 'doc', 'pdf', 'image', 'sheet', 'slides')),
  description  TEXT,
  ext          TEXT NOT NULL,                                          -- file extension of every version
  mime         TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,                             -- current version
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  has_thumb    INTEGER NOT NULL DEFAULT 0,
  proactive    INTEGER NOT NULL DEFAULT 0,                             -- made without being asked
  source_label TEXT,                                                   -- short "why": "from a research question"
  thread_id    INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  run_id       INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT                                                    -- soft delete (restorable)
);
CREATE INDEX library_items_owner ON library_items(owner_id, deleted_at, updated_at DESC);

-- Search over the person's own items (title, description, text of the current version).
CREATE VIRTUAL TABLE library_fts USING fts5(title, description, body, tokenize = 'unicode61 remove_diacritics 2');

-- Making things for people is on by default (admins can still turn it off or to ask-first per person/group).
UPDATE policies SET toolsets = json_set(toolsets, '$.library', 'allow'), updated_at = datetime('now')
 WHERE subject_type = 'global' AND json_extract(toolsets, '$.library') IS NULL;
