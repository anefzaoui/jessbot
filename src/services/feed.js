// The Feed's data layer (decisions #23, #34, #54): per-person preferences and topics, shared sources fetched through
// the browser (src/browser/) and parsed with feedsmith, deduplicated items, and the stories Jess writes from them.
// The model parts (turning a prompt into topics, picking and writing stories) live in src/agent/feed.js.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { get, all, run, tx } from '../db/index.js';
import { paths } from '../config/index.js';
import { fetchRaw, decodeBody, downloadImage } from '../browser/read.js';
import { normalizeFeed } from '../browser/site-readers/feed.js';
import { gnewsUrl as newsSearchUrl, scriptLang } from '../browser/news.js';
import { primaryPlace } from './places.js';
import { cleanArticle, localizeImages, textOf, looksLikeArticle, withDir } from '../lib/reader.js';
import { ftsQuery } from '../lib/fts.js';
import { tzOf, dayLabel, dayKey } from '../lib/when.js';
import { clusterFor, rankCards } from './feed-rank.js';
import { renderMarkdown } from '../lib/markdown.js';
import { toIso } from './chatview.js';
import { iconUrl } from './favicons.js';
import { wordMatcher } from '../lib/word-match.js';
import { invalid, notFound } from '../lib/errors.js';

export const COVERS = path.join(paths.data, 'feed', 'covers');
const GNEWS_EVERY_MS = 45 * 60000;
const RSS_EVERY_MS = 60 * 60000;
const MAX_BACKOFF_MS = 12 * 3600000;

// ---- Preferences -------------------------------------------------------------------------------------------
export function prefsOf(user) {
  const p = get('SELECT * FROM feed_prefs WHERE user_id = ?', user.id);
  return p ? { ...p, topics: JSON.parse(p.topics || '[]') } : { user_id: user.id, prompt: '', topics: [], last_digest_at: null, digest_state: null };
}

export function savePrefs(user, { prompt, topics }) {
  run(`INSERT INTO feed_prefs (user_id, prompt, topics, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET prompt = excluded.prompt, topics = excluded.topics, updated_at = excluded.updated_at`,
  user.id, String(prompt).slice(0, 2000), JSON.stringify(topics));
}

/** At boot: a digest that was mid-way when the server stopped isn't running any more (the next slot redoes it). */
export const recoverDigests = () => run(`UPDATE feed_prefs SET digest_state = 'idle', digest_note = NULL WHERE digest_state = 'working'`).changes;

export function setDigestState(userId, state, note = null) {
  run(`INSERT INTO feed_prefs (user_id, digest_state, digest_note) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET digest_state = excluded.digest_state, digest_note = excluded.digest_note`, userId, state, note);
}

// ---- Sources & subscriptions ------------------------------------------------------------------------------
/** Google News search as a feed: any topic becomes a source (keyless; fetched like any other page). The edition follows
 *  the person (decision #137): the language the topic is written in (its script; English otherwise) and the country of
 *  their primary place — no longer always en-US. */
export const gnewsUrl = (query, user = null) => newsSearchUrl(query, {
  lang: scriptLang(query) || 'en', country: user ? primaryPlace(user)?.country_code || null : null, when: '3d' });

export function ensureSource(url, { kind = 'rss', title = null, siteUrl = null } = {}) {
  run('INSERT INTO feed_sources (url, kind, title, site_url) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO NOTHING', url, kind, title, siteUrl);
  return get('SELECT * FROM feed_sources WHERE url = ?', url);
}

/** Replace Jess's picks (Tune) with `[{ sourceId, topicKey }]`. The person's own sources stay, except on topics that are
 *  gone; sources nobody follows are dropped (decision #89). */
export function setSubscriptions(user, subs) {
  const keys = prefsOf(user).topics.map(t => t.key);
  tx(() => {
    run(`DELETE FROM feed_subscriptions WHERE user_id = ? AND origin = 'auto'`, user.id);
    run(`DELETE FROM feed_subscriptions WHERE user_id = ? AND topic_key NOT IN (SELECT value FROM json_each(?))`, user.id, JSON.stringify(keys));
    for (const s of subs) run('INSERT OR IGNORE INTO feed_subscriptions (user_id, source_id, topic_key) VALUES (?, ?, ?)', user.id, s.sourceId, s.topicKey);
    dropOrphanSources();
  });
}
export const dropOrphanSources = () => run('DELETE FROM feed_sources WHERE id NOT IN (SELECT source_id FROM feed_subscriptions)').changes;

