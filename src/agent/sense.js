// Quick judgments before spending a full reply (Phase 16, docs/JEV.md, decision #107). Each asks the decision model
// (services/decide.js) a narrow question and returns what to do — or null/true when unsure or unavailable, so the
// caller does exactly what it did before. They only ever skip work Jev is confident isn't needed.
import { get, all, run as sql } from '../db/index.js';
import { decide, enabled, noul, choice, yes, picked, note, threshold, logFallback } from '../services/decide.js';
import { readableScopes, recallHybrid, recallEpisodesHybrid, recentEpisodes, queryVector, markUsed, datedItems, datedLine,
  episodeLine } from '../services/memory.js';
import { upcomingBlock, timeBlock } from './prompt.js';
import { goalsBlock } from '../services/goals.js';
import { FAMILIES, PROMISE_TOOLS, unmetAsk } from './reply-audit.js';
import { skillsFor } from '../services/skills.js';
import { routeRanking, words } from '../services/skill-lint.js';
import { enabledToolsets } from '../services/policy.js';
import { CORRECTION_QUESTION, correctionOf } from '../services/lessons.js';
import { botName } from '../services/bot.js';

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const pct = p => (p == null ? '?' : p.toFixed(2));

// ---- Check-ins ------------------------------------------------------------------------------------------------------
/** false = Jev is confident there's nothing worth saying (skip the check-in); true = go ahead (or unsure/unavailable).
 *  notes: what unattended work left for them (#200): an important one always goes ahead; the others are part of the state. */
export async function worthCheckin(user, thread, now = new Date(), { notes = [] } = {}) {
  if (notes.some(n => n.priority === 'high')) return true;
  const recent = all(`SELECT role, content, created_at FROM messages WHERE thread_id = ? AND role IN ('user', 'assistant') AND tool_calls IS NULL
    AND trim(content) != '' ORDER BY id DESC LIMIT 10`, thread.id).reverse();
  const res = await decide('checkin', {
    user, timeoutMs: 4000,
    state: {
      right_now: timeBlock(user, null, now),
      coming_up: upcomingBlock(user, now) || 'Nothing until the end of tomorrow.',
      goals: goalsBlock(user) || 'No active goals.',
      // Remembered dates (decision #154): what's coming in the next week, and one-off events of the last three days.
      remembered_dates: datedItems(user, now, { back: 3, ahead: 7 }).filter(d => d.diff >= 0 || !d.recurs).map(d => `- ${datedLine(d)}`).join('\n')
        || 'None.',
      recent_chat: recent.map(m => `${m.created_at} ${m.role === 'user' ? 'Them' : botName()}: ${clip(m.content, 300)}`).join('\n') || '(no recent chat)',
      notes_for_them: notes.map(n => `- ${n.source_label ? `${n.source_label}: ` : ''}${clip(n.text, 200)}`).join('\n') || 'None.',
    },
    questions: {
      worth: noul('Is there something genuinely useful and timely to tell them right now, unprompted: a note in `notes_for_them` that their '
        + 'own background work left for them, a heads-up about something in '
        + '`coming_up` or `remembered_dates` soon (a birthday to prepare for), a kind follow-up on a remembered event that just passed '
        + '("how did the dentist go?"), a conflict or risk, a follow-up they would welcome on something in `recent_chat`, or a helpful '
        + 'next step on a goal? Small talk, repeating what they already know, or something that can wait does not count.'),
    },
  });
  if (!res) return true;
  const p = yes(res.answers.worth);
  const skip = p != null && p <= 1 - threshold();
  note(res.id, skip ? `skipped — nothing worth saying (${pct(p)})` : `went ahead — maybe worth it (${pct(p)})`, { confidence: p == null ? null : 1 - p });
  return !skip;
}

