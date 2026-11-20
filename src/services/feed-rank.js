// Discover-grade ranking (decision #63, docs/FEED.md). Plain code, no model calls here — one input, how well a story fits
// what they asked for, is judged ahead of time by the decision model and stored (services/feed-relevance.js, #110):
//   learn    — what a person does with cards (seen, opened, read, liked, saved, "less like this"…) moves weights on the
//              card's topic, source and title words; weights fade with a 30-day half-life unless the topic is followed
//   cluster  — the same story from several outlets becomes one cluster (title-word Jaccard), shown once with "+N sources"
//   rank     — relevance × fit × freshness × source quality × fatigue × novelty, then diversified (no runs of one topic/source)
//              with an exploration slot, each card carrying the reason it's there ("Because you follow …")
import { get, all, run, tx } from '../db/index.js';
import { relevanceOf } from './feed-relevance.js';

const HALF_LIFE_DAYS = 30;
const STOP = new Set(('the a an and or but of to in on for with from by at as is are was were be been it its this that these those '
  + 'after before over under about into new says say said will would can could may might more most than then how why what who when '
  + 'where which your you our their his her they them we he she not no yes all any some just also out up down off here there now '
  + 'les des une un et ou de du la le en au aux pour par sur avec dans est sont ce cette ces il elle ils elles').split(' '));

/** Content words of a title (the "terms" a person's taste is learned on). */
export function termsOf(text) {
  return [...new Set(String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .match(/[\p{L}\p{N}]{4,}/gu) || [])].filter(w => !STOP.has(w)).slice(0, 10);
}

// ---- Clustering (on insert) -----------------------------------------------------------------------------------
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };

/** The cluster this new item belongs to: an item from the last 48 h whose title shares ≥ 50% of its words, else itself. */
export function clusterFor(itemId, title) {
  const mine = new Set(termsOf(title));
  if (mine.size < 3) return itemId;
  const since = new Date(Date.now() - 48 * 3600000).toISOString();
  let best = null;
  for (const r of all('SELECT id, cluster_id, title FROM feed_items WHERE id != ? AND published_at >= ? ORDER BY id DESC LIMIT 600', itemId, since)) {
    const score = jaccard(mine, new Set(termsOf(r.title)));
    if (score >= 0.5 && (!best || score > best.score)) best = { id: r.cluster_id || r.id, score };
  }
  return best ? best.id : itemId;
}

// ---- Learning from what people do ------------------------------------------------------------------------------
const DELTAS = { // topic, source, per term
  impression: [0, 0, 0], open: [0.5, 0.3, 0.2], read: [1, 0.5, 0.4], bounce: [-0.2, -0.1, 0],
  like: [2, 1, 0.8], save: [1.5, 0.6, 0.6], share: [1.5, 0.6, 0.6], less: [-1.5, -1, -0.8], hide: [-2, -1, -0.5],
};

const decayed = (w, updatedAt, follows) => {
  const days = (Date.now() - new Date(`${String(updatedAt).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(updatedAt) ? '' : 'Z'}`)) / 864e5;
  const f = Math.pow(0.5, Math.max(0, days) / HALF_LIFE_DAYS);
  return follows ? Math.max(w * f, 1) : w * f; // a followed topic never fades below 1
};

function bump(userId, kind, key, delta) {
  if (!key || !delta) return;
  const row = get('SELECT * FROM feed_interests WHERE user_id = ? AND kind = ? AND key = ?', userId, kind, key);
  const now = decayed(row?.weight || 0, row?.updated_at || new Date().toISOString(), row?.follows);
  const next = Math.max(-10, Math.min(10, now + delta));
  run(`INSERT INTO feed_interests (user_id, kind, key, weight, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, kind, key) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at`, userId, kind, key, next);
}

/** Record one signal about a card and learn from it. `topic` is the card's topic label; value = seconds read. */
export function recordEvent(userId, item, kind, { topic = null, value = 0 } = {}) {
  if (!DELTAS[kind] || !item) return;
  run('INSERT INTO feed_events (user_id, item_id, kind, value) VALUES (?, ?, ?, ?)', userId, item.id, kind, Number(value) || 0);
  const [dt, ds, dw] = DELTAS[kind];
  tx(() => {
    bump(userId, 'topic', topic, dt);
    bump(userId, 'source', item.source_name || item.source_host, ds);
    for (const t of termsOf(item.title)) bump(userId, 'term', t, dw);
  });
}

/** Follow / unfollow a topic from any card ("Follow AI Releases"). */
export function setFollow(userId, topic, on) {
  run(`INSERT INTO feed_interests (user_id, kind, key, weight, follows, updated_at) VALUES (?, 'topic', ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, kind, key) DO UPDATE SET follows = excluded.follows, weight = MAX(feed_interests.weight, excluded.weight), updated_at = excluded.updated_at`,
  userId, topic, on ? 2 : 0, on ? 1 : 0);
}

