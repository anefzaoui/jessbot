-- Feed sources people can see and control (decision #89).
-- A subscription is Jess's pick (auto, from Tune) or the person's own (manual). Re-tuning replaces only Jess's picks.
ALTER TABLE feed_subscriptions ADD COLUMN origin TEXT NOT NULL DEFAULT 'auto' CHECK (origin IN ('auto', 'manual'));

-- What a person removed, so a re-tune doesn't bring it back: a source (by URL — the row itself may be gone) or a topic
-- (by key). Adding it again by hand lifts the block.
CREATE TABLE feed_removed (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('source', 'topic')),
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, value)
);
