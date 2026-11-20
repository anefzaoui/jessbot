-- Phase 20 part A (docs/CONTEXT-AND-MEMORY.md, decisions #151–#156).
-- Dated memories: event_at (already there) holds 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM' (the person's wall-clock time) or, for a
-- yearly date whose year isn't known, 'MM-DD'; recurs says it comes back every year (birthdays, anniversaries).
ALTER TABLE memories ADD COLUMN recurs TEXT CHECK (recurs IS NULL OR recurs IN ('yearly'));
CREATE INDEX memories_event ON memories(scope_id, event_at) WHERE event_at IS NOT NULL;

-- Episodes (one dated line per extraction pass) know which messages they cover, so deleting a message removes them.
ALTER TABLE episodes ADD COLUMN from_msg_id INTEGER;
ALTER TABLE episodes ADD COLUMN to_msg_id INTEGER;
CREATE INDEX episodes_scope ON episodes(scope_id, observed_at);
CREATE INDEX episodes_thread ON episodes(thread_id, from_msg_id, to_msg_id);

-- Meaning search over episodes, like memory_vec for facts (normalised Float32; model + dims recorded per row).
CREATE TABLE episode_vec (
  episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  vec        BLOB NOT NULL
);