// ---- Ideas (reflection) and goal check-ins -------------------------------------------------------------------------
/** false = nothing new in their recent messages that ideas could help with. */
export async function worthReflecting(user, sinceMsgId) {
  const msgs = all(`SELECT m.content FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.user_id = ? AND t.deleted_at IS NULL
    AND t.no_memory = 0 AND m.id > COALESCE(t.no_memory_upto, 0) -- off the record (#123)
    AND m.role = 'user' AND m.id > ? ORDER BY m.id DESC LIMIT 40`, user.id, sinceMsgId).reverse();
  if (!msgs.length) return false;
  const ideas = all(`SELECT title FROM ideas WHERE user_id = ? ORDER BY id DESC LIMIT 30`, user.id).map(i => i.title);
  const goals = all(`SELECT title FROM goals WHERE user_id = ? AND state IN ('active', 'suggested')`, user.id).map(g => g.title);
  const res = await decide('reflect', {
    user,
    state: { their_messages: msgs.map(m => `- ${clip(m.content, 300)}`).join('\n').slice(0, 9000),
      already_suggested: ideas.join('; ') || '(none)', goals: goals.join('; ') || '(none)' },
    questions: { worth: noul('Do `their_messages` reveal a need, recurring chore, problem or ambition that a personal assistant could '
      + 'proactively help with, and that is not already covered by `already_suggested` or `goals`?') },
  });
  if (!res) return true;
  const p = yes(res.answers.worth);
  const skip = p != null && p <= 1 - threshold();
  note(res.id, skip ? `no ideas pass — nothing new (${pct(p)})` : `thinking of ideas (${pct(p)})`, { confidence: p == null ? null : 1 - p });
  return !skip;
}

/** false = nothing happened that a goal check-in would add to. */
export async function worthReviewing(user, g, events, tasks) {
  const since = g.last_review_at || g.created_at;
  const ms = v => new Date(/[TZ]/.test(v) ? v : `${String(v).replace(' ', 'T')}Z`).getTime(); // SQL times and ISO times
  const fresh = events.filter(e => ms(e.at) > ms(since));
  const res = await decide('reflect', {
    user,
    state: { today: new Date().toISOString().slice(0, 10), goal: g.title, progress: `${g.progress}%`, status: g.status_line || '(none)',
      last_check_in: since, activity_since: fresh.map(e => `- ${e.at} ${e.title}${e.detail ? ` — ${clip(e.detail, 160)}` : ''}`).join('\n') || '(nothing)',
      plan: tasks.map(t => `- [${t.status}] ${t.title}${t.kind === 'recurring' ? ` (${t.repeat}${t.at ? ` at ${t.at}` : ''})` : ''}`).join('\n') || '(none)' },
    questions: { worth: noul('Would a fresh check-in on this goal be useful now: new `activity_since` the last check-in, a step '
      + 'finished or failed, a date or deadline in `plan` coming up soon, or progress stalled long enough to flag?') },
  });
  if (!res) return true;
  const p = yes(res.answers.worth);
  const skip = p != null && p <= 1 - threshold();
  note(res.id, skip ? `goal “${clip(g.title, 40)}”: no check-in needed (${pct(p)})` : `goal “${clip(g.title, 40)}”: checking in (${pct(p)})`,
    { confidence: p == null ? null : 1 - p });
  return !skip;
}

// ---- See it through (decision #113) and the checks before a reply counts (#176, #177) ----------------------------------
// Owner: "this jessbot really gives up too fast … giving up is not an option". Before a reply counts as done, one call to
// the decision model asks, as needed: did it deliver what they asked for (and meet every explicit requirement)? did it
// claim something no step did, deny a tool it has, or promise a follow-up nothing will do (the reply audit, found first in
// code by agent/reply-audit.js)? are the figures code couldn't match in what the task read really there? did they ask for
// something no tool can do (the wish log)? The loop turns what's left into ONE push with a specific nudge.
const FAMILY_CHOICES = { email: 'an email was sent', calendar: 'a calendar event was added or changed', schedule: 'a reminder, alarm or scheduled task was set',
  memory: 'something was saved to memory', lists: 'a list was changed', library: 'a document or file was saved', booking: 'something was booked, ordered or paid',
  goals: 'a goal was changed', none: 'nothing: it only answers, offers, plans, describes or reports what it found' };
const DENY_CHOICES = { web: 'browsing or searching the web', email: 'reading or sending email', calendar: 'the calendar', schedule: 'reminders or scheduled tasks',
  memory: 'remembering things', none: 'none: it says nothing like that' };
