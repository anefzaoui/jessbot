-- Phase 3: long-term memory (docs/CONTEXT-AND-MEMORY.md). Scope is always derived on the server.

CREATE TABLE scopes (
  id       INTEGER PRIMARY KEY,
  kind     TEXT NOT NULL CHECK (kind IN ('user', 'group', 'global')),
  ref_id   INTEGER,                                 -- users.id / groups.id / NULL for global
  name     TEXT NOT NULL
);
CREATE UNIQUE INDEX scopes_ref ON scopes(kind, ref_id);

CREATE TABLE memories (
  id                INTEGER PRIMARY KEY,
  scope_id          INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  subject_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- who the fact is about
  author_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- whose words it came from
  kind              TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('profile', 'preference', 'fact', 'event', 'instruction', 'schedule', 'place')),
  text              TEXT NOT NULL,
  pinned            INTEGER NOT NULL DEFAULT 0,      -- core memory (always in the prompt)
  importance        INTEGER NOT NULL DEFAULT 1,
  confidence        REAL NOT NULL DEFAULT 0.8,
  observed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  event_at          TEXT,                             -- the date the fact refers to, if any
  valid_to          TEXT,                             -- set when superseded
  supersedes_id     INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'forgotten')),
  created_by        TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('user', 'agent', 'extractor', 'admin')),
  source_thread_id  INTEGER,
  source_message_id INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at      TEXT,
  use_count         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX memories_scope ON memories(scope_id, status);

CREATE VIRTUAL TABLE memories_fts USING fts5(text, content='memories', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF text ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Optional embeddings (pluggable provider; model + dims recorded per row).
CREATE TABLE memory_vec (
  memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model     TEXT NOT NULL,
  dims      INTEGER NOT NULL,
  vec       BLOB NOT NULL
);

-- One dated observation per session chunk (Mastra-style), searchable.
CREATE TABLE episodes (
  id          INTEGER PRIMARY KEY,
  scope_id    INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  thread_id   INTEGER,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  ref_date    TEXT,
  text        TEXT NOT NULL
);
CREATE VIRTUAL TABLE episodes_fts USING fts5(text, content='episodes', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

-- Audit trail for every memory change (tombstones keep no text after a hard forget).
CREATE TABLE memory_events (
  id        INTEGER PRIMARY KEY,
  memory_id INTEGER,
  op        TEXT NOT NULL,                        -- add | update | supersede | forget | restore | pin | unpin | move
  actor     TEXT NOT NULL,                        -- user:<id> | agent | extractor | admin:<id>
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  old_text  TEXT,
  new_text  TEXT
);
