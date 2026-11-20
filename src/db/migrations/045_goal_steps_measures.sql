-- Phase 22 (docs/PLAN-SKILLS.md item 15; decisions #182–#185): goals whose steps say when they're done and run in
-- order, real numbers with streaks and milestones, a second round of intake questions, and ideas that remember why
-- they were turned down.

-- Plan steps: one checkable line that says the step is finished (appended to its run and used by the goal gate), and
-- the earlier steps it waits for (JSON [goal_tasks.id], once-steps of the same goal; cycles are refused when saved).
ALTER TABLE goal_tasks ADD COLUMN done_when TEXT;
ALTER TABLE goal_tasks ADD COLUMN after_ids TEXT NOT NULL DEFAULT '[]';

-- Goals: which intake round the questions belong to (1 = the first questions, 2 = the follow-ups those answers raised),
-- the highest progress milestone already put on the timeline (0, 25, 50 or 75; each is announced once), and when the
-- last gentle "how's it going?" nudge after a lapse was sent (at most one a day per person, one per lapse).
ALTER TABLE goals ADD COLUMN intake_round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE goals ADD COLUMN milestone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE goals ADD COLUMN lapse_hint_at TEXT;

-- What a goal counts: a level to move from start to target ("weight 92 → 84 kg", direction down) and/or a rhythm
-- ("runs, 3 per week"). With start and target, progress = (latest value − start) / (target − start).
CREATE TABLE goal_measures (
  id         INTEGER PRIMARY KEY,
  goal_id    INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  unit       TEXT,
  start      REAL,
  target     REAL,
  direction  TEXT NOT NULL DEFAULT 'up' CHECK (direction IN ('up', 'down')),
  per_week   INTEGER CHECK (per_week IS NULL OR per_week BETWEEN 1 AND 21),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX goal_measures_goal ON goal_measures(goal_id);

-- Each number logged against a measure (a level reading, or one session of a rhythm measure).
CREATE TABLE goal_logs (
  id         INTEGER PRIMARY KEY,
  measure_id INTEGER NOT NULL REFERENCES goal_measures(id) ON DELETE CASCADE,
  value      REAL NOT NULL,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  note       TEXT,
  run_id     INTEGER REFERENCES runs(id) ON DELETE SET NULL
);
CREATE INDEX goal_logs_measure ON goal_logs(measure_id, at);

-- Why an idea was turned down (durable reasons only: "Not now" is a snooze, never recorded as a rejection).
ALTER TABLE ideas ADD COLUMN dismiss_reason TEXT CHECK (dismiss_reason IS NULL OR dismiss_reason IN ('not_for_me', 'already_doing'));
ALTER TABLE ideas ADD COLUMN dismiss_note TEXT;
