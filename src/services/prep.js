// Overnight prep (Phase 22, decision #199). Opt-in per person (users.prep: off | ideas): during their quiet hours, when nothing
// else is running for them and the week's budget isn't running low, Jess prepares ONE of their open Ideas (a research, plan,
// draft or comparison idea the decision model thinks they'll care about tomorrow) as a Library draft, and says "Ready for you"
// after their quiet hours end (a notification, and a note the morning check-in mentions).
//   - the run (origin `prep`) may only search, read pages, save one document and leave a note: runs.tool_allow, enforced by
//     the loop (offered and allowed); a call that would ask for an OK is refused (nobody is awake to approve), no ask_user;
//   - what it may spend is the night's cap (runs.spend_cap = the admin's daily cap per person, default $0.05), checked before
//     every model call; at the cap it stops without another call;
//   - an idea is tried once (ideas.prep_started_at), never one they dismissed, snoozed or started.
// Driven by the scheduler (agent/goals.js goalsTick → prepTick), from the database, so a restart loses nothing.
import { get, all, run as sql, settings } from '../db/index.js';
import { invalid } from '../lib/errors.js';
import { publish } from '../lib/bus.js';
import { inQuietHours, tzOf } from '../lib/when.js';
import { effectivePolicy, enabledToolsets, overBudget } from './policy.js';
import { spentThisWeek } from './usage.js';
import { getUser } from './users.js';
import * as runs from './runs.js';
import { createSideThread } from './threads.js';
import { addMessage } from './messages.js';
import { llmSettings } from './llm.js';
import { addNote } from './notes.js';
import { notify } from './notify.js';
import { logActivity } from './activity.js';
import { decide, noul, yes, note, threshold, logFallback } from './decide.js';
import { enqueueRun, onRunFinished, onRunRetried } from '../agent/loop.js';

export const PREP_VALUES = ['off', 'ideas'];
export const PREP_KINDS = ['research', 'plan', 'draft', 'comparison'];
// Web reads, one document, a note for the morning: nothing that sends, books, buys, schedules or remembers.
export const PREP_TOOLS = ['web_search', 'web_read', 'read_offloaded', 'library_create', 'leave_note'];
export const DEFAULT_DAILY_CAP = 0.05;
export const MAX_DAILY_CAP = 1;
const NIGHT_MS = 20 * 3600e3;   // one preparation per person per night
const LOW_BUDGET = 0.75;        // the week's budget is "low" from the first budget alert's level on (#178)
const CANDIDATES = 5;
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---- Settings -------------------------------------------------------------------------------------------------------
/** The admin's settings: { dailyCap } in USD, what one person's overnight prep may spend per night. */
export function prepSettings() {
  const s = settings.get('prep', {}) || {};
  const cap = Number(s.dailyCap);
  return { dailyCap: Number.isFinite(cap) && cap >= 0 ? Math.min(cap, MAX_DAILY_CAP) : DEFAULT_DAILY_CAP };
}

export function savePrepSettings({ dailyCap } = {}) {
  const cap = Number(dailyCap);
  if (dailyCap === '' || dailyCap == null || !Number.isFinite(cap) || cap < 0 || cap > MAX_DAILY_CAP) {
    throw invalid({ dailyCap: `Between $0 and $${MAX_DAILY_CAP.toFixed(2)} a night per person ($0 turns overnight prep off for everyone).` });
  }
  settings.set('prep', { dailyCap: Math.round(cap * 1000) / 1000 });
  return prepSettings();
}

export const prepOf = userId => get('SELECT prep FROM users WHERE id = ?', userId)?.prep || 'off';

/** The person's own switch: off (default) | ideas. */
export function setPrep(user, value) {
  if (!PREP_VALUES.includes(value)) throw invalid({ prep: 'Choose off or ideas.' });
  sql('UPDATE users SET prep = ? WHERE id = ?', value, user.id);
  return value;
}

