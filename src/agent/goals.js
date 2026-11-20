// Goals & Ideas — the model side (decision #55). Cheap JSON calls, everything else plain code:
//   intake   — a new goal → 3–4 multiple-choice questions that coax a brain dump (transcript T1), then 0–3 follow-ups
//   plan     — goal + answers → "here's everything I can do" (steps the person switches on; once = a run, recurring = a schedule;
//              each step says when it's done and which earlier steps it waits for), plus a measure when there's a real number
//   review   — a periodic / on-demand check-in: honest progress (computed from a measure when there is one), status line, next step
//   lapses   — a rhythm gone quiet → at most one gentle nudge a day per person
//   reflect  — recent conversations + memory → Ideas (concrete helps) and suggested goals ("I noticed you care about…")
// Jobs are driven from the database by the scheduler tick (a restart loses nothing); routes also kick them at once.
import { get, all, run as sql } from '../db/index.js';
import { askJson, llmSettings } from '../services/llm.js';
import { decide, noul, yes, threshold, note as noteDecision } from '../services/decide.js';
import { TOOLSETS, enabledToolsets, effectivePolicy, overBudget } from '../services/policy.js';
import { normalizeQuestions } from '../services/questions.js';
import { coreMemory } from '../services/memory.js';
import { getUser } from '../services/users.js';
import { addMessage } from '../services/messages.js';
import * as runs from '../services/runs.js';
import { createSchedule, getSchedule, pauseSchedule } from '../services/schedules.js';
import { logActivity } from '../services/activity.js';
import { notify } from '../services/notify.js';
import { publish } from '../lib/bus.js';
import { repeatToCron, inQuietHours, tzOf } from '../lib/when.js';
import * as G from '../services/goals.js';
import { addIdea, ideaTitles, IDEA_CATEGORIES, IDEA_ICONS } from '../services/ideas.js';
import { enqueueRun, cancelRun, onRunFinished, onRunRetried } from './loop.js';
import { pokeScheduler } from './proactive.js';
import { worthReviewing, worthReflecting } from './sense.js';
import { prepTick } from '../services/prep.js';

const REVIEW_EVERY_MS = 864e5;           // active goals get a check-in daily…
const REVIEW_LONG_MS = 3 * 864e5;        // …longer-horizon ones every three days
const REFLECT_EVERY_MS = 20 * 3600000;   // at most ~daily per person
const REFLECT_MIN_MESSAGES = 6;          // …and only once there's something new to reflect on

const INTAKE_PROMPT = `You help someone turn a goal into action. Write 3–4 multiple-choice questions that coax out what matters:
where they are now, what "done" looks like, constraints (time, money, energy), what they've tried, how they want help.
Options must be concrete and specific to THIS goal (3–6 each). Use what you already know about them — never ask what you know.
Return JSON {"questions":[{"header":"1–2 words","question":"…","kind":"single|multi","options":[{"label":"…","description":"optional"}]}]}`;

// A second, optional round (mattpocock review 4.1): questions that only make sense after the first answers.
const FOLLOWUP_PROMPT = `You help someone turn a goal into action. They just answered your first questions (below). Write 0–3 follow-up
multiple-choice questions that only make sense NOW, because of what they answered (they picked "a race in spring" → which race, or
what distance they can run today). Never repeat or rephrase a question already asked; never ask what their answers or what you know
already tell you. If nothing important is missing, return no questions: that is often the right answer.
Options must be concrete and specific to their answers (3–6 each).
Return JSON {"questions":[{"header":"1–2 words","question":"…","kind":"single|multi","options":[{"label":"…","description":"optional"}]}]}`;

const PLAN_PROMPT = `You are Jess, the person's capable personal agent. From their goal and answers, lay out everything YOU can do for them:
concrete things you will actually do with your capabilities (listed below) — never generic advice they must do alone.
4–8 steps: mostly one-off deliverables (research, a plan document, a tracker or dashboard page, a draft, a comparison, a shortlist),
plus at most 3 recurring routines (a weekly progress check, a daily nudge, a monthly review). Order: the best ones to start with first.
Each step delivers something usable on its own (not "part 1 of 3").
Each step: "title" (imperative, ≤ 70 chars, e.g. "Build a 12-week LinkedIn content calendar"), "description" (one sentence: what they get),
"icon" (one of ICONS), "kind" ("once" | "recurring"), "repeat" (recurring only: daily | weekdays | weekly | monthly), "at" (recurring only, HH:MM local),
"prompt" (the exact, self-contained instruction you will follow when it runs — include the relevant details from their answers;
for deliverables, say to save it to the Library),
"done_when" (one checkable line: what exists when this step is finished, e.g. "a Library doc with 3 priced options and sources"),
"after" (the numbers of earlier one-off steps in this list that must be finished first, 1 = the first step; [] when it can start now —
only when it truly needs their result, e.g. "Book the venue" after "Shortlist venues").
Also: "summary" (2 sentences: where they are and your approach), "status_line" (≤ 90 chars), "next_step" (≤ 70 chars),
"measure" (only when the goal has a real number to track from their answers, else null): {"label":"Weight","unit":"kg","start":92,"target":84,
"per_week":null} for a level to reach, or {"label":"Runs","unit":null,"start":null,"target":null,"per_week":3} for a rhythm (both may be set).
Return JSON {"summary":"…","status_line":"…","next_step":"…","measure":null,"steps":[…]}`;

