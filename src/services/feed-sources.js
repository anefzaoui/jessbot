// Feed sources people can see and control (decision #89). Tune makes Jess's picks (a Google News search per topic, plus a
// feed for each site the person named); here the person reviews them per topic, adds their own sites or feeds, removes any,
// edits a topic's search words, pauses or deletes a topic. Their edits survive a re-tune: their own sources and topics
// stay, and what they removed stays removed (feed_removed). Admins see every source on the install with its health.
import { discoverFeeds } from 'feedscout';
import { parseOpml, generateOpml } from 'feedsmith';
import { get, all, run, tx } from '../db/index.js';
import { fetchRaw, decodeBody } from '../browser/read.js';
import { validHost, iconUrl } from './favicons.js';
import { toIso } from './chatview.js';
import { invalid, notFound, badRequest } from '../lib/errors.js';
import * as feed from './feed.js';

export const MAX_TOPICS = 12;             // Tune picks at most 8; people may add a few of their own
export const MAX_SOURCES_PER_TOPIC = 10;
const WHEN = ['morning', 'midday', 'evening', 'any'];

// Topic keys keep any script's letters (an Arabic topic name must not collapse to "topic").
export const slug = s => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'topic';
export const cleanDomain = d => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

// ---- What was removed (so a re-tune doesn't bring it back) ------------------------------------------------------------
export const removedOf = (user, kind) => new Set(all('SELECT value FROM feed_removed WHERE user_id = ? AND kind = ?', user.id, kind).map(r => r.value));
const markRemoved = (userId, kind, value) => run('INSERT OR IGNORE INTO feed_removed (user_id, kind, value) VALUES (?, ?, ?)', userId, kind, value);
const unmarkRemoved = (userId, kind, value) => run('DELETE FROM feed_removed WHERE user_id = ? AND kind = ? AND value = ?', userId, kind, value);
/** A removed source is remembered per topic: removing it from one topic doesn't block it elsewhere. */
export const removedKey = (topicKey, url) => `${topicKey} ${url}`;

// ---- Finding a site's feed (feedscout, fetching through the browser — the only way out to the internet) ---------------
export async function discoverSiteFeed(pageUrl, signal) {
  const fetchFn = async (url, opts = {}) => {
    const r = await fetchRaw(url, { headers: opts.headers, signal, timeout: 15000 });
    return { headers: new Headers(r.headers), body: decodeBody(r.body, r.contentType), url: r.url, status: r.status, statusText: '' };
  };
  const found = await Promise.race([
    discoverFeeds(pageUrl, { methods: ['platform', 'html', 'guess'], fetchFn, stopOnFirstResult: true, maxUris: 6, concurrency: 2 }),
    new Promise(resolve => setTimeout(() => resolve([]), 45000)),
  ]).catch(() => []);
  return found.find(f => f.isValid) || null;
}

/** A link the person pasted → { url, title, siteUrl } of a real feed: the link itself, or one the page points to. */
async function resolveFeed(u, signal) {
  try {
    const r = await fetchRaw(u.href, { signal, timeout: 20000 });
    if (r.status < 400) {
      try {
        const f = feed.normalizeFeed(decodeBody(r.body, r.contentType));
        if (f.items.length || f.title) return { url: r.url || u.href, title: f.title, siteUrl: f.siteUrl };
      } catch { /* a page, not a feed */ }
    }
  } catch (err) { if (err.name === 'AbortError') throw err; }
  const d = await discoverSiteFeed(u.pathname.length > 1 ? u.href : `${u.origin}/`, signal);
  return d ? { url: d.url, title: d.title || null, siteUrl: `${u.origin}/` } : null;
}

// ---- Views ------------------------------------------------------------------------------------------------------------
const STATS = `(SELECT COUNT(*) FROM feed_items i WHERE i.source_id = s.id) AS items,
  (SELECT MAX(published_at) FROM feed_items i WHERE i.source_id = s.id) AS latest_at`;

