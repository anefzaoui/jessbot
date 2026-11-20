-- Admin → Personality: every save of SOUL.md / AGENTS.md / MEMORY.md keeps the previous text (restore any time).
CREATE TABLE workspace_versions (
  id         INTEGER PRIMARY KEY,
  file       TEXT NOT NULL CHECK (file IN ('SOUL.md', 'AGENTS.md', 'MEMORY.md')),
  body       TEXT NOT NULL,
  author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note       TEXT,                                   -- 'saved' | 'restored v12' | 'identity' | 'before first edit'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX workspace_versions_file ON workspace_versions(file, id DESC);
