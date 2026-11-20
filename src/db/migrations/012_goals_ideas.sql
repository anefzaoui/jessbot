-- Phase 8: Goals (with their tasks = the projects/tasks model) and Ideas (decision #55).

CREATE TABLE goals (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'other',
  state          TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('suggested', 'active', 'paused', 'done', 'archived', 'dismissed')),
  -- intake: questions being written / waiting for answers · planning: the plan is being written · ready: plan exists
  stage          TEXT NOT NULL DEFAULT 'intake' CHECK (stage IN ('intake', 'planning', 'ready')),
  horizon        TEXT NOT NULL DEFAULT 'now' CHECK (horizon IN ('now', 'long')),
  why            TEXT,                        -- suggested goals: what Jess noticed
  intake         TEXT,                        -- JSON questions (ask-dock contract); null while being written
  answers        TEXT,                        -- JSON [{ question, answer }] (readable) or '[]' when skipped
  summary        TEXT,
  status_line    TEXT,
  next_step      TEXT,
  progress       INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  thread_id      INTEGER REFERENCES threads(id) ON DELETE SET NULL,   -- the side chat where Jess works on it
  error          TEXT,                        -- the last background job's failure (shown with Retry)
  last_review_at TEXT,
  next_review_at TEXT,                        -- UTC ISO
  created_by     TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'agent', 'reflection')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX goals_user ON goals(user_id, state);

-- A goal's plan: things Jess can do. once = one run; recurring = a schedule in the goal's thread.
CREATE TABLE goal_tasks (
  id          INTEGER PRIMARY KEY,
  goal_id     INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  prompt      TEXT NOT NULL,                  -- what Jess does when it runs
  kind        TEXT NOT NULL DEFAULT 'once' CHECK (kind IN ('once', 'recurring')),
  repeat      TEXT,                           -- recurring: daily | weekdays | weekly | monthly (+ at)
  at          TEXT,                           -- recurring: HH:MM local
  enabled     INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done', 'failed')),
  run_id      INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL DEFAULT 'plan' CHECK (created_by IN ('plan', 'agent', 'user')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  done_at     TEXT
);
CREATE INDEX goal_tasks_goal ON goal_tasks(goal_id, position);

-- The goal's timeline.
CREATE TABLE goal_events (
  id      INTEGER PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  kind    TEXT NOT NULL CHECK (kind IN ('checkin', 'action', 'reply', 'artifact', 'milestone', 'note')),
  icon    TEXT,
  title   TEXT NOT NULL,
  detail  TEXT,
  href    TEXT,
  run_id  INTEGER REFERENCES runs(id) ON DELETE SET NULL
);
CREATE INDEX goal_events_goal ON goal_events(goal_id, at);

-- Runs and schedules that work on a goal (the timeline and task status follow them).
ALTER TABLE runs ADD COLUMN goal_id INTEGER REFERENCES goals(id) ON DELETE SET NULL;
ALTER TABLE schedules ADD COLUMN goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE;

CREATE TABLE ideas (
  id                INTEGER PRIMARY KEY,
  public_id         TEXT NOT NULL UNIQUE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  why               TEXT NOT NULL,
  category          TEXT NOT NULL DEFAULT 'Everyday',
  icon              TEXT,
  prompt            TEXT NOT NULL,              -- what gets sent to Jess on "Let's do it"
  source_thread_id  INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  state             TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'seen', 'snoozed', 'dismissed', 'started')),
  snooze_until      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ideas_user ON ideas(user_id, state);

-- When each person's conversations were last reflected on (ideas + suggested goals).
ALTER TABLE users ADD COLUMN reflected_at TEXT;
ALTER TABLE users ADD COLUMN reflected_msg_id INTEGER NOT NULL DEFAULT 0;

-- Goals & ideas are on for everyone by default (like web, library, schedule).
UPDATE policies SET toolsets = json_set(toolsets, '$.goals', 'allow'), updated_at = datetime('now')
 WHERE subject_type = 'global' AND json_extract(toolsets, '$.goals') IS NULL;
