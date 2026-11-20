-- Run taint (Phase 18, docs/SECURITY.md, decision #119): what outside content each run read, and whether any of it was
-- caught addressing AI assistants. 'low' = the run read outside content (a page, an email, a file…); 'high' = suspected
-- injection. One row per (run, level, tool, label); approvals read it (src/agent/taint.js).
CREATE TABLE run_taint (
  id      INTEGER PRIMARY KEY,
  run_id  INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  level   TEXT NOT NULL CHECK (level IN ('low', 'high')),
  tool    TEXT NOT NULL,                       -- the tool (or 'attachment') that brought the content in
  label   TEXT NOT NULL,                       -- where it came from: "page on example.com", "email from Ann <a@x> · “Invoice”"
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, level, tool, label)
);
