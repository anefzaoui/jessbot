// The scheduler (decisions #28, #32, #48): one timer sleeps until the next due alarm / schedule (≤ 60 s), fires what
// is due, and goes back to sleep. Everything lives in SQLite, so restarts lose nothing: at boot, whatever came due
// while the server was down is caught up (alarms missed by more than MISSED_AFTER are reported, not rung late).
import crypto from 'node:crypto';
import { get, all, run as sql } from '../db/index.js';
import { addMessage } from '../services/messages.js';
import * as runs from '../services/runs.js';
import { getUser } from '../services/users.js';
import { mainThread, touchThread } from '../services/threads.js';
import { llmSettings } from '../services/llm.js';
import { publish } from '../lib/bus.js';
import { notify } from '../services/notify.js';
import { logActivity } from '../services/activity.js';
import { effectivePolicy, overBudget } from '../services/policy.js';
import { assistantView } from '../services/chatview.js';
import { renderFragment } from '../views/render.js';
import { inQuietHours, tzOf, localLabel } from '../lib/when.js';
import * as alarms from '../services/alarms.js';
import * as schedules from '../services/schedules.js';
import { fireReminder } from './reminders.js';
import { enqueueRun, closeWaitingRun, runDueRetries, nextRetryAt, onRunFinished } from './loop.js';
import { readPage } from '../browser/read.js';
import { fence } from '../lib/untrusted.js';
import * as weather from '../services/weather.js';
import { runDueExtractions } from '../services/context.js';
import { markAlerted } from '../services/places.js';
import { browserStatus } from '../browser/index.js';
import { feedTick } from './feed.js';
import { goalsTick } from './goals.js';
import { tidyProjects } from './projects.js';
import { memoryTidyTick } from './memory-tidy.js';
import { selfReviewTick } from './self-review.js';
import { whatsNewTick } from '../services/whats-new.js';
import { recoverDigests } from '../services/feed.js';
import { syncUser as syncCalendars } from '../services/calendar.js';
import { worthCheckin } from './sense.js';
import { checkBudgetAlerts, checkSpendSpike, refreshBalance } from '../services/spend-watch.js';
import { pendingNotes, claimNotes, deliverNotesOf, markDelivered, notesBlock, notesMessage } from '../services/notes.js';

const MISSED_AFTER_MS = 15 * 60000;      // an alarm this late isn't rung — it's reported as missed
const TASK_GRACE_MS = 2 * 3600000;       // a scheduled task this late is skipped to its next occurrence

export const CHECKIN_PROMPT = `[Check-in — you are reaching out on your own initiative; the person has not written anything.]
Look at what you know right now: the time and day, their routines and schedule (memory), what's coming up (alarms, reminders, scheduled tasks), recent conversation, and anything you offered to follow up on. If there is something genuinely useful to say now — a timely heads-up, a conflict or risk you noticed, a helpful next step, a follow-up on something they mentioned — send ONE short, warm message (1–3 sentences) that stands on its own. You may use tools first if that helps. If nothing is worth interrupting them for, reply with exactly: NOTHING`;

let timer = null;
let ticking = false;

let lastSync = 0;
/** Each person's check-in row follows their preference, timezone and account status (new people included). */
export function syncCheckins(user = null) {
  for (const u of user ? [user] : all('SELECT * FROM users')) schedules.ensureCheckin(u);
  lastSync = Date.now();
}

export function startScheduler() {
  syncCheckins();
  recoverDigests();
  tick();
}

/** Something was created or changed: re-plan the next wake-up now. */
export function pokeScheduler() {
  clearTimeout(timer);
  timer = setTimeout(tick, 50);
}

let lastTickAt = null;
/** For Admin → System's health check: when the scheduler last woke up. */
export const schedulerHealth = () => ({ lastTickAt });