const REVIEW_PROMPT = `You keep track of one of the person's goals. From the plan, what is done and the timeline, return JSON
{"progress":0-100,"status_line":"≤ 90 chars — what's happening now","summary":"2 sentences","next_step":"≤ 70 chars — the single most useful next thing",
"new_steps":[],"done":false}
- progress: honest — finished deliverables (each step's "done when") and real evidence of their progress, not effort or time passed.
  When MEASURES has a start and a target, progress is computed from their numbers: make the status line agree with it.
- new_steps: 0–2 new steps (same shape as the plan: title, description, icon, kind, repeat, at, prompt, done_when, after — where
  after = numbers of PLAN steps it needs finished first) only when clearly useful and new.
- done: true only if the goal is clearly achieved.`;

const REFLECT_PROMPT = `You are Jess, reflecting on recent conversations with the person to find ways to help proactively.
Return JSON {"ideas":[{"title":"…","why":"…","category":"…","icon":"…","kind":"…","prompt":"…","from":123}],"goals":[{"title":"…","category":"…","why":"…"}]}
- ideas (0–5): concrete things you could do for them, e.g. "Lower back recovery regimen", "Kindergarten coordination", "Permit applications".
  title ≤ 60 chars · why: 1–2 sentences speaking to them, grounded in what they said · category: one of CATEGORIES · icon: one of ICONS ·
  kind: research (find things out) | plan (a plan, schedule or checklist) | draft (something written for them) | comparison (options
  side by side) | other · prompt: what they would say to you to start it (first person, self-contained) · from: the #id of the message
  it came from, if any.
- goals (0–2): longer-running aims they clearly care about. title ≤ 60 chars · category: health|money|career|family|home|learning|creative ·
  why ≤ 120 chars, e.g. "You mentioned wanting to…".
Only things grounded in the conversation or what you know — nothing generic. Never repeat anything listed under ALREADY SUGGESTED or GOALS.
Never suggest anything like what is listed under TURNED DOWN, even in other words (the same idea by another name counts), and respect why.
Empty lists are fine.`;

const ask = (user, system, content, purpose, maxTokens) => askJson(user, system, content, { purpose, maxTokens });

// ---- Guards & in-flight jobs ----------------------------------------------------------------------------------
/** Background work for this person is allowed: active account, Goals & ideas switched on, budget left. */
export const canWork = user => !!user && user.status === 'active' && enabledToolsets(user).has('goals') && !overBudget(user);

const inflight = new Map(); // goalId → 'intake' | 'plan' | 'review'
export const busyKind = goalId => inflight.get(goalId) || null;
export const busyGoals = () => new Set(inflight.keys());

async function job(g, kind, fn) {
  if (inflight.has(g.id)) return;
  inflight.set(g.id, kind);
  G.announceGoal(g.user_id, g.id, { busy: kind });
  try {
    await fn();
    G.setGoalFields(g.id, { error: null });
  } catch (err) {
    console.warn(`[goals] ${kind} failed for goal ${g.id}:`, err.message);
    G.setGoalFields(g.id, { error: err.message.slice(0, 300) });
  } finally {
    inflight.delete(g.id);
    G.announceGoal(g.user_id, g.id);
  }
}

const knownAbout = user => {
  const facts = coreMemory(user).map(f => `- ${f.text}`).join('\n');
  return facts ? `WHAT YOU KNOW ABOUT THEM:\n${facts}` : 'WHAT YOU KNOW ABOUT THEM: (nothing yet)';
};
const answersText = g => (JSON.parse(g.answers || '[]').map(a => `- ${a.question} → ${a.answer}`).join('\n') || '(they skipped the questions)');
const capabilities = user => [...enabledToolsets(user)].map(k => `- ${TOOLSETS[k].label}: ${TOOLSETS[k].description}`).join('\n');

// ---- Intake ---------------------------------------------------------------------------------------------------
// Two rounds (decision #184): the first questions; then, from their answers, 0–3 follow-ups that only make sense now
// (a second `intake` set, same ask-dock contract). Planning waits for those answers or for Skip. No follow-ups, or the
// follow-up call failing, goes straight to planning: the second round is a bonus, never a blocker.
const asQuestions = out => normalizeQuestions((out.questions || []).map(q => ({ ...q, allowOther: true, kind: q.kind === 'multi' ? 'multi' : 'single' })));