/** The person's profile, faded to now: { topic: Map, source: Map, term: Map, follows: Set }. */
export function profileOf(userId) {
  const p = { topic: new Map(), source: new Map(), term: new Map(), follows: new Set() };
  for (const r of all('SELECT * FROM feed_interests WHERE user_id = ?', userId)) {
    p[r.kind].set(r.key, decayed(r.weight, r.updated_at, r.follows));
    if (r.follows) p.follows.add(r.key);
  }
  return p;
}

// ---- Ranking -----------------------------------------------------------------------------------------------------
const tanh = Math.tanh;

/**
 * Rank candidate cards (items joined with their topic) for one person. Each candidate needs: id, cluster_id, title,
 * source_name/source_host, published_at, topic (label), sources (cluster size). Returns them scored, diversified, with
 * a reason, and every 7th slot an exploration pick ("Suggested for you").
 */
export function rankCards(userId, candidates, { now = Date.now() } = {}) {
  const p = profileOf(userId);
  const seen = new Map(), opened = new Set(), lessened = new Set();
  for (const e of all(`SELECT item_id, kind, COUNT(*) AS n FROM feed_events WHERE user_id = ? AND at >= datetime('now', '-14 days') GROUP BY item_id, kind`, userId)) {
    if (e.kind === 'impression') seen.set(e.item_id, e.n);
    if (['open', 'read', 'like', 'save', 'share'].includes(e.kind)) opened.add(e.item_id);
    if (e.kind === 'less' || e.kind === 'hide') lessened.add(e.item_id);
  }
  // Source quality: how often this person opens what they're shown from a source (smoothed).
  const quality = new Map(all(`SELECT i.source_host AS host, SUM(e.kind = 'impression') AS imp, SUM(e.kind IN ('open', 'read')) AS op
    FROM feed_events e JOIN feed_items i ON i.id = e.item_id WHERE e.user_id = ? AND e.at >= datetime('now', '-60 days') GROUP BY i.source_host`, userId)
    .map(r => [r.host, (r.op + 1) / (r.imp + 5) / 0.2])); // 0.2 = the prior's rate → 1.0 for an unknown source

  // What they asked the feed for, as the decision model judged each story (#110; unscored stories are neutral).
  const asked = relevanceOf({ id: userId }, candidates.map(c => c.id));
  const scored = [];
  for (const c of candidates) {
    if (lessened.has(c.id)) continue;
    const want = asked.get(c.id);
    const ageH = Math.max(0, (now - new Date(c.published_at || now)) / 3600000);
    const terms = termsOf(c.title);
    const tw = p.topic.get(c.topic) ?? 0, sw = p.source.get(c.source_name || c.source_host) ?? 0;
    const termW = terms.reduce((s, t) => s + (p.term.get(t) || 0), 0);
    const rel = Math.max(0.05, 1 + 0.8 * tanh(tw / 3) + 0.5 * tanh(sw / 3) + 0.6 * tanh(termW / 4));
    const fresh = Math.pow(2, -ageH / 18);
    const qual = Math.min(2, Math.max(0.4, quality.get(c.source_host) ?? 1)) * (1 + 0.2 * Math.log(Math.max(1, c.sources || 1)));
    const fatigue = Math.pow(0.85, seen.get(c.id) || 0);
    const novelty = opened.has(c.id) ? 0.3 : 1;
    const fit = want == null ? 1 : 0.6 + 0.8 * want; // ×0.6 (not what they asked for) … ×1.4 (exactly it)
    const score = rel * fit * fresh * qual * fatigue * novelty;
    // Why it's here: the strongest of what matched.
    const bestTerm = terms.map(t => [t, p.term.get(t) || 0]).sort((a, b) => b[1] - a[1])[0];
    const why = p.follows.has(c.topic) || tw > 1.5 ? `Because you follow ${c.topic}`
      : sw > 1.5 ? `Because you often read ${c.source_name || c.source_host}`
        : want >= 0.85 ? 'Matches what you asked for'
        : bestTerm && bestTerm[1] > 1 ? `Because you read about ${bestTerm[0]}`
          : (c.sources || 1) >= 3 ? `Covered by ${c.sources} outlets` : c.topic ? `From ${c.topic}` : null;
    scored.push({ ...c, score, why, opened: opened.has(c.id) });
  }
  scored.sort((a, b) => b.score - a.score);

  // Diversify: never three of one topic or two of one source in a row; every 7th slot explores a less-followed topic.
  const out = [], pool = [...scored];
  const median = scored[Math.floor(scored.length / 2)]?.score || 0;
  while (pool.length) {
    let pick;
    if (out.length % 7 === 6) {
      const known = p.topic;
      const i = pool.findIndex(c => (known.get(c.topic) ?? 0) <= 0.5 && c.score >= median * 0.3);
      if (i >= 0) { pick = pool.splice(i, 1)[0]; pick = { ...pick, explore: true, why: 'Suggested for you' }; }
    }
    if (!pick) {
      const last = out.slice(-2);
      const i = pool.findIndex(c => !(last.length === 2 && last.every(x => x.topic === c.topic)) && !(last.at(-1)?.source_host && last.at(-1).source_host === c.source_host));
      pick = pool.splice(i >= 0 ? i : 0, 1)[0];
    }
    out.push(pick);
  }
  return out;
}

