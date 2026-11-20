// Fair draws (decision #141): picks, shuffles, teams, pairs, dice and Secret Santa, decided by crypto.randomInt, never by
// the model (a language model "picking at random" is neither random nor checkable). Every draw is recorded (draws table)
// with its inputs, method, result and time, so "was it fair?" has an answer. A Secret Santa's matches are never stored:
// each person got their own match privately (agent/tools/household.js), and the result column stays NULL.
import crypto from 'node:crypto';
import { get, all, run } from '../db/index.js';
import { invalid } from '../lib/errors.js';

export const MODES = ['pick', 'shuffle', 'teams', 'pairs', 'dice', 'secret_santa'];
export const MAX_ITEMS = 200;
export const MAX_SANTA = 100;
const MAX_DICE = 100;
const MAX_SIDES = 1000;

/** The randomness source. Tests pass a seeded one; the app always uses this. int(n): 0..n-1 uniformly; float(): [0, 1). */
export const cryptoRng = {
  int: n => crypto.randomInt(n),
  float: () => crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48,
};

const label = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
const key = s => label(s).toLowerCase();

/** Fisher–Yates: every order equally likely. */
export function shuffle(items, rng = cryptoRng) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = rng.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function cleanItems(items, { unique = false, min = 1 } = {}) {
  const list = (Array.isArray(items) ? items : []).map(label).filter(Boolean);
  if (list.length < min) throw invalid({ items: `Give at least ${min} item${min === 1 ? '' : 's'} to draw from.` });
  if (list.length > MAX_ITEMS) throw invalid({ items: `At most ${MAX_ITEMS} items.` });
  if (unique) {
    const seen = new Set();
    for (const x of list) { if (seen.has(key(x))) throw invalid({ items: `“${x}” is listed twice — each name once, please.` }); seen.add(key(x)); }
  }
  return list;
}

function withoutExcluded(items, exclude = []) {
  const ex = new Set((Array.isArray(exclude) ? exclude : []).map(key));
  return items.filter(x => !ex.has(key(x)));
}

// Pairs to keep apart, as a Set of JSON [a, b] keys (both orders, names lower-cased).
const pairKey = (a, b) => JSON.stringify([key(a), key(b)]);
function apartSet(pairs = [], items = []) {
  const known = new Set(items.map(key));
  const out = new Set();
  const unknown = [];
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (!Array.isArray(p) || p.length !== 2) throw invalid({ avoid_pairs: 'Each pair to keep apart is two names, like ["Sam", "Priya"].' });
    const [a, b] = p;
    for (const x of [a, b]) if (!known.has(key(x))) unknown.push(label(x));
    out.add(pairKey(a, b)); out.add(pairKey(b, a));
  }
  if (unknown.length) throw invalid({ avoid_pairs: `${[...new Set(unknown)].join(', ')} ${unknown.length === 1 ? 'isn’t' : 'aren’t'} in the draw.` });
  return out;
}
const apart = (set, a, b) => set.has(pairKey(a, b));

/** count distinct items; with weights, each draw is proportional to the weights of those still in the hat. */
export function pick(items, { count = 1, weights = null, rng = cryptoRng } = {}) {
  const n = Math.round(Number(count) || 1);
  if (n < 1 || n > items.length) throw invalid({ count: `Pick between 1 and ${items.length}.` });
  if (!weights) return shuffle(items, rng).slice(0, n);
  if (!Array.isArray(weights) || weights.length !== items.length) throw invalid({ weights: 'Give one weight per item, in the same order.' });
  const w = weights.map(Number);
  if (w.some(x => !Number.isFinite(x) || x < 0)) throw invalid({ weights: 'Weights are numbers of 0 or more.' });
  if (w.filter(x => x > 0).length < n) throw invalid({ weights: `Only ${w.filter(x => x > 0).length} item(s) have a weight above 0.` });
  const pool = items.map((x, i) => ({ x, w: w[i] })).filter(p => p.w > 0);
  const out = [];
  for (let k = 0; k < n; k++) {
    const total = pool.reduce((a, p) => a + p.w, 0);
    let r = rng.float() * total, i = 0;
    while (i < pool.length - 1 && r >= pool[i].w) { r -= pool[i].w; i++; }
    out.push(pool.splice(i, 1)[0].x);
  }
  return out;
}

const TRIES = 20000;
/** n teams, sizes differing by at most one, keeping apart the pairs asked for (rejection sampling keeps it uniform). */
export function teams(items, n, { avoidPairs = [], rng = cryptoRng } = {}) {
  const k = Math.round(Number(n));
  if (!(k >= 2) || k > items.length) throw invalid({ teams: `Make between 2 and ${items.length} teams.` });
  const set = apartSet(avoidPairs, items);
  for (let t = 0; t < TRIES; t++) {
    const order = shuffle(items, rng);
    const out = Array.from({ length: k }, () => []);
    order.forEach((x, i) => out[i % k].push(x));
    if (!out.some(team => team.some((a, i) => team.slice(i + 1).some(b => apart(set, a, b))))) return out;
  }
  throw invalid({ avoid_pairs: `I couldn't split them into ${k} teams while keeping all those pairs apart — drop a pair or make more teams.` });
}