/** Google News search sources show their words (and the site they're limited to), not the long URL. */
function searchOf(s) {
  if (s.kind !== 'gnews') return null;
  try { return new URL(s.url).searchParams.get('q').replace(/\s*when:\d+[dh]\s*$/, '').trim(); } catch { return null; }
}

export function sourceView(s) {
  const query = searchOf(s);
  const site = query && /(?:^|\s)site:(\S+)/.exec(query)?.[1];
  const host = site || hostOf(s.site_url) || hostOf(s.url);
  const state = s.error_count ? 'failing' : s.fetched_at ? 'ok' : 'new';
  return {
    id: s.id, title: s.title || host || 'Source', kind: s.kind, kindLabel: s.kind === 'gnews' ? (site ? 'Google News · this site' : 'Google News search') : 'Site feed',
    host, favicon: iconUrl(site || (s.kind === 'gnews' && !site ? 'news.google.com' : host)), url: s.url, siteUrl: s.site_url || (host ? `https://${host}/` : null),
    query: query ? query.replace(/(?:^|\s)site:\S+/, '').trim() || null : null, origin: s.origin || null, mine: s.origin === 'manual',
    state, error: s.error || null, errorCount: s.error_count || 0,
    fetchedAt: s.fetched_at ? toIso(s.fetched_at) : null, nextFetchAt: s.next_fetch_at ? toIso(s.next_fetch_at) : null,
    items: s.items ?? null, latestAt: s.latest_at ? toIso(s.latest_at) : null,
  };
}

/** A person's topics, each with its sources — what /feed/sources shows and GET /api/v1/feed/sources returns. */
export function topicsWithSources(user) {
  const subs = all(`SELECT s.*, f.topic_key, f.origin, ${STATS} FROM feed_subscriptions f JOIN feed_sources s ON s.id = f.source_id
    WHERE f.user_id = ? ORDER BY f.origin = 'manual' DESC, s.kind = 'gnews' DESC, s.title`, user.id);
  return feed.prefsOf(user).topics.map(t => topicView(t, subs.filter(x => x.topic_key === t.key)));
}
const topicView = (t, subs) => ({
  key: t.key, label: t.label, query: t.query, when: t.when && t.when !== 'any' ? t.when : null, whenValue: t.when || 'any',
  paused: !!t.paused, custom: !!t.custom, sources: subs.map(sourceView), failing: subs.filter(x => x.error_count).length,
});
export function topicWithSources(user, key) {
  const t = topicOf(user, key);
  const subs = all(`SELECT s.*, f.topic_key, f.origin, ${STATS} FROM feed_subscriptions f JOIN feed_sources s ON s.id = f.source_id
    WHERE f.user_id = ? AND f.topic_key = ? ORDER BY f.origin = 'manual' DESC, s.kind = 'gnews' DESC, s.title`, user.id, key);
  return topicView(t, subs);
}

/** Everything /feed/sources shows. */
export function sourcesPage(user) {
  const topics = topicsWithSources(user);
  const list = topics.flatMap(t => t.sources);
  return {
    topics, prompt: feed.prefsOf(user).prompt || null, limits: { topics: MAX_TOPICS, sourcesPerTopic: MAX_SOURCES_PER_TOPIC },
    counts: { topics: topics.length, sources: list.length, mine: list.filter(s => s.mine).length, failing: list.filter(s => s.state === 'failing').length },
  };
}

function topicOf(user, key) {
  const t = feed.prefsOf(user).topics.find(x => x.key === key);
  if (!t) throw notFound('That topic is gone — reload the page.');
  return t;
}

// ---- Topics -------------------------------------------------------------------------------------------------------------
function readTopic(body) {
  const label = String(body?.label ?? '').replace(/\s+/g, ' ').trim();
  const query = String(body?.query ?? '').replace(/\s+/g, ' ').trim();
  const errors = {};
  if (!label) errors.label = 'Give the topic a short name.';
  else if (label.length > 30) errors.label = 'Keep the name under 30 characters.';
  if (query.length > 200) errors.query = 'Keep the search words under 200 characters.';
  if (Object.keys(errors).length) throw invalid(errors);
  return { label, query: query || label, when: WHEN.includes(body?.when) ? body.when : 'any' };
}

