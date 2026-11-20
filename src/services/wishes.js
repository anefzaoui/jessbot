// The wish log (Phase 23 item 4, decision #181): what people asked for that Jess has no tool for ("book me a taxi",
// "turn on the lights"). Each ask is one clean line per person; the same wish again (by its words, found with full-text
// search and confirmed by word overlap) counts up instead of adding a row. The owner sees them in Admin → System (Phase
// 25) as "Asked for, can't do yet", the raw material for new tools or skills.
import { get, all, run } from '../db/index.js';
import { oneLine } from '../lib/untrusted.js';

export const WISH_MAX = 240;
const SAME = 0.5; // share of words (of the shorter wish) that makes two asks the same wish
const STOP = new Set('the and for from with that this you your can please could would want need some any about into them they our'.split(' '));
const words = s => new Set((String(s || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !STOP.has(w)));
function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

/** Record a wish (or count it again) → { id, count, created }. text: what they asked for (their words, clipped). */
export function recordWish(userId, text, { runId = null } = {}) {
  const clean = oneLine(text, WISH_MAX);
  if (!clean || words(clean).size === 0) return null;
  const terms = [...words(clean)].slice(0, 10).map(w => `"${w.replace(/"/g, '')}"`).join(' OR ');
  const candidates = terms ? all(`SELECT w.id, w.text, w.count FROM wishes_fts f JOIN wishes w ON w.id = f.rowid
    WHERE wishes_fts MATCH ? AND w.user_id IS ? ORDER BY bm25(wishes_fts) LIMIT 10`, terms, userId) : [];
  const same = candidates.map(c => ({ ...c, s: similarity(clean, c.text) })).filter(c => c.s >= SAME).sort((a, b) => b.s - a.s)[0];
  if (same) {
    run(`UPDATE wishes SET count = count + 1, last_seen = datetime('now'), run_id = COALESCE(?, run_id) WHERE id = ?`, runId, same.id);
    return { id: same.id, count: same.count + 1, created: false };
  }
  const id = Number(run('INSERT INTO wishes (user_id, text, run_id) VALUES (?, ?, ?)', userId, clean, runId).lastInsertRowid);
  return { id, count: 1, created: true };
}

/** For Admin → System: the most asked, newest first among equals. */
export function wishesView({ limit = 30 } = {}) {
  return all(`SELECT w.*, u.name AS person FROM wishes w LEFT JOIN users u ON u.id = w.user_id ORDER BY w.count DESC, w.last_seen DESC LIMIT ?`, limit)
    .map(w => ({ id: w.id, text: w.text, count: w.count, person: w.person || null, userId: w.user_id, runId: w.run_id,
      firstSeen: w.first_seen, lastSeen: w.last_seen }));
}

export const wishCount = () => get('SELECT COUNT(*) AS n FROM wishes').n;
/** The log's header (Admin → System, Phase 25 #203): { wishes, asks, people }. */
export const wishSummary = () => get(`SELECT COUNT(*) AS wishes, COALESCE(SUM(count), 0) AS asks, COUNT(DISTINCT user_id) AS people FROM wishes`);
export const deleteWish = id => run('DELETE FROM wishes WHERE id = ?', id).changes > 0;