/** Random pairs (an odd one out joins the last pair as a three), keeping apart the pairs asked for. */
export function pairs(items, { avoidPairs = [], rng = cryptoRng } = {}) {
  if (items.length < 2) throw invalid({ items: 'Pairs need at least two people.' });
  const set = apartSet(avoidPairs, items);
  for (let t = 0; t < TRIES; t++) {
    const order = shuffle(items, rng);
    const out = [];
    for (let i = 0; i + 1 < order.length; i += 2) out.push([order[i], order[i + 1]]);
    if (order.length % 2) out.at(-1).push(order.at(-1));
    if (!out.some(g => g.some((a, i) => g.slice(i + 1).some(b => apart(set, a, b))))) return out;
  }
  throw invalid({ avoid_pairs: 'I couldn’t pair everyone while keeping all those pairs apart — drop one of them.' });
}

/** "2d6+1", "d20", "3d6-2", "1d4+1d6+2" → { expr, rolls: [{ term, values }], modifier, total }. */
export function rollDice(expr, rng = cryptoRng) {
  const s = String(expr || '').replace(/\s+/g, '').toLowerCase();
  if (!/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/.test(s)) throw invalid({ dice: `“${expr}” isn't dice notation — use something like 2d6+1 or d20.` });
  const rolls = [];
  let modifier = 0, total = 0, count = 0;
  for (const m of s.matchAll(/([+-]?)(\d*d\d+|\d+)/g)) {
    const sign = m[1] === '-' ? -1 : 1;
    const d = /^(\d*)d(\d+)$/.exec(m[2]);
    if (!d) { modifier += sign * Number(m[2]); continue; }
    const n = Number(d[1] || 1), sides = Number(d[2]);
    if (n < 1 || sides < 2 || sides > MAX_SIDES) throw invalid({ dice: `Dice have 2 to ${MAX_SIDES} sides, and at least one die per term.` });
    count += n;
    if (count > MAX_DICE) throw invalid({ dice: `At most ${MAX_DICE} dice at once.` });
    const values = Array.from({ length: n }, () => 1 + rng.int(sides));
    rolls.push({ term: `${sign < 0 ? '-' : ''}${n}d${sides}`, values });
    total += sign * values.reduce((a, b) => a + b, 0);
  }
  if (!rolls.length) throw invalid({ dice: 'Roll at least one die, like d6.' });
  return { expr: s, rolls, modifier, total: total + modifier };
}

// Can everyone give to someone allowed? Kuhn's augmenting paths on the giver → receiver graph (a perfect matching exists).
function hasAssignment(n, allowed) {
  const match = Array(n).fill(-1);
  const tryKuhn = (v, seen) => {
    for (let u = 0; u < n; u++) {
      if (!allowed[v][u] || seen[u]) continue;
      seen[u] = true;
      if (match[u] < 0 || tryKuhn(match[u], seen)) { match[u] = v; return true; }
    }
    return false;
  };
  for (let v = 0; v < n; v++) if (!tryKuhn(v, Array(n).fill(false))) return false;
  return true;
}

/**
 * Secret Santa: nobody draws themselves or someone they're kept apart from (both ways — couples). Uniform among the
 * valid draws (rejection sampling); when constraints are so tight that sampling runs long, a randomised search finishes
 * it. Impossible constraints fail with a clear reason before anything is drawn. → [{ giver, receiver }] in input order.
 */
export function secretSanta(people, { avoidPairs = [], rng = cryptoRng } = {}) {
  if (people.length < 3) throw invalid({ items: 'Secret Santa needs at least three people (with two, each would know who has them).' });
  if (people.length > MAX_SANTA) throw invalid({ items: `At most ${MAX_SANTA} people in one Secret Santa.` });
  const set = apartSet(avoidPairs, people);
  const n = people.length;
  const allowed = people.map((g, i) => people.map((r, j) => i !== j && !apart(set, g, r)));
  const lonely = people.filter((_, i) => !allowed[i].some(Boolean));
  if (lonely.length) throw invalid({ avoid_pairs: `${lonely.join(', ')} can't give to anyone with those pairs kept apart.` });
  if (!hasAssignment(n, allowed)) throw invalid({ avoid_pairs: 'No draw can keep all those pairs apart — drop one of them (or add someone).' });
  const ok = perm => perm.every((j, i) => allowed[i][j]);
  const idx = people.map((_, i) => i);
  for (let t = 0; t < TRIES; t++) {
    const perm = shuffle(idx, rng);
    if (ok(perm)) return perm.map((j, i) => ({ giver: people[i], receiver: people[j] }));
  }
  // Randomised depth-first search: givers in random order, each trying receivers in random order.
  const order = shuffle(idx, rng);
  const taken = Array(n).fill(false);
  const pickOf = Array(n).fill(-1);
  const dfs = k => {
    if (k === n) return true;
    const g = order[k];
    for (const r of shuffle(idx, rng)) {
      if (taken[r] || !allowed[g][r]) continue;
      taken[r] = true; pickOf[g] = r;
      if (dfs(k + 1)) return true;
      taken[r] = false;
    }
    return false;
  };
  dfs(0);
  return pickOf.map((j, i) => ({ giver: people[i], receiver: people[j] }));
}

