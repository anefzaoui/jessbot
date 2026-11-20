# Feed — toward Google Discover (owner: "as powerful as Google's swipe feed")

Research done 2026-09-24 (subagent; sources in the links). This is the design the Feed is being built toward. Status
per item is tracked at the bottom; decisions land in `DECISIONS.md` (#34, #54, and the Discover-grade entry).

## What Discover does (public evidence)
- **Interest sources:** Discover reads your Web & App Activity (searches, watches, follows) and matches it through Knowledge-Graph
  entities and past queries. Older evergreen pages can still appear. Large cards need images ≥ 1200 px
  ([Search Central](https://developers.google.com/search/docs/appearance/google-discover)).
- **Follow and feedback:**
  - Follow publishers and creators from a card (since Sept 2025).
  - A heart replaced more/less (since 2023), with a Liked history.
  - The card menu has "Not interested in X" and "Don't show content from Y".
- **Trending topics:** AI summaries stack several publishers with a list of sources (July 2025), which is clustering plus Full Coverage.
- **Feb 2026 core update:** more local, less clickbait, originality and timeliness, expertise judged per topic.
- **What the app itself reveals** ([analysis](https://metehan.ai/blog/google-discover-architecture/)):
  - ranking by a pCTR model;
  - age buckets: 0 d, 1–7, 8–14, 15–30, 31–60, older;
  - a dismiss is permanent, and a publisher block covers the whole domain;
  - reading time is logged;
  - 13 cluster types, e.g. fresh videos and headline stories.
- **Google News personalization** ([Liu et al., IUI 2010](https://research.google.com/pubs/pub35599.html)): the person's click-topic
  distribution is blended with the current general news trend.

## Reuse
- **Embeddings:** `@huggingface/transformers` (4.3.x, Apache-2.0) runs locally on the CPU. Measured on this machine (384-dim vectors):
  - bge-small-en-v1.5 q8: 34 MB, ~2 ms/text;
  - all-MiniLM-L6-v2: 23 MB, 1.4 ms/text.
  Prefer bge-small, which separates duplicates better. Install size is ~470 MB (onnxruntime).
- **Vectors:** brute-force cosine over Float32Array BLOBs is enough for a household. `sqlite-vec` 0.1.9 loads in node:sqlite if it's ever needed.
- **Clustering:** plain code (title-shingle Jaccard plus embedding "leader" clustering). Google News headline and section feeds also carry up to 5
  sibling articles per item in an `<ol>`, which is free clustering; search feeds don't.
- **Ideas from existing readers:**
  - NewsBlur: focus/neutral/hidden classifiers; liked beats disliked; plain-English classifiers.
  - Tiny Tiny RSS: additive filter scores.
  - PersonalRSS: a logistic classifier with its evidence shown.
  - ReadPrism: dwell time, scroll depth, source trust, novelty, 15% exploration. It's AGPL, so we take ideas only.
  - Kagi Kite: open curated feed lists.
- **Keyless sources that answer:**
  - Google News headlines and sections, Hacker News (Firebase/Algolia, hnrss.org), Reddit `/.rss` (`.json` is 403).
  - YouTube `feeds/videos.xml?channel_id=` with thumbnails, arXiv, the Wikimedia featured feed, Google Trends `trending/rss`.
  - Open-Meteo, iTunes podcast search, Bluesky public API, Mastodon trends, Techmeme, Lobsters.
  - TheSportsDB (key `123`) and Yahoo chart (unofficial, fragile).
  - GDELT rate-limits hard, so it's a rare fallback only.

## Architecture
- **Interest profile.** `feed_interests(user, kind: topic|entity|source|query, key, weight, follows, updated)`.
  - Weights have a 30-day half-life; followed items never drop below a floor.
  - Each topic keeps a moving-average embedding centroid of positively engaged items, plus one negative centroid per person.
- **Signals.** `feed_events(user, item, kind, value, ts)`, captured in-house:
  - impression: ≥ 50% visible for 1 s → 0
  - open → +1
  - reader active time ≥ 30 s or scroll ≥ 60% → +2 (paused while the tab is hidden)
  - save, like, share → +3
  - bounce under 10 s → −0.5
  - less → −2
  - mutes → removed
- **Candidates.** Continuous ingestion. Every item is embedded, aged, clustered and tagged with entities.
- **Score (plain code).** `score = rel × fresh × quality × fatigue × novelty`
  - `rel` = 0.6·max cos(item, topic centroids) + 0.4·matched topic/entity/source weights − 0.3·cos(item, negative centroid)
  - `fresh` = 2^(−age/half-life): news 18 h, papers 3 d, evergreen/video 7 d
  - `quality` = (opens+1)/(impressions+5) per source, × (1 + 0.2·ln(#sources in the cluster))
  - `fatigue` = 0.85 for each impression not opened
  - `novelty` = downweight clusters already opened
  - Then MMR (λ≈0.7), with at most 2 cards in a row from the same topic or source.
- **Exploration.** About 1 slot in 7 is chosen by Thompson sampling (Beta(opens+1, skips+1)) per topic, or taken from Trends/Wikipedia items near the person's
  interests. Those cards are labelled "Suggested for you".
- **Cadence.** ~40 ranked cards, continuously refreshed.
  - The LLM writes only the top 3–5 per digest (the 3×/day briefs stay) and writes any other story when it's opened.
  - The rank LLM call is replaced by code.
- **The LLM only:**
  - turns the prompt into topics;
  - writes stories (plus `entities[]`, `evergreen`, a clickbait score);
  - runs optional plain-English filters;
  - writes cluster summaries;
  - suggests adjacent topics for Explore.

## Build order and status
1. [x] **P0 Signals + profile:** events, interests, impression/dwell capture, decay, "Because you follow X / liked Y". *(2026-09-25, #63)*
2. [~] **P0 Embeddings + clustering:** bge-small q8 loaded lazily, clusters within 48 h, Google `<ol>` siblings, "+N sources" and a Full Coverage page.
   *Done: clustering by title terms (Jaccard ≥ 0.5, 48 h) and "+N sources". Open: embeddings, Full Coverage page.*
3. [x] **P0 Scored feed:** the formula, MMR, many cards, stories written for the top items or when opened, "N new stories" pill. *(#63)*
4. [~] **P1 Follow everywhere:** topic/entity/source chips on cards, topic pages, an Explore row. *Done: "More about <topic>" on every card, an exploration card every 7th slot.*
5. [ ] **P1 New sources:** YouTube (video cards), HN, Reddit, arXiv, podcasts.
6. [ ] **P2 Glanceable cards:** weather, stock watchlist, scores.
7. [~] **P2 Explain + control:** "Why am I seeing this", Manage interests, keyword and plain-English filters.
   *Done: **Your sources** (`/feed/sources`, #89) — every topic with its sources and their health; add a site or feed,
   remove any, edit a topic's search words, pause or delete a topic, all kept across re-tunes; Admin → Feed sources.
   **Muted words** (#193, whole words in any script) and OPML import/export (server side and API; buttons in Phase 25).
   Open: plain-English filters.*
8. [ ] **P3:** per-person learned weights (logistic regression in JS over feed_events), a local-news slot.

Already done (2026-09-24):
- day-grouped history with infinite scroll;
- FTS search over stories and saved articles;
- reader mode (Readability, sanitized, images saved offline, quality gate);
- like/less/save/share;
- not interested in a topic, fewer from a source (with Undo);
- live status and the new-stories pill.

## Sources you control (2026-09-25, decision #89)
- **Where they come from.** Tune turns the person's words into topics; each topic gets a Google News search, and each
  site they named gets its own feed (found with feedscout) or, without one, a Google News search limited to that site.
- **Which Google News edition** (2026-09-26, decision #137; `browser/news.js`). A Google News search used to be fixed to
  the American edition (`hl=en-US&gl=US&ceid=US:en`). Now the edition follows the person: the topic's language when its
  script says so (Arabic, Hebrew, Cyrillic, Greek, Japanese, Korean, Chinese, Thai, Hindi, Bengali; English otherwise) and
  the country of their primary place. Google has editions for some country/language pairs only: an unknown pair uses the
  language's main edition (Arabic in Jordan → `EG:ar`, as Google itself redirects), then US English. So an English
  speaker in the UK gets `GB:en`, and an Arabic topic reads Arabic news. Existing sources keep their address until the
  topic's search is next synced (editing it, or Tune). web_search's `kind: "news"` uses the same editions, with the
  language the person writes in.
- **The parser is shared with web_read.** `normalizeFeed` lives in `browser/site-readers/feed.js` (re-exported here):
  web_read shows a feed link as its newest 50 items, dated, instead of raw XML (decision #135).
- **What the person can change** on `/feed/sources` (linked from the Tune dialog): add a site or feed link to a topic
  (`origin = 'manual'`), remove any source, check one now, edit a topic's name/search words/time of day (`custom`),
  pause a topic (`paused`: not fetched, out of the feed, search and chips), delete a topic, or make one from scratch.
- **Re-tune keeps it.** Tune replaces only `origin = 'auto'` subscriptions; custom topics keep the person's version,
  paused stays paused, topics holding their sources stay, and `feed_removed` (source URL per topic, topic key) stops
  Jess re-adding what they removed. Adding it again by hand lifts the block.
- **Admins** see every shared source on Admin → Feed sources (followers, health, stories stored) and can fetch or
  remove one for everyone. The health check links there.
- **Polite polling works.** Feeds are re-fetched with `If-None-Match` / `If-Modified-Since`; the browser cancels a
  navigation answered 304, so `fetchRaw` reads the status from the DevTools network events and reports the 304.

## The Feed in chat, OPML, muted words, your reading diet (2026-09-26, decisions #192–#193)
- **Jess reads the Feed.** `feed_stories({ topic?, query?, hours = 24, limit = 8 })` (core toolset, reads the database only):
  the ranked cards of the last `hours` (`cardCandidates` + `rankCards`, so mutes, pauses and the "why" are the Feed's own), or a
  search of every story of their sources (`searchCards`; a search looks back 7 days unless `hours` is set). Each story comes
  with its source, topic, the "why", a one-line summary, the publisher's link and `/feed?story=<id>` (the Feed page shows that
  one card; `feedFilters.story`, `storyCard`). Titles and summaries are the publishers' words, so the result is fenced as
  outside content and marks the run (`guardOutside`). Morning briefs and check-ins read this instead of searching the web again.
- **Following and muting from chat.** `feed_follow({ url | site, topic? })` (web toolset: it reaches the internet to find the
  site's feed) wraps `addSource` exactly like the Sources page (same validation, feedscout discovery, Google News `site:` when
  there is no feed, one fetch on the spot); `topic` is one of theirs or a new name (created); with no topic and more than one,
  it asks which. `feed_mute({ word | source | topic, undo? })` (core) mutes one thing. Both are persistent writes (they ask
  first after the task read outside content, #124).
- **Muted words.** `feed_mutes.kind` gains `word` (migration 047 rebuilds the table to widen its CHECK). Matching lives in
  `lib/word-match.js`: NFKC, case and accents folded, Arabic diacritics and letter variants unified, whole words only
  (`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`, so "trump" never hides "trumpet"), Arabic proclitics allowed in front (و ف ب ل ك ال لل:
  "رياضة" hides "والرياضة"), and a phrase in a script written without spaces (Chinese, Japanese, Thai…) matched as written.
  Applied where topic and source mutes apply: the ranked feed and the digest's picks (`cardCandidates`, so `feed_stories` too),
  and written stories (`feed_posts.hidden`, recomputed in code by `refreshHidden` after every mute change so hidden = exactly
  what the active mutes cover). A search is an explicit ask and, as with topic and source mutes, shows what it finds. Up to
  100 words, each ≤ 60 characters and ≤ 5 words.
- **OPML.** `importOpml` (feedsmith's parser): with a topic name everything goes there; otherwise each top-level folder
  becomes a topic (reused by name or key, or created *without* its Google News search: the search starts out in
  `feed_removed`, so editing the topic's time of day later doesn't bring it back; new search words do, as for any topic) and
  loose feeds go to a topic named after the list. Each feed: http(s) and a real host name (as on the Sources page),
  deduplicated within the file and against the topic, at most 10 per topic / 12 topics / 200 per file, subscribed as the
  person's own (`origin = 'manual'`). Nothing is fetched during the request: new sources have `next_fetch_at = NULL`, so the
  feed tick fetches them first, politely, through the browser. `exportOpml` writes OPML 2.0 (topics as folders). Import of an
  export round-trips.
- **Your reading diet** (`feed-rank.js readingDiet`, `GET /api/v1/feed/diet`): from `feed_events` of the last 30 days (opened,
  read, liked, saved, shared; impressions don't count), the topics and sources they actually read with shares, minutes read,
  variety (normalised Shannon entropy over the topics they follow: narrow / balanced / varied) and one suggestion, first that
  applies: a followed topic never opened ("keep it, or pause it?"), one source ≥ 50%, one topic ≥ 70%, else "try something
  new". A monthly card on the Feed is Phase 25.