// ---- Which idea -----------------------------------------------------------------------------------------------------
// Older ideas and starters have no kind: guessed from their words (English, French, Arabic), comparison first.
const KIND_WORDS = [
  ['comparison', /\b(?:compar\w*|vs\.?|versus|which\s+(?:is|one)\s+(?:better|best)|pros\s+and\s+cons|shortlist\w*|side[-\s]by[-\s]side)\b|مقارنة|comparatif/iu],
  ['draft', /\b(?:draft\w*|write|writing|letter|e-?mails?|messages?|speech|toast|cv|r[ée]sum[ée]|cover\s+letter|posts?|invitations?|templates?|rédiger|lettre|brouillon)\b|رسالة|مسودة/iu],
  ['plan', /\b(?:plan\w*|itinerar\w*|schedules?|routines?|regimen|checklists?|timelines?|roadmap|programm?e?s?|menus?|budget\w*|itinéraire)\b|خطة|برنامج/iu],
  ['research', /\b(?:research\w*|find|look\s+(?:into|up)|learn\s+about|options?|guides?|recommend\w*|best|how\s+to|what\s+are|ideas?\s+for|explore|recherch\w*|trouver)\b|بحث|ابحث/iu],
];
export const guessKind = text => KIND_WORDS.find(([, re]) => re.test(String(text || '')))?.[0] || 'other';
export const ideaKind = i => i.kind || guessKind(`${i.title} ${i.prompt}`);

/** Open ideas that could be prepared: not dismissed, snoozed or started, never tried before, of a kind prep can move forward. */
export function prepCandidates(user) {
  return all(`SELECT * FROM ideas WHERE user_id = ? AND state IN ('new', 'seen') AND prep_started_at IS NULL AND prepared_item_id IS NULL
    ORDER BY id DESC LIMIT 20`, user.id).filter(i => PREP_KINDS.includes(ideaKind(i))).slice(0, CANDIDATES);
}

/**
 * The idea worth preparing tonight (decision model, use `reflect`: "worth preparing now? will they care tomorrow?"), or null
 * when it is sure none is. Off or failing: the newest candidate (logged as a fallback).
 */
export async function pickIdea(user, cands) {
  if (!cands.length) return null;
  const recent = all(`SELECT m.role, m.content, m.created_at FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.user_id = ?
    AND t.deleted_at IS NULL AND t.no_memory = 0 AND m.role IN ('user', 'assistant') AND m.tool_calls IS NULL AND trim(m.content) != ''
    ORDER BY m.id DESC LIMIT 12`, user.id).reverse();
  const res = await decide('reflect', {
    user, timeoutMs: 4000,
    state: {
      ideas: Object.fromEntries(cands.map(i => [`i${i.id}`, `${clip(i.title, 100)} (${ideaKind(i)}): ${clip(i.why, 240)}`])),
      recent_chat: recent.map(m => `${m.created_at} ${m.role === 'user' ? 'Them' : 'Jess'}: ${clip(m.content, 300)}`).join('\n') || '(no recent chat)',
    },
    questions: Object.fromEntries(cands.map(i => [`i${i.id}`, noul(`Is idea \`ideas.i${i.id}\` worth preparing tonight, so a first draft is ready `
      + 'when they wake up: will they still care about it tomorrow (it fits what they talk about, and `recent_chat` does not show it done, '
      + 'dropped or already handled), and can research, a plan, a draft or a comparison move it forward without them?')])),
  });
  if (!res) {
    logFallback('reflect', { userId: user.id, outcome: `overnight prep: the newest idea “${clip(cands[0].title, 40)}” (by rule)` });
    return cands[0];
  }
  const top = cands.map(i => ({ i, p: yes(res.answers[`i${i.id}`]) })).filter(x => x.p != null).sort((a, b) => b.p - a.p)[0];
  if (!top) { note(res.id, 'overnight prep: no answer, the newest idea', { acted: false }); return cands[0]; }
  if (top.p <= 1 - threshold()) {
    note(res.id, `overnight prep: nothing worth preparing tonight (${top.p.toFixed(2)})`, { confidence: 1 - top.p });
    return null;
  }
  note(res.id, `overnight prep: “${clip(top.i.title, 40)}” (${top.p.toFixed(2)})`, { confidence: top.p });
  return top.i;
}

