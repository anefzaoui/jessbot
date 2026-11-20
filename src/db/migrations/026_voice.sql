-- Voice (docs/VOICE.md, decision #99): voice notes from the person (in) and Jess's spoken replies (out).
-- Audio files live in data/voice/<user_id>/<public_id>.wav; this table is their index.
CREATE TABLE voice_clips (
  id          INTEGER PRIMARY KEY,
  public_id   TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id   INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,   -- in: their message · out: her reply
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  peaks       TEXT,                                                  -- JSON: 48 bars (0–1) for the waveform
  transcript  TEXT,                                                  -- in: what they said · out: what she said
  model       TEXT,
  voice       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX voice_clips_message ON voice_clips(message_id, direction);
CREATE INDEX voice_clips_user ON voice_clips(user_id, created_at);

-- A reply that should be spoken (they asked, or they sent a voice note): made into a voice note when it finishes.
ALTER TABLE runs ADD COLUMN voice INTEGER NOT NULL DEFAULT 0;