export const prepareIntake = g => job(g, 'intake', async () => {
  const user = getUser(g.user_id);
  if (g.intake_round >= 2) {
    let qs = [];
    try {
      qs = asQuestions(await ask(user, FOLLOWUP_PROMPT, `GOAL: ${g.title} (${G.categoryOf(g.category).label})\nTHEIR ANSWERS:\n${answersText(g)}\n\n`
        + `${knownAbout(user)}`, 'goals', 1200)).slice(0, 3);
    } catch (err) { console.warn(`[goals] follow-up questions failed for goal ${g.id}:`, err.message); }
    G.setGoalFields(g.id, qs.length ? { intake: JSON.stringify(qs) } : { stage: 'planning' });
    return;
  }
  const out = await ask(user, INTAKE_PROMPT, `GOAL: ${g.title} (${G.categoryOf(g.category).label})\n\n${knownAbout(user)}`, 'goals', 1500);
  const qs = asQuestions(out);
  if (!qs.length) throw new Error('I couldn’t come up with good questions — press Retry.');
  G.setGoalFields(g.id, { intake: JSON.stringify(qs) });
}).then(() => { const n = G.getGoal(g.id); if (n?.stage === 'planning') kick(n); }); // no follow-ups: plan now

/** Answers from the goal page (already validated against the stored questions): round 1 → follow-ups next; round 2 → plan. */
export function saveIntakeAnswers(g, answers) {
  const qs = JSON.parse(g.intake || '[]');
  const readable = answers.map(a => {
    const q = qs.find(x => x.id === a.questionId);
    const label = v => (v === '__other__' ? a.other : q?.options.find(o => o.value === v)?.label || v);
    return { question: q?.question || a.questionId, answer: [].concat(a.value).map(label).filter(Boolean).join(', ') };
  });
  const round = g.intake_round || 1;
  const earlier = round >= 2 ? JSON.parse(g.answers || '[]') : [];
  G.setGoalFields(g.id, round >= 2
    ? { answers: JSON.stringify([...earlier, ...readable]), stage: 'planning', error: null }
    : { answers: JSON.stringify(readable), intake: null, intake_round: 2, error: null });
  G.addEvent(g, { kind: 'note', iconName: 'message-circle-question', title: round >= 2 ? 'You answered a couple more' : 'You answered a few questions',
    detail: readable.map(r => r.answer).join(' · ') });
  kick(G.getGoal(g.id));
}

/** Skip: in the first round, all questions; in the second, just the follow-ups (the first answers stay). Plan next. */
export function skipIntake(g) {
  G.setGoalFields(g.id, (g.intake_round || 1) >= 2 ? { stage: 'planning', error: null } : { answers: '[]', stage: 'planning', error: null });
  kick(G.getGoal(g.id));
}

// ---- Plan -----------------------------------------------------------------------------------------------------
export const buildPlan = g => job(g, 'plan', async () => {
  const user = getUser(g.user_id);
  const out = await ask(user, PLAN_PROMPT.replace('ICONS', G.TASK_ICONS.join(', ')),
    `GOAL: ${g.title} (${G.categoryOf(g.category).label}${g.horizon === 'long' ? ', longer horizon' : ''})\nTHEIR ANSWERS:\n${answersText(g)}\n\n`
    + `${knownAbout(user)}\n\nYOUR CAPABILITIES FOR THEM:\n${capabilities(user)}`, 'goals', 4000);
  const added = G.addTasks(g, out.steps);
  if (!added.length) throw new Error('I couldn’t lay out a plan — press Retry.');
  // A real number to track, when their answers gave one (a level to reach and/or a rhythm). A bad one is just left out.
  if (out.measure && typeof out.measure === 'object' && !G.measuresOf(g).length) {
    try { G.addMeasure(g, out.measure); } catch (err) { console.warn(`[goals] plan measure skipped for goal ${g.id}:`, err.message); }
  }
  G.setGoalFields(g.id, {
    stage: 'ready', summary: String(out.summary || '').slice(0, 600) || null, status_line: String(out.status_line || '').slice(0, 140) || null,
    next_step: String(out.next_step || '').slice(0, 120) || null, next_review_at: new Date(Date.now() + REVIEW_EVERY_MS).toISOString(),
  });
  G.addEvent(g, { kind: 'milestone', iconName: 'list-checks', title: `Plan ready — ${added.length} things I can do`, detail: 'Switch on the ones you want.' });
  logActivity(user.id, { kind: 'task', icon: 'target', title: `Planned “${g.title}”`, href: `/goals/${g.id}` });
});