// ---- When -----------------------------------------------------------------------------------------------------------
const busy = userId => !!get(`SELECT 1 FROM runs WHERE user_id = ? AND status IN ('queued', 'running', 'waiting') LIMIT 1`, userId);
const sinceSql = (now, ms) => new Date(now.getTime() - ms).toISOString();
/** What overnight prep spent for this person in the last night's window. */
export const prepSpent = (userId, now = new Date()) => get(`SELECT COALESCE(SUM(u.cost), 0) AS c FROM usage_events u JOIN runs r ON r.id = u.run_id
  WHERE r.user_id = ? AND r.origin = 'prep' AND r.started_at >= datetime(?)`, userId, sinceSql(now, NIGHT_MS)).c;

/** Why not now (a short reason, for tests and logs), or null when this person's prep may start. assumeOn: as if their switch
 *  were on (the You screen says what would stop it before they turn it on). */
export function prepBlocker(user, now = new Date(), { assumeOn = false } = {}) {
  if (!user || user.status !== 'active') return 'inactive';
  if (!assumeOn && prepOf(user.id) !== 'ideas') return 'off';
  const { dailyCap } = prepSettings();
  if (!(dailyCap > 0)) return 'no cap';
  const policy = effectivePolicy(user);
  const toolsets = enabledToolsets(user);
  if (!toolsets.has('goals') || !toolsets.has('web')) return 'toolsets';
  // The draft is a write: with the Library on "ask" it would need an OK nobody is awake to give.
  if (policy.toolsets.library !== 'allow') return 'library';
  if (!inQuietHours(policy.quietStart, policy.quietEnd, tzOf(user), now)) return 'awake';
  if (overBudget(user)) return 'budget';
  const weekly = policy.weeklyBudget;
  if (weekly > 0) {
    const spent = spentThisWeek(user.id);
    if (spent >= weekly * LOW_BUDGET || weekly - spent < dailyCap) return 'budget low';
  }
  if (busy(user.id)) return 'busy';
  if (get(`SELECT 1 FROM runs WHERE user_id = ? AND origin = 'prep' AND started_at >= datetime(?) LIMIT 1`, user.id, sinceSql(now, NIGHT_MS))) return 'done tonight';
  return null;
}

// ---- The screens (Phase 25 #212) -------------------------------------------------------------------------------------
const usd = v => `$${Number(v || 0).toFixed(Number(v) > 0 && Number(v) < 0.01 ? 3 : 2)}`;
// What would keep their prep from ever running, in their words. The passing reasons (awake, busy, done tonight) aren't shown.
const STOPPED = {
  'no cap': 'Your admin has overnight prep switched off for everyone right now.',
  toolsets: 'It needs web search and goals, which aren’t switched on for you. Ask your admin.',
  library: 'Saving a draft to your Library needs your OK at the moment, and nobody is awake to give it. Ask your admin to allow the Library.',
  budget: 'Your weekly budget is used up, so I’ll wait until it resets.',
  'budget low': 'Your weekly budget is running low, so I’ll wait until it resets.',
};

/** You → Notifications: { value: off|ideas, capLabel, quiet: '22:00 to 07:00', stopped: why it can't run | null, last: { title,
 *  ideaTitle, href, at } | null (the latest draft it made) }. */
export function prepView(user, now = new Date()) {
  const p = effectivePolicy(user);
  const blocker = prepBlocker(user, now, { assumeOn: true });
  const last = get(`SELECT i.title AS idea, i.ready_at, i.prep_started_at, li.public_id, li.title FROM ideas i
    JOIN library_items li ON li.id = i.prepared_item_id AND li.deleted_at IS NULL WHERE i.user_id = ? ORDER BY i.prep_started_at DESC LIMIT 1`, user.id);
  return { value: prepOf(user.id), capLabel: usd(prepSettings().dailyCap), quiet: p.quietStart && p.quietEnd ? `${p.quietStart} to ${p.quietEnd}` : null,
    stopped: STOPPED[blocker] || null,
    last: last ? { title: last.title, ideaTitle: last.idea, href: `/library/${last.public_id}`, at: last.ready_at || last.prep_started_at } : null };
}

