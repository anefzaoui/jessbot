-- Phase 7a: things that happen on their own — scheduled tasks, proactive check-ins, alarms/reminders/timers
-- (decisions #28, #32, #48) — plus the device registry the Android app will use for push (Phase 12).

-- Agent tasks on a rhythm or at one moment ("every weekday at 7, brief me"), and the per-person check-in.
CREATE TABLE schedules (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'checkin')),
  title        TEXT NOT NULL,
  prompt       TEXT NOT NULL DEFAULT '',                  -- what Jess should do when it fires
  cron         TEXT,                                      -- croner pattern in `timezone` (null = one-off)
  run_at       TEXT,                                      -- one-off: UTC ISO
  timezone     TEXT NOT NULL,
  next_run_at  TEXT,                                      -- UTC ISO; null once finished
  paused       INTEGER NOT NULL DEFAULT 0,
  last_run_at  TEXT,
  last_status  TEXT CHECK (last_status IN ('ok', 'bad', 'silent', 'skipped')),
  last_run_id  INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  thread_id    INTEGER REFERENCES threads(id) ON DELETE SET NULL,  -- where results appear (default: main chat)
  created_by   TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('user', 'agent', 'system')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX schedules_due ON schedules(next_run_at) WHERE next_run_at IS NOT NULL AND paused = 0;
CREATE INDEX schedules_user ON schedules(user_id);

-- Alarms ring until stopped; reminders post a message; timers ring after a duration.
CREATE TABLE alarms (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('alarm', 'reminder', 'timer')),
  label         TEXT NOT NULL DEFAULT '',
  fire_at       TEXT NOT NULL,                            -- UTC ISO of the next ring
  timezone      TEXT NOT NULL,
  repeat_cron   TEXT,                                     -- croner pattern in `timezone` (null = once)
  duration_sec  INTEGER,                                  -- timers
  status        TEXT NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'ringing', 'snoozed', 'dismissed', 'missed', 'cancelled', 'done')),
  rang_at       TEXT,
  ended_at      TEXT,
  snooze_count  INTEGER NOT NULL DEFAULT 0,
  thread_id     INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  created_by    TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('user', 'agent')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX alarms_due ON alarms(fire_at) WHERE status IN ('scheduled', 'snoozed');
CREATE INDEX alarms_user ON alarms(user_id, status);

-- Phones/tablets that should receive pushes (Android app, Phase 12). Web browsers use the socket.
CREATE TABLE devices (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web', 'other')),
  name         TEXT,
  push_kind    TEXT CHECK (push_kind IN ('fcm', 'unifiedpush', 'ntfy')),
  push_token   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, push_token)
);

-- Runs can start without a typed message (schedule, check-in, reminder); silent check-ins stay out of the chat.
ALTER TABLE runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE runs ADD COLUMN origin_label TEXT;
ALTER TABLE runs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

-- Per-person check-in rhythm: 'off' | 'light' (once a day) | 'normal' (three times a day). Null = default (normal).
ALTER TABLE users ADD COLUMN checkins TEXT CHECK (checkins IN ('off', 'light', 'normal'));

-- Schedules, alarms, reminders and timers are on by default.
UPDATE policies SET toolsets = json_set(toolsets, '$.schedule', 'allow'), updated_at = datetime('now')
 WHERE subject_type = 'global' AND json_extract(toolsets, '$.schedule') IS NULL;
