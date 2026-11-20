-- Phase 19 part A (docs/PLAN-SKILLS.md; decisions #128–#130, #148–#150): runs that finish and tell the truth.

-- Approvals: the intent is recorded before the approved call goes out, so a restart in the middle is an "outcome unknown"
-- (never a silent redo, never a run stuck "waiting for your OK"); and an approval that closed with its run says why.
ALTER TABLE approvals ADD COLUMN executing_at TEXT;   -- set right before the approved call runs (NULL = not started)
ALTER TABLE approvals ADD COLUMN closed_reason TEXT;  -- expired because: 'timeout' | 'moved_on' (a new message) | 'run_closed'

-- Runs: which schedule started them, whether it's a quiet watch check, and what went wrong (for one automatic retry).
ALTER TABLE runs ADD COLUMN schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN watch INTEGER NOT NULL DEFAULT 0;      -- 1 = a quiet watch check (reports only when its condition is met)
ALTER TABLE runs ADD COLUMN error_kind TEXT;                       -- 'transient' | 'permanent' | 'interrupted' | 'budget'
ALTER TABLE runs ADD COLUMN retry_at TEXT;                         -- UTC ISO: one automatic retry is due then (schedule/goal runs)
ALTER TABLE runs ADD COLUMN retry_of INTEGER REFERENCES runs(id) ON DELETE SET NULL; -- the failed run this one retries
ALTER TABLE runs ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0;  -- 1 = a restart already re-queued it once
CREATE INDEX runs_retry ON runs(retry_at) WHERE retry_at IS NOT NULL;

-- Watches: a scheduled check that writes only when its condition is met, remembering what it saw last time (in its own
-- words, one line), counting failures in a row, ending on a date, optionally skipping the model when a page is unchanged.
ALTER TABLE schedules ADD COLUMN notify TEXT NOT NULL DEFAULT 'always' CHECK (notify IN ('always', 'changes'));
ALTER TABLE schedules ADD COLUMN only_when TEXT;                   -- the condition in words ("the fare is under 900 TND")
ALTER TABLE schedules ADD COLUMN memo TEXT;                        -- the last NOTE line (sanitised, ≤ 500 chars; data, never instructions)
ALTER TABLE schedules ADD COLUMN memo_at TEXT;
ALTER TABLE schedules ADD COLUMN ends_at TEXT;                     -- UTC ISO: stops after this (the end of the `until` day)
ALTER TABLE schedules ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN watch_url TEXT;                   -- optional page checked in code first
ALTER TABLE schedules ADD COLUMN watch_hash TEXT;                  -- SHA-256 of that page's readable text at the last good check
ALTER TABLE schedules ADD COLUMN checked_at TEXT;                  -- the last check (by code or by the model)
ALTER TABLE schedules ADD COLUMN last_check TEXT;                  -- 'unchanged' | 'noted' | 'reported' | 'failed' | 'missed'