/** The topic's Google News searches follow its words: its own search, and any search limited to one site (a site with
 *  no feed) — those keep their origin (Jess's pick or the person's). Feeds of sites don't depend on the words. */
function syncTopicSearch(user, t) {
  const removed = removedOf(user, 'source');
  let hasOwn = false;
  for (const s of all(`SELECT s.id, s.url, s.kind, s.title, f.origin FROM feed_subscriptions f JOIN feed_sources s ON s.id = f.source_id
      WHERE f.user_id = ? AND f.topic_key = ? AND s.kind = 'gnews'`, user.id, t.key)) {
    const site = /(?:^|\s)site:(\S+)/.exec(searchOf(s) || '')?.[1];
    if (!site && s.origin !== 'auto') continue;
    const url = feed.gnewsUrl(site ? `site:${site} ${t.query}` : t.query, user);
    if (!site) hasOwn = true;
    if (s.url === url) continue;
    run('DELETE FROM feed_subscriptions WHERE user_id = ? AND source_id = ? AND topic_key = ?', user.id, s.id, t.key);
    if (removed.has(removedKey(t.key, url))) continue;
    const next = feed.ensureSource(url, { kind: 'gnews', title: site || t.label });
    run(`INSERT OR IGNORE INTO feed_subscriptions (user_id, source_id, topic_key, origin) VALUES (?, ?, ?, ?)`, user.id, next.id, t.key, s.origin);
  }
  const own = feed.gnewsUrl(t.query, user);
  if (hasOwn || removed.has(removedKey(t.key, own))) return;
  const src = feed.ensureSource(own, { kind: 'gnews', title: t.label });
  run(`INSERT OR IGNORE INTO feed_subscriptions (user_id, source_id, topic_key, origin) VALUES (?, ?, ?, 'auto')`, user.id, src.id, t.key);
}

/** withSearch: false = a topic made of the person's own feeds only (an OPML folder): its Google News search starts out
 *  removed, exactly as if they had removed it, so editing the topic later doesn't bring it back either. */
export function createTopic(user, body, { withSearch = true } = {}) {
  const input = readTopic(body);
  const prefs = feed.prefsOf(user);
  if (prefs.topics.length >= MAX_TOPICS) throw badRequest(`You can follow up to ${MAX_TOPICS} topics — pause or delete one first.`);
  const key = slug(input.label);
  if (prefs.topics.some(t => t.key === key)) throw invalid({ label: 'You already have a topic with that name.' });
  const t = { key, ...input, sites: [], custom: true };
  tx(() => {
    feed.savePrefs(user, { prompt: prefs.prompt, topics: [...prefs.topics, t] });
    unmarkRemoved(user.id, 'topic', key);
    if (withSearch) syncTopicSearch(user, t);
    else markRemoved(user.id, 'source', removedKey(key, feed.gnewsUrl(t.query, user)));
  });
  return topicWithSources(user, key);
}

/** A topic by key or name (any case), or null. */
export const findTopic = (user, name) => {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return n ? feed.prefsOf(user).topics.find(t => t.key === n || t.label.toLowerCase() === n || t.key === slug(n)) || null : null;
};

export function editTopic(user, key, body) {
  const input = readTopic(body);
  const prefs = feed.prefsOf(user);
  const i = prefs.topics.findIndex(t => t.key === key);
  if (i < 0) throw notFound('That topic is gone — reload the page.');
  const topics = prefs.topics.slice();
  topics[i] = { ...topics[i], ...input, custom: true }; // the key stays: its sources and stories keep pointing at it
  tx(() => {
    feed.savePrefs(user, { prompt: prefs.prompt, topics });
    syncTopicSearch(user, topics[i]);
    feed.dropOrphanSources();
  });
  return topicWithSources(user, key);
}