// ---- Steps ------------------------------------------------------------------------------------------------------
/**
 * The person switched a step on or off. once → a run now; recurring → a schedule in the goal's chat. A step whose earlier
 * steps aren't done yet is queued instead (switched on, status todo): it starts by itself when they are (startReady).
 * Returns the step row, with `queuedAfter` (titles) when it was queued.
 */
export function toggleTask(g, t, on) {
  const user = getUser(g.user_id);
  if (on && g.state !== 'active') throw Object.assign(new Error('Resume the goal first.'), { status: 400 });
  if (on && t.status !== 'done' && !(t.kind === 'recurring' && t.schedule_id)) {
    const waitFor = G.blockersOf(t);
    if (waitFor.length) {
      const after = waitFor.map(b => `“${b.title}”`).join(' and ');
      if (!t.enabled) G.addEvent(g, { kind: 'action', iconName: 'hourglass', title: `Queued “${t.title}”`, detail: `Starts by itself after ${after}.` });
      return { ...G.setTask(t.id, { enabled: 1, status: 'todo' }), queuedAfter: waitFor.map(b => b.title) };
    }
  }
  if (t.kind === 'once') {
    if (on) {
      if (t.status === 'done') return t;
      if (overBudget(user)) throw Object.assign(new Error("This week's budget is used up — it resets Monday."), { status: 400 });
      return startTask(g, t);
    }
    if (t.run_id && t.status === 'doing') cancelRun(t.run_id);
    return G.setTask(t.id, { enabled: 0, status: t.status === 'doing' ? 'todo' : t.status });
  }
  // recurring
  let s = t.schedule_id && getSchedule(t.schedule_id);
  if (on && !s) {
    const thread = G.goalThread(g);
    s = createSchedule({ user, title: t.title.slice(0, 80), cron: repeatToCron(t.repeat, t.at, { tz: tzOf(user) }), threadId: thread.id, createdBy: 'user',
      prompt: `For their goal “${g.title}” (Goals page): ${t.prompt}\n${t.done_when ? `Done when (each time): ${t.done_when}\n` : ''}`
        + 'Keep it short. End with one line on progress toward the goal.' });
    sql('UPDATE schedules SET goal_id = ? WHERE id = ?', g.id, s.id);
    G.addEvent(g, { kind: 'action', iconName: 'calendar-clock', title: `Scheduled “${t.title}”`, detail: `${t.repeat} at ${t.at}` });
    pokeScheduler();
  } else if (s) {
    pauseSchedule(s, !on);
    pokeScheduler();
  }
  return G.setTask(t.id, { enabled: on ? 1 : 0, status: on ? 'doing' : 'todo', schedule_id: s?.id ?? t.schedule_id });
}

/**
 * Start every queued step whose earlier steps are now all done (a blocker finished, the goal resumed). Only for an active
 * goal with work allowed (Goals on, budget left); otherwise they stay queued and the next finish or resume tries again.
 */
export function startReady(goal) {
  const g = G.getGoal(goal.id);
  if (!g || g.state !== 'active' || !canWork(getUser(g.user_id))) return [];
  const tasks = G.tasksOf(g);
  const ready = tasks.filter(t => t.enabled && t.status === 'todo' && !t.schedule_id && G.afterIdsOf(t).length && !G.blockersOf(t, tasks).length);
  const started = [];
  for (const t of ready) {
    G.addEvent(g, { kind: 'note', iconName: 'play', title: `“${t.title}” can start now`, detail: 'The steps it waited for are done.' });
    try { toggleTask(g, t, true); started.push(t); } catch (err) { console.warn(`[goals] couldn't start step ${t.id}:`, err.message); }
  }
  if (ready.length) G.announceGoal(g.user_id, g.id);
  return started;
}

function startTask(g, t) {
  const user = getUser(g.user_id);
  const thread = G.goalThread(g);
  // The step and its "Done when" come first: the goal gate (#113) reads this text as what was asked, and checks the reply
  // against it (sense.goalCheck reads the first 3,000 characters of the run's trigger).
  const system = `[Goal “${g.title}” — step “${t.title}”. The person switched this on from their Goals page; they may not be watching live.]\n`
    + `Do this now: ${t.prompt}\n${t.done_when ? `Done when: ${t.done_when}\n` : ''}\n`
    + `About the goal: ${g.summary || g.title}\nTheir answers:\n${answersText(g)}\n\n`
    // They already answered the intake questions and aren't watching: asking again stalls the step (it sat "doing" for
    // good). Assume sensibly and say so; stop to ask only for a decision that is truly theirs.
    + 'They already answered your questions above and may not be watching, so do not ask more: where something is unknown, make a '
    + 'sensible assumption, state it in one line, and carry on. Use ask_user only when you cannot continue without a decision '
    + 'that must be theirs (money, sending something, personal choices you cannot infer).\n'
    + (t.done_when ? 'Before you reply, check the result against the "Done when" line; if it isn’t met yet, keep going.\n' : '')
    + 'If it is a deliverable, save it to the Library and link it. End with one short line on what you did and what comes next.';
  const trigger = addMessage({ threadId: thread.id, role: 'system', content: system });
  const r = runs.createRun({ threadId: thread.id, userId: user.id, triggerMessageId: trigger.id, model: llmSettings().model,
    origin: 'goal', originLabel: t.title, goalId: g.id });
  const next = G.setTask(t.id, { enabled: 1, status: 'doing', run_id: r.id });
  G.addEvent(g, { kind: 'action', iconName: 'zap', title: `Started “${t.title}”`, href: `/chat/${thread.id}`, runId: r.id });
  enqueueRun(r.id);
  return next;
}