// ---- Your reading diet (decision #193 notes; a monthly Feed card in Phase 25) ------------------------------------------------
// From what they did with stories (feed_events): which topics and sources they actually read, how varied that was, and ONE
// suggestion to broaden it. Plain code; no model call.
const ENGAGED = ['open', 'read', 'like', 'save', 'share'];
const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

export function readingDiet(user, { days = 30, now = new Date() } = {}) {
  const d = Math.max(7, Math.min(90, Math.round(Number(days) || 30)));
  const from = new Date(now.getTime() - d * 864e5);
  const sqlTime = x => x.toISOString().replace('T', ' ').slice(0, 19);
  const prefs = get('SELECT topics FROM feed_prefs WHERE user_id = ?', user.id);
  const topics = prefs ? JSON.parse(prefs.topics || '[]') : [];
  const labelOf = new Map(topics.map(t => [t.key, t.label]));
  const rows = all(`SELECT e.item_id, e.kind, e.value, i.source_name, i.source_host,
      (SELECT MIN(f.topic_key) FROM feed_subscriptions f WHERE f.user_id = e.user_id AND f.source_id = i.source_id) AS topic_key
    FROM feed_events e JOIN feed_items i ON i.id = e.item_id
    WHERE e.user_id = ? AND e.at >= ? AND e.at <= ? AND e.kind IN (${ENGAGED.map(() => '?').join(',')})`,
  user.id, sqlTime(from), sqlTime(now), ...ENGAGED);
  const items = new Map();
  let seconds = 0, liked = 0, saved = 0;
  for (const r of rows) {
    if (r.kind === 'read') seconds += Math.max(0, Math.min(3600, Number(r.value) || 0));
    if (r.kind === 'like') liked++;
    if (r.kind === 'save') saved++;
    if (!items.has(r.item_id)) items.set(r.item_id, { topic: labelOf.get(r.topic_key) || 'Other', source: r.source_name || r.source_host || 'Unknown' });
  }
  const count = key => {
    const m = new Map();
    for (const it of items.values()) m.set(it[key], (m.get(it[key]) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const total = items.size;
  const byTopic = count('topic'), bySource = count('source');
  // Variety: how evenly their reading spread over the topics they follow (normalised Shannon entropy, 0..1).
  const k = Math.max(byTopic.length, topics.filter(t => !t.paused).length);
  const entropy = byTopic.reduce((s, [, c]) => s - (c / total) * Math.log(c / total), 0);
  const score = total && k > 1 ? Math.round((entropy / Math.log(k)) * 100) / 100 : 0;
  const enough = total >= 5;
  let suggestion = null;
  if (!enough) {
    suggestion = { kind: 'start', text: 'Open a few more stories this month and I’ll show you what you read most.' };
  } else {
    const unread = topics.find(t => !t.paused && !byTopic.some(([label]) => label === t.label));
    const [topSource, topSourceN] = bySource[0];
    const [topTopic, topTopicN] = byTopic[0];
    if (unread) {
      suggestion = { kind: 'unread_topic', topic: unread.label, text: `You follow ${unread.label} but didn’t open any of its stories this month. Keep it, or pause it?` };
    } else if (bySource.length > 1 && topSourceN / total >= 0.5) {
      suggestion = { kind: 'one_source', source: topSource, text: `${pct(topSourceN, total)}% of what you read came from ${topSource}. Want another outlet next to it?` };
    } else if (topTopicN / total >= 0.7) {
      suggestion = { kind: 'one_topic', topic: topTopic, text: `Most of what you read was ${topTopic}. Want a new topic next to it?` };
    } else {
      suggestion = { kind: 'explore', text: 'A varied month. Try one new topic you’ve been curious about.' };
    }
  }
  return {
    days: d, from: from.toISOString(), to: now.toISOString(), enough, stories: total, minutes: Math.round(seconds / 60), liked, saved,
    topics: byTopic.map(([label, n]) => ({ label, count: n, share: pct(n, total) })),
    sources: bySource.slice(0, 10).map(([name, n]) => ({ name, count: n, share: pct(n, total) })),
    variety: { topics: byTopic.length, sources: bySource.length, score, label: score >= 0.75 ? 'varied' : score >= 0.4 ? 'balanced' : 'narrow' },
    suggestion,
  };
}