async function tick() {
  clearTimeout(timer);
  lastTickAt = new Date().toISOString();
  if (ticking) return pokeLater(1000);
  ticking = true;
  try {
    // Hourly full sync (timezone / preference changes); new people get their check-in right away.
    if (Date.now() - lastSync > 3600000) syncCheckins();
    else for (const u of all(`SELECT * FROM users WHERE status = 'active' AND id NOT IN (SELECT user_id FROM schedules WHERE kind = 'checkin')`)) schedules.ensureCheckin(u);
    await runDue(new Date());
  } finally { ticking = false; }
  refreshWeather().catch(err => console.warn('[weather]', err.message)); // background, never blocks alarms
  runDueExtractions().catch(err => console.warn('[memory]', err.message));
  spendTick().catch(err => console.warn('[spend]', err.message));
  if (browserStatus().installed) feedTick().catch(err => console.warn('[feed]', err.message));
  goalsTick().catch(err => console.warn('[goals]', err.message));
  tidyProjects().catch(err => console.warn('[projects] tidy', err.message)); // weekly, one project per tick
  memoryTidyTick().catch(err => console.warn('[memory] tidy', err.message)); // weekly per person, in their quiet hours (#189)
  selfReviewTick().catch(err => console.warn('[self-review]', err.message)); // weekly for the owner when switched on (#208)
  whatsNewTick().catch(err => console.warn('[whats-new]', err.message)); // a release's notes drafted once, for the admin (#210)
  deliverNotesWithoutCheckins().catch(err => console.warn('[notes]', err.message)); // notes for someone with check-ins off (#200)
  // Calendars: refreshed every 15 minutes for everyone who connected one (their prompt and Upcoming read the cache).
  for (const u of all(`SELECT DISTINCT u.* FROM users u JOIN connections c ON c.user_id = u.id AND c.kind = 'calendar' WHERE u.status = 'active'`)) {
    syncCalendars(u).catch(err => console.warn('[calendar]', err.message));
  }
  const next = [alarms.nextAlarmAt(), schedules.nextScheduleAt(), nextRingExpiry(), nextRetryAt()].filter(Boolean).map(t => new Date(t).getTime());
  pokeLater(next.length ? Math.min(...next) - Date.now() : 60000);
}

/** Fire everything due at `now` (exported for tests). */
export async function runDue(now = new Date()) {
  for (const a of alarms.dueAlarms(now)) await fireAlarm(a, now).catch(e => console.error('[scheduler] alarm', a.id, e));
  for (const a of alarms.staleRinging(now)) alarms.missAlarm(a, now);
  for (const s of schedules.dueSchedules(now)) await fireSchedule(s, now).catch(e => console.error('[scheduler] schedule', s.id, e));
  await runDueRetries(now); // the one automatic retry of an unattended run after a passing failure (Phase 19)
}

function pokeLater(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, Math.max(200, Math.min(60000, ms)));
  timer.unref?.();
}

function nextRingExpiry() {
  const t = get(`SELECT MIN(rang_at) AS t FROM alarms WHERE status = 'ringing'`)?.t;
  return t ? new Date(new Date(t).getTime() + alarms.RING_MINUTES * 60000).toISOString() : null;
}

// ---- Spend watch (decisions #178, #179): budget alerts for spend outside chats (feed, goals, memory), the admin's unusual-day
// alert, and the OpenRouter balance, at most every 10 minutes (the balance itself every few hours, services/spend-watch.js).
let lastSpend = 0;
async function spendTick(now = new Date()) {
  if (now - lastSpend < 10 * 60000) return;
  lastSpend = now.getTime();
  for (const u of all(`SELECT * FROM users WHERE status = 'active'`)) checkBudgetAlerts(getUser(u.id), now);
  checkSpendSpike(now);
  await refreshBalance({ now });
}

