// Lessons (docs/CONTEXT-AND-MEMORY.md "Lessons", decisions #186–#188): short rules for how to work, learned from what
// people said ("When …, do … (not …)"). Two scopes:
//   person    — one person's (a correction, a thumbs-down); active at once (a thumbs-down guess waits for their Keep), shown
//               only to them and removable by them. Never shown to anyone else, the admin included.
//   household — applies to everyone (a task that needed pushing before it delivered, or the owner's own); it waits for the
//               owner's OK in Admin and must carry no personal details.
// Lessons with a domain are notes for one site (shown when Jess opens it); the others ride in the cached system prompt.
import { getDomain } from 'tldts';
import { get, all, run, tx } from '../db/index.js';
import { invalid, notFound } from '../lib/errors.js';
import { stripInvisible, oneLine } from '../lib/untrusted.js';
import { looksLikeInjection } from '../agent/injection.js';
import { looksLikeSecret, SECRET_REFUSAL, textSimilarity } from './memory.js';
import { ftsAny } from '../lib/fts.js';
import { listUsers } from './users.js';
import { readWorkspaceFile, saveWorkspaceFile } from './workspace.js';
import { isOffRecord } from './threads.js';
import { enabledToolsets } from './policy.js';
import { noul, yes } from './decide.js';

export const MAX_RULE = 220;
export const MAX_WHY = 160;
export const CAPS = { person: 1000, household: 1200 };   // characters of each part of the prompt block (cached prefix)
const SAME_RULE = 0.6;         // this share of the same words (Jaccard), same scope and site = the same lesson learned again
export const RETIRE_DAYS = 90; // an active lesson unused this long is marked "retire?" (never deleted by itself)
export const PROMOTE = { hits: 3, runs: 2, days: 30 }; // the owner may move a lesson into AGENTS.md past this

const marks = xs => xs.map(() => '?').join(',');

// ---- Cleaning ---------------------------------------------------------------------------------------------------------
// The same filters as a memory (services/memory.js cleanFact): invisible characters out, nothing that reads as an
// instruction to an AI or carries a secret. A lesson IS an instruction to Jess, so the injection patterns catch the
// hostile kind only (ignore previous instructions, persona switches, "send … to …" addressed to assistants).
function cleanText(text, max, field, { required = true } = {}) {
  const t = stripInvisible(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) { if (required) throw invalid({ [field]: 'Say the lesson in one line.' }); return null; }
  if (t.length > max) throw invalid({ [field]: `Keep it under ${max} characters.` });
  if (looksLikeInjection(t)) throw invalid({ [field]: 'That reads like someone else’s instruction to an assistant, so it isn’t kept as a lesson.' });
  if (looksLikeSecret(t)) throw invalid({ [field]: SECRET_REFUSAL });
  return t;
}
export const cleanRule = text => cleanText(text, MAX_RULE, 'rule');
export const cleanWhy = text => cleanText(text, MAX_WHY, 'why', { required: false });

// Household lessons go into everyone's prompt: no one's contact details, account numbers or names. Plain code, stricter
// than it needs to be (a false alarm just means the owner writes it without the detail).
const PERSONAL = [
  [/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/u, 'an email address'],
  [/(?:\+|\b00)\d[\d\s().-]{6,}\d|\b\d[\d\s().-]{7,}\d\b/, 'a phone or account number'],
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,}/, 'an IBAN'],
  [/https?:\/\/\S*[?#]\S+/i, 'a link with personal parameters'],
];
export function personalDataIn(text) {
  const t = String(text || '');
  for (const [re, what] of PERSONAL) if (re.test(t)) return what;
  const words = new Set(t.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean));
  for (const u of listUsers()) {
    for (const n of [u.name, u.callMe].filter(Boolean).flatMap(x => String(x).toLowerCase().split(/[^\p{L}]+/u))) {
      if ([...n].length >= 3 && words.has(n)) return 'someone’s name';
    }
  }
  return null;
}

/** "https://www.Booking.com/x" · "booking.com" → "booking.com" (the registrable domain); null when it isn't a host. */
export function normaliseDomain(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  let host = v;
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(v) ? v : `http://${v}`).hostname; } catch { return null; }
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host)) return null;
  return getDomain(host) || host;
}

// ---- Views ------------------------------------------------------------------------------------------------------------
const sqlMs = s => (s ? Date.parse(`${String(s).replace(' ', 'T')}Z`) || 0 : 0);
export const retireSuggested = (l, now = Date.now()) => l.status === 'active'
  && now - Math.max(sqlMs(l.last_used_at), sqlMs(l.created_at)) > RETIRE_DAYS * 864e5;

