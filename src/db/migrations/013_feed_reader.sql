-- Feed: reader mode (the full article saved offline, via Readability) and search across every story (owner request).

ALTER TABLE feed_posts ADD COLUMN article_html TEXT;     -- sanitized Readability HTML; images point at /feed/covers/…
ALTER TABLE feed_posts ADD COLUMN article_status TEXT;   -- null = not tried · ok · failed (paywall, blocked, not an article)
ALTER TABLE feed_posts ADD COLUMN article_at TEXT;

-- Search: one row per post (rowid = feed_posts.id), maintained by services/feed.js (article text is HTML-stripped there).
CREATE VIRTUAL TABLE feed_fts USING fts5(title, summary, body, article, tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO feed_fts (rowid, title, summary, body, article)
  SELECT id, title, COALESCE(summary, ''), body_md, '' FROM feed_posts WHERE kind = 'story';
CREATE TRIGGER feed_posts_fts_ad AFTER DELETE ON feed_posts BEGIN
  DELETE FROM feed_fts WHERE rowid = old.id;
END;