// ---- Scheduled tasks that keep failing pause themselves (decision #178) ---------------------------------------------------
// Three final failures in a row (after the one automatic retry; a restart, the budget or a Stop don't count) pause the task,
// with one note in its chat and a push: nobody is watching it, and it would otherwise fail (and cost) every day. Watches
// count their own failed checks (fail_streak) and offer another way instead. Resuming in Upcoming starts the count over.
export const FAIL_PAUSE = schedules.FAIL_PAUSE;
onRunFinished(async (r, status, { error }) => {
  if (!r?.schedule_id || r.origin !== 'schedule' || r.watch || r.hidden) return;
  const s = schedules.getSchedule(r.schedule_id);
  if (!s || s.kind !== 'task' || schedules.isWatch(s)) return;
  if (status === 'done') { if (s.fail_streak) schedules.recordTaskOutcome(s.id, true); return; }
  if (status !== 'error' || r.retry_at || !['transient', 'permanent'].includes(r.error_kind)) return;
  const streak = schedules.recordTaskOutcome(s.id, false);
  if (streak < FAIL_PAUSE || s.paused) return;
  schedules.pauseSchedule(s, true);
  const user = getUser(r.user_id);
  const why = String(error || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  await postNote(user, {
    threadId: r.thread_id, origin: 'schedule', originLabel: s.title, scheduleId: s.id, errorKind: 'paused',
    system: `[Scheduled task “${s.title}” failed ${streak} times in a row, so it was paused. It won't run again until the person resumes it in Upcoming.]`,
    text: `I’ve paused **${s.title}**: it failed ${streak} times in a row${why ? ` (last time: ${why})` : ''}. Resume it in [Upcoming](/upcoming) `
      + 'when it should run again, or tell me what to change.',
  });
  notify(user.id, { kind: 'schedule', title: `Paused “${s.title}”`, body: `It failed ${streak} times in a row. Resume it in Upcoming when it should run again.`,
    href: '/upcoming', tag: `schedule-paused-${s.id}` });
  logActivity(user.id, { kind: 'schedule', icon: 'calendar-x', status: 'warn', href: '/upcoming', title: `Paused “${s.title.slice(0, 60)}” after ${streak} failures` });
});

// ---- Notes for later (decision #200) -------------------------------------------------------------------------------------
// A check-in that posted delivered the notes it carried (once). One that stayed silent (NOTHING leaves no trace and no hook),
// failed or was stopped leaves them for the next check-in.
onRunFinished(r => {
  if (r?.origin === 'checkin' && r.status === 'done' && !r.hidden) deliverNotesOf(r.id);
});

// Someone with check-ins off still gets what their background work left: one plain message (no model call) after their quiet
// hours, when nothing else is running for them. At most every 10 minutes.
let lastNotes = 0;
export async function deliverNotesWithoutCheckins(now = new Date()) {
  if (now - lastNotes < 10 * 60000) return 0;
  lastNotes = now.getTime();
  let sent = 0;
  for (const row of all(`SELECT DISTINCT u.id FROM users u JOIN notes n ON n.user_id = u.id AND n.delivered_at IS NULL
    WHERE u.status = 'active' AND u.checkins = 'off'`)) {
    const user = getUser(row.id);
    const p = effectivePolicy(user);
    if (inQuietHours(p.quietStart, p.quietEnd, tzOf(user), now) || busy(user.id)) continue;
    const notes = pendingNotes(user, { limit: 5 });
    if (!notes.length) continue;
    await postNote(user, { origin: 'checkin', originLabel: 'Notes', text: notesMessage(notes),
      system: `[Notes that background tasks left for them, delivered as they were written (check-ins are off): ${notes.length}.]` });
    markDelivered(notes);
    notify(user.id, { kind: 'message', title: notes.length === 1 ? 'A note from my background work' : `${notes.length} notes from my background work`,
      body: notes[0].text.slice(0, 180), href: '/chat', tag: `notes-${notes[0].id}` });
    sent++;
  }
  return sent;
}

// ---- Alarms, timers, reminders -----------------------------------------------------------------------------
async function fireAlarm(a, now) {
  const user = getUser(a.user_id);
  if (!user || user.status !== 'active') return alarms.cancelAlarm(a);
  const late = now.getTime() - new Date(a.fire_at).getTime();
  const v = alarms.alarmView(a, now);

  // Reminders post a note, and with follow_up keep nudging until they're done (agent/reminders.js, decision #190).
  if (a.kind === 'reminder') return fireReminder(user, a, now, { late: late > MISSED_AFTER_MS });

  if (late > MISSED_AFTER_MS) {
    notify(user.id, { kind: a.kind, title: `Missed ${v.noun.toLowerCase()}`, body: `${v.label} — ${localLabel(a.fire_at, a.timezone, now)} (I was offline)`, href: '/upcoming', tag: `alarm-${a.id}` });
    return alarms.missAlarm(a, now);
  }
  const ringing = alarms.startRinging(a, now);
  publish(user.id, 'alarm.ring', { alarm: alarms.alarmView(ringing, now) });
  publish(user.id, 'agent.moment', { kind: 'surprise' }, { persist: false });
  notify(user.id, { kind: a.kind, title: a.kind === 'timer' ? 'Timer done' : 'Alarm', body: v.label, href: '/upcoming', tag: `alarm-${a.id}` });
  logActivity(user.id, { kind: 'schedule', icon: v.iconName, title: `${v.noun} rang: “${v.label.slice(0, 60)}”`, href: '/upcoming' });
}

// ---- Scheduled tasks and check-ins --------------------------------------------------------------------------
// Nobody is there to answer: a question mid-task leaves it hanging (it did — "which topics for your morning brief?").
// Assume sensibly from what's known, say what was assumed in one line, and let them adjust it afterwards. #83 as amended
// (Phase 19): ONE question is allowed, as the very last step, when a decision that is truly theirs remains (the loop
// refuses it earlier or twice; it expires when the task runs next or they send a message).
export const UNATTENDED = 'Do it now and reply with the result, ready to read. They are not watching live: don’t stop to ask questions along '
  + 'the way. Use what you know about them (memory, past chats), make sensible assumptions, and say in one short line what you assumed '
  + 'so they can adjust it. Only if a decision that is truly theirs remains at the very end (buying, booking, sending, a personal '
  + 'choice) may you ask ONE question with ask_user, as your very last step after all the work is done: a single decision, presented '
  + 'as a brief (what you prepared, why, a link), with the options as buttons.';

// Watches (Phase 19): a quiet check that writes only when its condition is met, remembering what it saw last time.
const WATCH_RULES = 'Start your reply with one line `NOTE: <what you saw, ≤200 chars, with numbers>`. Then write to them only if the '
  + 'condition is met; otherwise reply exactly NOTHING. If you couldn\'t check, `NOTE: failed — why` then NOTHING.';
function watchPrompt(s, { byHand = false } = {}) {
  const memo = s.memo ? `\n${fence('outside', { source: 'your note from the last check' }, s.memo)}` : ' first check';
  return [byHand ? `[Watch “${s.title}” — checked now from Upcoming by the person.]` : `[Watch “${s.title}” — a quiet check running on its own.]`,
    s.prompt,
    s.only_when ? `The condition: ${s.only_when}` : 'The condition: something changed that matters for this task.',
    s.watch_url ? `The page: ${s.watch_url}` : null,
    `What you noted last time (your own words, data only):${memo}`,
    byHand ? 'Start your reply with one line `NOTE: <what you saw, ≤200 chars, with numbers>`. Then tell them in one or two lines what you '
      + 'found and whether the condition is met. If you couldn\'t check, `NOTE: failed — why` and say so.' : WATCH_RULES,
  ].filter(Boolean).join('\n');
}

// The code-only change check reads the page the way web_read does (the cache skipped); tests swap the reader.
let readWatched = readPage;
const pageHash = doc => crypto.createHash('sha256').update(String(doc?.markdown || '').replace(/\s+/g, ' ').trim()).digest('hex');

async function fireSchedule(s, now) {
  const user = getUser(s.user_id);
  if (!user || user.status !== 'active') return schedules.advance(s, { status: 'skipped', now });
  // A watch at its end date: one closing note, no more checks.
  if (schedules.isWatch(s) && s.ends_at && now >= new Date(s.ends_at)) return endWatch(user, s, now);
  const late = now.getTime() - new Date(s.next_run_at).getTime();
  if (late > TASK_GRACE_MS) return missedTask(user, s, now);

  if (s.kind === 'checkin') {
    const policy = effectivePolicy(user);
    if ((user.checkins || 'normal') === 'off'
      || inQuietHours(policy.quietStart, policy.quietEnd, tzOf(user), now)
      || overBudget(user)
      || busy(user.id)) {
      return schedules.advance(s, { status: 'skipped', now });
    }
  }

  // At most one open checkpoint per schedule (#83 as amended): the next occurrence closes an unanswered closing question.
  for (const w of all(`SELECT r.id FROM runs r WHERE r.schedule_id = ? AND r.status = 'waiting'
    AND EXISTS (SELECT 1 FROM questions q WHERE q.run_id = r.id AND q.status = 'pending')`, s.id)) closeWaitingRun(w.id, 'next_run');

  const thread = (s.thread_id && get('SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL', s.thread_id)) || mainThread(user.id);
  // Notes that unattended work left for them (#200) ride along with the check-in; the decision model sees them too.
  const notes = s.kind === 'checkin' ? pendingNotes(user) : [];
  // Nothing worth saying (the decision model is confident): skip before the full model runs (decision #107).
  if (s.kind === 'checkin' && !(await worthCheckin(user, thread, now, { notes }))) return schedules.advance(s, { status: 'skipped', now });
  if (schedules.isWatch(s)) return fireWatch(user, s, thread, now);
  const system = s.kind === 'checkin' ? [CHECKIN_PROMPT, notesBlock(notes)].filter(Boolean).join('\n\n')
    : `[Scheduled task “${s.title}” — running on its own, as the person asked; they are not watching live.]\n${s.prompt}\n${UNATTENDED}`;
  const trigger = addMessage({ threadId: thread.id, role: 'system', content: system });
  const r = runs.createRun({ threadId: thread.id, userId: user.id, triggerMessageId: trigger.id, model: llmSettings().model,
    origin: s.kind === 'checkin' ? 'checkin' : 'schedule', originLabel: s.kind === 'checkin' ? 'Check-in' : s.title, goalId: s.goal_id || null,
    scheduleId: s.id });
  claimNotes(notes, r.id); // delivered once, when this check-in posts (the hook below)
  // Its status is recorded when the run FINISHES (ok, silent, bad), not now: a run that fails must not read "ok".
  schedules.advance(s, { runId: r.id, now });
  // Scheduled tasks show up live in an open chat; check-ins only appear if they have something to say.
  if (s.kind === 'task') await announceRun(user, r);
  enqueueRun(r.id);
}

// A watch's check: within the weekly budget (else skipped, quietly), and when it watches a page whose readable text hasn't
// changed since the last good check, no model call at all ("checked, no change"). No live bubble: it speaks only when
// the condition is met (the loop's finishWatch).
async function fireWatch(user, s, thread, now) {
  if (overBudget(user)) return schedules.advance(s, { status: 'skipped', now });
  let hash = null;
  if (s.watch_url) {
    try { hash = pageHash(await readWatched(s.watch_url, { userId: user.id, fresh: true })); } catch { hash = null; } // the model tries other ways
    if (hash && s.memo && hash === s.watch_hash) return schedules.advance(s, { status: 'silent', now, check: 'unchanged' });
  }
  const trigger = addMessage({ threadId: thread.id, role: 'system', content: watchPrompt(s) });
  const r = runs.createRun({ threadId: thread.id, userId: user.id, triggerMessageId: trigger.id, model: llmSettings().model,
    origin: 'schedule', originLabel: s.title, goalId: s.goal_id || null, scheduleId: s.id, watch: true });
  if (hash) schedules.stageWatchHash(r.id, hash);
  schedules.advance(s, { runId: r.id, now });
  enqueueRun(r.id);
}

// A task more than 2 h late (the server was off, #48) is skipped to its next occurrence, and it says so once, with a way
// to run it now: kept distinct as "skipped" (never shown as ok). Running it late by itself was rejected: a morning brief
// at 15:00 is stale, costs a full run, and may act on old assumptions; one tap does it when they still want it.
// Check-ins and watches just move on (the next check covers it).
async function missedTask(user, s, now) {
  const next = schedules.advance(s, { status: 'skipped', now, check: schedules.isWatch(s) ? 'missed' : null });
  if (s.kind !== 'task' || schedules.isWatch(s)) return next;
  const when = localLabel(s.next_run_at, s.timezone, now);
  const r = await postNote(user, {
    threadId: s.thread_id, origin: 'schedule', originLabel: s.title, scheduleId: s.id, errorKind: 'missed',
    system: `[Scheduled task “${s.title}” was due ${when} but did not run: the server was offline then. Nothing was done for it.]`,
    text: `I was offline when **${s.title}** was due (${when}), so it didn’t run. Want it now? [Run it now](/upcoming)`,
  });
  logActivity(user.id, { kind: 'schedule', icon: 'calendar-x', status: 'warn', runId: r.id, href: '/upcoming', title: `Missed “${s.title.slice(0, 60)}” (I was offline)` });
  return next;
}

// A watch that reached its `until` day: stops, with one closing note (what it saw last).
async function endWatch(user, s, now) {
  schedules.endSchedule(s);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: s.timezone, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(s.ends_at));
  await postNote(user, {
    threadId: s.thread_id, origin: 'schedule', originLabel: s.title, scheduleId: s.id,
    system: `[Watch “${s.title}” reached its end date and stopped. Nothing more will be checked.]`,
    text: `I’ve stopped watching **${s.title}**: it was set to run until ${day}.${s.memo ? ` Last thing I saw: ${s.memo}` : ''}`,
  });
  notify(user.id, { kind: 'schedule', title: `Stopped watching “${s.title}”`, body: s.memo || 'It reached its end date.', href: '/chat', tag: `watch-end-${s.id}` });
  return schedules.getSchedule(s.id);
}

