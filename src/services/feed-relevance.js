// Story relevance for the feed (Phase 16, docs/JEV.md, decision #110): the decision model reads each new story's title
// and source against what the person asked the feed for ("finance news in the morning, non-fiction books…") and says
// how likely they'd want to read it. Scored in the background (fetch ticks, digests) and stored, so ranking — which also
// runs while pages render — only reads numbers. Before anyone clicks anything, this is what makes the feed theirs.
import crypto from 'node:crypto';
import { all, run } from '../db/index.js';
import { decide, noul, yes, note } from './decide.js';
import { prefsOf } from './feed.js';

const BATCH = 60;        // stories per decision call (state stays small, questions run in parallel)
const PER_PASS = 180;    // at most this many new stories per pass

const wantsOf = user => {
  const p = prefsOf(user);
  const topics = p.topics.map(t => `${t.label}${t.when && t.when !== 'any' ? ` (${t.when})` : ''}`).join(', ');
  const text = [p.prompt && `In their words: ${p.prompt}`, topics && `Topics: ${topics}`].filter(Boolean).join('\n');
  return { text, key: crypto.createHash('sha1').update(text).digest('hex').slice(0, 12) };
};

/** Score the candidates that have no score for the current request yet. Returns how many were scored. */
export async function scoreStories(user, candidates, { signal } = {}) {
  const wants = wantsOf(user);
  if (!wants.text || !candidates.length) return 0;
  const done = new Set(all('SELECT item_id FROM feed_relevance WHERE user_id = ? AND wants = ?', user.id, wants.key).map(r => r.item_id));
  const todo = candidates.filter(c => !done.has(c.id)).slice(0, PER_PASS);
  let scored = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const res = await decide('feed', {
      user, timeoutMs: 5000, signal,
      state: { what_they_want: wants.text,
        stories: Object.fromEntries(batch.map(c => [`s${c.id}`, `${c.title} — ${c.source_name || c.source_host}${c.topic ? ` [${c.topic}]` : ''}`])) },
      questions: Object.fromEntries(batch.map(c => [`s${c.id}`, noul(`Would they want to read story \`stories.s${c.id}\`, given \`what_they_want\`?`)])),
    });
    if (!res) break; // off or failing: ranking simply goes on without it
    let high = 0;
    for (const c of batch) {
      const p = yes(res.answers[`s${c.id}`]);
      if (p == null) continue;
      if (p >= 0.7) high++;
      run(`INSERT INTO feed_relevance (user_id, item_id, score, wants) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, item_id) DO UPDATE SET score = excluded.score, wants = excluded.wants, at = datetime('now')`, user.id, c.id, p, wants.key);
      scored++;
    }
    note(res.id, `${batch.length} stories scored · ${high} look like what you asked for`);
  }
  return scored;
}

/** item id → 0–1, for the current request (stories scored against an older request don't count). */
export function relevanceOf(user, ids) {
  if (!ids.length) return new Map();
  const { key } = wantsOf(user);
  const rows = all(`SELECT item_id, score FROM feed_relevance WHERE user_id = ? AND wants = ? AND item_id IN (${ids.map(() => '?').join(',')})`,
    user.id, key, ...ids);
  return new Map(rows.map(r => [r.item_id, r.score]));
}