// A goal's run ended: timeline, step status, a check-in soon. (Registered with the loop.)
onRunFinished(async (r, status, { html, error }) => {
  if (!r?.goal_id || r.hidden) return;
  const g = G.getGoal(r.goal_id);
  if (!g) return;
  const task = get('SELECT * FROM goal_tasks WHERE run_id = ?', r.id)
    || get('SELECT t.* FROM goal_tasks t JOIN schedules s ON s.id = t.schedule_id WHERE s.last_run_id = ?', r.id);
  const reply = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (status === 'done') {
    G.addEvent(g, { kind: 'action', iconName: 'circle-check', title: `Did “${task?.title || r.origin_label || 'a step'}”`, detail: reply.slice(0, 280),
      href: `/chat/${r.thread_id}`, runId: r.id });
    for (const item of all('SELECT public_id, title FROM library_items WHERE run_id = ?', r.id)) {
      G.addEvent(g, { kind: 'artifact', iconName: 'sparkles', title: `Made “${item.title}”`, href: `/library/${item.public_id}`, runId: r.id });
    }
    if (task?.kind === 'once') {
      G.setTask(task.id, { status: 'done', done_at: new Date().toISOString() });
      startReady(g); // steps queued after this one start now
    }
    if (r.origin === 'goal') notify(r.user_id, { kind: 'schedule', title: `Done: ${task?.title || r.origin_label}`, body: reply.slice(0, 180), href: `/goals/${g.id}`, tag: `goal-run-${r.id}` });
  } else if (status === 'error' && r.retry_at) {
    // A passing failure with one automatic retry coming (Phase 19): the step stays "doing"; the timeline says so.
    G.addEvent(g, { kind: 'note', iconName: 'rotate-cw', title: `Hit a snag on “${task?.title || r.origin_label}”, trying again soon`, detail: error, href: `/chat/${r.thread_id}` });
  } else if (status === 'error' || status === 'cancelled') {
    if (task?.kind === 'once') G.setTask(task.id, { status: status === 'error' ? 'failed' : 'todo', enabled: 0 });
    if (status === 'error') G.addEvent(g, { kind: 'note', iconName: 'triangle-alert', title: `Couldn’t finish “${task?.title || r.origin_label}”`, detail: error, href: `/chat/${r.thread_id}` });
  }
  // A fresh, honest status soon after real work happened.
  if (g.state === 'active' && status === 'done') G.setGoalFields(g.id, { next_review_at: new Date(Date.now() + 60000).toISOString() });
  G.announceGoal(g.user_id, g.id);
});

// A retry (by hand, or the automatic one after a passing failure) takes over the failed run's step: it's being worked on again.
onRunRetried((old, r) => {
  if (!old.goal_id) return;
  sql(`UPDATE goal_tasks SET run_id = ?, status = 'doing', enabled = 1 WHERE run_id = ? AND kind = 'once'`, r.id, old.id);
  G.announceGoal(old.user_id, old.goal_id);
});

