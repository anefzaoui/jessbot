-- Projects P13d (decision #95): meaning-based search next to word search, and a weekly tidy of each brief.
-- One vector per project-file chunk (normalised Float32, brute-force cosine: a project has hundreds of chunks, not millions).
-- The chunk's rowid changes when its file is re-indexed, so vectors are replaced with it (keyed by item for cleanup).
CREATE TABLE project_chunk_vecs (
  chunk_rowid INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  dims        INTEGER NOT NULL,
  vec         BLOB NOT NULL
);
CREATE INDEX project_chunk_vecs_project ON project_chunk_vecs(project_id, model);
CREATE INDEX project_chunk_vecs_item ON project_chunk_vecs(item_id);
ALTER TABLE projects ADD COLUMN tidied_at TEXT;
