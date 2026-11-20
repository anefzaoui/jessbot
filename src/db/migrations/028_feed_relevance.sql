-- Feed story relevance (docs/JEV.md, decision #110): how well each story matches what the person asked the feed for,
-- judged by the decision model in the background (fetch ticks, digests) and read by the ranking. `wants` fingerprints
-- the request the score was made against — a new request is scored afresh.
CREATE TABLE feed_relevance (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id  INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  score    REAL NOT NULL,                     -- 0–1: would they want to read it?
  wants    TEXT NOT NULL,
  at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, item_id)
);
