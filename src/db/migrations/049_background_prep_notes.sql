-- Phase 22 (decisions #197–#200): delegate to the background, overnight prep, notes for later.

-- Delegate (#197): the run whose `delegate` call started this one (a background task in its own side chat). When it
-- finishes, a one-line result and a link go back to that run's chat. NULL for every other run.
ALTER TABLE runs ADD COLUMN parent_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;
-- What this run may spend when it isn't the person's per-task cap (#178): overnight prep (#199) sets what is left of the
-- night's cap. NULL = the policy's task budget.
ALTER TABLE runs ADD COLUMN spend_cap REAL;
-- The only tools this run may use (JSON array of tool names): offered to the model and allowed by the loop, nothing else.
-- NULL = whatever the person's toolsets allow. Overnight prep: web reads, library_create and leave_note (#199).
ALTER TABLE runs ADD COLUMN tool_allow TEXT;
CREATE INDEX runs_parent ON runs(parent_run_id) WHERE parent_run_id IS NOT NULL;

-- Overnight prep (#199), opt-in per person: off | ideas (one of their Ideas prepared during their quiet hours).
ALTER TABLE users ADD COLUMN prep TEXT NOT NULL DEFAULT 'off' CHECK (prep IN ('off', 'ideas'));
-- What kind of help an idea is (reflection says; NULL for older ideas and starters, guessed in code). Only research, plan,
-- draft and comparison ideas are prepared overnight.
ALTER TABLE ideas ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind IN ('research', 'plan', 'draft', 'comparison', 'other'));
ALTER TABLE ideas ADD COLUMN prep_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;              -- the overnight run
ALTER TABLE ideas ADD COLUMN prep_started_at TEXT;                                                      -- tried once: never twice
ALTER TABLE ideas ADD COLUMN prepared_item_id INTEGER REFERENCES library_items(id) ON DELETE SET NULL; -- the draft it made
ALTER TABLE ideas ADD COLUMN ready_at TEXT;                                                             -- "Ready for you" sent

-- Notes for later (#200): a line an unattended run (a scheduled task, a background task, overnight prep, a goal step) leaves
-- for the person's next check-in instead of posting at night. Delivered once: the check-in run that carries it claims it
-- (delivery_run_id) and delivered_at is set when that check-in posts; a check-in that stays silent or fails leaves it
-- pending. Overnight prep's "Ready for you" is one too (kind 'prep', with its idea).
CREATE TABLE notes (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  kind            TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'prep')),
  href            TEXT,                                                  -- where the work is (a Library item, a chat)
  source_label    TEXT,                                                  -- what left it: "Morning brief", "Overnight prep"
  run_id          INTEGER REFERENCES runs(id) ON DELETE SET NULL,        -- the run that left it
  idea_id         INTEGER REFERENCES ideas(id) ON DELETE CASCADE,        -- prep notes: the idea it was prepared for
  delivery_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,        -- the check-in carrying it
  delivered_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX notes_pending ON notes(user_id, delivered_at, id);