export function pauseTopic(user, key, paused) {
  const prefs = feed.prefsOf(user);
  topicOf(user, key);
  feed.savePrefs(user, { prompt: prefs.prompt, topics: prefs.topics.map(t => (t.key === key ? { ...t, paused: !!paused } : t)) });
  return topicWithSources(user, key);
}

export function deleteTopic(user, key) {
  const prefs = feed.prefsOf(user);
  const t = topicOf(user, key);
  tx(() => {
    feed.savePrefs(user, { prompt: prefs.prompt, topics: prefs.topics.filter(x => x.key !== key) });
    run('DELETE FROM feed_subscriptions WHERE user_id = ? AND topic_key = ?', user.id, key);
    markRemoved(user.id, 'topic', key);
    feed.dropOrphanSources();
  });
  return { label: t.label };
}

// ---- Sources --------------------------------------------------------------------------------------------------------
/** Add a site or a feed link to a topic. Finds the site's feed when there is one; otherwise follows the site through
 *  Google News. Fetches it right away so the person sees it work. Returns { topic, source, how, added }. */
export async function addSource(user, key, input, { signal } = {}) {
  const t = topicOf(user, key);
  const raw = String(input ?? '').trim();
  if (!raw) throw invalid({ url: 'Paste a site (like theverge.com) or a feed link.' });
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { throw invalid({ url: 'That doesn’t look like a web address.' }); }
  if (!['http:', 'https:'].includes(u.protocol) || !validHost(u.hostname)) throw invalid({ url: 'That doesn’t look like a web address.' });
  const count = get('SELECT COUNT(*) AS n FROM feed_subscriptions WHERE user_id = ? AND topic_key = ?', user.id, key).n;
  if (count >= MAX_SOURCES_PER_TOPIC) throw badRequest(`A topic can have up to ${MAX_SOURCES_PER_TOPIC} sources — remove one first.`);

  const host = u.hostname.replace(/^www\./, '');
  const found = await resolveFeed(u, signal);
  const src = found
    ? feed.ensureSource(found.url, { title: found.title || host, siteUrl: found.siteUrl || `${u.origin}/` })
    : feed.ensureSource(feed.gnewsUrl(`site:${host} ${t.query}`, user), { kind: 'gnews', title: host });
  const already = get('SELECT origin FROM feed_subscriptions WHERE user_id = ? AND source_id = ? AND topic_key = ?', user.id, src.id, key);
  run(`INSERT INTO feed_subscriptions (user_id, source_id, topic_key, origin) VALUES (?, ?, ?, 'manual')
       ON CONFLICT(user_id, source_id, topic_key) DO UPDATE SET origin = 'manual'`, user.id, src.id, key);
  unmarkRemoved(user.id, 'source', removedKey(key, src.url));
  const fresh = src.fetched_at && Date.now() - new Date(toIso(src.fetched_at)).getTime() < 10 * 60000;
  const added = fresh ? 0 : await feed.fetchSource(src, { signal });
  const row = get(`SELECT s.*, 'manual' AS origin, ${STATS} FROM feed_sources s WHERE s.id = ?`, src.id);
  return { topic: topicWithSources(user, key), source: sourceView(row), how: found ? 'feed' : 'search', already: !!already, added };
}

export function removeSource(user, key, sourceId) {
  topicOf(user, key);
  const src = get(`SELECT s.* FROM feed_subscriptions f JOIN feed_sources s ON s.id = f.source_id WHERE f.user_id = ? AND f.topic_key = ? AND s.id = ?`,
    user.id, key, Number(sourceId));
  if (!src) throw notFound('That source is already gone.');
  tx(() => {
    run('DELETE FROM feed_subscriptions WHERE user_id = ? AND topic_key = ? AND source_id = ?', user.id, key, src.id);
    markRemoved(user.id, 'source', removedKey(key, src.url));
    feed.dropOrphanSources();
  });
  return { topic: topicWithSources(user, key), title: src.title };
}