// ---- Review (check-in) ------------------------------------------------------------------------------------------
export const reviewGoal = g => job(g, 'review', async () => {
  const user = getUser(g.user_id);
  const tasks = G.tasksOf(g);
  const events = G.eventsOf(g, 25).reverse();
  const tz = tzOf(user);
  const measures = G.measuresOf(g).map(m => G.measureView(m, { tz }));
  const streak = G.streakOf(g, { tz });
  const num = new Map(tasks.map((t, i) => [t.id, i + 1]));
  const planLine = t => `${num.get(t.id)}. [${t.status}${t.enabled ? ', on' : ''}] ${t.title}${t.kind === 'recurring' ? ` (${t.repeat})` : ''}`
    + `${t.done_when ? ` · done when: ${t.done_when}` : ''}${G.afterIdsOf(t).length ? ` · after ${G.afterIdsOf(t).map(id => num.get(id)).filter(Boolean).join(', ')}` : ''}`;
  const out = await ask(user, REVIEW_PROMPT,
    `GOAL: ${g.title}\nSUMMARY SO FAR: ${g.summary || '(none)'}\nPROGRESS SO FAR: ${g.progress}%\nTHEIR ANSWERS:\n${answersText(g)}\n\n`
    + `PLAN:\n${tasks.map(planLine).join('\n') || '(none)'}\n\n`
    + `MEASURES:\n${measures.map(m => `- ${m.line}${m.progress != null ? ` → ${m.progress}% of the way` : ''}`).join('\n') || '(none)'}\n`
    + `STREAK: ${streak.count ? `${streak.count} ${streak.cadence}${streak.count > 1 ? 's' : ''} in a row with something done` : 'none right now'}\n\n`
    + `TIMELINE:\n${events.map(e => `- ${e.at} ${e.title}${e.detail ? ` — ${e.detail.slice(0, 200)}` : ''}`).join('\n')}\n\n${knownAbout(user)}\n\n`
    + `ICONS: ${G.TASK_ICONS.join(', ')}`, 'goals', 2000);
  // Their own numbers beat an estimate: with a measure that has a start and a target, progress is computed (#183).
  const computed = G.measureProgress(g);
  const progress = computed ?? Math.max(0, Math.min(100, Math.round(Number(out.progress) || 0)));
  const added = G.addTasks(g, (out.new_steps || []).slice(0, 2), 'agent', { refsTo: 'existing' });
  G.setProgress(G.getGoal(g.id), out.done ? 100 : progress); // crossing 25/50/75% puts a milestone on the timeline, once
  G.setGoalFields(g.id, {
    status_line: String(out.status_line || g.status_line || '').slice(0, 140) || null,
    summary: String(out.summary || g.summary || '').slice(0, 600) || null, next_step: String(out.next_step || '').slice(0, 120) || null,
    last_review_at: new Date().toISOString(),
    next_review_at: new Date(Date.now() + (g.horizon === 'long' ? REVIEW_LONG_MS : REVIEW_EVERY_MS)).toISOString(),
  });
  G.addEvent(g, { kind: 'checkin', iconName: 'refresh-cw', title: 'Checked in', detail: [out.status_line, added.length ? `Added ${added.length} new idea${added.length > 1 ? 's' : ''} to the plan.` : null].filter(Boolean).join(' ') });
  if (out.done && g.state === 'active') {
    G.updateGoal(G.getGoal(g.id), { state: 'done' });
    notify(user.id, { kind: 'message', title: 'Goal reached 🎉', body: g.title, href: `/goals/${g.id}`, tag: `goal-done-${g.id}` });
  }
});

// ---- Reflection: Ideas + suggested goals -----------------------------------------------------------------------
const reflecting = new Set();
export const isReflecting = userId => reflecting.has(userId);

/** Returns the ideas it added. `force` = the person pressed "Think of more" (runs even without new messages). */
export async function reflect(user, { force = false } = {}) {
  if (reflecting.has(user.id)) throw Object.assign(new Error('Already thinking — give me a moment.'), { status: 409 });
  reflecting.add(user.id);
  try {
    const cursor = get('SELECT reflected_msg_id FROM users WHERE id = ?', user.id)?.reflected_msg_id || 0;
    const since = force ? 0 : cursor;
    // Off-the-record chats (and stretches that were) never feed ideas either (#123).
    const msgs = all(`SELECT m.id, m.thread_id, m.content FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.user_id = ? AND t.deleted_at IS NULL AND t.no_memory = 0 AND m.id > COALESCE(t.no_memory_upto, 0) AND m.role = 'user' AND m.id > ?
      ORDER BY m.id DESC LIMIT 60`, user.id, since).reverse();
    let budget = 12000;
    const convo = [];
    for (const m of [...msgs].reverse()) { // newest first until the budget runs out, then back in order
      const line = `#${m.id}: ${m.content.replace(/\s+/g, ' ').slice(0, 600)}`;
      if ((budget -= line.length) < 0) break;
      convo.unshift(line);
    }
    const goals = all(`SELECT title, state FROM goals WHERE user_id = ?`, user.id);
    const out = await ask(user, REFLECT_PROMPT.replace('CATEGORIES', IDEA_CATEGORIES.join(', ')).replace('ICONS', IDEA_ICONS.join(', ')),
      `RECENT MESSAGES FROM THEM:\n${convo.join('\n') || '(none yet)'}\n\n${knownAbout(user)}\n\n`
      + `ALREADY SUGGESTED:\n${ideaTitles(user).map(i => `- ${i.title} (${i.state})`).join('\n') || '(none)'}\n\n`
      + `${G.turnedDownBlock(user, 20) || 'TURNED DOWN (with why): (none)'}\n\n`
      + `GOALS:\n${goals.map(g => `- ${g.title} (${g.state})`).join('\n') || '(none)'}`, 'ideas', 2500);
    const byId = new Map(msgs.map(m => [m.id, m]));
    const ideas = (out.ideas || []).slice(0, 5).map(i => {
      const src = byId.get(Number(i.from));
      return addIdea(user, { ...i, sourceThreadId: src?.thread_id, sourceMessageId: src?.id });
    }).filter(Boolean);
    const have = new Set(goals.map(g => g.title.toLowerCase()));
    let suggested = 0;
    for (const s of (out.goals || []).slice(0, 2)) {
      if (!s?.title || have.has(String(s.title).toLowerCase())) continue;
      try { G.createGoal({ user, title: s.title, category: s.category, createdBy: 'reflection', state: 'suggested', why: s.why }); suggested++; } catch { /* too short */ }
    }
    sql('UPDATE users SET reflected_at = ?, reflected_msg_id = ? WHERE id = ?', new Date().toISOString(),
      Math.max(cursor, msgs.at(-1)?.id || 0), user.id);
    if (ideas.length) publish(user.id, 'ideas.updated', { added: ideas.length });
    if (suggested) publish(user.id, 'goal.updated', { suggested }, { persist: false });
    if (ideas.length || suggested) {
      logActivity(user.id, { kind: 'task', icon: 'lightbulb', href: ideas.length ? '/ideas' : '/goals',
        title: [ideas.length && `Thought of ${ideas.length} idea${ideas.length > 1 ? 's' : ''} for you`, suggested && `noticed ${suggested} possible goal${suggested > 1 ? 's' : ''}`].filter(Boolean).join(' and ') });
    }
    return ideas;
  } finally { reflecting.delete(user.id); }
}