const ABILITY = { web: 'search the web and read pages', email: 'read and send email', calendar: 'read and change the calendar', schedule: 'set reminders, alarms and scheduled tasks',
  memory: 'remember and recall facts', library: 'write documents and pages', files: 'read files', office: 'make spreadsheets, documents, slides and PDFs',
  goals: 'track goals', projects: 'keep projects', lists: 'keep shared lists', images: 'make pictures', core: 'ask questions and search past chats' };
const quote = s => `“${clip(s, 160)}”`;
const HEADS = { audit: 'Check what you said before it counts', figures: 'Double-check the numbers',
  goal: 'Not done yet — your last reply did not deliver what they asked for', constraints: 'Check every requirement' };
// Each line of a nudge starts with its tag: the loop reads them back to know which checks already pushed in this run (they
// survive a pause for an OK, when the loop starts over).
const UNMET_BAR = 0.25;
export const ISSUE_TAGS = { audit: 'What you said', figures: 'Numbers', goal: 'Result', constraints: 'Requirements' };
// The visible step (UI copy: no em-dashes, #116; the "Not done yet" label predates it and stays as people know it).
export const CHECK_LABELS = { audit: 'Checking what I said I did', figures: 'Double-checking the numbers', goal: 'Not done yet — trying another way',
  constraints: 'Checking every requirement' };

/**
 * The checks before a reply counts. goal: ask "delivered? theirs? a question? every requirement met?" (after real work);
 * audit: the code audit (auditReply): its hits, or a non-Latin reply, get the decision model's view; figures: the reply's
 * figures code found nowhere in what the task read; gap: also ask "did they want something no tool does?".
 * succeeded / toolsets: the tools that worked in this task, the person's toolsets; failed: failed step labels for the nudge.
 * → { push, issues: [{ kind, text }], kind, label, nudge, gap }. With the decision model off or failing, code alone decides
 * the audit (its patterns are specific) and the figures (all unmatched count), and "delivered" is not judged (as before).
 */