/** Fetch one of the person's sources now (the "Check now" button). */
export async function checkSource(user, sourceId, topicKey, { signal } = {}) {
  const q = `SELECT s.*, f.origin, ${STATS} FROM feed_subscriptions f JOIN feed_sources s ON s.id = f.source_id
    WHERE f.user_id = ? AND s.id = ? ORDER BY f.topic_key = ? DESC LIMIT 1`;
  const src = get(q, user.id, Number(sourceId), String(topicKey || ''));
  if (!src) throw notFound('That source is gone — reload the page.');
  const added = await feed.fetchSource(src, { signal });
  return { source: sourceView(get(q, user.id, src.id, String(topicKey || ''))), added };
}

// ---- Admin: every source on this install ---------------------------------------------------------------------------------
export function allSources() {
  const names = new Map();
  for (const r of all('SELECT DISTINCT f.source_id, u.name FROM feed_subscriptions f JOIN users u ON u.id = f.user_id ORDER BY u.name')) {
    names.set(r.source_id, [...(names.get(r.source_id) || []), r.name]);
  }
  return all(`SELECT s.*, ${STATS} FROM feed_sources s ORDER BY s.error_count > 0 DESC, s.title COLLATE NOCASE`)
    .map(s => ({ ...sourceView(s), followerNames: names.get(s.id) || [], followers: (names.get(s.id) || []).length }));
}

export async function adminCheckSource(id, { signal } = {}) {
  const src = get('SELECT * FROM feed_sources WHERE id = ?', Number(id));
  if (!src) throw notFound('That source is already gone.');
  const added = await feed.fetchSource(src, { signal });
  return { source: allSources().find(s => s.id === src.id), added };
}

/** Remove a source for everyone. Each follower's re-tune won't bring it back. */
export function adminRemoveSource(id) {
  const src = get('SELECT * FROM feed_sources WHERE id = ?', Number(id));
  if (!src) throw notFound('That source is already gone.');
  const subs = all('SELECT user_id, topic_key FROM feed_subscriptions WHERE source_id = ?', src.id);
  tx(() => {
    for (const s of subs) markRemoved(s.user_id, 'source', removedKey(s.topic_key, src.url));
    run('DELETE FROM feed_sources WHERE id = ?', src.id);
  });
  return { title: src.title || hostOf(src.url), followers: new Set(subs.map(s => s.user_id)).size };
}

