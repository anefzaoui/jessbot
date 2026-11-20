// Phase 22 part B (decisions #139–#143): family lists, fair draws, a name's pronunciation, and audio in the Library.
// JS rather than SQL for one reason: the Library's `type` CHECK must also allow 'audio' (long read-aloud, #142), and SQLite
// can't alter a CHECK. The table is rebuilt from its OWN current definition (sqlite_master) with only that list changed,
// so columns other migrations added before this one (project_id, use_count, caption, …) are carried over whatever they are.
export const foreignKeys = false; // the 12-step rebuild (docs/DATABASE.md): FKs off around it, foreign_key_check after

export async function up({ exec, get, all }) {
  exec(`
-- Family lists (#139): shopping, to-dos, wish and packing lists, private or shared with a group, like memory scopes.
CREATE TABLE lists (
  id          INTEGER PRIMARY KEY,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,       -- who made it (may rename / archive it)
  scope_id    INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,      -- a person's own scope or a group's (services/memory.js)
  kind        TEXT NOT NULL DEFAULT 'todo' CHECK (kind IN ('shopping', 'todo', 'wish', 'packing', 'custom')),
  title       TEXT NOT NULL,
  wisher_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,               -- wish lists: whose wishes (never sees "bought")
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX lists_scope_title ON lists(scope_id, lower(title)) WHERE archived_at IS NULL;

-- One row per item, changed one at a time: two people ticking or adding at once never overwrite each other.
CREATE TABLE list_items (
  id                INTEGER PRIMARY KEY,
  list_id           INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  text              TEXT NOT NULL,
  qty               TEXT,                                                 -- "1 L", "2 kg", "12"
  category          TEXT,                                                 -- shopping aisle (inferred, editable)
  assignee_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_at            TEXT,                                                 -- UTC ISO
  done_at           TEXT,
  done_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  hidden_from_owner INTEGER NOT NULL DEFAULT 0,                           -- wish lists: ticked as bought by someone else
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source_msg_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  pos               INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX list_items_list ON list_items(list_id, done_at, pos);
CREATE INDEX list_items_due ON list_items(due_at) WHERE due_at IS NOT NULL AND done_at IS NULL;

-- Fair draws (#141): what was drawn, from what, how and when, so "was it fair?" has an answer. A Secret Santa's matches
-- are never stored (result is NULL): each person got theirs privately, and nobody, the organiser included, can look them up.
CREATE TABLE draws (
  id         INTEGER PRIMARY KEY,
  public_id  TEXT NOT NULL UNIQUE,                                        -- "d-7Kq2…", said in chat
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id     INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  mode       TEXT NOT NULL,
  input      TEXT NOT NULL,                                               -- JSON: items and options as given
  result     TEXT,                                                        -- JSON, or NULL for a private reveal
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX draws_user ON draws(user_id, created_at);

-- How to say my name (#143): a phonetic spelling her voice uses in place of the written name.
ALTER TABLE users ADD COLUMN name_say TEXT;

-- Lists are on for everyone, like schedules: they only touch the person's own and their groups' lists. An admin's own
-- choice is kept.
UPDATE policies SET toolsets = json_set(toolsets, '$.lists', 'allow'), updated_at = datetime('now')
 WHERE subject_type = 'global' AND json_extract(toolsets, '$.lists') IS NULL;
`);

  // ---- library_items.type gains 'audio' -------------------------------------------------------------------------------
  const table = get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'library_items'`);
  const check = /CHECK\s*\(\s*type\s+IN\s*\(([^)]*)\)\s*\)/i;
  const m = check.exec(table?.sql || '');
  if (!m) throw new Error('library_items has no type CHECK where one was expected — not rebuilding blindly.');
  if (/'audio'/.test(m[1])) return;
  const newSql = table.sql.replace(check, `CHECK (type IN (${m[1].trim()}, 'audio'))`)
    .replace(/^CREATE TABLE\s+("?)library_items\1\s*\(/i, 'CREATE TABLE library_items_new (');
  if (!newSql.startsWith('CREATE TABLE library_items_new (')) throw new Error('Unexpected library_items definition.');
  const extras = all(`SELECT sql FROM sqlite_master WHERE tbl_name = 'library_items' AND type IN ('index', 'trigger') AND sql IS NOT NULL`);
  exec(newSql);
  exec('INSERT INTO library_items_new SELECT * FROM library_items');
  exec('DROP TABLE library_items');
  exec('ALTER TABLE library_items_new RENAME TO library_items');
  for (const x of extras) exec(x.sql);
}
