-- Phase 7c: the Feed (decisions #23, #34, #54). Sources are shared (fetched once for everyone who follows them);
-- stories are written per person from what they follow.

-- What a person wants: their words (Tune) and the topics Jess derived from them.
CREATE TABLE feed_prefs (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prompt         TEXT NOT NULL DEFAULT '',
  topics         TEXT NOT NULL DEFAULT '[]',   -- [{ key, label, query, sites: [], when: morning|midday|evening|any, hue }]
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_digest_at TEXT,
  digest_state   TEXT,                           -- idle | working | error (for the page's status line)
  digest_note    TEXT
);

CREATE TABLE feed_sources (
  id            INTEGER PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'rss' CHECK (kind IN ('rss', 'gnews')),
  title         TEXT,
  site_url      TEXT,
  etag          TEXT,
  last_modified TEXT,
  fetched_at    TEXT,
  next_fetch_at TEXT,                            -- UTC ISO; null = as soon as possible
  error         TEXT,
  error_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE feed_subscriptions (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES feed_sources(id) ON DELETE CASCADE,
  topic_key TEXT NOT NULL,
  PRIMARY KEY (user_id, source_id, topic_key)
);

CREATE TABLE feed_items (
  id           INTEGER PRIMARY KEY,
  source_id    INTEGER NOT NULL REFERENCES feed_sources(id) ON DELETE CASCADE,
  dedupe_key   TEXT NOT NULL,                    -- guid → link → title hash
  url          TEXT,
  title        TEXT NOT NULL,
  summary      TEXT,
  source_name  TEXT,                             -- the publisher (Google News carries it per item)
  source_host  TEXT,
  published_at TEXT,                             -- UTC ISO
  fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_id, dedupe_key)
);
CREATE INDEX feed_items_recent ON feed_items(source_id, published_at DESC);

CREATE TABLE feed_posts (
  id           INTEGER PRIMARY KEY,
  public_id    TEXT NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'story' CHECK (kind IN ('story', 'brief')),
  topic_key    TEXT,
  topic        TEXT,
  item_id      INTEGER REFERENCES feed_items(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  summary      TEXT,
  body_md      TEXT NOT NULL DEFAULT '',
  url          TEXT,
  source_name  TEXT,
  source_host  TEXT,
  cover        TEXT,                             -- file name in data/feed/covers
  why          TEXT,
  read_minutes INTEGER,
  published_at TEXT,
  feedback     TEXT CHECK (feedback IN ('up', 'down')),
  saved        INTEGER NOT NULL DEFAULT 0,
  hidden       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX feed_posts_user ON feed_posts(user_id, hidden, created_at DESC);

-- "Not interested in <topic>" / "Fewer from <source>".
CREATE TABLE feed_mutes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('topic', 'source')),
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, value)
);