/** The recurrence evidence: { hits, runs } in the last 30 days, and whether the owner may promote it into AGENTS.md. */
export function evidenceOf(lessonId, now = Date.now()) {
  const since = new Date(now - PROMOTE.days * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  const e = get(`SELECT COUNT(*) AS hits, COUNT(DISTINCT run_id) AS runs FROM lesson_hits WHERE lesson_id = ? AND at >= ?`, lessonId, since);
  return { hits: e.hits, runs: e.runs, promotable: e.hits >= PROMOTE.hits && e.runs >= PROMOTE.runs };
}

export function lessonView(l, now = Date.now()) {
  const ev = evidenceOf(l.id, now);
  return {
    id: l.id, scope: l.scope, rule: l.rule, why: l.why, domain: l.domain, source: l.source, status: l.status,
    uses: l.uses, lastUsedAt: l.last_used_at, recurrences: l.recurrences, createdAt: l.created_at, updatedAt: l.updated_at,
    reviewedAt: l.reviewed_at, retireSuggested: retireSuggested(l, now), recent: { hits: ev.hits, tasks: ev.runs }, promotable: ev.promotable,
    runId: l.run_id, sourceMessageId: l.source_message_id,
  };
}

export const getLesson = id => get('SELECT * FROM lessons WHERE id = ?', Number(id)) || null;

// ---- The thumbs-down's "Noted: …" chip (decision #187; the screen is Phase 25 #211) ------------------------------------
/** The chip under a reply: { text, rule, lessonId, keep } (keep: a guess waiting for their Keep). Contract of chat/noted-chip. */
export const notedChip = l => ({ text: `Noted: ${l.rule}`, rule: l.rule, lessonId: l.id, keep: l.status === 'proposed' });

/** The lesson a thumbs-down on this reply made, still in use or waiting for Keep → its chip, or null. */
export function notedFor(userId, messageId) {
  const l = messageId && get(`SELECT * FROM lessons WHERE source = 'thumbs_down' AND source_message_id = ? AND user_id = ? AND scope = 'person'
    AND status IN ('active', 'proposed') ORDER BY id DESC LIMIT 1`, messageId, userId);
  return l ? notedChip(l) : null;
}

// ---- Writes -----------------------------------------------------------------------------------------------------------
// The same lesson: same scope (a person's own, or the household's one list whoever's task taught it), same site, nearly the
// same words. Retired and promoted ones don't count: learning it again starts a new one.
function sameLesson({ scope, userId, domain, rule }) {
  const q = ftsAny(rule);
  if (!q) return null;
  const rows = all(`SELECT l.* FROM lessons_fts JOIN lessons l ON l.id = lessons_fts.rowid
      WHERE lessons_fts MATCH ? AND l.scope = ? AND (? = 'household' OR l.user_id = ?) AND l.domain IS ?
        AND l.status IN ('active', 'proposed', 'rejected') ORDER BY bm25(lessons_fts) LIMIT 10`, q, scope, scope, userId, domain);
  return rows.map(l => ({ l, s: textSimilarity(rule, l.rule) })).filter(x => x.s >= SAME_RULE).sort((a, b) => b.s - a.s)[0]?.l || null;
}

// How many of a message's words (as the prefix terms recall uses: "booking" → "bookin"*) a lesson contains. Two or more
// = the lesson is about what they're asking; one shared word is too often chance ("reply", "always").
const stemsOf = text => (ftsAny(text).match(/"([^"]+)"/g) || []).map(s => s.slice(1, -1));
const wordsOf = text => String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export const stemHits = (stems, text) => { const ws = wordsOf(text); return stems.filter(s => ws.some(w => w.startsWith(s))).length; };

/**
 * Save a lesson, or count it again when the same one exists (same scope, person and site, nearly the same words): its
 * recurrences go up and a hit is logged, which is how a repeated correction shows (#187). A person saying it again makes a
 * personal proposal active; household lessons stay proposed until the owner approves. A lesson the person or the owner
 * turned down is not proposed again by a guess (thumbs-down, pushed): { lesson, duplicate, rejected }.
 * Throws a field error (422) for text that can't be a lesson.
 */
export function addLesson({ scope = 'person', user = null, rule, why = null, domain = null, source, sourceMessageId = null, runId = null, status = null }) {
  if (!['person', 'household'].includes(scope)) throw invalid({ scope: 'A lesson is for one person or the household.' });
  if (!['said', 'thumbs_down', 'pushed', 'owner'].includes(source)) throw invalid({ source: 'Unknown source.' });
  if (scope === 'person' && !user) throw invalid({ user: 'Whose lesson is it?' });
  const r = cleanRule(rule);
  const w = cleanWhy(why);
  const d = domain ? normaliseDomain(domain) : null;
  if (scope === 'household') {
    const personal = personalDataIn(`${r} ${w || ''}`);
    if (personal) throw invalid({ rule: `A household lesson goes to everyone, so it can’t contain ${personal}.` });
  }
  const want = status || (scope === 'household' && source !== 'owner' ? 'proposed' : 'active');
  return tx(() => {
    const same = sameLesson({ scope, userId: user?.id ?? null, domain: d, rule: r });
    if (same?.status === 'rejected' && ['thumbs_down', 'pushed'].includes(source)) return { lesson: same, duplicate: true, rejected: true };
    if (same) {
      const activate = same.status !== 'active' && want === 'active' && (scope === 'person' || source === 'owner');
      run(`UPDATE lessons SET recurrences = recurrences + 1, status = ?, updated_at = datetime('now') WHERE id = ?`,
        activate ? 'active' : same.status, same.id);
      run('INSERT INTO lesson_hits (lesson_id, run_id, source) VALUES (?, ?, ?)', same.id, runId, source);
      return { lesson: getLesson(same.id), duplicate: true, rejected: false };
    }
    const { lastInsertRowid } = run(`INSERT INTO lessons (scope, user_id, domain, rule, why, source, source_message_id, run_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, scope, user?.id ?? null, d, r, w, source, sourceMessageId, runId, want);
    const id = Number(lastInsertRowid);
    run('INSERT INTO lesson_hits (lesson_id, run_id, source) VALUES (?, ?, ?)', id, runId, source);
    return { lesson: getLesson(id), duplicate: false, rejected: false };
  });
}

function update(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return getLesson(id);
  run(`UPDATE lessons SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map(k => fields[k]), id);
  return getLesson(id);
}

// ---- The person's own (You → Memory, /api/v1/me/lessons) ---------------------------------------------------------------
function ownLesson(user, id) {
  const l = getLesson(id);
  if (!l || l.scope !== 'person' || l.user_id !== user.id) throw notFound('That lesson no longer exists.');
  return l;
}
/** Their lessons: active and proposed first (newest first), then retired. Rejected ones are kept only to not guess them again. */
export const listPersonLessons = user => all(`SELECT * FROM lessons WHERE scope = 'person' AND user_id = ? AND status IN ('active', 'proposed', 'retired')
  ORDER BY status = 'retired', status = 'active', id DESC`, user.id).map(l => lessonView(l));

const PERSON_SOURCE = { said: 'You told me', thumbs_down: 'From a thumbs-down', pushed: 'From a task I had to redo', owner: 'Added by an admin' };
/** You → Memory, "How I work with you" (partials/me/lessons.hbs, Phase 25 #204): their lessons and where each came from. */
export const personLessonsView = user => listPersonLessons(user).map(l => ({ ...l, sourceLabel: PERSON_SOURCE[l.source] || null }));

/** Edit wording, keep a proposed one (status 'active'), or retire one. */
export function editPersonLesson(user, id, { rule, why, status } = {}) {
  const l = ownLesson(user, id);
  const fields = {};
  if (rule !== undefined) fields.rule = cleanRule(rule);
  if (why !== undefined) fields.why = cleanWhy(why);
  if (status !== undefined) {
    if (!['active', 'retired'].includes(status)) throw invalid({ status: 'A lesson can be active or retired.' });
    fields.status = status;
  }
  return lessonView(update(l.id, fields));
}
/** Removing is final (their words leave the database); "No" on a thumbs-down guess marks it rejected so it isn't guessed again. */
export function deletePersonLesson(user, id, { reject = false } = {}) {
  const l = ownLesson(user, id);
  if (reject && l.status === 'proposed') update(l.id, { status: 'rejected' });
  else run('DELETE FROM lessons WHERE id = ?', l.id);
  return { ok: true };
}

// ---- The owner's review (Admin → Lessons, household only) --------------------------------------------------------------
export function listHouseholdLessons({ status = null } = {}) {
  const want = status && status !== 'all' ? [status] : ['proposed', 'active', 'retired', 'promoted', 'rejected'];
  return all(`SELECT l.*, u.name AS from_name FROM lessons l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.scope = 'household' AND l.status IN (${marks(want)})
    ORDER BY l.status != 'proposed', l.status != 'active', l.id DESC`, ...want)
    .map(l => ({ ...lessonView(l), fromName: l.from_name || null }));
}
function householdLesson(id) {
  const l = getLesson(id);
  if (!l || l.scope !== 'household') throw notFound('That lesson no longer exists.');
  return l;
}
function edits({ rule, why, domain } = {}) {
  const f = {};
  if (rule !== undefined) f.rule = cleanRule(rule);
  if (why !== undefined) f.why = cleanWhy(why);
  if (domain !== undefined) f.domain = domain ? normaliseDomain(domain) : null;
  if (domain && !f.domain) throw invalid({ domain: 'Give a site like booking.com, or leave it empty.' });
  const personal = personalDataIn(`${f.rule || ''} ${f.why || ''}`);
  if (personal) throw invalid({ rule: `A household lesson goes to everyone, so it can’t contain ${personal}.` });
  return f;
}
export const editHouseholdLesson = (admin, id, input) => lessonView(update(householdLesson(id).id, edits(input)));
const review = (admin, id, status, input = {}) => {
  const l = householdLesson(id);
  return lessonView(update(l.id, { ...edits(input), status, reviewed_by: admin.id, reviewed_at: new Date().toISOString().replace('T', ' ').slice(0, 19) }));
};
export const approveLesson = (admin, id, input) => review(admin, id, 'active', input);
export const rejectLesson = (admin, id) => review(admin, id, 'rejected');
export const retireLesson = (admin, id) => review(admin, id, 'retired');
export const createOwnerLesson = (admin, { rule, why, domain } = {}) => {
  const out = addLesson({ scope: 'household', user: null, rule, why, domain, source: 'owner', status: 'active' });
  return lessonView(update(out.lesson.id, { reviewed_by: admin.id, reviewed_at: new Date().toISOString().replace('T', ' ').slice(0, 19) }));
};

export const PROMOTED_HEADING = '## Lessons learned';
/**
 * Move a household lesson that keeps coming back into AGENTS.md (versioned: Admin → Personality → History can restore it),
 * under "## Lessons learned", and mark it promoted so it isn't in the prompt twice. Only past the evidence bar (#186).
 */
export function promoteLesson(admin, id, now = Date.now()) {
  const l = householdLesson(id);
  if (!['active', 'proposed'].includes(l.status)) throw invalid({ status: 'Only an active or proposed lesson can be promoted.' });
  const ev = evidenceOf(l.id, now);
  if (!ev.promotable) {
    throw invalid({ status: `It has come up ${ev.hits} time${ev.hits === 1 ? '' : 's'} in ${ev.runs} task${ev.runs === 1 ? '' : 's'} in the last `
      + `${PROMOTE.days} days; promote it once it has come up ${PROMOTE.hits} times in ${PROMOTE.runs} different tasks.` });
  }
  const line = `- ${l.domain ? `On ${l.domain}: ` : ''}${l.rule}`;
  const text = readWorkspaceFile('AGENTS.md').replace(/\s+$/, '');
  const at = text.indexOf(PROMOTED_HEADING);
  let next;
  if (at < 0) next = `${text}\n\n${PROMOTED_HEADING}\n${line}\n`;
  else {
    const after = text.indexOf('\n## ', at + PROMOTED_HEADING.length); // the section ends at the next heading
    next = after < 0 ? `${text}\n${line}\n` : `${text.slice(0, after).replace(/\s+$/, '')}\n${line}\n${text.slice(after)}\n`;
  }
  saveWorkspaceFile('AGENTS.md', next, { authorId: admin.id, note: `lesson ${l.id} promoted` });
  return lessonView(update(l.id, { status: 'promoted', reviewed_by: admin.id, reviewed_at: new Date(now).toISOString().replace('T', ' ').slice(0, 19) }));
}

// ---- Use: the prompt (#188) ---------------------------------------------------------------------------------------------
// Active lessons without a site, most used first. Deterministic for the same rows, so the system prompt (cached prefix)
// only changes when a lesson is added, edited or reviewed, or when uses reorder them (every lesson in the block is counted
// once per message, so their order among themselves holds).
function blockLessons(user) {
  const pick = (rows, cap) => {
    const out = [];
    let used = 0;
    for (const l of rows) {
      if (used + l.rule.length > cap) break;
      used += l.rule.length;
      out.push(l);
    }
    return out;
  };
  const person = all(`SELECT * FROM lessons WHERE scope = 'person' AND user_id = ? AND status = 'active' AND domain IS NULL
    ORDER BY uses DESC, id`, user.id);
  const household = all(`SELECT * FROM lessons WHERE scope = 'household' AND status = 'active' AND domain IS NULL ORDER BY uses DESC, id`);
  return { person: pick(person, CAPS.person), household: pick(household, CAPS.household), total: person.length + household.length };
}

/** The system block, placed right after AGENTS.md: "## Lessons learned", theirs then the household's. null when none. */
export function lessonsBlock(user) {
  const { person, household } = blockLessons(user);
  if (!person.length && !household.length) return null;
  return ['## Lessons learned (follow these)',
    ...(person.length ? [`From ${user.callMe || user.name}’s corrections:`, ...person.map(l => `- ${l.rule}`)] : []),
    ...(household.length ? ['For everyone here (approved by the owner):', ...household.map(l => `- ${l.rule}`)] : []),
  ].join('\n');
}

// Uses move once per message (like memories, #153): the prompt is rebuilt on every step of a run, so "once" is keyed.
const usedFor = new Set();
export function markLessonsUsed(ids, onceKey = null) {
  if (onceKey != null) {
    if (usedFor.has(onceKey)) return false;
    usedFor.add(onceKey);
    if (usedFor.size > 2000) usedFor.delete(usedFor.values().next().value);
  }
  for (const id of new Set(ids)) run(`UPDATE lessons SET uses = uses + 1, last_used_at = datetime('now') WHERE id = ?`, id);
  return true;
}

/**
 * "Notes from past visits to booking.com: …" for browser_open / web_read results: ≤ 3 active lessons for that site (the
 * person's own and the household's), or null. Counted as used once per run and site.
 */
export function domainNotes(user, host, { runId = null } = {}) {
  const d = normaliseDomain(host);
  if (!d || !user) return null;
  const rows = all(`SELECT * FROM lessons WHERE domain = ? AND status = 'active' AND (scope = 'household' OR (scope = 'person' AND user_id = ?))
    ORDER BY scope = 'household', uses DESC, id LIMIT 3`, d, user.id);
  if (!rows.length) return null;
  markLessonsUsed(rows.map(l => l.id), runId ? `site:${runId}:${d}` : null);
  return [`Notes from past visits to ${d} (lessons learned; follow them unless the page shows they no longer apply):`, ...rows.map(l => `- ${l.rule}`)].join('\n');
}

// ---- Corrections (#187) ------------------------------------------------------------------------------------------------
// The per-message sense (agent/sense.js) asks the decision model this with its other questions; without an answer, the
// words below decide.
export const CORRECTION_QUESTION = noul('Is `message` correcting how the assistant did something in its previous reply (a wrong format, units, '
  + 'tone, assumption or way of working: "no, I meant…", "don’t do X", "I told you…", "stop…", "that’s wrong")? A new request, a follow-up '
  + 'question or adding a detail does not count.');
/** The sense's answer → true / false (null when the question wasn't asked). */
export const correctionOf = (answers, thr = 0.6) => {
  const p = yes(answers?.correction);
  return p == null ? null : p >= Math.max(thr, 0.6);
};
const CORRECTION_WORDS = [
  /^\s*(?:no|nope|nah|wrong)\b[\s,.!:;-]/i,
  /\b(?:that'?s|that is|this is) (?:not (?:what|how|right)|wrong|incorrect)\b/i,
  /\b(?:i (?:said|told you|asked for|meant|already said)|not what i (?:asked|meant|wanted)|you (?:forgot|missed|ignored|keep|always|never|didn'?t listen))\b/i,
  /\b(?:stop|quit) (?:doing|using|giving|saying|adding|sending)\b/i,
  /\b(?:don'?t|do not|never) (?:ever )?(?:do|use|give|say|add|send|write|call|put|make)\b.*\b(?:again|anymore|any more|like that)\b/i,
  /\b(?:please )?(?:always|from now on|next time)\b.*\b(?:use|give|write|put|check|ask|do|send|reply|answer|say)\b/i,
  /^\s*(?:non|pas (?:ça|comme ça)|je t'?ai dit)\b|\bce n'?est pas ce que\b/i,             // French
  /^\s*(?:no,|te dije)\b|\beso no es lo que\b/i,                                           // Spanish
  /^\s*(?:nein|falsch)\b|\bich (?:hab|habe) (?:doch )?gesagt\b/i,                          // German
  /^\s*(?:لا[،,\s]|خطأ)|قلت لك|ليس هذا ما/u,                                                // Arabic
];
// "No worries", "no thanks": politeness, not a correction.
const NOT_CORRECTION = /^\s*no\s+(?:worries|problem|probs|thanks|thank you|need|rush|pressure|stress|biggie|way!|kidding)\b/i;
/** Does this message read like a correction? (the fallback when the decision model didn't answer). */
export const looksLikeCorrection = text => {
  const t = String(text || '').replace(/[’‘`´]/g, "'");
  return !NOT_CORRECTION.test(t) && CORRECTION_WORDS.some(re => re.test(t));
};

export const CORRECTION_NUDGE = '## They just corrected you\nTheir last message corrects how you did something. Fix it now. If it is a lasting '
  + 'preference about how you work (not a one-off slip), save it with learn_rule ("When …, do … (not …)", with their exact words as the quote) '
  + 'and say so in one short line: they can see and remove it under You → Memory. If you can’t tell whether it is lasting, ask in one line '
  + 'whether to remember it.';
const repeatNudge = l => `## They just corrected you, again\nThis repeats lesson ${l.id}: “${oneLine(l.rule, MAX_RULE)}”. Say sorry in a few `
  + 'words, follow it from now on, and call learn_rule again with their words as the quote so it counts as a repeat.';

/**
 * The prompt tail's lessons part (after the memories): a nudge when their message corrects her (the decision model's
 * `correction` answer from the per-message sense, else the words above), and up to 3 lessons outside the system block whose
 * words match their message (the block is capped). Counts the lessons in play as used once per message.
 * Only for the run their message started; nothing in an off-the-record chat or without the memory toolset.
 */
export function lessonsTail({ user, thread, message, run: r = null, sense = null }) {
  const text = String(message?.content || '').trim();
  if (!user || !message?.id || !text || r?.trigger_message_id !== message.id) return null;
  if (thread && (thread.no_memory || isOffRecord(thread.id))) return null;
  if (!enabledToolsets(user).has('memory')) return null;
  const { person, household } = blockLessons(user);
  const inBlock = new Set([...person, ...household].map(l => l.id));
  const q = ftsAny(text);
  const stems = stemsOf(text);
  const lower = text.toLowerCase();
  // A lesson about a site comes up when they name the site; any other when it shares two or more of their words.
  const matches = q ? all(`SELECT l.* FROM lessons_fts JOIN lessons l ON l.id = lessons_fts.rowid WHERE lessons_fts MATCH ? AND l.status = 'active'
      AND (l.scope = 'household' OR (l.scope = 'person' AND l.user_id = ?)) ORDER BY bm25(lessons_fts) LIMIT 12`, q, user.id)
    .filter(l => (l.domain ? lower.includes(l.domain) : stemHits(stems, l.rule) >= 2)) : [];
  const extra = matches.filter(l => !inBlock.has(l.id)).slice(0, 3);
  markLessonsUsed([...inBlock, ...extra.map(l => l.id)], `msg:${message.id}`);
  // The nudge lasts until she acted on it in this run: the tail is rebuilt on every step, and a nudge still there after
  // learn_rule (or remember) ran kept her calling it again (seen live: 50 steps of "Learned: …"). A lesson learned in this
  // run is not a "repeat" of itself either.
  const acted = !!get(`SELECT 1 FROM messages WHERE run_id = ? AND role = 'tool' AND tool_name IN ('learn_rule', 'remember') LIMIT 1`, r.id);
  const corrected = !acted && (typeof sense?.correction === 'boolean' ? sense.correction : looksLikeCorrection(text));
  const repeat = corrected ? matches.find(l => l.scope === 'person' && !get('SELECT 1 FROM lesson_hits WHERE lesson_id = ? AND run_id = ?', l.id, r.id)) : null;
  const parts = [];
  if (corrected) parts.push(repeat ? repeatNudge(repeat) : CORRECTION_NUDGE);
  if (extra.length) parts.push(['## Lessons that may apply here', ...extra.map(l => `- ${l.domain ? `(${l.domain}) ` : ''}${l.rule}`)].join('\n'));
  return parts.length ? parts.join('\n\n') : null;
}

export const __test = { usedFor, blockLessons };
