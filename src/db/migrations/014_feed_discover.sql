-- Feed, Discover-grade (decision #63, docs/FEED.md): every fetched story can be a card, ranked per person from what they
-- do with it; the same story from several outlets is one cluster; the article (reader mode) and cover are cached per item.

ALTER TABLE feed_items ADD COLUMN image TEXT;            -- picture the feed itself offers (media:content / enclosure / thumbnail)
ALTER TABLE feed_items ADD COLUMN cluster_id INTEGER;    -- same story from several outlets → the first item's id
ALTER TABLE feed_items ADD COLUMN resolved_url TEXT;     -- the publisher's own URL (Google News links resolve in the browser)
ALTER TABLE feed_items ADD COLUMN cover TEXT;            -- file in data/feed/covers
ALTER TABLE feed_items ADD COLUMN article_html TEXT;     -- reader mode, shared by everyone who opens it
ALTER TABLE feed_items ADD COLUMN article_status TEXT;   -- null = not tried · ok · failed
ALTER TABLE feed_items ADD COLUMN article_at TEXT;
UPDATE feed_items SET cluster_id = id WHERE cluster_id IS NULL;
CREATE INDEX feed_items_cluster ON feed_items(cluster_id);
CREATE INDEX feed_items_published ON feed_items(published_at);

-- What each person did with each card (Discover's signals, captured in-house).
CREATE TABLE feed_events (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL CHECK (kind IN ('impression', 'open', 'read', 'bounce', 'like', 'less', 'save', 'share', 'hide')),
  value   REAL NOT NULL DEFAULT 0,                       -- seconds read (read/bounce)
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX feed_events_user_item ON feed_events(user_id, item_id);
CREATE INDEX feed_events_user_at ON feed_events(user_id, at);

-- The interest profile: weights per topic / source / word; they fade (30-day half-life) unless the topic is followed.
CREATE TABLE feed_interests (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('topic', 'source', 'term')),
  key        TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 0,
  follows    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, key)
);

-- Search across every story (not only the written ones).
CREATE VIRTUAL TABLE feed_items_fts USING fts5(title, summary, content = 'feed_items', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO feed_items_fts (rowid, title, summary) SELECT id, title, COALESCE(summary, '') FROM feed_items;
CREATE TRIGGER feed_items_fts_ai AFTER INSERT ON feed_items BEGIN
  INSERT INTO feed_items_fts (rowid, title, summary) VALUES (new.id, new.title, COALESCE(new.summary, ''));
END;
CREATE TRIGGER feed_items_fts_ad AFTER DELETE ON feed_items BEGIN
  INSERT INTO feed_items_fts (feed_items_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, COALESCE(old.summary, ''));
END;