// ---- The record ------------------------------------------------------------------------------------------------------
/** Store a draw → { id, at }. result null = revealed privately (Secret Santa): nothing to look up, by design. */
export function recordDraw(user, { runId = null, mode, input, result }) {
  const publicId = `d-${crypto.randomBytes(5).toString('base64url')}`;
  run('INSERT INTO draws (public_id, user_id, run_id, mode, input, result) VALUES (?, ?, ?, ?, ?, ?)',
    publicId, user.id, runId, mode, JSON.stringify(input), result == null ? null : JSON.stringify(result));
  const row = get('SELECT * FROM draws WHERE public_id = ?', publicId);
  return { id: publicId, at: new Date(`${row.created_at.replace(' ', 'T')}Z`).toISOString() };
}

/** A person's own draw (for "was it fair?"): { id, mode, input, result (null when private), at }, or null. */
export function drawOf(user, publicId) {
  const r = get('SELECT * FROM draws WHERE public_id = ? AND user_id = ?', String(publicId || ''), user.id);
  return r ? { id: r.public_id, mode: r.mode, input: JSON.parse(r.input), result: r.result ? JSON.parse(r.result) : null, at: `${r.created_at.replace(' ', 'T')}Z` } : null;
}

export const recentDraws = (user, limit = 20) => all('SELECT public_id FROM draws WHERE user_id = ? ORDER BY id DESC LIMIT ?', user.id, limit)
  .map(r => drawOf(user, r.public_id));

// ---- Draw history (Phase 25, decision #196): the record, readable, for "was it fair?" ------------------------------------
const MODE = { pick: ['Picked at random', 'dice-5'], shuffle: ['Shuffled', 'shuffle'], teams: ['Split into teams', 'users'],
  pairs: ['Made pairs', 'users'], dice: ['Rolled dice', 'dice-5'], secret_santa: ['Secret Santa', 'gift'] };
const few = (list, n = 8) => (list.length > n ? `${list.slice(0, n).join(', ')} and ${list.length - n} more` : list.join(', '));
/** One draw as the history shows it → { id, mode, label, iconName, headline, detail, from, at, private }. */
export function drawView(d) {
  const [label, iconName] = MODE[d.mode] || MODE.pick;
  const items = Array.isArray(d.input?.items) ? d.input.items : Array.isArray(d.input?.people) ? d.input.people : [];
  const r = d.result;
  let headline = label, detail = null;
  if (d.mode === 'dice' && r) { headline = `Rolled ${r.expr}: ${r.total}`; detail = r.rolls?.map(x => `${x.term}: ${x.values.join(' + ')}`).join('; '); }
  else if (d.mode === 'pick' && Array.isArray(r)) { headline = r.length === 1 ? `Picked ${r[0]}` : `Picked ${r.length}: ${few(r, 4)}`; }
  else if (d.mode === 'shuffle' && Array.isArray(r)) { headline = `Shuffled ${r.length} into an order`; detail = r.join(' → '); }
  else if (d.mode === 'teams' && Array.isArray(r)) { headline = `${items.length} into ${r.length} teams`; detail = r.map((t, i) => `Team ${i + 1}: ${t.join(', ')}`).join(' · '); }
  else if (d.mode === 'pairs' && Array.isArray(r)) { headline = `${r.length} pairs`; detail = r.map(p => p.join(' & ')).join(' · '); }
  else if (d.mode === 'secret_santa') {
    headline = `Secret Santa for ${items.length} people`;
    detail = r ? r.map(m => `${m.giver} → ${m.receiver}`).join(' · ') : 'Each person got their own match privately; nobody keeps the list, not even me.';
  }
  return { id: d.id, mode: d.mode, label, iconName, headline, detail, from: d.mode === 'dice' ? null : few(items), count: items.length, at: d.at,
    private: d.mode === 'secret_santa' && !r };
}
/** A person's recent draws for the history (their own only). */
export const drawHistory = (user, limit = 10) => recentDraws(user, limit).filter(Boolean).map(drawView);

export { cleanItems, withoutExcluded };
