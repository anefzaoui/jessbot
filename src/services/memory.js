// Long-term memory (docs/CONTEXT-AND-MEMORY.md, decisions #27, #151–#156). Thin layer on SQLite + FTS5 + vectors.
// Scope is ALWAYS derived on the server from who is speaking — never from model output.
import { get, all, run, tx } from '../db/index.js';
import { groupsOfUser } from './groups.js';
import { invalid, notFound, forbidden } from '../lib/errors.js';
import { stripInvisible, oneLine } from '../lib/untrusted.js';
import { looksLikeInjection } from '../agent/injection.js';
import { findShapes, secretsIn } from '../lib/dlp.js';
import { ftsAny } from '../lib/fts.js';
import { rrfMerge } from '../lib/rrf.js';
import { tzOf, dayKey } from '../lib/when.js';
import { embed, embedModel, dot, toBlob, fromBlob } from './embeddings.js';

export const CORE_LIMITS = { user: 1400, group: 2200 };
const MAX_FACT = 300;
const MAX_EPISODE = 280;
export const DUPLICATE_COSINE = 0.93;   // same scope, this close in meaning = the same memory (decision #152)
const DUPLICATE_WORDS = 0.9;            // without vectors: this share of the same words (Jaccard) = the same memory
const SIMILAR_COSINE = 0.75;            // "similar memories already saved" in the remember tool's answer

// ---- Scopes ------------------------------------------------------------------------------------
function scope(kind, refId, name) {
  const row = get('SELECT * FROM scopes WHERE kind = ? AND ref_id IS ?', kind, refId);
  if (row) return row;
  const { lastInsertRowid } = run('INSERT INTO scopes (kind, ref_id, name) VALUES (?, ?, ?)', kind, refId, name);
  return get('SELECT * FROM scopes WHERE id = ?', Number(lastInsertRowid));
}
export const userScope = user => scope('user', user.id, user.name);
export const groupScope = g => scope('group', g.id, g.name);

// Scopes this person may read: their own + each group they belong to.
export function readableScopes(user) {
  return [userScope(user), ...groupsOfUser(user.id).map(groupScope)];
}

// Where a write goes. Default private; a group only if the person belongs to it (no auto-promotion).
export function writableScope(user, hint) {
  if (!hint || hint === 'private') return userScope(user);
  const name = String(hint).replace(/^(group|shared):/i, '').trim().toLowerCase();
  const g = groupsOfUser(user.id).find(x => x.name.toLowerCase() === name);
  if (!g) throw forbidden(`You're not in a group called “${name}”, so that can't be shared there.`);
  return groupScope(g);
}

const marks = ids => ids.map(() => '?').join(',');

// ---- Safety ------------------------------------------------------------------------------------
// Invisible characters are stripped with the one shared definition (lib/untrusted.js), which keeps the joiners U+200C and
// U+200D: "می‌خواهم" and 👨‍👩‍👧 stay whole. Instruction-looking text uses the injection detector's stage-1 patterns
// (English, French, Spanish, German, Arabic) plus persona switches — one definition in agent/injection.js.
// Secrets never become memories (decision #125): memories go to the AI service with every message. Card numbers (Luhn),
// keys and tokens, two-step sign-in seeds and "password/PIN/code is …" are refused with one kind line — the same shapes
// the outbound guard flags (lib/dlp.js). IBANs and phone numbers are fine to keep.
export const SECRET_REFUSAL = 'I don’t keep passwords or card numbers in memory: they’d go to the AI service with every message. '
  + 'A password manager is the safe place.';
export const looksLikeSecret = text => findShapes(text).length > 0 || secretsIn(text).length > 0;

export function cleanFact(text) {
  const t = stripInvisible(text).replace(/\s+/g, ' ').trim();
  if (!t) throw invalid({ text: 'Nothing to remember.' });
  if (t.length > MAX_FACT) throw invalid({ text: `Keep each memory under ${MAX_FACT} characters.` });
  if (looksLikeInjection(t)) throw invalid({ text: "That looks like an instruction to the assistant, not a memory — I won't store it." });
  if (looksLikeSecret(t)) throw invalid({ text: SECRET_REFUSAL });
  return t;
}

const event = (memoryId, op, actor, oldText = null, newText = null) =>
  run('INSERT INTO memory_events (memory_id, op, actor, old_text, new_text) VALUES (?, ?, ?, ?, ?)', memoryId, op, actor, oldText, newText);

// ---- Dates (decision #154) ---------------------------------------------------------------------
// A memory can be about a day: a one-off ('2026-10-03', or '2026-10-03T15:00' in the person's wall-clock time) or a date
// that comes back every year ('2016-02-14' + yearly: a birthday with its year, so the age is known; '02-14' when the year
// isn't known). Stored in memories.event_at + memories.recurs (migration 037).
const YMD = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/;
const MD = /^(?:--)?(\d{2})-(\d{2})$/;
const realDay = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const DATE_HELP = 'Use a date like 2026-10-03 (or 10-03 for a yearly date without its year).';

/** A date (+ recurs) from a tool, the extraction model or a form → { eventAt, recurs } for storage. Throws a field error. */
export function normaliseDate(date, recurs) {
  const d = String(date ?? '').trim();
  const r = String(recurs ?? '').trim().toLowerCase();
  if (r && !['yearly', 'none', 'once', 'no'].includes(r)) throw invalid({ recurs: 'A memory can only repeat "yearly".' });
  const yearly = r === 'yearly';
  if (!d) {
    if (yearly) throw invalid({ date: `A yearly memory needs its date. ${DATE_HELP}` });
    return { eventAt: null, recurs: null };
  }
  let m;
  if ((m = MD.exec(d))) {
    if (!realDay(2000, Number(m[1]), Number(m[2]))) throw invalid({ date: DATE_HELP }); // 2000 is a leap year: 02-29 is fine
    return { eventAt: `${m[1]}-${m[2]}`, recurs: 'yearly' };
  }
  if ((m = YMD.exec(d))) {
    const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 1900 || y > 2200 || !realDay(y, mo, day)) throw invalid({ date: DATE_HELP });
    if (m[4] && (Number(m[4]) > 23 || Number(m[5]) > 59)) throw invalid({ date: DATE_HELP });
    const ymd = `${m[1]}-${m[2]}-${m[3]}`;
    return { eventAt: m[4] && !yearly ? `${ymd}T${m[4]}:${m[5]}` : ymd, recurs: yearly ? 'yearly' : null };
  }
  throw invalid({ date: DATE_HELP });
}