export async function goalCheck({ run: r, user, reply, signal, goal = true, audit = null, figures = [], gap = false,
  succeeded = new Set(), toolsets = new Set(), failed = [] }) {
  const request = get('SELECT content FROM messages WHERE id = ?', r.trigger_message_id)?.content || '';
  if (!String(reply || '').trim()) return { push: false, issues: [] };
  const askGoal = goal && !!request.trim();
  const askAudit = !!audit && (audit.claims.length + audit.denials.length + audit.promises.length > 0 || audit.nonLatin);
  const askGap = gap && !!request.trim();
  if (!askGoal && !askAudit && !figures.length && !askGap) return { push: false, issues: [] };
  const steps = (() => { try { return JSON.parse(r.steps || '[]'); } catch { return []; } })();
  const questions = {};
  if (askGoal) {
    questions.delivered = noul('Does `reply` give them what `request` asked for — the actual, complete result — rather than an apology, a '
      + 'partial or unverified answer, a plan, a description of problems, or "I couldn’t"?');
    questions.theirs = noul('Did `reply` stop because the task has reached a step only the person can take — the page is now waiting for '
      + 'their payment, sign-in, CAPTCHA or approval, or they must make a personal choice or give missing information — rather '
      + 'than because something went wrong, wasn’t found, or couldn’t be verified?');
    questions.question = noul('Does `reply` ask them a question they must answer before anything else can happen?');
    questions.constraints_met = noul('Does the result in `reply` match every explicit requirement in `request` (dates, times, number of people, '
      + 'class, budget limit, place, format, language)? A requirement that `reply` does not mention counts as unmet.');
  }
  if (askAudit) {
    questions.claimed = choice('Which kind of action does `reply` say was ALREADY carried out in this task (not offered, planned or described)?', FAMILY_CHOICES);
    questions.denied = choice('Which ability does `reply` say the assistant does not have or cannot use?', DENY_CHOICES);
    questions.promise = noul('Does `reply` promise to do something later on its own (let them know, follow up, keep an eye on it, remind them)?');
  }
  figures.forEach((f, i) => {
    questions[`f${i}`] = noul(`Is the figure \`figures.f${i}.figure\` (in \`figures.f${i}.sentence\`) stated in \`figures.f${i}.evidence\` or directly computed from it?`);
  });
  if (askGap) {
    questions.gap = noul('Did `request` ask for something that none of `abilities` can do (for example a phone call, controlling home devices, '
      + 'or a service the assistant has no way to reach), rather than something they cover?');
  }
  const res = await decide('goal', {
    user, runId: r.id, timeoutMs: 3000, signal,
    state: {
      request: request.slice(0, 3000), reply: String(reply).slice(0, 4000),
      steps_taken: steps.slice(-15).map(s => `${s.label}${s.status === 'bad' ? ' (failed)' : ''}`).join('\n') || '(none)',
      ...(figures.length ? { figures: Object.fromEntries(figures.map((f, i) => [`f${i}`, { figure: f.figure, sentence: f.sentence, evidence: f.evidence || '(nothing close)' }])) } : {}),
      ...(askGap ? { abilities: [...toolsets].map(t => ABILITY[t]).filter(Boolean).join('; ') || '(none)' } : {}),
    },
    questions,
  });
  const thr = threshold();
  const issues = [];
  const outcome = [];
  // The reply audit: a code hit stands unless the decision model clearly says otherwise; what the decision model finds on its
  // own (a non-Latin reply) counts only when it is sure and code agrees the task didn't do it.
  if (askAudit) {
    const did = family => FAMILIES[family]?.tools.some(t => succeeded.has(t));
    const claimed = res ? picked(res.answers.claimed) : null;
    const denied = res ? picked(res.answers.denied) : null;
    const promised = res ? yes(res.answers.promise) : null;
    const clearNo = x => !!x && x.pick === 'none' && x.p >= thr;
    const claims = clearNo(claimed) ? [] : [...audit.claims];
    if (!audit.claims.length && claimed && claimed.pick !== 'none' && claimed.p >= thr && FAMILIES[claimed.pick] && !did(claimed.pick)) {
      claims.push({ family: claimed.pick, label: FAMILIES[claimed.pick].label, sentence: '' });
    }
    const denials = clearNo(denied) ? [] : [...audit.denials];
    if (!audit.denials.length && denied && denied.pick !== 'none' && denied.p >= thr && toolsets.has(denied.pick)) denials.push({ toolset: denied.pick, sentence: '' });
    const promises = promised != null && promised <= 1 - thr ? [] : [...audit.promises];
    if (!audit.promises.length && promised != null && promised >= thr && !PROMISE_TOOLS.some(t => succeeded.has(t))) promises.push({ sentence: '' });
    for (const c of claims.slice(0, 2)) {
      issues.push({ kind: 'audit', text: `Your reply says ${c.label} is done${c.sentence ? ` (${quote(c.sentence)})` : ''}, but no step in this task did it. `
        + 'If it should be done, do it now with the right tool and check that it took; if it can’t be done, say plainly that it isn’t done and why.' });
    }
    for (const d of denials.slice(0, 1)) {
      issues.push({ kind: 'audit', text: `Your reply says you can’t use ${DENY_CHOICES[d.toolset]}${d.sentence ? ` (${quote(d.sentence)})` : ''}, but you can: `
        + `it is switched on for them (you can ${ABILITY[d.toolset] || d.toolset}). Use it now instead of declining.` });
    }
    for (const p of promises.slice(0, 1)) {
      issues.push({ kind: 'audit', text: `Your reply promises a follow-up${p.sentence ? ` (${quote(p.sentence)})` : ''}, but nothing is scheduled, so it would never `
        + 'happen. Set it up now (set_reminder, or schedule_task with only_when for a quiet watch), or don’t promise it.' });
    }
    outcome.push(claims.length || denials.length || promises.length ? `audit: ${claims.length} claim · ${denials.length} denial · ${promises.length} promise` : 'audit: clear');
  }
  // Figures: the decision model sees each one with the nearest evidence (never her reasoning); unsure or off counts as unsupported.
  if (figures.length) {
    const unsupported = figures.filter((f, i) => !res || (yes(res.answers[`f${i}`]) ?? 0) < 0.5);
    if (unsupported.length) {
      issues.push({ kind: 'figures', text: `These figures aren’t in what you read this task: ${unsupported.map(f => f.figure).join(', ')}. `
        + 'Re-check them (read the page again) or mark them clearly as your estimate.' });
    }
    outcome.push(`figures: ${unsupported.length} of ${figures.length} unsupported`);
  }
  let delivered = null;
  if (askGoal && res) {
    delivered = yes(res.answers.delivered);
    const theirs = yes(res.answers.theirs), q = yes(res.answers.question), met = yes(res.answers.constraints_met);
    const notTheirs = (theirs ?? 0) < 0.7 && (q ?? 0) < 0.5;
    const notDelivered = delivered != null && delivered <= 1 - thr && notTheirs;
    // A missed requirement needs a clear no (≤ 0.25, or stricter with a higher bar): on real replies a complete answer read
    // 0.40–0.45 here, and a false push costs a whole extra loop.
    const unmet = !notDelivered && met != null && met <= Math.min(1 - thr, UNMET_BAR) && notTheirs;
    if (notDelivered) {
      issues.push({ kind: 'goal', text: 'Giving up is not an option. Try a genuinely different approach now: start the flow over cleanly; set every requested '
        + 'option explicitly (class, dates, passengers, filters) and check each one took; use the site’s own search or URL parameters, or another '
        + 'route or source; read the page again before concluding anything. Reply only when you have the actual result, or when the next step '
        + 'truly needs the person (paying, signing in, a choice only they can make), and then say exactly what they need to do.' });
    } else if (unmet) {
      issues.push({ kind: 'constraints', text: 'Check each requirement from their request (dates, times, number of people, class, budget, place, format, '
        + 'language) against your result, and fix the ones that don’t match before replying. A requirement your reply doesn’t mention counts as unmet.' });
    }
    outcome.unshift(notDelivered ? `not delivered (${pct(delivered)}) — back to work` : unmet ? `requirements unmet (${pct(met)})`
      : `finished — delivered ${pct(delivered)} · theirs ${pct(theirs)} · asks ${pct(q)} · met ${pct(met)}`);
  }
  // The wish log: something no tool does. Decision model: sure it's a gap (≥ 0.8) and not delivered; off: the reply says it
  // can't do something outside the person's toolsets.
  let wish = null;
  if (askGap) {
    const g = res ? yes(res.answers.gap) : null;
    if (res ? g != null && g >= Math.max(0.8, thr) && (delivered == null || delivered < 0.5) : !!unmetAsk(reply, toolsets)) wish = clip(request, 240);
    if (res) outcome.push(`gap ${pct(g)}`);
  }
  if (res) note(res.id, outcome.join(' · ') || 'checked', { confidence: delivered });
  if (!issues.length) return { push: false, issues, gap: wish };
  const kind = issues.some(i => i.kind === 'audit') ? 'audit' : issues.some(i => i.kind === 'figures') ? 'figures' : issues[0].kind;
  const failedLine = failed.length ? `\nAlready tried and failed (don’t repeat these): ${failed.slice(-5).join('; ')}.` : '';
  const nudge = `[${HEADS[kind]}]\nTheir request: “${request.slice(0, 600)}”\n${issues.map(i => `- ${ISSUE_TAGS[i.kind]}: ${i.text}`).join('\n')}${failedLine}\n`
    + 'Do not report back until this is fixed. Don’t repeat what didn’t work.';
  return { push: true, issues, kind, label: CHECK_LABELS[kind], nudge, gap: wish };
}