// ---- OPML: bring your feeds, take them with you (decision #193) ---------------------------------------------------------------
export const MAX_OPML_FEEDS = 200;
const cleanFeedUrl = raw => {
  try {
    const u = new URL(String(raw || '').trim());
    if (!['http:', 'https:'].includes(u.protocol) || !validHost(u.hostname)) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
};

/**
 * Import an OPML subscription list (FreshRSS, Feedly, Inoreader, NetNewsWire…; parsed with feedsmith). `topic` (a name):
 * every feed goes there (made if new). Otherwise each top-level folder becomes a topic of the same name (an existing one is
 * reused) and loose feeds go to a topic named after the list. Each feed is checked like one pasted on the Sources page
 * (http(s), a real host name), deduplicated (within the file and against what the topic already follows), and capped
 * (MAX_SOURCES_PER_TOPIC per topic, MAX_TOPICS topics, MAX_OPML_FEEDS per file). Topics made from a folder carry only its
 * feeds (no Google News search). Nothing is fetched here: new sources are due at once and the feed tick fetches them
 * politely (through the browser, #23). → { added: [{ title, url, topic }], skipped: [{ title, url, reason }], topics:
 * [{ key, label, created }] } with reason: duplicate | already | invalid | full | topics | too_many.
 */
export function importOpml(user, text, { topic = null } = {}) {
  let o;
  try { o = parseOpml(String(text || '')); } catch { throw invalid({ opml: 'That isn’t an OPML feed list (the .opml file a feed reader exports).' }); }
  const feeds = [];
  const walk = (outlines, folder) => {
    for (const n of outlines || []) {
      if (n.xmlUrl) feeds.push({ title: String(n.title || n.text || '').replace(/\s+/g, ' ').trim().slice(0, 200), raw: n.xmlUrl, site: n.htmlUrl || null, folder });
      else if (n.outlines?.length) walk(n.outlines, folder ?? (String(n.title || n.text || '').replace(/\s+/g, ' ').trim().slice(0, 30) || null));
    }
  };
  walk(o?.body?.outlines, null);
  if (!feeds.length) throw invalid({ opml: 'That list has no feeds in it.' });
  const listName = String(o?.head?.title || '').replace(/\s+/g, ' ').trim().slice(0, 30) || 'Imported';
  const out = { added: [], skipped: [], topics: [] };
  const topicFor = new Map(); // wanted name → topic (or null when it couldn't be made)
  const resolve = name => {
    if (topicFor.has(name)) return topicFor.get(name);
    let t = findTopic(user, name), created = false;
    if (!t) {
      try { t = createTopic(user, { label: name }, { withSearch: false }); created = true; } catch { t = null; }
      if (t) t = feed.prefsOf(user).topics.find(x => x.key === t.key);
    }
    topicFor.set(name, t);
    if (t) out.topics.push({ key: t.key, label: t.label, created });
    return t;
  };
  const seen = new Set();
  tx(() => {
    for (const [i, f] of feeds.entries()) {
      const url = cleanFeedUrl(f.raw);
      const skip = reason => out.skipped.push({ title: f.title || null, url: url || String(f.raw).slice(0, 300), reason });
      if (i >= MAX_OPML_FEEDS) { skip('too_many'); continue; }
      if (!url) { skip('invalid'); continue; }
      const t = resolve(topic ? String(topic).trim().slice(0, 30) : f.folder || listName);
      if (!t) { skip('topics'); continue; }
      if (seen.has(`${t.key} ${url}`)) { skip('duplicate'); continue; }
      seen.add(`${t.key} ${url}`);
      const src = get('SELECT * FROM feed_sources WHERE url = ?', url);
      if (src && get('SELECT 1 FROM feed_subscriptions WHERE user_id = ? AND source_id = ? AND topic_key = ?', user.id, src.id, t.key)) { skip('already'); continue; }
      if (get('SELECT COUNT(*) AS n FROM feed_subscriptions WHERE user_id = ? AND topic_key = ?', user.id, t.key).n >= MAX_SOURCES_PER_TOPIC) { skip('full'); continue; }
      const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; } })();
      const s = src || feed.ensureSource(url, { title: f.title || host, siteUrl: cleanFeedUrl(f.site) });
      run(`INSERT INTO feed_subscriptions (user_id, source_id, topic_key, origin) VALUES (?, ?, ?, 'manual')
           ON CONFLICT(user_id, source_id, topic_key) DO UPDATE SET origin = 'manual'`, user.id, s.id, t.key);
      unmarkRemoved(user.id, 'source', removedKey(t.key, url));
      out.added.push({ title: s.title || f.title || host, url, topic: t.label });
    }
  });
  return out;
}

/** Every topic as a folder with its sources (paused ones included), for another reader or a backup. → OPML 2.0 text. */
export function exportOpml(user) {
  const who = String(user.name || '').split(/\s+/)[0];
  return generateOpml({
    head: { title: `${who ? `${who}’s` : 'My'} feeds (Jessbot)`, dateCreated: new Date() },
    body: { outlines: topicsWithSources(user).filter(t => t.sources.length).map(t => ({
      text: t.label, title: t.label,
      outlines: t.sources.map(s => ({ type: 'rss', text: s.title, title: s.title, xmlUrl: s.url, ...(s.siteUrl ? { htmlUrl: s.siteUrl } : {}) })),
    })) },
  });
}