const clampImportance = v => Math.max(1, Math.min(3, Math.round(Number(v) || 1)));
const ymdParts = s => s.split('-').map(Number);
const dayDiff = (from, to) => { const [a, b, c] = ymdParts(from), [x, y, z] = ymdParts(to); return Math.round((Date.UTC(x, y - 1, z) - Date.UTC(a, b - 1, c)) / 864e5); };
const leap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const monthDay = eventAt => (eventAt.length === 5 ? eventAt : eventAt.slice(5, 10));
const dayName = ymd => { const [y, m, d] = ymdParts(ymd); return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(Date.UTC(y, m - 1, d)); };
const longDate = (ymd, withYear = true) => { const [y, m, d] = ymdParts(ymd); return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) }).format(Date.UTC(y, m - 1, d)); };

/** The date words a memory line carries: "14 Feb 2016, every year" · "14 Feb, every year" · "22 Sep 2026, 15:00" · null. */
export function dateText(m) {
  if (!m?.event_at) return null;
  if (m.recurs === 'yearly') return m.event_at.length === 5 ? `${longDate(`2000-${m.event_at}`, false)}, every year` : `${longDate(m.event_at.slice(0, 10))}, every year`;
  return `${longDate(m.event_at.slice(0, 10))}${m.event_at.length > 10 ? `, ${m.event_at.slice(11, 16)}` : ''}`;
}

// A one-off event more than 14 days past weighs ×0.2 in recall: "dentist on 3 March" rarely matters in June.
function pastEvent(m, now) {
  if (!m.event_at || m.recurs || m.event_at.length < 10) return false;
  const [y, mo, d] = ymdParts(m.event_at.slice(0, 10));
  return now - Date.UTC(y, mo - 1, d) > 14 * 864e5;
}

// ---- Vectors (decision #151): memory_vec for facts, episode_vec for episodes ------------------------
// Filled in the background (after each write, and a backfill whenever recall finds rows without one). A vector is kept
// only while its row's text is unchanged; rows go with their vectors (ON DELETE CASCADE), and an edit or supersede drops it.
let embedder = embed;
const KINDS = {
  memory: { table: 'memories', vec: 'memory_vec', key: 'memory_id', fts: 'memories_fts', live: `t.status = 'active'` },
  episode: { table: 'episodes', vec: 'episode_vec', key: 'episode_id', fts: 'episodes_fts',
    live: '(t.thread_id IS NULL OR EXISTS (SELECT 1 FROM threads th WHERE th.id = t.thread_id AND th.deleted_at IS NULL))' },
};
const embeddingsOff = () => embedder === embed && process.env.JESSBOT_EMBED_OFF === '1';

async function fillVectors(kind, limit) {
  const k = KINDS[kind];
  const { model, dims } = embedModel();
  const rows = all(`SELECT t.id, t.text, CASE WHEN s.kind = 'user' THEN s.ref_id END AS uid FROM ${k.table} t JOIN scopes s ON s.id = t.scope_id
    WHERE ${k.live} AND NOT EXISTS (SELECT 1 FROM ${k.vec} v WHERE v.${k.key} = t.id AND v.model = ? AND v.dims = ?)
    ORDER BY uid, t.id DESC LIMIT ?`, model, dims, limit);
  const batch = rows.filter(r => r.uid === rows[0]?.uid); // one person per call, so the cost lands on them
  if (!batch.length) return 0;
  const vecs = await embedder(batch.map(r => r.text), { userId: batch[0].uid ?? null });
  if (!vecs) return 0;
  let stored = 0;
  tx(() => batch.forEach((r, i) => {
    // Only if the row is still there with the same text (it may have been edited or forgotten while we waited).
    stored += Number(run(`INSERT OR REPLACE INTO ${k.vec} (${k.key}, model, dims, vec) SELECT ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM ${k.table} WHERE id = ? AND text = ?)`, r.id, model, dims, toBlob(vecs[i]), r.id, r.text).changes);
  }));
  return stored;
}

/** Embed facts and episodes that have no vector for the current model yet (one batch of each). Returns how many. */
export async function ensureVectors({ limit = 64 } = {}) {
  if (embeddingsOff()) return 0;
  return (await fillVectors('memory', limit)) + (await fillVectors('episode', limit));
}

let filling = null, fillAgain = false;
/** Fill missing vectors in the background (one worker; a call while it runs makes it go round once more). */
export function embedSoon() {
  if (embeddingsOff()) return;
  if (filling) { fillAgain = true; return; }
  filling = (async () => {
    await new Promise(r => setImmediate(r));
    do { fillAgain = false; while ((await ensureVectors()) > 0); } while (fillAgain);
  })().catch(err => console.warn('[memory] embedding failed', err.message)).finally(() => { filling = null; });
}

/** Query texts → vectors, or null when embeddings are off, failing or slower than `raceMs` (callers then use words only). */
export async function queryVectors(texts, userId = null, raceMs = 900) {
  if (!texts.length || embeddingsOff()) return null;
  let timer;
  const late = new Promise(r => { timer = setTimeout(() => r(null), raceMs); timer.unref?.(); });
  try { return await Promise.race([embedder(texts, { userId }).catch(() => null), late]); } finally { clearTimeout(timer); }
}
export const queryVector = async (text, userId = null, raceMs = 900) => (await queryVectors([String(text || '')], userId, raceMs))?.[0] || null;