/** Admin → Usage: the nightly cap and what it did in the last 30 days: { dailyCap, capLabel, maxCap, people: [{ id, name }] (switched
 *  on), nights (preparations started), drafts (made a draft), spent, spentLabel }. */
export function prepAdminView() {
  const { dailyCap } = prepSettings();
  const since = "datetime('now', '-30 days')";
  const nights = get(`SELECT COUNT(*) AS n FROM runs WHERE origin = 'prep' AND started_at >= ${since}`).n;
  const drafts = get(`SELECT COUNT(*) AS n FROM ideas i JOIN runs r ON r.id = i.prep_run_id WHERE i.prepared_item_id IS NOT NULL AND r.started_at >= ${since}`).n;
  const spent = get(`SELECT COALESCE(SUM(u.cost), 0) AS c FROM usage_events u JOIN runs r ON r.id = u.run_id WHERE r.origin = 'prep' AND r.started_at >= ${since}`).c;
  return { dailyCap, capLabel: usd(dailyCap), maxCap: MAX_DAILY_CAP,
    people: all(`SELECT id, name FROM users WHERE status = 'active' AND prep = 'ideas' ORDER BY id`),
    nights, drafts, spent: Math.round(spent * 10000) / 10000, spentLabel: usd(spent) };
}

// ---- The run --------------------------------------------------------------------------------------------------------
export function prepPrompt(idea) {
  return `[Overnight preparation: their idea “${clip(idea.title, 100)}”. They switched on overnight prep; they are asleep and not watching, `
    + 'and nobody can answer a question or approve anything tonight.]\n'
    + `The idea (from their Ideas page; theirs to take up or not):\n- Idea: ${clip(idea.title, 100)}\n- Why it came up: ${clip(idea.why, 300)}\n`
    + `- What they would say to start it: ${clip(idea.prompt, 1500)}\n\n`
    + 'Prepare ONE first draft they can pick up in the morning: look things up with web_search and web_read (a few good sources, not '
    + 'everything), then save one focused document with library_create (type md, a clear title; the key points first, what you assumed, '
    + 'and the next steps for them; sources are added for you). You can only search, read pages, save that one document and leave_note: '
    + 'anything that would send, book, buy, schedule or remember something waits for them, so put it under next steps. The whole '
    + 'preparation has a small budget: be brief and don’t repeat searches. End with one line saying what you prepared.';
}

/** Start the night's preparation of this idea → the run. cap: what it may spend (the night's cap left). */
export function startPrep(user, idea, cap, now = new Date()) {
  const thread = createSideThread(user.id, `Prepared overnight: ${clip(idea.title, 60)}`);
  const trigger = addMessage({ threadId: thread.id, role: 'system', content: prepPrompt(idea) });
  const r = runs.createRun({ threadId: thread.id, userId: user.id, triggerMessageId: trigger.id, model: llmSettings().model,
    origin: 'prep', originLabel: clip(idea.title, 60), spendCap: Math.max(0, Math.round(cap * 10000) / 10000), toolAllow: PREP_TOOLS });
  sql('UPDATE ideas SET prep_run_id = ?, prep_started_at = ? WHERE id = ?', r.id, now.toISOString(), idea.id);
  enqueueRun(r.id);
  return r;
}