// Someone mid-conversation shouldn't be interrupted by a check-in (nor overnight prep started, #199).
export const busy = userId => !!get(`SELECT 1 FROM runs WHERE user_id = ? AND status IN ('queued', 'running', 'waiting') LIMIT 1`, userId);

/** A run Jess started on her own shows up live in an open chat (a scheduled task, a background task). */
export async function announceRun(user, r) {
  const html = await renderFragment('chat/message', assistantView(runs.getRun(r.id), user), user).catch(() => null);
  publish(user.id, 'run.started', { html }, { threadId: r.thread_id, runId: r.id });
}

/** A message from Jess without a model call (reminders, a missed task, a watch's end): a finished run with a hidden
 *  system trigger. scheduleId/errorKind: which schedule it's about and what went wrong ('missed'), for "Run it now". */
export async function postNote(user, { threadId, origin, originLabel, system, text, scheduleId = null, errorKind = null }) {
  const thread = (threadId && get('SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL', threadId)) || mainThread(user.id);
  const trigger = addMessage({ threadId: thread.id, role: 'system', content: system });
  const r = runs.createRun({ threadId: thread.id, userId: user.id, triggerMessageId: trigger.id, model: null, origin, originLabel, scheduleId });
  const reply = addMessage({ threadId: thread.id, runId: r.id, role: 'assistant', content: text });
  runs.setReplyMessage(r.id, reply.id);
  sql(`UPDATE runs SET status = 'done', error_kind = ?, ended_at = datetime('now') WHERE id = ?`, errorKind, r.id);
  const html = await renderFragment('chat/message', assistantView(runs.getRun(r.id), user), user).catch(() => null);
  publish(user.id, 'run.done', { status: 'done', html }, { threadId: thread.id, runId: r.id });
  touchThread(thread.id);
  return r;
}