function meaningHits(kind, qv, scopeIds, n = 40, min = 0.2) {
  const k = KINDS[kind];
  const { model, dims } = embedModel();
  if (!scopeIds.length || qv.length !== dims) return [];
  return all(`SELECT v.${k.key} AS id, v.vec FROM ${k.vec} v JOIN ${k.table} t ON t.id = v.${k.key}
      WHERE ${k.live} AND t.scope_id IN (${marks(scopeIds)}) AND v.model = ? AND v.dims = ?`, ...scopeIds, model, dims)
    .map(r => ({ id: r.id, score: dot(qv, fromBlob(r.vec)) })).filter(r => r.score > min)
    .sort((a, b) => b.score - a.score).slice(0, n);
}

function wordHits(kind, query, scopeIds, n = 40) {
  const k = KINDS[kind];
  const q = ftsAny(query);
  if (!q || !scopeIds.length) return [];
  return all(`SELECT t.id FROM ${k.fts} JOIN ${k.table} t ON t.id = ${k.fts}.rowid
      WHERE ${k.fts} MATCH ? AND ${k.live} AND t.scope_id IN (${marks(scopeIds)}) ORDER BY bm25(${k.fts}) LIMIT ?`, q, ...scopeIds, n).map(r => r.id);
}

// ---- Near-duplicates (decision #152) -------------------------------------------------------------
const SEG = new Intl.Segmenter(undefined, { granularity: 'word' });
const wordSet = t => new Set([...SEG.segment(stripInvisible(t).normalize('NFKC').toLowerCase())].filter(s => s.isWordLike).map(s => s.segment));
/** Share of words two texts have in common (Jaccard over their word sets, any script): 1 = the same words. */
export function textSimilarity(a, b) {
  const x = wordSet(a), y = wordSet(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

// Embeddings barely see numbers (calibrated on text-embedding-3-small: "Dentist appointment on 2026-09-29" vs "… on
// 2026-10-14" scored 0.945, above real paraphrases at 0.81–0.96), and the same words can be two events: a duplicate must
// also carry the same numbers and the same date.
const numbersOf = t => (stripInvisible(t).normalize('NFKC').match(/\p{N}+/gu) || []).sort().join(' ');
const sameDetails = (text, eventAt, m) => numbersOf(text) === numbersOf(m.text) && (eventAt || null) === (m.event_at || null);

function sameByWords(text, scopeId, eventAt = null) {
  const exact = all(`SELECT * FROM memories WHERE scope_id = ? AND status = 'active' AND lower(text) = lower(?)`, scopeId, text)
    .find(m => sameDetails(text, eventAt, m));
  if (exact) return exact;
  const ids = wordHits('memory', text, [scopeId], 20);
  if (!ids.length) return null;
  return all(`SELECT * FROM memories WHERE id IN (${marks(ids)})`, ...ids).map(m => ({ m, s: textSimilarity(text, m.text) }))
    .filter(x => x.s >= DUPLICATE_WORDS && sameDetails(text, eventAt, x.m)).sort((a, b) => b.s - a.s)[0]?.m || null;
}

// ---- Writes -------------------------------------------------------------------------------------
/** Validate a new memory without writing it: clean text, the scope it may go to, its date and importance. Throws. */
export function prepareFact({ user, text, kind = 'fact', scopeHint, createdBy = 'agent', pinned = false, eventAt, date, recurs,
  importance = 1, sourceThreadId = null, sourceMessageId = null }) {
  const t = cleanFact(text);
  const sc = writableScope(user, scopeHint);
  const when = normaliseDate(date ?? eventAt, recurs);
  if (pinned) assertCoreRoom(sc, t.length);
  return { user, text: t, kind, scope: sc, createdBy, pinned: !!pinned, eventAt: when.eventAt, recurs: when.recurs,
    importance: clampImportance(importance), sourceThreadId, sourceMessageId };
}

function insertFact(p, vec = null) {
  const { lastInsertRowid } = run(
    `INSERT INTO memories (scope_id, subject_user_id, author_user_id, kind, text, pinned, importance, event_at, recurs, created_by, source_thread_id, source_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    p.scope.id, p.scope.kind === 'user' ? p.user.id : null, p.user.id, p.kind, p.text, p.pinned ? 1 : 0, p.importance, p.eventAt, p.recurs,
    p.createdBy, p.sourceThreadId, p.sourceMessageId);
  const id = Number(lastInsertRowid);
  event(id, 'add', actorOf(p), null, p.text);
  if (vec) { const { model, dims } = embedModel(); run('INSERT OR REPLACE INTO memory_vec (memory_id, model, dims, vec) VALUES (?, ?, ?, ?)', id, model, dims, toBlob(vec)); }
  else embedSoon();
  return getFact(id);
}
const actorOf = p => (p.createdBy === 'user' ? `user:${p.user.id}` : p.createdBy);

/** Save a memory now (exact-text duplicates in the same scope return the existing one). Vectors follow in the background. */
export function addFact(opts) {
  const p = prepareFact(opts);
  const dupe = all(`SELECT * FROM memories WHERE scope_id = ? AND status = 'active' AND lower(text) = lower(?)`, p.scope.id, p.text)
    .find(m => (m.event_at || null) === (p.eventAt || null)); // the same words on another date is another memory
  if (dupe) return getFact(dupe.id);
  return insertFact(p);
}

/**
 * Save a memory unless the same scope already holds it (decision #152): cosine ≥ 0.93 when embeddings work, else nearly
 * the same words. A duplicate returns the existing fact and logs a 'dedupe' event. → { fact, duplicate, similar }, where
 * `similar` are up to 3 other memories close to it (for the remember tool: "if one is now wrong, update it by id").
 * Validation runs before anything is awaited, so bad input throws right away (not as a rejected promise).
 */
export function addFactChecked(opts, { vec: known } = {}) {
  const p = prepareFact(opts);
  return saveChecked(p, known);
}
/** The active memory in a scope that says the same as `text` (on the same date) in nearly the same words, or null. */
export const sameInScope = (scopeId, text, eventAt = null) => sameByWords(stripInvisible(text).replace(/\s+/g, ' ').trim(), scopeId, eventAt);
// known: the text's vector when the caller embedded it already (an import embeds all its lines in one call); null = none.
async function saveChecked(p, known) {
  const dupeOf = existing => {
    event(existing.id, 'dedupe', actorOf(p), null, p.text);
    return { fact: getFact(existing.id), duplicate: true, similar: [] };
  };
  const byWords = sameByWords(p.text, p.scope.id, p.eventAt);
  if (byWords) return dupeOf(byWords);
  const vec = known !== undefined ? known : await queryVector(p.text, p.user.id, 2500);
  const near = vec ? meaningHits('memory', vec, [p.scope.id], 4, SIMILAR_COSINE) : [];
  const same = near.filter(h => h.score >= DUPLICATE_COSINE).map(h => getFact(h.id)).find(m => m && sameDetails(p.text, p.eventAt, m));
  if (same) return dupeOf(same);
  const again = sameByWords(p.text, p.scope.id, p.eventAt); // written by someone else while we were embedding
  if (again) return dupeOf(again);
  const fact = insertFact(p, vec);
  const similarIds = (vec ? near.map(h => h.id) : wordHits('memory', p.text, [p.scope.id], 4)).filter(id => id !== fact.id).slice(0, 3);
  return { fact, duplicate: false, similar: similarIds.map(getFact).filter(Boolean) };
}

// Temporal update: the old fact is superseded (kept for history), the new one takes its place. Date, repeat and importance
// carry over unless given. createdBy: who wrote the new text when the actor isn't one of the usual (the weekly tidy's merge
// is actor 'tidy', written by the agent).
export function supersedeFact(user, id, text, actor = 'agent', { sourceMessageId = null, date, recurs, importance, createdBy = null } = {}) {
  const old = factForUser(user, id);
  const t = cleanFact(text);
  const when = date !== undefined || recurs !== undefined ? normaliseDate(date, recurs) : { eventAt: old.event_at, recurs: old.recurs };
  const fact = tx(() => {
    run(`UPDATE memories SET status = 'superseded', valid_to = datetime('now'), updated_at = datetime('now') WHERE id = ?`, old.id);
    run('DELETE FROM memory_vec WHERE memory_id = ?', old.id); // history isn't searched
    const { lastInsertRowid } = run(
      `INSERT INTO memories (scope_id, subject_user_id, author_user_id, kind, text, pinned, importance, event_at, recurs, supersedes_id, created_by, source_thread_id, source_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      old.scope_id, old.subject_user_id, user.id, old.kind, t, old.pinned, importance == null ? old.importance : clampImportance(importance),
      when.eventAt, when.recurs, old.id, createdBy || (['agent', 'extractor'].includes(actor) ? actor : 'user'), old.source_thread_id,
      sourceMessageId ?? old.source_message_id);
    event(Number(lastInsertRowid), 'supersede', actor, old.text, t);
    return getFact(Number(lastInsertRowid));
  });
  embedSoon();
  return fact;
}

// User edits (UI) change text in place; they are marked created_by=user so extraction never overwrites them.
export function editFact(user, id, text) {
  const f = factForUser(user, id, { write: true });
  const t = cleanFact(text);
  run(`UPDATE memories SET text = ?, created_by = 'user', updated_at = datetime('now') WHERE id = ?`, t, f.id);
  if (t !== f.text) { run('DELETE FROM memory_vec WHERE memory_id = ?', f.id); embedSoon(); }
  event(f.id, 'update', `user:${user.id}`, f.text, t);
  return getFact(f.id);
}

// Forget = hidden now (status 'forgotten'), hard-deleted ~1 minute later (fact, FTS row, vector) with a
// text-less tombstone. The grace period lets the UI's Undo genuinely restore it.
const PURGE_AFTER_MS = 60_000;
export function forgetFact(user, id, actor) {
  const f = factForUser(user, id, { write: true });
  run(`UPDATE memories SET status = 'forgotten', updated_at = datetime('now') WHERE id = ?`, f.id);
  event(f.id, 'forget', actor || `user:${user.id}`);
  setTimeout(purgeForgotten, PURGE_AFTER_MS + 1000).unref?.();
  return f;
}

export function restoreFact(user, id) {
  const f = getFact(Number(id));
  if (!f || f.status !== 'forgotten' || !readableScopes(user).some(s => s.id === f.scope_id)) throw notFound('Too late to undo — it has been forgotten.');
  run(`UPDATE memories SET status = 'active', updated_at = datetime('now') WHERE id = ?`, f.id);
  event(f.id, 'restore', `user:${user.id}`);
  return getFact(f.id);
}

// The row goes, and with it its FTS row (trigger) and its vector (memory_vec … ON DELETE CASCADE); events keep no text.
export function purgeForgotten() {
  return tx(() => {
    const rows = all(`SELECT id FROM memories WHERE status = 'forgotten' AND updated_at <= datetime('now', '-60 seconds')`);
    for (const r of rows) run('DELETE FROM memories WHERE id = ?', r.id);
    if (rows.length) run(`UPDATE memory_events SET old_text = NULL, new_text = NULL WHERE memory_id IN (${marks(rows)})`, ...rows.map(r => r.id));
    return rows.length;
  });
}

export function setPinned(user, id, pinned) {
  const f = factForUser(user, id, { write: true });
  if (pinned) assertCoreRoom(get('SELECT * FROM scopes WHERE id = ?', f.scope_id), f.text.length);
  run('UPDATE memories SET pinned = ? WHERE id = ?', pinned ? 1 : 0, f.id);
  event(f.id, pinned ? 'pin' : 'unpin', `user:${user.id}`);
}

function assertCoreRoom(sc, extra) {
  const used = get(`SELECT COALESCE(SUM(length(text)), 0) AS n FROM memories WHERE scope_id = ? AND status = 'active' AND pinned = 1`, sc.id).n;
  const cap = CORE_LIMITS[sc.kind] || CORE_LIMITS.group;
  if (used + extra > cap) throw invalid({ text: `Core memory for ${sc.name} is full (${cap} characters). Unpin or merge something first.` });
}

// ---- Reads --------------------------------------------------------------------------------------
export const getFact = id => get('SELECT * FROM memories WHERE id = ?', id) || null;

export function factForUser(user, id, { write = false } = {}) {
  const f = getFact(Number(id));
  const scopes = readableScopes(user);
  if (!f || !scopes.some(s => s.id === f.scope_id)) throw notFound('That memory no longer exists.');
  if (write && f.scope_id !== userScope(user).id && f.author_user_id !== user.id && user.role !== 'admin') {
    throw forbidden("Only the person who shared this (or the admin) can change it.");
  }
  return f;
}

// Core memory: pinned + profile facts across readable scopes (bounded by CORE_LIMITS), for the prompt.
export function coreMemory(user) {
  const out = [];
  for (const sc of readableScopes(user)) {
    let used = 0;
    const cap = CORE_LIMITS[sc.kind] || CORE_LIMITS.group;
    for (const f of all(`SELECT text, kind FROM memories WHERE scope_id = ? AND status = 'active' AND (pinned = 1 OR kind = 'profile')
                         ORDER BY pinned DESC, importance DESC, id DESC`, sc.id)) {
      if (used + f.text.length > cap) break;
      used += f.text.length;
      out.push({ scope: sc.kind === 'user' ? 'private' : sc.name, text: f.text });
    }
  }
  return out;
}

// ---- Recall (decisions #151, #153) ----------------------------------------------------------------
// score = RRF(word ranks, meaning ranks) × decay × (1 + 0.3·(importance − 1)) × (pinned 1.5) × (0.2 for a one-off event
// more than 14 days past). Decay halves with age by kind — event 30 days, schedule 90, fact and preference 365; profile,
// place, instruction and pinned facts never decay — and age counts from when it was last noted OR last used.
const HALF_LIFE_DAYS = { event: 30, schedule: 90, fact: 365, preference: 365 };
const sqlMs = s => (s ? Date.parse(`${String(s).replace(' ', 'T')}Z`) || 0 : 0);
export function salience(m, now = Date.now()) {
  const halfLife = m.pinned ? null : HALF_LIFE_DAYS[m.kind] ?? null;
  const ageDays = Math.max(0, now - Math.max(sqlMs(m.observed_at), sqlMs(m.last_used_at))) / 864e5;
  let f = halfLife ? 0.5 ** (ageDays / halfLife) : 1;
  f *= 1 + 0.3 * (clampImportance(m.importance) - 1);
  if (m.pinned) f *= 1.5;
  if (pastEvent(m, now)) f *= 0.2;
  return f;
}

function ranked(fused, limit, now) {
  const top = fused.slice(0, 80);
  if (!top.length) return [];
  const byId = new Map(all(`SELECT * FROM memories WHERE id IN (${marks(top)})`, ...top.map(f => f.id)).map(r => [r.id, r]));
  return top.flatMap(f => (byId.has(f.id) ? [{ ...byId.get(f.id), score: f.score * salience(byId.get(f.id), now) }] : []))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

// Use counts move once per message (decision #153): the prompt is rebuilt on every step of a run, so "once" is keyed.
const usedFor = new Set();
/** Mark memories as used (decay counts age from last_used_at). With `onceKey`, only the first call for that key counts. */
export function markUsed(ids, onceKey = null) {
  if (onceKey != null) {
    if (usedFor.has(onceKey)) return false;
    usedFor.add(onceKey);
    if (usedFor.size > 2000) usedFor.delete(usedFor.values().next().value);
  }
  for (const id of new Set(ids)) run(`UPDATE memories SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?`, id);
  return true;
}

/**
 * Words only (synchronous; the prompt's fallback when the per-message sense didn't answer): prefix terms over readable
 * scopes, ranked like recallHybrid. touch=false: just looking.
 */
export function recall(user, query, limit = 8, { touch = true, scopeIds = null, now = Date.now() } = {}) {
  const ids = scopeIds || readableScopes(user).map(s => s.id);
  const out = ranked(rrfMerge({ words: wordHits('memory', query, ids) }), limit, now);
  if (touch) markUsed(out.map(r => r.id));
  return out;
}

/**
 * Words + meaning (decision #151): BM25 top 40 with prefix terms and cosine top 40, merged by RRF, then salience. Finds
 * facts in another language or other words ("ماذا أطبخ" → "Allergic to peanuts"). `query` may be a list (each text is
 * its own pair of rankings, e.g. every new turn at extraction). The query embedding races `raceMs`, then words alone;
 * pass `qv` (a vector, a list of them, or null) when it is already known.
 */
export async function recallHybrid(user, query, limit = 8, { touch = false, scopeIds = null, raceMs = 900, qv, now = Date.now() } = {}) {
  const queries = (Array.isArray(query) ? query : [query]).map(q => String(q || '').trim()).filter(Boolean).slice(0, 12);
  if (!queries.length) return [];
  const ids = scopeIds || readableScopes(user).map(s => s.id);
  const lists = {};
  queries.forEach((q, i) => { lists[`words${i}`] = wordHits('memory', q, ids); });
  const vecs = qv !== undefined ? (Array.isArray(qv) ? qv : [qv]) : await queryVectors(queries, user.id, raceMs);
  (vecs || []).forEach((v, i) => { if (v) lists[`meaning${i}`] = meaningHits('memory', v, ids).map(h => h.id); });
  embedSoon(); // backfill anything still without a vector (older memories, a changed embedding model)
  const out = ranked(rrfMerge(lists), limit, now);
  if (touch) markUsed(out.map(r => r.id));
  return out;
}

/** One memory as a prompt / tool line: "[12] Maya (daughter)'s birthday (date: 14 Feb 2016, every year)". */
export const factLine = m => `[${m.id}] ${m.text}${m.event_at ? ` (date: ${dateText(m)})` : ''}`;

// ---- Dated memories soon (decision #154) ----------------------------------------------------------
/** Remembered dates from `back` days ago to `ahead` days on, in the person's timezone: [{ id, text, ymd, diff, age, … }]. */
export function datedItems(user, now = new Date(), { back = 0, ahead = 7 } = {}) {
  const tz = tzOf(user);
  const today = dayKey(now, tz);
  const year = Number(today.slice(0, 4));
  const ids = readableScopes(user).map(s => s.id);
  const out = [];
  for (const m of all(`SELECT * FROM memories WHERE status = 'active' AND event_at IS NOT NULL AND scope_id IN (${marks(ids)})`, ...ids)) {
    let dates = [m.event_at.slice(0, 10)];
    if (m.recurs === 'yearly') {
      const md = monthDay(m.event_at);
      dates = [year - 1, year, year + 1].map(y => `${y}-${md === '02-29' && !leap(y) ? '02-28' : md}`);
    } else if (m.event_at.length < 10) continue;
    const ymd = dates.find(d => { const n = dayDiff(today, d); return n >= -back && n <= ahead; });
    if (!ymd) continue;
    const bornYear = m.recurs === 'yearly' && m.event_at.length >= 10 ? Number(m.event_at.slice(0, 4)) : null;
    const age = bornYear && Number(ymd.slice(0, 4)) > bornYear ? Number(ymd.slice(0, 4)) - bornYear : null;
    out.push({ id: m.id, text: m.text, kind: m.kind, ymd, time: m.event_at.length > 10 ? m.event_at.slice(11, 16) : null,
      diff: dayDiff(today, ymd), age, recurs: m.recurs, scopeId: m.scope_id });
  }
  return out.sort((a, b) => a.diff - b.diff || (a.time || '').localeCompare(b.time || ''));
}

const relDay = n => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`);
/** "Sat 14 Feb (in 3 days): Maya (daughter)'s birthday [memory 12], turns 10" */
export const datedLine = d => `${dayName(d.ymd)}${d.time ? ` ${d.time}` : ''} (${relDay(d.diff)}): ${oneLine(d.text, 200)} [memory ${d.id}]`
  + `${d.age ? `, turns ${d.age}` : ''}${d.recurs ? ' (every year)' : ''}`;

/**
 * The prompt's "Dates soon" block: remembered dates in the next 7 days, plus one-off events of the last 3 days (so she can
 * ask how the dentist went). Memories are the person's own words or a group member's (cleaned on write); each is one line.
 */
export function datesBlock(user, now = new Date()) {
  const items = datedItems(user, now, { back: 3, ahead: 7 }).filter(d => d.diff >= 0 || !d.recurs);
  if (!items.length) return null;
  const soon = items.filter(d => d.diff >= 0), past = items.filter(d => d.diff < 0);
  return ['## Dates soon (from memory)', ...soon.map(d => `- ${datedLine(d)}`),
    ...(past.length ? ['Just passed (a kind follow-up may be welcome):', ...past.map(d => `- ${datedLine(d)}`)] : [])].join('\n');
}

// ---- Episodes (decision #155): one dated line per extraction pass ---------------------------------
/** Store one episode (≤ 280 characters) for the person's private scope. Same filters as a memory. Returns the row. */
export function addEpisode({ user, threadId = null, text, fromMsgId = null, toMsgId = null, refDate = null }) {
  let t = stripInvisible(text).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length > MAX_EPISODE) t = `${t.slice(0, MAX_EPISODE - 1).replace(/\s+\S*$/, '')}…`;
  t = cleanFact(t);
  const { lastInsertRowid } = run(`INSERT INTO episodes (scope_id, thread_id, ref_date, text, from_msg_id, to_msg_id) VALUES (?, ?, ?, ?, ?, ?)`,
    userScope(user).id, threadId, refDate, t, fromMsgId, toMsgId);
  embedSoon();
  return get('SELECT * FROM episodes WHERE id = ?', Number(lastInsertRowid));
}

const EPISODE_HALF_LIFE = 30;
function rankedEpisodes(fused, limit, now) {
  const top = fused.slice(0, 40);
  if (!top.length) return [];
  const byId = new Map(all(`SELECT * FROM episodes WHERE id IN (${marks(top)})`, ...top.map(f => f.id)).map(r => [r.id, r]));
  return top.flatMap(f => {
    const e = byId.get(f.id);
    return e ? [{ ...e, score: f.score * 0.5 ** (Math.max(0, now - sqlMs(e.observed_at)) / 864e5 / EPISODE_HALF_LIFE) }] : [];
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Episodes by words (synchronous). Private scope only: episodes are the person's own chats. */
export function recallEpisodes(user, query, limit = 3, { now = Date.now() } = {}) {
  return rankedEpisodes(rrfMerge({ words: wordHits('episode', query, [userScope(user).id]) }), limit, now);
}
/** Episodes by words + meaning (like recallHybrid). */
export async function recallEpisodesHybrid(user, query, limit = 3, { raceMs = 900, qv, now = Date.now() } = {}) {
  const ids = [userScope(user).id];
  const v = qv !== undefined ? qv : await queryVector(query, user.id, raceMs);
  return rankedEpisodes(rrfMerge({ words: wordHits('episode', query, ids), ...(v ? { meaning: meaningHits('episode', v, ids).map(h => h.id) } : {}) }), limit, now);
}
/** Newest episodes first (for the sense's candidates and a future screen). */
export const recentEpisodes = (user, n = 3) => all(`SELECT t.* FROM episodes t WHERE t.scope_id = ? AND ${KINDS.episode.live}
  ORDER BY t.id DESC LIMIT ?`, userScope(user).id, n);
export const listEpisodes = (user, { limit = 100 } = {}) => recentEpisodes(user, Math.min(200, limit))
  .map(e => ({ id: e.id, text: e.text, date: e.ref_date || e.observed_at.slice(0, 10), threadId: e.thread_id, observedAt: e.observed_at }));

/** "(chat on Tue 22 Sep) Planned the Lyon trip with Maya (daughter) …" */
export const episodeLine = e => `(chat on ${dayName(e.ref_date || e.observed_at.slice(0, 10))}) ${e.text}`;

/** The tail's memory block: the facts and earlier conversations the sense (or the words fallback) picked. */
export function memoriesBlock(memories = [], episodes = []) {
  if (!memories.length && !episodes.length) return null;
  return ['## Possibly relevant memories', ...memories.map(m => `- ${factLine(m)}`),
    ...(episodes.length ? ['Earlier conversations:', ...episodes.map(e => `- ${episodeLine(e)}`)] : [])].join('\n');
}

// ---- The weekly tidy (decision #189) ------------------------------------------------------------------------------------
// Once a week (agent/memory-tidy.js) the person's own memories are looked over: near-duplicates of the same kind (cosine ≥
// 0.85, from memory_vec; none when embeddings are off), one-off events more than 30 days past, and details (importance 1)
// nobody used in a year. The model sees only those groups and proposes merges and archives; each change is recorded here
// and can be undone one by one. Never touched: pinned memories, the person's own words (created_by user), shared scopes, and
// anything learned in a chat that is now off the record.
export const TIDY = { cosine: 0.85, eventDays: 30, unusedDays: 365, maxCluster: 6, maxClusters: 8, maxStale: 24, maxRows: 600 };

function tidyable(user) {
  return all(`SELECT m.* FROM memories m WHERE m.scope_id = ? AND m.status = 'active' AND m.pinned = 0 AND m.created_by != 'user'
      AND (m.source_thread_id IS NULL OR NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = m.source_thread_id AND t.no_memory = 1))
    ORDER BY m.id DESC LIMIT ?`, userScope(user).id, TIDY.maxRows);
}

/** → { clusters: [[memory…]], stale: [{ memory, reason }] } for one person (nothing is changed). */
export function tidyCandidates(user, now = Date.now()) {
  const rows = tidyable(user);
  const clusters = [];
  if (!embeddingsOff() && rows.length > 1) {
    const { model, dims } = embedModel();
    const vecs = new Map(all(`SELECT memory_id, vec FROM memory_vec WHERE model = ? AND dims = ? AND memory_id IN (${marks(rows)})`, model, dims,
      ...rows.map(r => r.id)).map(v => [v.memory_id, fromBlob(v.vec)]));
    const withVec = rows.filter(r => vecs.has(r.id));
    const parent = new Map(withVec.map(r => [r.id, r.id]));
    const root = id => { while (parent.get(id) !== id) id = parent.get(id); return id; };
    for (let i = 0; i < withVec.length; i++) {
      for (let j = i + 1; j < withVec.length; j++) {
        const a = withVec[i], b = withVec[j];
        // Same kind and the same date: two appointments on different days are two memories, however alike they read.
        if (a.kind !== b.kind || (a.event_at || null) !== (b.event_at || null)) continue;
        if (dot(vecs.get(a.id), vecs.get(b.id)) >= TIDY.cosine) parent.set(root(a.id), root(b.id));
      }
    }
    const groups = new Map();
    for (const r of withVec) { const k = root(r.id); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    clusters.push(...[...groups.values()].filter(g => g.length > 1).map(g => g.sort((a, b) => a.id - b.id).slice(0, TIDY.maxCluster))
      .slice(0, TIDY.maxClusters));
  }
  const inCluster = new Set(clusters.flat().map(m => m.id));
  const ageDays = s => (now - sqlMs(s)) / 864e5;
  const daysPast = ymd => { const [y, mo, d] = ymdParts(ymd); return (now - Date.UTC(y, mo - 1, d)) / 864e5; };
  const stale = [];
  for (const m of rows) {
    if (inCluster.has(m.id) || stale.length >= TIDY.maxStale) continue;
    const dated = m.event_at && !m.recurs && m.event_at.length >= 10;
    if (dated && daysPast(m.event_at.slice(0, 10)) > TIDY.eventDays) {
      stale.push({ memory: m, reason: `a one-off event more than ${TIDY.eventDays} days past` });
    } else if (m.kind === 'event' && !m.event_at && ageDays(m.observed_at) > TIDY.eventDays && ageDays(m.last_used_at || m.observed_at) > TIDY.eventDays) {
      stale.push({ memory: m, reason: `an event noted more than ${TIDY.eventDays} days ago, not used since` });
    } else if (clampImportance(m.importance) === 1 && ['fact', 'preference', 'schedule'].includes(m.kind)
      && ageDays(m.last_used_at || m.observed_at) > TIDY.unusedDays) {
      stale.push({ memory: m, reason: 'a detail nobody used in over a year' });
    }
  }
  return { clusters, stale };
}

export function startTidy(user) {
  return Number(run(`INSERT INTO memory_tidies (user_id, status) VALUES (?, 'nothing')`, user.id).lastInsertRowid);
}
export function finishTidy(id, { status, note = null }) {
  const n = get(`SELECT SUM(op = 'merge') AS merged, SUM(op = 'archive') AS archived FROM memory_tidy_changes WHERE tidy_id = ?`, id);
  run('UPDATE memory_tidies SET status = ?, merged = ?, archived = ?, note = ? WHERE id = ?', status, n.merged || 0, n.archived || 0,
    note ? String(note).slice(0, 300) : null, id);
  return get('SELECT * FROM memory_tidies WHERE id = ?', id);
}

// The memories a tidy may change: still active, the person's private scope, not pinned, not their own words.
function tidyFact(user, id) {
  const f = getFact(Number(id));
  if (!f || f.scope_id !== userScope(user).id || f.status !== 'active' || f.pinned || f.created_by === 'user') {
    throw invalid({ ids: `Memory ${id} can't be tidied (it changed, it's pinned, shared or in their own words).` });
  }
  return f;
}
const archiveRow = (id, actor) => {
  run(`UPDATE memories SET status = 'archived', valid_to = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'active'`, id);
  event(id, 'archive', actor);
};

/** Merge 2+ memories into one (the first is superseded by the merged text, the rest archived). → the change row. */
export function tidyMerge(user, tidyId, ids, text, why = null) {
  const uniq = [...new Set(ids.map(Number))];
  if (uniq.length < 2) throw invalid({ ids: 'A merge needs two or more memories.' });
  const facts = uniq.map(id => tidyFact(user, id));
  if (new Set(facts.map(f => f.kind)).size > 1 || new Set(facts.map(f => f.event_at || '')).size > 1) {
    throw invalid({ ids: 'Only memories of the same kind and date can be merged.' });
  }
  return tx(() => {
    const merged = supersedeFact(user, facts[0].id, text, 'tidy', { createdBy: 'agent', importance: Math.max(...facts.map(f => clampImportance(f.importance))) });
    for (const f of facts.slice(1)) archiveRow(f.id, 'tidy');
    const { lastInsertRowid } = run(`INSERT INTO memory_tidy_changes (tidy_id, op, memory_ids, new_memory_id, why) VALUES (?, 'merge', ?, ?, ?)`,
      tidyId, JSON.stringify(uniq), merged.id, why ? String(why).slice(0, 200) : null);
    return get('SELECT * FROM memory_tidy_changes WHERE id = ?', Number(lastInsertRowid));
  });
}

/** Archive one memory (no longer current; kept for history, out of recall and the prompt). → the change row. */
export function tidyArchive(user, tidyId, id, why = null) {
  const f = tidyFact(user, id);
  return tx(() => {
    archiveRow(f.id, 'tidy');
    const { lastInsertRowid } = run(`INSERT INTO memory_tidy_changes (tidy_id, op, memory_ids, why) VALUES (?, 'archive', ?, ?)`,
      tidyId, JSON.stringify([f.id]), why ? String(why).slice(0, 200) : null);
    return get('SELECT * FROM memory_tidy_changes WHERE id = ?', Number(lastInsertRowid));
  });
}

/**
 * Undo one change of a tidy: the memories it took out come back as they were; a merge's new memory goes (unless it has been
 * changed since: then it is theirs to edit on the Memory page).
 */
export function undoTidyChange(user, changeId) {
  const c = get(`SELECT c.*, t.user_id FROM memory_tidy_changes c JOIN memory_tidies t ON t.id = c.tidy_id WHERE c.id = ?`, Number(changeId));
  if (!c || c.user_id !== user.id) throw notFound('That change no longer exists.');
  if (c.undone_at) return { ok: true, already: true };
  const ids = JSON.parse(c.memory_ids);
  tx(() => {
    if (c.op === 'merge') {
      const merged = getFact(c.new_memory_id);
      if (merged && merged.status !== 'active') throw invalid({ change: 'The merged memory was changed since, so this can’t be undone. Edit it on the Memory page instead.' });
      // It existed only because of the tidy: the row goes (its FTS row by trigger, its vector by cascade), the event stays.
      if (merged) { event(merged.id, 'undo', `user:${user.id}`); run('DELETE FROM memories WHERE id = ?', merged.id); }
    }
    for (const id of ids) {
      const f = getFact(id);
      if (!f || !['archived', 'superseded'].includes(f.status)) continue;
      run(`UPDATE memories SET status = 'active', valid_to = NULL, updated_at = datetime('now') WHERE id = ?`, id);
      event(id, 'restore', `user:${user.id}`);
    }
    run(`UPDATE memory_tidy_changes SET undone_at = datetime('now') WHERE id = ?`, c.id);
  });
  embedSoon(); // the superseded original lost its vector
  return { ok: true };
}

/** The person's recent tidies with their changes (texts included), newest first: the Activity item's "see and undo". */
export function listTidies(user, { limit = 10, id = null } = {}) {
  const rows = id ? all('SELECT * FROM memory_tidies WHERE id = ? AND user_id = ?', Number(id), user.id)
    : all(`SELECT * FROM memory_tidies WHERE user_id = ? AND status = 'done' ORDER BY id DESC LIMIT ?`, user.id, Math.min(50, limit));
  return rows.map(t => ({
    id: t.id, at: t.at, status: t.status, merged: t.merged, archived: t.archived,
    changes: all('SELECT * FROM memory_tidy_changes WHERE tidy_id = ? ORDER BY id', t.id).map(c => {
      const before = JSON.parse(c.memory_ids).map(getFact).filter(Boolean).map(f => ({ id: f.id, text: f.text, dateLabel: dateText(f) }));
      const merged = c.new_memory_id ? getFact(c.new_memory_id) : null;
      return { id: c.id, op: c.op, why: c.why, undone: !!c.undone_at, before, after: merged ? { id: merged.id, text: merged.text } : null };
    }),
  }));
}

// "What I remember about you" (the /me page): everything readable, with scope + source.
export function listForUser(user) {
  const scopes = readableScopes(user);
  const byId = new Map(scopes.map(s => [s.id, s]));
  return all(`SELECT * FROM memories WHERE status = 'active' AND scope_id IN (${marks(scopes)}) ORDER BY pinned DESC, id DESC`,
    ...scopes.map(s => s.id))
    .map(m => ({
      id: m.id, text: m.text, kind: m.kind, pinned: !!m.pinned, createdAt: m.created_at,
      scope: byId.get(m.scope_id).kind === 'user' ? 'private' : 'shared', scopeName: byId.get(m.scope_id).name,
      sourceLabel: m.source_thread_id ? 'a chat' : null, sourceHref: m.source_thread_id ? `/chat/${m.source_thread_id}` : null,
      importance: m.importance, date: m.event_at || null, recurs: m.recurs || null, dateLabel: dateText(m),
      useCount: m.use_count, lastUsedAt: m.last_used_at,
    }));
}

export const __test = {
  /** Swap the embedder (tests: a fake that works offline); no argument restores the real one. */
  useEmbedder: fn => { embedder = fn || embed; },
  embedIdle: async () => { while (filling) await filling; },
};
