-- Phase 4: per-subject policies, approvals queue + standing grants, activity log.

-- Policy per subject (global → group → user; deny wins). toolsets: JSON { "<toolset>": "off" | "ask" | "allow" }.
CREATE TABLE policies (
  id                INTEGER PRIMARY KEY,
  subject_type      TEXT NOT NULL CHECK (subject_type IN ('global', 'group', 'user')),
  subject_id        INTEGER,
  toolsets          TEXT NOT NULL DEFAULT '{}',
  approver          TEXT CHECK (approver IN ('self', 'admin')),
  weekly_budget_usd REAL,
  quiet_start       TEXT,                     -- 'HH:MM' local time; null = inherit
  quiet_end         TEXT,
  updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX policies_subject ON policies(subject_type, subject_id);

-- A tool call waiting for a human OK (decision #14).
CREATE TABLE approvals (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  thread_id    INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,     -- whose request
  approver_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,             -- who must decide
  tool_call_id TEXT NOT NULL,
  tool         TEXT NOT NULL,
  risk         TEXT NOT NULL CHECK (risk IN ('read', 'write', 'spend', 'external')),
  title        TEXT NOT NULL,
  preview      TEXT,
  args         TEXT NOT NULL,                  -- JSON (executed as-is once approved)
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  scope        TEXT CHECK (scope IN ('once', 'task', 'always')),
  reason       TEXT,
  decided_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at   TEXT,
  expires_at   TEXT NOT NULL
);
CREATE INDEX approvals_pending ON approvals(approver_id, status);
CREATE INDEX approvals_user ON approvals(user_id, id);

-- "Always allow <tool>" for a person (or for one run = "this task").
CREATE TABLE approval_grants (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool       TEXT NOT NULL,
  run_id     INTEGER,                          -- set for scope 'task'
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX grants_user_tool ON approval_grants(user_id, tool);

-- What Jess did, hour by hour (panel + /activity).
CREATE TABLE activity_log (
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  kind      TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'search', 'file', 'schedule', 'message', 'memory', 'approval')),
  icon      TEXT,
  title     TEXT NOT NULL,
  detail    TEXT,
  status    TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'run', 'warn', 'bad', 'idle')),
  href      TEXT,
  run_id    INTEGER
);
CREATE INDEX activity_user_at ON activity_log(user_id, at);

-- Sensible global defaults: everyone gets the core + memory toolsets; outward actions ask first.
INSERT INTO policies (subject_type, subject_id, toolsets, approver, weekly_budget_usd, quiet_start, quiet_end)
VALUES ('global', NULL, '{"core":"allow","memory":"allow"}', 'self', 2.0, '22:00', '07:30');