// ---- Every message: spoken reply? which language? which memories? --------------------------------------------------
// One call per message, started when it arrives and awaited before the first model step (it runs while the run queues).
const LANGS = { en: 'English', ar: 'Arabic', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese', tr: 'Turkish', nl: 'Dutch' };
const senses = new Map();   // trigger message id → { voice, lang, memories, episodes } (kept for the turn; a restart falls back)
const pending = new Map();  // run id → { job: Promise, startedAt }
// The sense bounds itself: the query embedding races EMBED_RACE_MS (then words alone), then Jev gets TURN_DECIDE_MS. The
// loop waits for it at most that long counted from when it STARTED, with the message (a run that queued meanwhile waits
// only for what is left), plus a small margin. Measured on the dev data: typically ~0.6–0.7 s end to end (embedding
// ~0.3 s, Jev ~0.3 s); the old fixed 3.5 s wait cut off senses whose Jev call was still inside its own 3 s budget.
const EMBED_RACE_MS = 900;
const TURN_DECIDE_MS = 3000;
export const SENSE_MAX_MS = EMBED_RACE_MS + TURN_DECIDE_MS + 300;

// Candidates for the decision model to pick from (decision #151): the facts nearest the message by words AND meaning (so an
// Arabic message finds English facts, and "what should I cook?" finds "allergic to peanuts"), then the pinned and newest;
// plus earlier conversations (episodes, decision #155). One query embedding serves both; it races ~900 ms, then words alone.
async function memoryCandidates(user, text) {
  const ids = readableScopes(user).map(s => s.id);
  const qv = await queryVector(text, user.id, EMBED_RACE_MS);
  const near = await recallHybrid(user, text, 25, { qv });
  const recent = all(`SELECT * FROM memories WHERE status = 'active' AND scope_id IN (${ids.map(() => '?').join(',')})
    ORDER BY pinned DESC, observed_at DESC LIMIT 20`, ...ids);
  const seen = new Set();
  const memories = [...near, ...recent].filter(m => !seen.has(m.id) && seen.add(m.id)).slice(0, 40);
  const seenE = new Set();
  const episodes = [...await recallEpisodesHybrid(user, text, 4, { qv }), ...recentEpisodes(user, 2)]
    .filter(e => !seenE.has(e.id) && seenE.add(e.id)).slice(0, 6);
  return { memories, episodes };
}

// ---- Routing from the message sense (decision #177): a skill, the reasoning effort, a careful topic -------------------
// The skill list sits in the cached system prompt, and people's plain phrasing ("can you sort my emails?") often doesn't make
// the model open one; a hint in the tail, close to where it writes, does. ~94 skills is too many options for one question, so
// the words pre-filter them (TF-IDF over name + description, skill-lint's routeRanking) to the best ROUTE_TOP first.
const ROUTE_TOP = 12;
export const EFFORT_RUBRIC = {
  low: 'chit-chat, a greeting, a quick fact, a simple action like a reminder or a list item',
  medium: 'a few steps, comparing options, looking something up and summarising, writing something of some length',
  high: 'multi-step planning, maths or numbers that must be right, money, health or legal stakes, hard reasoning or a tricky decision',
};
export const FIELD_CHOICES = {
  health: 'health: symptoms, medicines and doses, a diagnosis, pregnancy, mental health',
  legal: 'law: contracts, leases, rights, disputes, visas, courts, official procedures',
  money: 'money decisions: investing, loans, debt, taxes, pensions, insurance, a big purchase',
  none: 'none of these',
};
const FIELD_WORDS = {
  health: /\b(?:symptoms?|pain|fever|doctor|medic(?:ine|ation)s?|doses?|dosage|pills?|tablets?|diagnos\w*|pregnan\w*|blood\s+pressure|diabet\w*|insulin|allerg\w*|rash|headaches?|migraines?|infections?|antibiotics?|vaccin\w*|depress\w*|anxiety|surgery|ibuprofen|paracetamol|side\s+effects?)\b|médecin|médicament|douleur|fièvre|symptôme|ordonnance|طبيب|دواء|ألم|حمى|أعراض|صداع/iu,
  legal: /\b(?:lawyers?|attorneys?|legal(?:ly)?|lawsuit|sue|court|contracts?|lease|tenant|landlord|evict\w*|visa|immigration|divorce|custody|inheritance|my\s+rights|copyright|gdpr)\b|avocat|tribunal|contrat|juridique|محامي|محكمة|عقد|قانون/iu,
  money: /\b(?:invest\w*|stocks?|crypto|bitcoin|loans?|mortgage|debts?|credit\s+card|tax(?:es)?|pension|retirement|savings|insurance|interest\s+rates?|refinanc\w*|bankrupt\w*)\b|impôts?|prêt|crédit|placement|قرض|ضريبة|استثمار|ديون|تأمين/iu,
};
/** A careful topic by words (the fallback when the decision model is off). */
export const keywordField = text => Object.keys(FIELD_WORDS).find(k => FIELD_WORDS[k].test(String(text || ''))) || null;

/** The person's usable skills whose words fit the message best (≤ ROUTE_TOP, only those with any overlap), best first. */
function skillCandidates(user, text) {
  const usable = skillsFor(user, enabledToolsets(user));
  if (!usable.length) return [];
  const byName = new Map(usable.map(s => [s.name, s]));
  return routeRanking(text, usable).filter(x => x.score > 0).slice(0, ROUTE_TOP).map(x => byName.get(x.name));
}
/** The skill by words alone (fallback): the top one, when it fits clearly (a message of 2+ content words; score ≥ 0.3 and
 *  1.3× the runner-up). One word ("what time is it") is too little to route on. */
export function keywordSkill(text, skills) {
  if (!skills.length || words(text).length < 2) return null;
  const [top, next] = routeRanking(String(text || ''), skills);
  return top && top.score >= 0.3 && (!next || top.score >= next.score * 1.3) ? top.name : null;
}

const routes = new Map(); // message id → { skill, effort, field, source }
/**
 * How to handle a message (the prompt tail and the chat call read it): { skill, effort, field, source: 'jev' | 'keywords' }.
 * From the message sense when the decision model answered; otherwise by words (skill, careful topic; no effort), which is
 * logged once per message in the decisions log. Cached per message.
 */
export function routingOf({ user, message, runId = null }) {
  const none = { skill: null, effort: null, field: null, source: 'none' };
  const text = String(message?.content || '').trim();
  if (!message?.id || !text) return none;
  const sense = senses.get(message.id);
  const cached = routes.get(message.id);
  if (cached && (cached.source === 'jev' || !sense?.routed)) return cached;
  let out;
  if (sense?.routed) out = { skill: sense.skill, effort: sense.effort, field: sense.field, source: 'jev' };
  else {
    out = { skill: keywordSkill(text, skillsFor(user, enabledToolsets(user))), effort: null, field: keywordField(text), source: 'keywords' };
    if (out.skill || out.field) {
      logFallback('turn', { userId: user.id, runId, outcome: [out.skill ? `skill “${out.skill}”` : null, out.field ? `careful: ${out.field}` : null]
        .filter(Boolean).join(' · ') + ' (by keywords)' });
    }
  }
  routes.set(message.id, out);
  if (routes.size > 500) routes.delete(routes.keys().next().value);
  return out;
}

export function senseTurn({ user, run, message, wantVoice = true }) {
  const text = String(message.content || '').trim();
  if (!text) return;
  const job = (async () => {
    if (!enabled('turn')) return null; // no decision model: the prompt picks memories by words (and no embedding is spent)
    const { memories: cands, episodes: eps } = await memoryCandidates(user, text);
    const questions = {
      lang: choice('Which language should the reply to `message` be written in (the language they wrote in, unless they ask for another)?',
        { ...LANGS, other: 'another language' }),
      ...(wantVoice ? { voice: noul('Does `message` ask to HEAR the reply spoken aloud — a voice note, "say it", "read it to me", "tell me verbally", "speak it out"? Asking about voice features or audio files does not count.') } : {}),
    };
    for (const m of cands) questions[`m${m.id}`] = noul(`Would knowing memory \`memories.m${m.id}\` help to answer \`message\` well?`);
    for (const e of eps) questions[`e${e.id}`] = noul(`Would knowing earlier conversation \`episodes.e${e.id}\` help to answer \`message\` well?`);
    // Routing (#177): which skill (of the ~12 whose words fit best), how much thinking, a careful topic.
    const skills = skillCandidates(user, text);
    if (skills.length) {
      questions.skill = choice('Which of these skills (if any) is meant for handling `message`? Pick one only when `message` clearly asks for what it does.',
        { none: 'no skill fits', ...Object.fromEntries(skills.map(s => [s.name, clip(s.description, 200)])) });
    }
    questions.effort = choice('How much careful thinking does answering `message` well need?', EFFORT_RUBRIC);
    questions.field = choice('Is `message` about one of these careful topics?', FIELD_CHOICES);
    questions.correction = CORRECTION_QUESTION; // → the "They just corrected you" nudge in the tail (#187)
    const res = await decide('turn', { user, runId: run.id, timeoutMs: TURN_DECIDE_MS,
      state: { message: text.slice(0, 6000), memories: Object.fromEntries(cands.map(m => [`m${m.id}`, m.text])),
        ...(eps.length ? { episodes: Object.fromEntries(eps.map(e => [`e${e.id}`, episodeLine(e)])) } : {}) }, questions });
    if (!res) return null;
    const thr = threshold();
    const v = wantVoice ? yes(res.answers.voice) : null;
    const lang = picked(res.answers.lang);
    const chosen = cands.map(m => ({ m, p: yes(res.answers[`m${m.id}`]) ?? 0 })).filter(x => x.p >= 0.5).sort((a, b) => b.p - a.p).slice(0, 8);
    const episodes = eps.map(e => ({ e, p: yes(res.answers[`e${e.id}`]) ?? 0 })).filter(x => x.p >= 0.5).sort((a, b) => b.p - a.p).slice(0, 3).map(x => x.e);
    markUsed(chosen.map(x => x.m.id), `msg:${message.id}`); // once per message (the prompt's fallback shares the key)
    const skill = skills.length ? picked(res.answers.skill) : null;
    const effort = picked(res.answers.effort), field = picked(res.answers.field);
    const sense = { voice: v != null && v >= thr, lang: lang && lang.p >= thr && LANGS[lang.pick] ? LANGS[lang.pick] : null,
      memories: chosen.map(x => x.m), episodes, routed: true,
      skill: skill && skill.pick !== 'none' && skill.p >= thr && skills.some(s => s.name === skill.pick) ? skill.pick : null,
      effort: effort && effort.p >= thr && EFFORT_RUBRIC[effort.pick] ? effort.pick : null,
      field: field && field.pick !== 'none' && field.p >= thr && FIELD_CHOICES[field.pick] ? field.pick : null,
      correction: correctionOf(res.answers, thr) }; // null when unanswered: the tail falls back to words
    if (sense.voice) sql('UPDATE runs SET voice = 1 WHERE id = ? AND voice = 0', run.id);
    senses.set(message.id, sense);
    note(res.id, [sense.voice ? `spoken reply (${pct(v)})` : null, sense.lang ? `in ${sense.lang}` : 'language: old rule',
      `${chosen.length} of ${cands.length} memories`, eps.length ? `${episodes.length} of ${eps.length} earlier chats` : null,
      sense.skill ? `skill “${sense.skill}” (${pct(skill.p)})` : skills.length ? `no skill of ${skills.length}` : null,
      sense.effort ? `effort ${sense.effort}` : null, sense.field ? `careful: ${sense.field}` : null, sense.correction ? 'a correction' : null]
      .filter(Boolean).join(' · '),
      { confidence: lang?.confidence ?? null });
    if (senses.size > 500) senses.delete(senses.keys().next().value);
    return sense;
  })().catch(err => { console.warn('[sense] turn:', err.message); return null; });
  pending.set(run.id, { job, startedAt: Date.now() });
  job.finally(() => setTimeout(() => pending.delete(run.id), 60_000).unref?.()); // housekeeping: never keeps the process alive
}

/** Wait (briefly) for a run's message sense before its first model step: by default until its own budget (SENSE_MAX_MS
 *  from its start) runs out, so a sense still inside its embedding race + Jev call is never cut off early. */
export async function awaitSense(runId, ms = null) {
  const p = pending.get(runId);
  if (!p) return null;
  const wait = ms ?? Math.max(0, p.startedAt + SENSE_MAX_MS - Date.now());
  let timer;
  const cutoff = new Promise(r => { timer = setTimeout(() => r(null), wait); });
  try { return await Promise.race([p.job, cutoff]); } finally { clearTimeout(timer); }
}

/** What the sense decided for this message (null: decide the old way). */
export const senseOf = messageId => (messageId ? senses.get(messageId) || null : null);
export const __test = { senses, pending, routes };