/** "Run now" from Upcoming: same as a due firing, without moving the schedule. */
export async function runScheduleNow(s) {
  const user = getUser(s.user_id);
  const thread = (s.thread_id && get('SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL', s.thread_id)) || mainThread(user.id);
  // A watch run by hand always answers (what it found, condition met or not) and still keeps its NOTE.
  const system = schedules.isWatch(s) ? watchPrompt(s, { byHand: true })
    : `[Scheduled task “${s.title}” — started now from Upcoming by the person.]\n${s.prompt}\nDo it now and reply with the result, ready to read.`;
  const trigger = addMessage({ threadId: thread.id, role: 'system', content: system });
  const r = runs.createRun({ threadId: thread.id, userId: user.id, triggerMessageId: trigger.id, model: llmSettings().model, origin: 'schedule',
    originLabel: s.title, goalId: s.goal_id || null, scheduleId: s.id });
  sql('UPDATE schedules SET last_run_id = ?, last_run_at = ? WHERE id = ?', r.id, new Date().toISOString(), s.id);
  await announceRun(user, r);
  enqueueRun(r.id);
  return r;
}

// ---- Weather: refresh every 30 min per home place, sky updates, one heads-up per rain/snow/storm event ------
const WEATHER_EVERY_MS = 30 * 60000;
let lastWeather = 0, weatherBusy = false;

