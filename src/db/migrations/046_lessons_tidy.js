// Phase 20 part B (decisions #186–#189): lessons (short rules learned from corrections, thumbs-down and tasks that were
// pushed before they delivered) and the weekly memory tidy (merge near-duplicates, archive stale events, with Undo).
// JS rather than SQL for one reason: memories.status must also allow 'archived', and SQLite can't alter a CHECK. The table
// is rebuilt from its OWN current definition (sqlite_master) with only that list changed, like migration 034, so columns
// other migrations added (event_at's partner recurs, …) are carried over whatever they are. Row ids stay the same, so the
// external-content FTS index (memories_fts) and memory_vec rows stay valid.
export const foreignKeys = false; // the 12-step rebuild (docs/DATABASE.md): FKs off around it, foreign_key_check after

export async function up({ exec, get, all }) {
  exec(`
-- Lessons (#186): "When …, do … (not …)". Personal ones belong to one person and are active at once (they see and remove
-- them); household ones apply to everyone and wait for the owner (status 'proposed') unless the owner wrote them.
CREATE TABLE lessons (
  id                INTEGER PRIMARY KEY,
  scope             TEXT NOT NULL CHECK (scope IN ('person', 'household')),
  user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE,          -- person: whose; household: whose task taught it
  domain            TEXT,                                                      -- registrable host (booking.com) or NULL
  rule              TEXT NOT NULL,                                             -- ≤ 220 chars
  why               TEXT,                                                      -- ≤ 160 chars
  source            TEXT NOT NULL CHECK (source IN ('said', 'thumbs_down', 'pushed', 'owner')),
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  run_id            INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'proposed', 'retired', 'rejected', 'promoted')),
  uses              INTEGER NOT NULL DEFAULT 0,                                -- messages / site visits it was relevant to
  last_used_at      TEXT,
  recurrences       INTEGER NOT NULL DEFAULT 1,                                -- times it was learned (again)
  reviewed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX lessons_scope ON lessons(scope, status, user_id);
CREATE INDEX lessons_domain ON lessons(domain) WHERE domain IS NOT NULL;
CREATE INDEX lessons_message ON lessons(source_message_id) WHERE source_message_id IS NOT NULL;
CREATE VIRTUAL TABLE lessons_fts USING fts5(rule, content='lessons', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER lessons_ai AFTER INSERT ON lessons BEGIN
  INSERT INTO lessons_fts(rowid, rule) VALUES (new.id, new.rule);
END;
CREATE TRIGGER lessons_ad AFTER DELETE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, rule) VALUES ('delete', old.id, old.rule);
END;
CREATE TRIGGER lessons_au AFTER UPDATE OF rule ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, rule) VALUES ('delete', old.id, old.rule);
  INSERT INTO lessons_fts(rowid, rule) VALUES (new.id, new.rule);
END;

-- Each time a lesson was learned (the first time included): the evidence for "recurred ≥ 3 times across ≥ 2 tasks in 30
-- days", when the owner may promote it into AGENTS.md.
CREATE TABLE lesson_hits (
  id        INTEGER PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  run_id    INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  source    TEXT NOT NULL,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX lesson_hits_lesson ON lesson_hits(lesson_id, at);

-- The weekly memory tidy (#189): one row per person per pass, and each change it made (undoable one by one).
CREATE TABLE memory_tidies (
  id       INTEGER PRIMARY KEY,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status   TEXT NOT NULL CHECK (status IN ('done', 'nothing', 'error')),
  merged   INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  note     TEXT,
  at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX memory_tidies_user ON memory_tidies(user_id, at);
CREATE TABLE memory_tidy_changes (
  id            INTEGER PRIMARY KEY,
  tidy_id       INTEGER NOT NULL REFERENCES memory_tidies(id) ON DELETE CASCADE,
  op            TEXT NOT NULL CHECK (op IN ('merge', 'archive')),
  memory_ids    TEXT NOT NULL,                  -- JSON [memories.id] the change took out of the active set
  new_memory_id INTEGER,                        -- merge: the memory that replaced them
  why           TEXT,
  undone_at     TEXT
);
CREATE INDEX memory_tidy_changes_tidy ON memory_tidy_changes(tidy_id);
`);

  // ---- memories.status gains 'archived' (the tidy's "no longer current, kept for history") --------------------------------
  const table = get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories'`);
  const check = /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i;
  const m = check.exec(table?.sql || '');
  if (!m) throw new Error('memories has no status CHECK where one was expected — not rebuilding blindly.');
  if (/'archived'/.test(m[1])) return;
  const newSql = table.sql.replace(check, `CHECK (status IN (${m[1].trim()}, 'archived'))`)
    .replace(/^CREATE TABLE\s+("?)memories\1\s*\(/i, 'CREATE TABLE memories_new (');
  if (!newSql.startsWith('CREATE TABLE memories_new (')) throw new Error('Unexpected memories definition.');
  const extras = all(`SELECT sql FROM sqlite_master WHERE tbl_name = 'memories' AND type IN ('index', 'trigger') AND sql IS NOT NULL`);
  exec(newSql);
  exec('INSERT INTO memories_new SELECT * FROM memories');
  exec('DROP TABLE memories');
  exec('ALTER TABLE memories_new RENAME TO memories');
  for (const x of extras) exec(x.sql);
}