// The night's run finished: the document it saved (the newest, when it saved more than one) becomes the idea's draft, and a
// "Ready for you" note waits for the morning check-in. Nothing saved (stopped at the cap, failed): nothing is announced.
onRunFinished(async (r, status) => {
  if (r?.origin !== 'prep' || r.hidden || status !== 'done') return;
  const idea = get('SELECT * FROM ideas WHERE prep_run_id = ?', r.id);
  const item = idea && get('SELECT id, public_id, title FROM library_items WHERE run_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', r.id);
  if (!item) return;
  sql('UPDATE ideas SET prepared_item_id = ? WHERE id = ?', item.id, idea.id);
  const user = getUser(r.user_id);
  addNote({ user, kind: 'prep', ideaId: idea.id, runId: r.id, sourceLabel: 'Overnight prep', href: `/library/${item.public_id}`,
    text: `Ready for you: I prepared “${clip(item.title, 100)}” overnight, for your idea “${clip(idea.title, 100)}”.` });
  publish(user.id, 'ideas.updated', { prepared: 1 });
});
// Retried (by hand in the morning): the new run is the idea's.
onRunRetried((old, r) => { if (old.origin === 'prep') sql('UPDATE ideas SET prep_run_id = ? WHERE prep_run_id = ?', r.id, old.id); });

/** After quiet hours: "Ready for you" (a notification, once) for each draft made overnight whose idea is still open. */
export function deliverReady(now = new Date()) {
  const rows = all(`SELECT i.*, li.public_id AS item_pid, li.title AS item_title FROM ideas i
    JOIN library_items li ON li.id = i.prepared_item_id AND li.deleted_at IS NULL WHERE i.ready_at IS NULL AND i.state IN ('new', 'seen')`);
  let sent = 0;
  for (const i of rows) {
    const user = getUser(i.user_id);
    if (!user || user.status !== 'active') continue;
    const p = effectivePolicy(user);
    if (inQuietHours(p.quietStart, p.quietEnd, tzOf(user), now)) continue;
    notify(user.id, { kind: 'message', title: 'Ready for you', href: `/library/${i.item_pid}`, tag: `prep-ready-${i.id}`,
      body: `“${clip(i.item_title, 80)}”, prepared overnight for your idea “${clip(i.title, 60)}”.` });
    sql('UPDATE ideas SET ready_at = ? WHERE id = ?', now.toISOString(), i.id);
    logActivity(user.id, { kind: 'task', icon: 'moon', title: `Prepared “${clip(i.item_title, 60)}” overnight`, detail: `For your idea “${clip(i.title, 60)}”`,
      href: `/library/${i.item_pid}` });
    publish(user.id, 'ideas.updated', { ready: 1 });
    sent++;
  }
  return sent;
}

// ---- The tick -------------------------------------------------------------------------------------------------------
const skippedTonight = new Map(); // user id → when the decision model said no idea is worth it (asked again the next night)
let ticking = false;

/** One pass (the scheduler's goals tick): "Ready for you" after quiet hours, then at most one new preparation. Returns what it
 *  did: { ready, started: [{ userId, ideaId, runId }] }. */
export async function prepTick(now = new Date()) {
  if (ticking) return { ready: 0, started: [] };
  ticking = true;
  try {
    const ready = deliverReady(now);
    const started = [];
    for (const row of all(`SELECT id FROM users WHERE status = 'active' AND prep = 'ideas' ORDER BY id`)) {
      const user = getUser(row.id);
      if (now.getTime() - (skippedTonight.get(user.id) ?? -Infinity) < NIGHT_MS) continue;
      if (prepBlocker(user, now)) continue;
      const cap = prepSettings().dailyCap - prepSpent(user.id, now);
      if (cap < 0.001) continue;
      const cands = prepCandidates(user);
      if (!cands.length) continue;
      const idea = await pickIdea(user, cands);
      if (!idea) { skippedTonight.set(user.id, now.getTime()); continue; } // sure none is worth it: not asked again all night
      const r = startPrep(user, idea, cap, now);
      started.push({ userId: user.id, ideaId: idea.id, runId: r.id });
      break; // one start per tick: each run takes one of the few run slots
    }
    return { ready, started };
  } finally { ticking = false; }
}

export const __test = { resetNight: () => skippedTonight.clear() };