// ---- Driving the jobs ---------------------------------------------------------------------------------------------
/** Run whatever this goal needs next (questions, plan) — called by routes right away and by the tick. */
export function kick(g) {
  if (!g || g.state !== 'active' || g.error || inflight.has(g.id)) return;
  const user = getUser(g.user_id);
  if (!canWork(user)) return;
  if (g.stage === 'intake' && !g.intake) prepareIntake(g);
  else if (g.stage === 'planning') buildPlan(g);
}

export function checkInNow(g) {
  if (inflight.has(g.id)) return;
  if (g.stage !== 'ready') return kick(g);
  reviewGoal(g);
}

// ---- Lapses: one gentle nudge (decision #183) ----------------------------------------------------------------------
// A rhythm they set ("3 runs a week") with nothing logged for twice its usual gap: at most one friendly "how's it going?"
// a day per person, one per lapse (G.lapseOf), never in quiet hours or with check-ins off. The decision model (use
// `checkin`) first asks whether it would be welcome now (not when they said they're ill, away or taking a break); when it
// is off or unsure, the rule above decides. A miss is never announced and a streak just starts again.
const LAPSE_EVERY_MS = 864e5;
const lapseAsked = new Map(); // goal id → when the decision model last said "not now" (asked again a day later)

async function nudgeWelcome(user, g, lapse) {
  const recent = all(`SELECT m.role, m.content, m.created_at FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.user_id = ?
    AND t.deleted_at IS NULL AND m.role IN ('user', 'assistant') AND m.tool_calls IS NULL AND trim(m.content) != '' ORDER BY m.id DESC LIMIT 10`, user.id).reverse();
  const m = lapse.measure;
  const res = await decide('checkin', {
    user, timeoutMs: 4000,
    state: { goal: g.title, rhythm: `${m.label}: ${m.per_week} a week`, this_week: `${G.weekCount(m, { tz: tzOf(user) })} so far`,
      last_logged: lapse.lastAt ? `${lapse.idleDays} days ago` : 'never yet',
      recent_chat: recent.map(x => `${x.created_at} ${x.role === 'user' ? 'Them' : 'Jess'}: ${String(x.content).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') || '(no recent chat)' },
    questions: { welcome: noul('Would a short, friendly "how is it going?" nudge about this goal be welcome right now? Not if `recent_chat` '
      + 'shows they are ill, injured, travelling, grieving or taking a deliberate break, have dropped or paused this goal, or already '
      + 'said they did it recently.') },
  });
  if (!res) return true;
  const p = yes(res.answers.welcome);
  const skip = p != null && p <= 1 - threshold();
  noteDecision(res.id, skip ? `goal “${g.title.slice(0, 40)}”: no nudge now (${p.toFixed(2)})` : `goal “${g.title.slice(0, 40)}”: gentle nudge`,
    { confidence: p == null ? null : skip ? 1 - p : p });
  return !skip;
}

/** Look for lapses and send at most one nudge per person (exported for tests). Returns the goals nudged. */
export async function nudgeLapses(now = new Date()) {
  const nudged = [];
  const seen = new Set();
  const rows = all(`SELECT g.* FROM goals g WHERE g.state = 'active' AND g.stage = 'ready'
    AND EXISTS (SELECT 1 FROM goal_measures m WHERE m.goal_id = g.id AND m.per_week IS NOT NULL) ORDER BY g.user_id, g.id`);
  for (const g of rows) {
    if (seen.has(g.user_id)) continue;
    const user = getUser(g.user_id);
    const p = effectivePolicy(user);
    const checkins = get('SELECT checkins FROM users WHERE id = ?', g.user_id)?.checkins || 'normal'; // not in getUser's columns
    if (!canWork(user) || checkins === 'off' || inQuietHours(p.quietStart, p.quietEnd, tzOf(user), now)) { seen.add(g.user_id); continue; }
    const last = get('SELECT MAX(lapse_hint_at) AS at FROM goals WHERE user_id = ?', user.id)?.at;
    if (last && now - new Date(last) < LAPSE_EVERY_MS) { seen.add(g.user_id); continue; } // one a day per person
    if (lapseAsked.has(g.id) && now - lapseAsked.get(g.id) < LAPSE_EVERY_MS) continue;
    const lapse = G.lapseOf(g, { now, tz: tzOf(user) });
    if (!lapse) continue;
    seen.add(g.user_id);
    if (!(await nudgeWelcome(user, g, lapse))) { lapseAsked.set(g.id, now); continue; }
    lapseAsked.delete(g.id);
    notify(user.id, { kind: 'message', title: `How’s “${g.title}” going?`, href: `/goals/${g.id}`, tag: `goal-lapse-${g.id}`,
      body: 'No pressure. When you’ve had a chance, tell me how it went and I’ll log it.' });
    G.addEvent(g, { kind: 'note', iconName: 'bell', title: 'Checked in gently',
      detail: lapse.lastAt ? `Last ${lapse.measure.label.toLowerCase()} logged ${lapse.idleDays} days ago.` : `Nothing logged for ${lapse.measure.label.toLowerCase()} yet.` });
    G.setGoalFields(g.id, { lapse_hint_at: now.toISOString() });
    G.announceGoal(user.id, g.id);
    nudged.push(g.id);
  }
  return nudged;
}

let ticking = false;
export async function goalsTick(now = new Date()) {
  if (ticking) return;
  ticking = true;
  try {
    // Unfinished intake/plan jobs (after a restart, or a goal made by the agent).
    for (const g of all(`SELECT * FROM goals WHERE state = 'active' AND error IS NULL AND ((stage = 'intake' AND intake IS NULL) OR stage = 'planning') LIMIT 5`)) kick(g);
    // One due check-in per tick, outside quiet hours.
    for (const g of all(`SELECT * FROM goals WHERE state = 'active' AND stage = 'ready' AND next_review_at <= ? ORDER BY next_review_at LIMIT 5`, now.toISOString())) {
      const user = getUser(g.user_id);
      const p = effectivePolicy(user);
      if (!canWork(user) || inQuietHours(p.quietStart, p.quietEnd, tzOf(user), now) || inflight.has(g.id)) continue;
      // Nothing happened since the last check-in (decision model, #107): look again after the usual interval.
      if (!(await worthReviewing(user, g, G.eventsOf(g, 25), G.tasksOf(g)))) {
        G.setGoalFields(g.id, { next_review_at: new Date(Date.now() + (g.horizon === 'long' ? REVIEW_LONG_MS : REVIEW_EVERY_MS)).toISOString() });
        continue;
      }
      await reviewGoal(g);
      break;
    }
    await nudgeLapses(now);
    // One reflection per tick, for someone with enough new conversation since the last one.
    for (const row of all(`SELECT id, reflected_msg_id FROM users WHERE status = 'active' AND (reflected_at IS NULL OR reflected_at <= ?)`, new Date(now - REFLECT_EVERY_MS).toISOString())) {
      const fresh = get(`SELECT COUNT(*) AS n FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.user_id = ? AND m.role = 'user' AND m.id > ?`, row.id, row.reflected_msg_id).n;
      const u = getUser(row.id);
      const p = effectivePolicy(u);
      if (fresh < REFLECT_MIN_MESSAGES || !canWork(u) || inQuietHours(p.quietStart, p.quietEnd, tzOf(u), now)) continue;
      // Nothing new an idea could help with (decision model, #107): move the cursor on without the full model.
      if (!(await worthReflecting(u, row.reflected_msg_id || 0))) {
        const last = get(`SELECT MAX(m.id) AS id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.user_id = ? AND m.role = 'user'`, u.id)?.id || 0;
        sql('UPDATE users SET reflected_at = ?, reflected_msg_id = ? WHERE id = ?', new Date().toISOString(), Math.max(row.reflected_msg_id || 0, last), u.id);
        continue;
      }
      await reflect(u).catch(err => console.warn('[ideas]', err.message));
      break;
    }
    // Overnight prep (#199): "Ready for you" after quiet hours, and at most one idea prepared for someone asleep who opted in.
    await prepTick(now).catch(err => console.warn('[prep]', err.message));
  } finally { ticking = false; }
}