export async function refreshWeather({ force = false } = {}) {
  if (weatherBusy || (!force && Date.now() - lastWeather < WEATHER_EVERY_MS) || !browserStatus().installed) return;
  weatherBusy = true;
  lastWeather = Date.now();
  try {
    const rows = all(`SELECT p.* FROM places p JOIN users u ON u.id = p.user_id WHERE p.is_primary = 1 AND u.status = 'active'`);
    for (const place of rows) {
      try {
        const f = await weather.forecast(place.latitude, place.longitude);
        const s = weather.sky(f);
        if (s) publish(place.user_id, 'weather.updated', { sky: s, place: place.name }, { persist: false });
        await weatherAlert(getUser(place.user_id), place, f);
      } catch (err) { console.warn('[weather]', place.name, err.message.split('\n')[0]); }
    }
  } finally { weatherBusy = false; }
}

/** Rain/snow/storm likely within 3 h while it's dry now → one message + notification per event (per day and kind). */
export async function weatherAlert(user, place, f, now = new Date()) {
  if (!user || !f) return null;
  if (['rain', 'snow', 'storm'].includes(f.current.bucket) || (f.current.precip ?? 0) >= 0.1) return null;
  const soon = f.hourly.find(x => new Date(x.at) > now && new Date(x.at) - now <= 3 * 3600000
    && ['rain', 'snow', 'storm'].includes(x.bucket) && (x.precipProb ?? 0) >= 60 && (x.bucket === 'storm' || (x.precip ?? 0) >= 0.3));
  if (!soon) return null;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: f.timezone }).format(now);
  const key = `${day}:${soon.bucket}`;
  if (place.alerted_key === key) return null;
  const policy = effectivePolicy(user);
  if (inQuietHours(policy.quietStart, policy.quietEnd, tzOf(user), now)) return null;
  const at = new Intl.DateTimeFormat('en-GB', { timeZone: f.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(soon.at));
  const where = place.name.split(',')[0];
  const what = { rain: ['Rain', 'Worth taking an umbrella if you’re heading out.'], snow: ['Snow', 'Roads and pavements may get slippery.'],
    storm: ['Thunderstorms', 'Best to be indoors around then if you can.'] }[soon.bucket];
  markAlerted(place, key);
  await postNote(user, {
    origin: 'weather', originLabel: 'Weather',
    system: `[Weather heads-up sent automatically: ${what[0].toLowerCase()} likely around ${at} in ${where} (${soon.precipProb}%).]`,
    text: `**Heads-up:** ${what[0].toLowerCase()} likely around **${at}** in ${where} (${soon.precipProb}% chance). ${what[1]}`,
  });
  notify(user.id, { kind: 'message', title: `${what[0]} around ${at}`, body: `${where} · ${soon.precipProb}% chance. ${what[1]}`, href: '/chat', tag: `weather-${place.id}-${key}` });
  logActivity(user.id, { kind: 'task', icon: 'cloud-sun-rain', title: `Warned you: ${what[0].toLowerCase()} around ${at}`, detail: where, href: '/chat' });
  return key;
}

// Unit tests: a stand-in for the page reader behind the watch pre-check (no browser, no network).
export const __test = { setWatchReader: fn => { readWatched = fn || readPage; }, spendTick: now => { lastSpend = 0; return spendTick(now); },
  notesTick: now => { lastNotes = 0; return deliverNotesWithoutCheckins(now); } };