// A subscription counts only while its topic isn't paused (the pause lives on the topic in feed_prefs.topics).
export const LIVE_SUB = `f.topic_key NOT IN (SELECT json_extract(j.value, '$.key') FROM feed_prefs fp, json_each(fp.topics) j
  WHERE fp.user_id = f.user_id AND json_extract(j.value, '$.paused'))`;

export const sourcesOf = user => all(`SELECT DISTINCT s.* FROM feed_sources s JOIN feed_subscriptions f ON f.source_id = s.id WHERE f.user_id = ? AND ${LIVE_SUB}`, user.id);
export const dueSources = (now = new Date(), limit = 6) => all(
  `SELECT * FROM feed_sources WHERE id IN (SELECT f.source_id FROM feed_subscriptions f WHERE ${LIVE_SUB}) AND (next_fetch_at IS NULL OR next_fetch_at <= ?)
   ORDER BY next_fetch_at IS NOT NULL, next_fetch_at LIMIT ?`, now.toISOString(), limit);

// The parser (feedsmith + our normaliser) is shared with web_read's feed reader: browser/site-readers/feed.js.
export { normalizeFeed };

/** Fetch one source politely (conditional GET, backoff on errors) and store new items. Returns the count added. */
export async function fetchSource(src, { signal } = {}) {
  const headers = {};
  if (src.etag) headers['If-None-Match'] = src.etag;
  if (src.last_modified) headers['If-Modified-Since'] = src.last_modified;
  const every = src.kind === 'gnews' ? GNEWS_EVERY_MS : RSS_EVERY_MS;
  try {
    const r = await fetchRaw(src.url, { headers, signal });
    if (r.status === 304) {
      run('UPDATE feed_sources SET fetched_at = ?, next_fetch_at = ?, error = NULL, error_count = 0 WHERE id = ?', new Date().toISOString(), new Date(Date.now() + every).toISOString(), src.id);
      return 0;
    }
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    const feed = normalizeFeed(decodeBody(r.body, r.contentType));
    let added = 0;
    tx(() => {
      for (const it of feed.items.slice(0, 100)) {
        const res = run(`INSERT OR IGNORE INTO feed_items (source_id, dedupe_key, url, title, summary, source_name, source_host, published_at, image)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, src.id, it.dedupe, it.url, it.title.slice(0, 400), it.summary,
        it.sourceName || (src.kind === 'rss' ? feed.title : null), it.sourceHost, it.published || new Date().toISOString(), it.image);
        if (!res.changes) continue;
        added++;
        const id = Number(res.lastInsertRowid);
        run('UPDATE feed_items SET cluster_id = ? WHERE id = ?', clusterFor(id, it.title), id); // same story, other outlets
      }
      run(`UPDATE feed_sources SET title = COALESCE(title, ?), site_url = COALESCE(site_url, ?), etag = ?, last_modified = ?, fetched_at = ?,
           next_fetch_at = ?, error = NULL, error_count = 0 WHERE id = ?`, feed.title, feed.siteUrl, r.headers.etag || null,
      r.headers['last-modified'] || null, new Date().toISOString(), new Date(Date.now() + every).toISOString(), src.id);
    });
    return added;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    const n = src.error_count + 1;
    run('UPDATE feed_sources SET error = ?, error_count = ?, next_fetch_at = ? WHERE id = ?', err.message.slice(0, 300), n,
      new Date(Date.now() + Math.min(MAX_BACKOFF_MS, every * 2 ** (n - 1))).toISOString(), src.id);
    return 0;
  }
}

// ---- Cards: every story this person could see, one per cluster, ranked from what they do (decision #63) ---------
// Mutes: a topic, a source, or a word (decision #193: whole words in the title or summary, any script — lib/word-match.js).
function mutesOf(user) {
  const m = { source: new Set(), topic: new Set(), words: [] };
  for (const r of all('SELECT kind, value FROM feed_mutes WHERE user_id = ?', user.id)) {
    if (r.kind === 'word') m.words.push(r.value);
    else m[r.kind]?.add(r.value.toLowerCase());
  }
  m.word = wordMatcher(m.words);
  return m;
}
const mutedWordIn = (mutes, item) => !!mutes.words.length && !!mutes.word(`${item.title || ''}\n${item.summary || ''}`);

// The better picture of one story: a cover or feed image, a saved article, then the earliest report.
const betterRep = (a, b) => (!!(b.cover || b.image) - !!(a.cover || a.image)) || ((b.article_status === 'ok') - (a.article_status === 'ok'))
  || String(a.published_at).localeCompare(String(b.published_at));

/** Recent items from what this person follows, grouped into stories (clusters), without muted/hidden ones. */
export function cardCandidates(user, { hours = 72, topic = null } = {}) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const mutes = mutesOf(user);
  const topics = Object.fromEntries(prefsOf(user).topics.map(t => [t.key, t]));
  const hidden = new Set(all('SELECT item_id FROM feed_posts WHERE user_id = ? AND hidden = 1 AND item_id IS NOT NULL', user.id).map(r => r.item_id));
  const rows = all(`SELECT i.*, MIN(f.topic_key) AS topic_key FROM feed_items i JOIN feed_subscriptions f ON f.source_id = i.source_id AND f.user_id = ? AND ${LIVE_SUB}
    WHERE i.published_at >= ? GROUP BY i.id ORDER BY i.published_at DESC LIMIT 1500`, user.id, since);
  const clusters = new Map();
  for (const r of rows) {
    const t = topics[r.topic_key];
    if (!t || hidden.has(r.id) || mutes.topic.has(t.label.toLowerCase())
      || mutes.source.has(String(r.source_name || '').toLowerCase()) || mutes.source.has(String(r.source_host || '').toLowerCase())
      || mutedWordIn(mutes, r)) continue;
    if (topic && t.label !== topic) continue;
    const key = r.cluster_id || r.id;
    const c = clusters.get(key);
    if (!c) clusters.set(key, { rep: r, topic: t, sources: new Set([r.source_name || r.source_host]), ids: [r.id] });
    else {
      c.sources.add(r.source_name || r.source_host);
      c.ids.push(r.id);
      if (betterRep(c.rep, r) > 0) c.rep = r;
    }
  }
  return [...clusters.values()].filter(c => !c.ids.some(id => hidden.has(id)))
    .map(c => ({ ...c.rep, topic: c.topic.label, topicKey: c.topic.key, sources: c.sources.size }));
}

/** One page of ranked cards (20), with Jess's write-up where there is one. next = the next page number, or null. */
export function rankedCards(user, { page = 0, topic = null, size = PAGE_SIZE } = {}) {
  const ranked = rankCards(user.id, cardCandidates(user, { topic }));
  const slice = ranked.slice(page * size, (page + 1) * size);
  const posts = new Map(slice.length ? all(`SELECT * FROM feed_posts WHERE user_id = ? AND item_id IN (${slice.map(() => '?').join(',')})`,
    user.id, ...slice.map(c => c.id)).map(p => [p.item_id, p]) : []);
  let n = page * size;
  const cards = slice.map(c => { const post = posts.get(c.id); const hasPic = !!(post?.cover || c.cover); return cardView(c, post, n++ % 3 === 0 && hasPic ? 'hero' : 'compact'); });
  return { cards, next: ranked.length > (page + 1) * size ? page + 1 : null, total: ranked.length };
}

const favicon = iconUrl;

/** feed/card contract for a story (item + this person's post, if any). */
export function cardView(item, post, kind = 'compact') {
  const cover = post?.cover || item.cover;
  return {
    id: `i${item.id}`, kind, topic: item.topic || post?.topic || 'For you', written: !!post?.body_md,
    title: post?.body_md ? post.title : item.title, summary: post?.summary || (item.summary ? item.summary.slice(0, 220) : null),
    html: post?.body_md ? renderMarkdown(post.body_md) : '', cover: cover ? `/feed/covers/${cover}` : null, hue: hueOf(item.topic || post?.topic || ''),
    source: { name: item.source_name || item.source_host || 'Source', host: item.source_host }, favicon: favicon(item.source_host),
    url: item.resolved_url || item.url, createdAt: toIso(item.published_at || post?.created_at), readMinutes: post?.read_minutes || null,
    saved: !!post?.saved, feedback: post?.feedback || null, why: item.why || post?.why || null, sources: item.sources > 1 ? item.sources : null,
    explore: !!item.explore, hasArticle: item.article_status === 'ok' || post?.article_status === 'ok',
  };
}

/** Search every story this person follows (titles and summaries) plus Jess's write-ups and saved articles. */
export function searchCards(user, q, { page = 0, size = PAGE_SIZE } = {}) {
  const match = ftsQuery(q);
  if (!match) return { cards: [], next: null };
  // bm25() only works in the MATCH query itself (not under GROUP BY), so rank first, then join.
  const rows = all(`SELECT i.*, (SELECT MIN(f.topic_key) FROM feed_subscriptions f WHERE f.source_id = i.source_id AND f.user_id = ? AND ${LIVE_SUB}) AS topic_key
      FROM (SELECT rowid, bm25(feed_items_fts, 4, 1) AS score FROM feed_items_fts WHERE feed_items_fts MATCH ?) m
      JOIN feed_items i ON i.id = m.rowid
      WHERE EXISTS (SELECT 1 FROM feed_subscriptions f WHERE f.source_id = i.source_id AND f.user_id = ? AND ${LIVE_SUB})
      ORDER BY m.score LIMIT ? OFFSET ?`, user.id, match, user.id, size + 1, page * size);
  const topics = Object.fromEntries(prefsOf(user).topics.map(t => [t.key, t.label]));
  const fromPosts = page ? [] : all(`SELECT p.* FROM feed_fts JOIN feed_posts p ON p.id = feed_fts.rowid WHERE feed_fts MATCH ? AND p.user_id = ? AND p.hidden = 0
      ORDER BY bm25(feed_fts, 8, 4, 2, 1) LIMIT 10`, match, user.id);
  const seen = new Set(rows.map(r => r.id));
  const posts = new Map(all(`SELECT * FROM feed_posts WHERE user_id = ? AND item_id IN (${rows.map(() => '?').join(',') || 'NULL'})`, user.id, ...rows.map(r => r.id)).map(p => [p.item_id, p]));
  const cards = rows.slice(0, size).map(r => cardView({ ...r, topic: topics[r.topic_key] }, posts.get(r.id)));
  for (const p of fromPosts) if (!p.item_id || !seen.has(p.item_id)) cards.push(postView(p, 'compact'));
  return { cards, next: rows.length > size ? page + 1 : null };
}

/** A card's per-person state lives in a post; opening, liking or saving an unwritten story makes a stub (body written later). */
export function postForCard(user, cardId) {
  const m = /^i(\d+)$/.exec(String(cardId));
  if (!m) return postForUser(user, cardId);
  const item = get(`SELECT i.*, MIN(f.topic_key) AS topic_key FROM feed_items i LEFT JOIN feed_subscriptions f ON f.source_id = i.source_id AND f.user_id = ?
    WHERE i.id = ? GROUP BY i.id`, user.id, Number(m[1]));
  if (!item) throw Object.assign(new Error('That story is gone.'), { status: 404 });
  const existing = get('SELECT * FROM feed_posts WHERE user_id = ? AND item_id = ? ORDER BY id DESC LIMIT 1', user.id, item.id);
  if (existing) return existing;
  const topic = prefsOf(user).topics.find(t => t.key === item.topic_key);
  return addPost(user, { topicKey: topic?.key, topic: topic?.label, itemId: item.id, title: item.title, summary: item.summary?.slice(0, 300),
    body: '', url: item.resolved_url || item.url, sourceName: item.source_name, sourceHost: item.source_host, cover: item.cover, publishedAt: item.published_at });
}

export const itemOf = post => (post?.item_id ? get('SELECT * FROM feed_items WHERE id = ?', post.item_id) : null);
export const itemById = id => get('SELECT * FROM feed_items WHERE id = ?', id) || null;

/** The person's topic label for a story (the topic of the subscription it came through). */
export function topicOfItem(user, item) {
  const key = get('SELECT MIN(topic_key) AS k FROM feed_subscriptions WHERE user_id = ? AND source_id = ?', user.id, item.source_id)?.k;
  return prefsOf(user).topics.find(t => t.key === key)?.label || null;
}

/** Jess's write-up lands on the person's post (a stub made when the card was opened, liked or picked). */
export function writePost(post, { title, summary, body, minutes = null, cover = null, url = null }) {
  run(`UPDATE feed_posts SET title = ?, summary = ?, body_md = ?, read_minutes = COALESCE(?, read_minutes), cover = COALESCE(cover, ?),
       url = COALESCE(?, url) WHERE id = ?`, String(title).slice(0, 300), summary ? String(summary).slice(0, 400) : null, String(body), minutes, cover, url, post.id);
  index(get('SELECT * FROM feed_posts WHERE id = ?', post.id));
}

// ---- Stories ------------------------------------------------------------------------------------------------
export function addPost(user, p) {
  const publicId = crypto.randomBytes(8).toString('base64url');
  run(`INSERT INTO feed_posts (public_id, user_id, kind, topic_key, topic, item_id, title, summary, body_md, url, source_name, source_host,
       cover, why, read_minutes, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  publicId, user.id, p.kind || 'story', p.topicKey || null, p.topic || null, p.itemId || null, String(p.title).slice(0, 300),
  p.summary ? String(p.summary).slice(0, 400) : null, String(p.body || ''), p.url || null, p.sourceName || null, p.sourceHost || null,
  p.cover || null, p.why ? String(p.why).slice(0, 200) : null, p.readMinutes || null, p.publishedAt || null);
  const post = get('SELECT * FROM feed_posts WHERE public_id = ?', publicId);
  if (post.kind === 'story') index(post);
  return post;
}

// Search index (migration 013): title, summary, Jess's write-up and the saved article's text.
function index(post) {
  run('DELETE FROM feed_fts WHERE rowid = ?', post.id);
  run('INSERT INTO feed_fts (rowid, title, summary, body, article) VALUES (?, ?, ?, ?, ?)', post.id, post.title, post.summary || '',
    post.body_md, textOf(post.article_html).slice(0, 60000));
}

export function saveCover(buf, ext) {
  fs.mkdirSync(COVERS, { recursive: true });
  const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${ext}`;
  const file = path.join(COVERS, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return name;
}

/**
 * Reader mode: keep the article (Readability HTML from readArticle) for offline reading — sanitized, with up to
 * MAX_IMAGES images downloaded next to the covers. Returns the stored HTML (or null when the page wasn't an article).
 */
const MAX_IMAGES = 8;
export async function articleFor(article, { signal, headline = '' } = {}) {
  if (!article?.html) return null;
  const { html, images } = cleanArticle(article.html, article.url);
  if (!looksLikeArticle(html, headline || article.title)) return null; // footers, menus, bot/pay walls
  const local = new Map();
  for (const src of images.slice(0, MAX_IMAGES)) {
    const img = await downloadImage(src, { signal, maxBytes: 3_000_000 });
    if (img) local.set(src, `/feed/covers/${saveCover(img.buf, img.ext)}`);
  }
  return localizeImages(html, local);
}

export function setArticle(post, html) {
  run(`UPDATE feed_posts SET article_html = ?, article_status = ?, article_at = ? WHERE id = ?`, html, html ? 'ok' : 'failed', new Date().toISOString(), post.id);
  index(get('SELECT * FROM feed_posts WHERE id = ?', post.id));
}

export function postForUser(user, publicId) {
  const p = get('SELECT * FROM feed_posts WHERE public_id = ? AND user_id = ?', String(publicId), user.id);
  if (!p) throw Object.assign(new Error('That story is gone.'), { status: 404 });
  return p;
}
export const setFeedback = (p, v) => run('UPDATE feed_posts SET feedback = ? WHERE id = ?', ['up', 'down'].includes(v) ? v : null, p.id);
export const setSaved = (p, v) => run('UPDATE feed_posts SET saved = ? WHERE id = ?', v ? 1 : 0, p.id);

/** "Not interested in <topic>" / "Fewer from <source>": mute (or undo), then hide exactly what the active mutes cover. */
export function mute(user, p, what, undo = false) {
  const value = what === 'topic' ? p.topic : p.source_name || p.source_host;
  if (!value) return;
  setMute(user, what, value, { undo });
}

export const MAX_MUTED_WORDS = 100;
const MUTE_KINDS = ['topic', 'source', 'word'];
/** A word to mute: a word or a short phrase (≤ 60 characters, ≤ 5 words), with at least one letter or digit. */
export function cleanMutedWord(value) {
  const w = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!w || !/[\p{L}\p{N}]/u.test(w)) throw invalid({ value: 'Which word should I hide stories about?' });
  if (w.length > 60 || w.split(' ').length > 5) throw invalid({ value: 'Mute a word or a short phrase (up to 5 words).' });
  return w;
}

/**
 * Mute (or unmute) a topic, a source or a word, then hide exactly what the active mutes cover (#54, #193).
 * → { kind, value, muted, hidden (stories of theirs now hidden) }.
 */
export function setMute(user, kind, value, { undo = false } = {}) {
  if (!MUTE_KINDS.includes(kind)) throw invalid({ kind: 'Mute a topic, a source or a word.' });
  const v = kind === 'word' ? cleanMutedWord(value) : String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!v) throw invalid({ value: `Which ${kind}?` });
  if (undo) run('DELETE FROM feed_mutes WHERE user_id = ? AND kind = ? AND lower(value) = lower(?)', user.id, kind, v);
  else if (!get('SELECT 1 FROM feed_mutes WHERE user_id = ? AND kind = ? AND lower(value) = lower(?)', user.id, kind, v)) {
    if (kind === 'word' && get(`SELECT COUNT(*) AS n FROM feed_mutes WHERE user_id = ? AND kind = 'word'`, user.id).n >= MAX_MUTED_WORDS) {
      throw invalid({ value: `You can mute up to ${MAX_MUTED_WORDS} words: unmute one first.` });
    }
    run('INSERT INTO feed_mutes (user_id, kind, value) VALUES (?, ?, ?)', user.id, kind, v);
  }
  refreshHidden(user);
  return { kind, value: v, muted: !undo, hidden: get('SELECT COUNT(*) AS n FROM feed_posts WHERE user_id = ? AND hidden = 1', user.id).n };
}

// hidden = exactly what the active mutes cover: topics and sources in SQL, then words (whole words, any script) in code.
function refreshHidden(user) {
  tx(() => {
    run(`UPDATE feed_posts SET hidden = EXISTS (SELECT 1 FROM feed_mutes m WHERE m.user_id = feed_posts.user_id AND (
           (m.kind = 'topic' AND lower(m.value) = lower(feed_posts.topic)) OR
           (m.kind = 'source' AND lower(m.value) IN (lower(feed_posts.source_name), lower(feed_posts.source_host)))))
         WHERE user_id = ?`, user.id);
    const mutes = mutesOf(user);
    if (!mutes.words.length) return;
    for (const p of all('SELECT id, title, summary FROM feed_posts WHERE user_id = ? AND hidden = 0', user.id)) {
      if (mutedWordIn(mutes, p)) run('UPDATE feed_posts SET hidden = 1 WHERE id = ?', p.id);
    }
  });
}

/** What this person muted, by kind (Sources page, Phase 25; GET /api/v1/feed/mutes). */
export function mutesList(user) {
  const rows = all('SELECT kind, value, created_at FROM feed_mutes WHERE user_id = ? ORDER BY kind, value COLLATE NOCASE', user.id);
  const of = k => rows.filter(r => r.kind === k).map(r => ({ value: r.value, at: toIso(r.created_at) }));
  return { topics: of('topic'), sources: of('source'), words: of('word'), limits: { words: MAX_MUTED_WORDS } };
}

export const tasteOf = user => ({
  liked: all(`SELECT DISTINCT topic, source_name FROM feed_posts WHERE user_id = ? AND feedback = 'up' ORDER BY id DESC LIMIT 20`, user.id),
  disliked: all(`SELECT DISTINCT topic, source_name FROM feed_posts WHERE user_id = ? AND feedback = 'down' ORDER BY id DESC LIMIT 20`, user.id),
});

// ---- Views (contracts: pages/feed.hbs, partials/feed/card.hbs, feed/brief.hbs) ------------------------------
export function postView(p, kind) {
  return {
    id: p.public_id, kind, topic: p.topic || 'For you', title: p.title, summary: p.summary, html: renderMarkdown(p.body_md),
    cover: p.cover ? `/feed/covers/${p.cover}` : null, hue: hueOf(p.topic || ''),
    source: { name: p.source_name || p.source_host || 'Source', host: p.source_host }, favicon: favicon(p.source_host), url: p.url,
    createdAt: toIso(p.published_at || p.created_at), readMinutes: p.read_minutes, saved: !!p.saved, feedback: p.feedback, why: p.why,
    written: !!p.body_md, hasArticle: p.article_status === 'ok' && looksLikeArticle(p.article_html),
  };
}

function hueOf(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }

export const PAGE_SIZE = 20;

/** Filters from the query string: ?topic=AI · ?saved=1 · ?q=words · ?before=<cursor> (older pages) · ?story=<card id>
 *  (one story: the link Jess gives in chat, "i<itemId>" or a post's public id). */
export function feedFilters(q = {}) {
  return {
    topic: q.topic ? String(q.topic).slice(0, 60) : null, saved: q.saved === '1' || q.saved === true,
    q: q.q ? String(q.q).trim().slice(0, 120) : '', before: /^\d+$/.test(String(q.before || '')) ? Number(q.before) : null,
    history: q.history === '1' || q.history === true, page: /^\d+$/.test(String(q.page || '')) ? Math.min(50, Number(q.page)) : 0,
    story: /^(?:i\d{1,12}|[\w-]{8,16})$/.test(String(q.story || '')) ? String(q.story) : null,
  };
}

/** One story as a card (the ?story= link): an item this person follows, or one of their posts. null when it's gone. */
export function storyCard(user, id) {
  const m = /^i(\d+)$/.exec(String(id));
  if (!m) {
    const p = get('SELECT * FROM feed_posts WHERE public_id = ? AND user_id = ? AND hidden = 0', String(id), user.id);
    return p ? postView(p, 'hero') : null;
  }
  const item = get(`SELECT i.*, MIN(f.topic_key) AS topic_key FROM feed_items i JOIN feed_subscriptions f ON f.source_id = i.source_id AND f.user_id = ?
    WHERE i.id = ? GROUP BY i.id`, user.id, Number(m[1]));
  if (!item) return null;
  const post = get('SELECT * FROM feed_posts WHERE user_id = ? AND item_id = ? ORDER BY id DESC LIMIT 1', user.id, item.id);
  return cardView({ ...item, topic: prefsOf(user).topics.find(t => t.key === item.topic_key)?.label || null }, post, 'hero');
}

/**
 * Stories for Jess in chat (feed_stories, decision #192; GET /api/v1/feed/stories): the ranked feed of the last `hours`
 * (optionally one topic), or a search. → [{ id, title, source, host, topic, why, summary, url, feedUrl, publishedAt, written }].
 */
export function storiesFor(user, { topic = null, query = '', hours = null, limit = 8 } = {}) {
  const n = Math.max(1, Math.min(20, Math.round(Number(limit) || 8)));
  const h = Math.max(1, Math.min(24 * 14, Math.round(Number(hours) || (query ? 24 * 7 : 24))));
  const topics = prefsOf(user).topics;
  let label = null;
  if (topic) {
    const t = topics.find(x => x.key === topic || x.label.toLowerCase() === String(topic).trim().toLowerCase());
    if (!t) throw notFound(`There is no topic “${topic}” in this feed${topics.length ? ` (topics: ${topics.map(x => x.label).join(', ')})` : ''}.`);
    label = t.label;
  }
  const since = Date.now() - h * 3600000;
  let cards;
  if (String(query || '').trim()) {
    cards = searchCards(user, query, { size: 40 }).cards.filter(c => (!label || c.topic === label) && (!c.createdAt || new Date(c.createdAt).getTime() >= since));
  } else {
    const ranked = rankCards(user.id, cardCandidates(user, { hours: h, topic: label })).slice(0, n);
    const posts = new Map(ranked.length ? all(`SELECT * FROM feed_posts WHERE user_id = ? AND item_id IN (${ranked.map(() => '?').join(',')})`,
      user.id, ...ranked.map(c => c.id)).map(p => [p.item_id, p]) : []);
    cards = ranked.map(c => cardView(c, posts.get(c.id)));
  }
  return cards.slice(0, n).map(c => ({
    id: c.id, title: c.title, source: c.source.name, host: c.source.host || null, topic: c.topic, why: c.why || null,
    summary: c.summary || null, url: c.url || null, feedUrl: `/feed?story=${encodeURIComponent(c.id)}`, publishedAt: c.createdAt, written: !!c.written,
  }));
}

/**
 * What a feed page shows for these filters: ranked cards (For you, a topic), search results, or the day-grouped history
 * of stories written/opened/saved. mode tells the client how to load more (page number vs cursor).
 */
export function feedPage(user, filters = {}) {
  if (filters.story) {
    const card = storyCard(user, filters.story);
    return { mode: 'story', sections: card ? [{ label: null, day: null, layout: 'stack', posts: [card] }] : [], next: null, count: card ? 1 : 0 };
  }
  if (filters.saved || filters.history) {
    const p = storiesPage(user, filters);
    return { mode: 'history', sections: p.sections, next: p.next, count: p.count };
  }
  const r = filters.q ? searchCards(user, filters.q, { page: filters.page }) : rankedCards(user, { page: filters.page, topic: filters.topic });
  return { mode: filters.q ? 'search' : 'ranked', sections: r.cards.length ? [{ label: null, day: null, layout: 'stack', posts: r.cards }] : [],
    next: r.next, count: r.cards.length };
}

/**
 * One page of stories, newest first, grouped by the person's day ("Today", "Yesterday", "Monday, September 21").
 * Search ranks by relevance instead (no day groups). next = cursor for the following page (null at the end).
 */
export function storiesPage(user, { topic = null, saved = false, q = '', before = null } = {}) {
  const tz = tzOf(user);
  const where = ['p.user_id = ?', 'p.hidden = 0', "p.kind = 'story'"], args = [user.id];
  if (topic) { where.push('p.topic = ?'); args.push(topic); }
  if (saved) where.push('p.saved = 1');
  const match = ftsQuery(q);
  if (match) {
    const offset = before || 0; // search pages by offset (relevance order has no id cursor)
    const rows = all(`SELECT p.* FROM feed_fts JOIN feed_posts p ON p.id = feed_fts.rowid WHERE feed_fts MATCH ? AND ${where.join(' AND ')}
      ORDER BY bm25(feed_fts, 8, 4, 2, 1) LIMIT ? OFFSET ?`, match, ...args, PAGE_SIZE + 1, offset);
    const page = rows.slice(0, PAGE_SIZE);
    return { sections: page.length ? [{ label: null, day: null, layout: 'stack', posts: page.map(p => postView(p, 'compact')) }] : [],
      next: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null, count: page.length };
  }
  if (before) { where.push('p.id < ?'); args.push(before); }
  const rows = all(`SELECT p.* FROM feed_posts p WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT ?`, ...args, PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const sections = [];
  for (const p of page) {
    const at = toIso(p.created_at);
    const day = dayKey(at, tz);
    let sec = sections.at(-1);
    if (!sec || sec.day !== day) sections.push(sec = { label: dayLabel(at, tz), day, layout: 'stack', posts: [] });
    // Discover rhythm inside each day: a big card, two compact rows, repeat.
    sec.posts.push(postView(p, sec.posts.length % 3 === 0 && p.cover ? 'hero' : 'compact'));
  }
  return { sections, next: rows.length > PAGE_SIZE ? page.at(-1).id : null, count: page.length };
}

export function feedData(user, filters = {}) {
  const prefs = prefsOf(user);
  const home = !filters.topic && !filters.saved && !filters.q && !filters.before && !filters.history && !filters.page && !filters.story;
  const briefRow = home && get(`SELECT * FROM feed_posts WHERE user_id = ? AND kind = 'brief' AND hidden = 0 ORDER BY id DESC LIMIT 1`, user.id);
  const fresh = briefRow && Date.now() - new Date(toIso(briefRow.created_at)).getTime() < 24 * 3600000;
  const page = feedPage(user, filters);
  return {
    prompt: prefs.prompt, filters: { topic: filters.topic || null, saved: !!filters.saved, history: !!filters.history, q: filters.q || '', story: filters.story || null }, home,
    mode: page.mode,
    topics: prefs.topics.filter(t => !t.paused).map(t => ({ label: t.label, when: t.when && t.when !== 'any' ? t.when : null, active: t.label === filters.topic })),
    brief: fresh ? {
      id: briefRow.public_id, title: briefRow.title, at: toIso(briefRow.created_at),
      bullets: briefRow.body_md.split('\n').filter(l => /^[-*] /.test(l)).map(l => l.slice(2)), html: renderMarkdown(briefRow.body_md),
    } : null,
    sections: page.sections, next: page.next, count: page.count,
    status: { state: prefs.digest_state, note: prefs.digest_note, lastAt: toIso(prefs.last_digest_at) },
  };
}

/** The reading sheet's second half: the saved article (or its state). */
export function articleView(p) {
  // The article is cached on the story (item) for everyone; older posts kept their own copy.
  const item = itemOf(p);
  const src = item?.article_status ? item : p;
  const ok = src.article_status === 'ok' && looksLikeArticle(src.article_html); // older saves predate the quality gate
  return { id: p.public_id, status: ok ? 'ok' : src.article_status === 'ok' ? 'failed' : src.article_status || null, html: ok ? withDir(src.article_html) : null,
    url: item?.resolved_url || p.url, source: p.source_name || p.source_host || 'the source' };
}

/** Save the article (and the publisher's URL / cover it revealed) on the story itself, shared by everyone who opens it. */
export function setItemArticle(item, { html, url = null, cover = null }) {
  run(`UPDATE feed_items SET article_html = ?, article_status = ?, article_at = ?, resolved_url = COALESCE(?, resolved_url),
       cover = COALESCE(cover, ?) WHERE id = ?`, html, html ? 'ok' : 'failed', new Date().toISOString(), url, cover, item.id);
}
