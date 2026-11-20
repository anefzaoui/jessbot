-- Deep project files (docs/PROJECTS.md P13c, decision #94): every project file is split into page- and heading-aware chunks
-- and indexed, so Jess searches inside them (project_search) and cites "title p.12" instead of carrying whole files.
CREATE VIRTUAL TABLE project_chunks USING fts5(
  text,                    -- the chunk
  header,                  -- deterministic context: "title › heading" (searched too)
  project_id UNINDEXED, item_id UNINDEXED, version UNINDEXED, page UNINDEXED, tokens UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
-- Which version of each file is indexed (re-indexed when a file gets a new version).
CREATE TABLE project_chunk_state (
  item_id    INTEGER PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  chunks     INTEGER NOT NULL,
  tokens     INTEGER NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- How often Jess used a file in her answers (read, found by search, looked at) — shown on the Files tab.
ALTER TABLE library_items ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
-- Images: what is in the picture (and any text in it), written once by a vision call, so later turns can find it without
-- re-sending pixels (view_image shows the picture again when it matters).
ALTER TABLE library_items ADD COLUMN caption TEXT;
