// The agent loop: one run = stream a reply (maybe calling tools, maybe pausing to ask) until done.
// Runs are server-side jobs: they continue when the browser closes; every step is an event (refresh-proof).
import { get, all, run as sql, settings } from '../db/index.js';
import { getClient, llmSettings, modelChoice, answeredBy } from '../services/llm.js';
import { buildPrompt, timeBlock, upcomingBlock } from './prompt.js';
import { getTool, toolSchemasFor } from './tools/registry.js';
import { addMessage } from '../services/messages.js';
import { expireQuestion } from '../services/questions.js';
import * as runs from '../services/runs.js';
import { getUser } from '../services/users.js';
import { touchThread } from '../services/threads.js';
import { projectOfThread, fileBigPastes, linkPublicIds } from '../services/projects.js';
import { recordUsage } from '../services/usage.js';
import { publish } from '../lib/bus.js';
import { rawMessageTokens, calibrate } from '../lib/tokens.js';
import { maybeCompact, scheduleExtraction } from '../services/context.js';
import { assistantView } from '../services/chatview.js';
import { renderFragment } from '../views/render.js';
import { assess, enabledToolsets, effectivePolicy, riskOf } from '../services/policy.js';
import { createApproval, approvalView, getApproval, expiredApprovals, expireApproval, closeApproval, closeApprovalsOfRun,
  markExecuting } from '../services/approvals.js';
import { getSchedule, isWatch, recordRunResult, recordWatchCheck, MEMO_MAX } from '../services/schedules.js';
import { oneLine } from '../lib/untrusted.js';
import { tzOf } from '../lib/when.js';
import { logActivity } from '../services/activity.js';
import { spentThisWeek, spentOnRuns } from '../services/usage.js';
import { notify } from '../services/notify.js';
import { senseTurn, awaitSense, goalCheck, senseOf, CHECK_LABELS, ISSUE_TAGS } from './sense.js';
import { proposeFastStep, FAST_STREAK } from './fast-steps.js';
import { noteToolRead, taintOf } from './taint.js';
import { auditReply, unmatchedFigures, unmetAsk } from './reply-audit.js';
import { stuckSignal, deadEndNudge, readKey, REPEAT_LIMIT, REPEAT_REFUSAL, errorStreak, REPLAN, checkpoint, failedSteps,
  MAX_DEAD_END_CHECKS, DEAD_END_GAP, CHECKPOINT_EVERY, DEAD_END_LABEL } from './dead-ends.js';
import { noteSources, sourcesOf, sourcesSection, hasSourcesSection, unseenLinks, urlsSeenIn, stripLinks } from '../services/sources.js';
import { runCap, checkBudgetAlerts, providerOutcome } from '../services/spend-watch.js';
import { recordWish } from '../services/wishes.js';
import { supportsReasoning } from '../services/model-price.js';
import { secretsIn, argText } from '../lib/dlp.js';
import { audit } from '../services/audit.js';

const botName = () => settings.get('bot', {}).name || 'Jessbot';
const SILENT = /^\s*NOTHING\s*\.?\s*$/i;

// A check-in (or a quiet watch check) with nothing worth saying leaves no trace in the chat (its hidden prompt and any
// tool steps go too).
async function finishSilently(runId) {
  const r = runs.getRun(runId);
  sql('DELETE FROM messages WHERE run_id = ? OR id = ?', runId, r.trigger_message_id || 0);
  sql(`UPDATE runs SET status = 'done', hidden = 1, draft = NULL, ended_at = datetime('now') WHERE id = ?`, runId);
  recordRunResult(r, 'silent');
  publish(r.user_id, 'run.done', { status: 'done', hidden: true }, { threadId: r.thread_id, runId });
  runs.publishAgentState(r.user_id);
}

// ---- Truthful outcomes (Phase 19) ---------------------------------------------------------------------------------
// An approved call a restart cut off may or may not have happened: never redone blindly, never reported as done.
export const UNKNOWN_OUTCOME = 'Outcome unknown: a restart interrupted this after it was approved. It may or may not have happened. '
  + 'Check first (sent folder / calendar / booking page) before doing it again.';
// A request that closed without a decision: what the model is told for its call (the card says the same in its words).
const CLOSED_TOOL = {
  moved_on: 'Not done: the person moved on and sent a new message instead of answering this request, so it closed. Deal with '
    + 'that new message now; do not ask for this again unless they come back to it.',
  run_closed: 'Not done: this request closed because the task ended before anyone decided. Nothing was sent or changed.',
  next_run: 'Not done: the next run of this scheduled task started before anyone decided, so this request closed.',
};
const RETRY_MS = 10 * 60000;     // one automatic retry of an unattended run after a transient failure, this much later

// Who is there (Phase 22). Tasks that run on their own: a schedule, a goal step, a background task (#197), overnight prep
// (#199). A restart re-queues them when they changed nothing yet.
const UNATTENDED = new Set(['schedule', 'goal', 'delegate', 'prep']);
// …of those, the ones that get ONE automatic retry after a passing failure (overnight prep is optional work: a failure just
// means nothing is ready in the morning).
const AUTO_RETRY = new Set(['schedule', 'goal', 'delegate']);
// …and the ones that may end with ONE closing question (#83 as amended; a background task the same way, #197).
const ONE_QUESTION = new Set(['schedule', 'delegate']);
// Overnight prep: nobody can answer or approve anything, so it never gets ask_user and a call that would ask is refused.
const NOBODY_TO_ASK = new Set(['prep']);

// Which tools a run may use (#197, #199): the run's own list when it has one (runs.tool_allow), and a tool that names the
// kinds of task it is for (tool.origins: delegate only where someone started a chat; leave_note only in unattended work).
// Offered to the model by this and refused by runTool otherwise, so a made-up call can't get around it.
const originOk = (tool, r) => !tool?.origins || tool.origins.includes(r.origin);
function toolRefusal(r, name, allow = runs.toolAllowOf(r)) {
  if (allow && !allow.has(name)) {
    return `${name} isn’t available in ${r.origin === 'prep' ? 'overnight preparation' : 'this task'}: it may only use ${[...allow].join(', ')}. `
      + 'Don’t try it again; if it matters, list it as a next step for the person.';
  }
  const tool = getTool(name);
  if (tool && !originOk(tool, r)) return `${name} isn’t available in this kind of task.`;
  return null;
}
function offeredTools(r, user) {
  const allow = runs.toolAllowOf(r);
  return toolSchemasFor(user, { toolsets: enabledToolsets(user) }).filter(t => !toolRefusal(r, t.function.name, allow));
}

const hasResult = (runId, toolCallId) => !!get(`SELECT 1 FROM messages WHERE run_id = ? AND role = 'tool' AND tool_call_id = ?`, runId, toolCallId);
const clock = (date, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(date);

// Results that are not a success (nothing happened, or nobody knows): never count as "already done" (#114).
const NOT_DONE = ['Error:%', 'The person declined%', 'Nobody approved%', 'Not done:%', 'Not answered%', 'Outcome unknown%', 'Already done%'];
const NOT_DONE_SQL = NOT_DONE.map(() => 'm.content NOT LIKE ?').join(' AND ');

/** The calls that succeeded in these runs, oldest first: [{ runId, name, args (string), content }]. */
function succeededCalls(runIds) {
  if (!runIds.length) return [];
  return all(`SELECT a.run_id AS runId, json_extract(j.value, '$.function.name') AS name, json_extract(j.value, '$.function.arguments') AS args, m.content
    FROM messages a, json_each(a.tool_calls) j
    JOIN messages m ON m.run_id = a.run_id AND m.role = 'tool' AND m.tool_call_id = json_extract(j.value, '$.id')
    WHERE a.run_id IN (${runIds.map(() => '?').join(',')}) AND a.role = 'assistant' AND a.tool_calls IS NOT NULL AND ${NOT_DONE_SQL}
    ORDER BY m.id`, ...runIds, ...NOT_DONE);
}

/** What a run changed (successful calls that aren't reads), with their visible labels. */
function changesOf(r, user = getUser(r.user_id)) {
  return succeededCalls([r.id]).flatMap(c => {
    const tool = getTool(c.name);
    let args = {};
    try { args = JSON.parse(c.args || '{}'); } catch { /* keep {} */ }
    if (!tool || riskOf(tool, args, { user, runId: r.id }) === 'read') return [];
    return [{ ...c, label: tool.label ? tool.label(args) : c.name }];
  });
}

/** Every call of these runs with its result, oldest first (errors included): [{ runId, name, args (string), content }]. */
function callsOf(runIds) {
  if (!runIds.length) return [];
  return all(`SELECT a.run_id AS runId, json_extract(j.value, '$.function.name') AS name, json_extract(j.value, '$.function.arguments') AS args, m.content
    FROM messages a, json_each(a.tool_calls) j
    JOIN messages m ON m.run_id = a.run_id AND m.role = 'tool' AND m.tool_call_id = json_extract(j.value, '$.id')
    WHERE a.run_id IN (${runIds.map(() => '?').join(',')}) AND a.role = 'assistant' AND a.tool_calls IS NOT NULL ORDER BY m.id`, ...runIds);
}
const parseArgs = s => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const stepsOf = r => { try { return JSON.parse(r?.steps || '[]'); } catch { return []; } };

// Runs of the same message (the first attempt and every Retry of it) share the #114 guard: a Retry never redoes a send.
const attemptsOf = r => (r.trigger_message_id
  ? all('SELECT id FROM runs WHERE trigger_message_id = ? AND id <= ? ORDER BY id', r.trigger_message_id, r.id).map(x => x.id) : [r.id]);

const MAX_STEPS = 60;           // model calls per run — a full booking flow takes ~35 small steps; seeing it through (#113) takes more
export const MAX_PUSHES = 3;    // times a reply that didn't deliver is sent back to work (#113)
const MAX_CONCURRENT = Number(process.env.JESSBOT_MAX_RUNS) || 3;
const DELTA_MS = 80;            // live typing cadence
const DRAFT_MS = 1000;          // refresh-proof draft save cadence

const controllers = new Map();  // runId → AbortController
const threadChains = new Map(); // threadId → Promise (one run at a time per thread)
let active = 0;
const waiters = [];

async function slot() {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise(r => waiters.push(r));
  active++;
}
function release() { active--; waiters.shift()?.(); }

// One job at a time per thread (a run, or an approved call and the run it continues), in order.
function chain(threadId, job) {
  const prev = threadChains.get(threadId) || Promise.resolve();
  const next = prev.then(job).catch(err => console.error('[agent] run failed', threadId, err));
  threadChains.set(threadId, next);
  next.finally(() => { if (threadChains.get(threadId) === next) threadChains.delete(threadId); });
  return next;
}

// Queue a run behind any earlier run in the same thread.
export function enqueueRun(runId) {
  const r = runs.getRun(runId);
  return chain(r.thread_id, () => execute(runId));
}

/** Resolves once every thread's queue is empty: all started runs have finished or paused, their bubbles, pushes and
 *  schedule status written (tests; a clean shutdown). */
export async function drainRuns() {
  while (threadChains.size) await Promise.all([...threadChains.values()]);
}

const NOT_ANSWERED = {
  moved_on: 'Not answered — the person moved on and sent a new message instead. Deal with that new message now; do not ask these questions again unless they come back to it.',
  next_run: 'Not answered: the next run of this scheduled task started, so this question closed. Nothing more to do for it.',
};

/**
 * Close a run that waits for the person (#97, Phase 19): they sent a new message (reason 'moved_on') or the next run of its
 * schedule started ('next_run'). Its open question and every pending approval close with it, and the model is told
 * plainly for each call, so the next turn deals with what's new instead of asking again, and deciding the old card
 * later says it closed instead of silently doing nothing.
 */
export function closeWaitingRun(runId, reason = 'moved_on') {
  const w = runs.getRun(runId);
  if (!w || w.status !== 'waiting') return false;
  const user = getUser(w.user_id);
  const q = get(`SELECT id, tool_call_id FROM questions WHERE run_id = ? AND status = 'pending'`, w.id);
  if (q) {
    expireQuestion(q.id);
    addMessage({ threadId: w.thread_id, runId: w.id, role: 'tool', toolCallId: q.tool_call_id, toolName: 'ask_user', content: NOT_ANSWERED[reason] });
  }
  for (const a of closeApprovalsOfRun(w.id, reason === 'moved_on' ? 'moved_on' : 'run_closed')) {
    addMessage({ threadId: w.thread_id, runId: w.id, role: 'tool', toolCallId: a.tool_call_id, toolName: a.tool, content: CLOSED_TOOL[reason] });
  }
  runs.setStatus(w.id, 'done');
  if (w.origin !== 'chat') recordRunResult(w, 'ok');
  // Open pages drop the question dock and re-draw that reply as finished ("Question expired"), not "Waiting for you".
  if (q) publish(user.id, 'question.expired', { id: q.id }, { threadId: w.thread_id, runId: w.id });
  renderFragment('chat/message', assistantView(runs.getRun(w.id), user), user)
    .then(html => publish(user.id, 'run.done', { status: 'done', html }, { threadId: w.thread_id, runId: w.id }))
    .catch(() => {});
  return true;
}

/** A person's message → a queued run in that thread (chat composer, ideas, starters). A question or an approval left
 *  unanswered means they moved on: it expires and its run closes gracefully. */
export function startTurn({ user, thread, text, clientId = null, attachments = null, voice = 0 }) {
  for (const w of all(`SELECT id FROM runs WHERE thread_id = ? AND status = 'waiting'`, thread.id)) closeWaitingRun(w.id, 'moved_on');
  // Any other question still open in this chat (its run was stopped or failed) is over too — a question can only be
  // open while its run waits for it.
  for (const q of all(`SELECT id, run_id FROM questions WHERE thread_id = ? AND status = 'pending'`, thread.id)) {
    expireQuestion(q.id);
    publish(user.id, 'question.expired', { id: q.id }, { threadId: thread.id, runId: q.run_id });
  }
  // A project chat keeps what's pasted into it as files (never summarized away) and adopts attached files.
  const project = projectOfThread(thread.id);
  if (project) {
    const filed = fileBigPastes(user, project, text, { threadId: thread.id });
    text = filed.text;
    attachments = [...(attachments || []), ...filed.attachments];
    linkPublicIds(project, attachments);
  }
  const msg = addMessage({ threadId: thread.id, role: 'user', content: text, clientId, model: llmSettings().model, attachments });
  touchThread(thread.id);
  if (thread.kind === 'side' && (!thread.title || thread.title === 'New side chat')) {
    const named = text.trim() || (attachments?.length ? `Files: ${attachments.length}` : '');
    if (named) sql('UPDATE threads SET title = ? WHERE id = ?', named.replace(/\s+/g, ' ').slice(0, 48), thread.id);
  }
  const r = runs.createRun({ threadId: thread.id, userId: user.id, triggerMessageId: msg.id, model: llmSettings().model });
  if (voice) sql('UPDATE runs SET voice = ? WHERE id = ?', voice, r.id); // 2: they sent a voice note → she answers with one (docs/VOICE.md)
  // Spoken reply? Which language? Which memories? — decided while the run queues (decision model, #107).
  senseTurn({ user, run: r, message: msg, wantVoice: !voice });
  enqueueRun(r.id);
  return { msg, run: runs.getRun(r.id) };
}

export function cancelRun(runId) {
  const r = runs.getRun(runId);
  if (!r || !['queued', 'running', 'waiting'].includes(r.status)) return false;
  controllers.get(runId)?.abort();
  // Not streaming (queued, waiting, or an approved call still queued behind another run): nothing to abort, end it here.
  if (r.status !== 'running' || !controllers.has(runId)) finish(runId, 'cancelled');
  return true;
}

// At boot: nothing is really running anymore (Phase 19: every interrupted run ends truthfully, none stays "waiting" forever).
// - An approved call that had started: "Outcome unknown", never redone blindly; the run goes on once to tell them / check.
// - Waiting for an answer or an OK: stays (answering resumes it). Decided but never resumed: resumed now (once).
// - Check-ins: dropped silently. Unattended tasks (schedule, goal) that changed nothing yet: re-queued once.
// - Everything else: an error with Retry; an unattended task that already changed things says what it did first.
// finish() also sends the final bubble, so a page that stayed open swaps "Thinking…" for the outcome.
export async function recoverRuns() {
  // Questions and approvals whose run is no longer waiting (stopped, failed, finished) can never be answered — close them.
  sql(`UPDATE questions SET status = 'expired' WHERE status = 'pending' AND run_id NOT IN (SELECT id FROM runs WHERE status = 'waiting')`);
  for (const a of all(`SELECT * FROM approvals WHERE status = 'pending' AND run_id NOT IN (SELECT id FROM runs WHERE status = 'waiting')`)) {
    closeApproval(a, 'run_closed');
    if (!hasResult(a.run_id, a.tool_call_id)) {
      addMessage({ threadId: a.thread_id, runId: a.run_id, role: 'tool', toolCallId: a.tool_call_id, toolName: a.tool, content: CLOSED_TOOL.run_closed });
    }
  }
  // A spoken reply the restart interrupted: its bubble stops saying "Recording…" (Listen makes it again).
  sql(`UPDATE runs SET voice = 0 WHERE voice > 0 AND status NOT IN ('queued', 'running', 'waiting')`);
  for (const r of all(`SELECT * FROM runs WHERE status IN ('queued', 'running', 'waiting') ORDER BY id`)) {
    await recoverRun(r).catch(e => console.error('[agent] recover', r.id, e));
  }
}

async function recoverRun(r) {
  // 1. Approved calls that had started going out: nobody knows whether they happened.
  let unknown = false;
  for (const a of all(`SELECT * FROM approvals WHERE run_id = ? AND status = 'approved' AND executing_at IS NOT NULL ORDER BY id`, r.id)) {
    if (hasResult(r.id, a.tool_call_id)) continue;
    addMessage({ threadId: r.thread_id, runId: r.id, role: 'tool', toolCallId: a.tool_call_id, toolName: a.tool, content: UNKNOWN_OUTCOME });
    unknown = true;
  }
  // Steps left spinning ("Sending…") end as interrupted, so the timeline doesn't claim they're still going.
  for (const s of JSON.parse(runs.getRun(r.id).steps || '[]').filter(x => x.status === 'run')) {
    runs.endStep(r.id, s.id, { status: 'bad', detail: 'Interrupted by a restart' });
  }
  if (r.status === 'waiting' && !unknown) {
    // Still waiting for the person: answering resumes it.
    if (get(`SELECT 1 FROM questions WHERE run_id = ? AND status = 'pending' UNION ALL SELECT 1 FROM approvals WHERE run_id = ? AND status = 'pending'`, r.id, r.id)) return;
    // Decided, but the restart came before the call started (or before a denial reached the model): carry it out once.
    const a = get(`SELECT * FROM approvals WHERE run_id = ? AND status != 'pending' AND executing_at IS NULL ORDER BY id DESC LIMIT 1`, r.id);
    if (a && !hasResult(r.id, a.tool_call_id)) { resumeAfterApproval(a.id).catch(e => console.error('[agent] recover resume', r.id, e)); return; }
  }
  if (r.origin === 'checkin') { await finishSilently(r.id); return; } // an interrupted check-in isn't worth a message
  const unattended = UNATTENDED.has(r.origin);
  const changed = changesOf(r);
  // Go on once when that is what they'd expect: after an unknown outcome (to tell them / check), when everything it waited
  // for already arrived, or an unattended task that hasn't changed anything yet (starting over is safe).
  if (!r.recovered && (unknown || r.status === 'waiting' || (unattended && !changed.length))) {
    sql(`UPDATE runs SET recovered = 1 WHERE id = ?`, r.id);
    runs.setStatus(r.id, 'queued');
    enqueueRun(r.id);
    return;
  }
  const error = unattended && changed.length
    ? `I was interrupted by a restart in the middle of “${r.origin_label || 'this task'}” after ${changed.slice(0, 3).map(c => c.label).join(', ')}`
      + `${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}. Want me to finish? Press Retry and I will pick it up without redoing what’s done.`
    : 'I was interrupted by a restart before finishing. Press Retry and I will pick it up.';
  await finish(r.id, 'error', { error, kind: 'interrupted' });
}

// Features that follow runs (goals: timeline + step status) register here instead of the loop importing them.
const finishHooks = [];
export const onRunFinished = fn => finishHooks.push(fn);
// …and a retry (by hand or automatic) hands the failed run's place to the new one: fn(oldRun, newRun).
const retryHooks = [];
export const onRunRetried = fn => retryHooks.push(fn);

// kind (errors): transient (provider/network hiccup) | permanent | interrupted (a restart) | budget.
async function finish(runId, status, { error, kind = null } = {}) {
  const before = runs.getRun(runId);
  // A stopped or failed run can't be answered: its open question expires with it (the dock goes; the card says so), and
  // so does any request for an OK (deciding that card later says it closed, instead of "Approved" doing nothing).
  for (const q of all(`SELECT id, thread_id FROM questions WHERE run_id = ? AND status = 'pending'`, runId)) {
    expireQuestion(q.id);
    publish(before.user_id, 'question.expired', { id: q.id }, { threadId: q.thread_id, runId });
  }
  for (const a of closeApprovalsOfRun(runId, 'run_closed')) {
    addMessage({ threadId: a.thread_id, runId, role: 'tool', toolCallId: a.tool_call_id, toolName: a.tool, content: CLOSED_TOOL.run_closed });
  }
  // Unattended work (a schedule, a goal step) that hit a passing provider or network problem gets ONE automatic retry
  // RETRY_MS later (the scheduler runs it, retryRun); anything else, or a second failure, is final and reaches them.
  const errorKind = status === 'error' ? kind || 'permanent' : null;
  const retryAt = errorKind === 'transient' && AUTO_RETRY.has(before.origin) && !before.watch && !before.retry_of && !before.hidden
    ? new Date(Date.now() + RETRY_MS) : null;
  if (retryAt) error = `${error || 'Something went wrong.'} I’ll try again by myself at ${clock(retryAt, tzOf(getUser(before.user_id)))}.`;
  const r = runs.setStatus(runId, status, { error });
  sql('UPDATE runs SET draft = NULL, error_kind = ?, retry_at = ? WHERE id = ?', errorKind, retryAt?.toISOString() || null, runId);
  const user = getUser(r.user_id);
  const view = assistantView(runs.getRun(runId), user);
  const html = await renderFragment('chat/message', view, user).catch(() => null);
  // Retried while it was still finishing (Stop, then Retry at once): the new reply already took its place — never send
  // the old bubble again (it came back at the end of the chat).
  if (runs.getRun(runId).hidden) publish(r.user_id, 'run.done', { status, hidden: true }, { threadId: r.thread_id, runId });
  else publish(r.user_id, 'run.done', { status, html }, { threadId: r.thread_id, runId });
  // The schedule's status follows the run's real outcome (it used to read "ok" from the moment the run was created).
  if (r.origin !== 'chat') recordRunResult(r, status === 'done' ? 'ok' : 'bad');
  if (status === 'done') {
    publish(r.user_id, 'agent.moment', { kind: 'done' }, { persist: false });
    const trigger = r.trigger_message_id ? get('SELECT content FROM messages WHERE id = ?', r.trigger_message_id)?.content : null;
    const steps = JSON.parse(r.steps || '[]').length;
    const title = r.origin === 'schedule' ? `Did “${r.origin_label}”` : r.origin === 'checkin' ? 'Checked in with you'
      : r.origin === 'project' ? 'Opened your new project'
      : r.origin === 'delegate' ? `Worked on “${r.origin_label}” in the background` : r.origin === 'prep' ? `Prepared “${r.origin_label}” overnight`
      : trigger ? `Replied to “${trigger.replace(/\s+/g, ' ').slice(0, 70)}”` : 'Sent you a message';
    if (r.origin !== 'reminder') {
      logActivity(r.user_id, { kind: r.origin === 'chat' ? 'message' : 'schedule', icon: r.origin === 'chat' ? 'message-circle' : 'calendar-clock',
        runId, href: `/chat/${r.thread_id}`, title, detail: steps ? `${steps} step${steps > 1 ? 's' : ''}` : null });
    }
    // Jess started this on her own: reach the person wherever they are.
    if (r.origin === 'schedule' || r.origin === 'checkin') {
      const reply = view.html ? String(view.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
      notify(r.user_id, { kind: r.origin === 'checkin' ? 'message' : 'schedule', title: r.origin === 'checkin' ? botName() : r.origin_label,
        body: reply.slice(0, 180), href: `/chat/${r.thread_id}`, tag: `run-${runId}` });
    }
  } else if (status === 'error') {
    logActivity(r.user_id, { kind: 'task', icon: 'triangle-alert', status: 'bad', runId, href: `/chat/${r.thread_id}`,
      title: 'A task hit a problem', detail: error?.slice(0, 120) });
    // Final failure of something Jess started on her own: nobody was watching, so reach them. The failed reply's Retry
    // runs it again with the same instructions (and the #114 guard across attempts), so the push leads there.
    if (!retryAt && (r.origin === 'schedule' || r.origin === 'goal') && !r.hidden) {
      notify(r.user_id, { kind: 'schedule', title: `Couldn’t do “${r.origin_label || 'a task'}”`, body: String(error || '').slice(0, 180),
        href: `/chat/${r.thread_id}`, tag: `run-${runId}` });
    }
  }
  touchThread(r.thread_id);
  for (const hook of finishHooks) {
    try { await hook(runs.getRun(runId), status, { html: view.html, error }); } catch (err) { console.error('[agent] finish hook', err); }
  }
  return r;
}

// A provider error's HTTP status: on the error itself, or (an error sent inside the stream, which the SDK raises without a
// status) the code the provider put in the error body — OpenRouter streams {"error":{"code":502,…}}.
const statusOf = err => Number(err?.status || err?.response?.status || err?.error?.code) || 0;

function friendlyError(err) {
  const s = statusOf(err);
  if (err?.name === 'AbortError' || err?.message === 'Request was aborted.') return null;
  if (s === 401) return "My connection to the model was rejected — the admin needs to check the API key.";
  if (s === 402) return 'The model account is out of credits. The admin can top it up, then press Retry.';
  if (s === 429) return "The model is rate-limiting me right now. Give it a moment, then press Retry.";
  if (s >= 500) return 'The model provider had a hiccup. Press Retry and I will pick it up again.';
  if (err?.code === 'ENOTFOUND' || err?.cause?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED') return "I can't reach the model right now — is the internet down?";
  return `Something went wrong while I was working on this (${String(err?.message || err).slice(0, 140)}).`;
}

// A passing problem (rate limit, provider 5xx, timeout, network) is worth one automatic retry; a rejected key, no credits
// or a bug is not.
const NET_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
export function errorKind(err) {
  const s = statusOf(err);
  if (s === 408 || s === 429 || s >= 500) return 'transient';
  if (NET_CODES.has(err?.code) || NET_CODES.has(err?.cause?.code)) return 'transient';
  if (['APIConnectionError', 'APIConnectionTimeoutError'].includes(err?.name) || err?.constructor?.name === 'APIConnectionError') return 'transient';
  return 'permanent';
}

// A run failed: a quiet watch check counts it and stays quiet (watchFailed); anything else ends with the error.
async function failRun(runId, error, kind) {
  const r = runs.getRun(runId);
  const s = r.watch && r.schedule_id ? getSchedule(r.schedule_id) : null;
  if (s) return watchFailed(runId, s, error);
  return finish(runId, 'error', { error, kind });
}

// ---- Watches (Phase 19): a quiet scheduled check that writes only when its condition is met ------------------------------
// The reply starts with "NOTE: <what was seen>" (kept as the schedule's memo, one clean line, shown to the next check as data),
// then either the message for them or NOTHING. Never goal-checked (NOTHING is the right answer most days).
const NOTE_LINE = /^\s*[*_]*NOTE[*_]*\s*:\s*(.*)$/i;
export function splitNote(text) {
  const lines = String(text || '').split('\n');
  const at = lines.findIndex(l => NOTE_LINE.test(l));
  if (at < 0) return { note: null, rest: String(text || '').trim() };
  const note = oneLine(lines[at].match(NOTE_LINE)[1].replace(/[*_]+$/, ''), MEMO_MAX);
  return { note: note || null, rest: [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n').trim() };
}
const FAILED_NOTE = /^failed\b\W*/i;
/** The watch schedule behind a run (a quiet check, or one run by hand from Upcoming), else null. */
function watchScheduleOf(r) {
  if (!r?.schedule_id || r.origin !== 'schedule') return null;
  const s = getSchedule(r.schedule_id);
  return isWatch(s) ? s : null;
}
const askedIn = runId => !!get('SELECT 1 FROM questions WHERE run_id = ? LIMIT 1', runId);

// #83 as amended (Phase 19): a scheduled task may end with ONE question, only as its last step, after the work is done; a
// background task (#197) the same way. "Done" in code: at least one step of this run finished well before the question
// (the brief it presents is the work).
const RULE_TAIL = 'may ask ONE question, and only as its very last step, after all the work is done: a single decision that is truly '
  + 'theirs, presented as a brief (what you prepared, why, a link), with the options as buttons.';
export const CHECKPOINT_RULE = `a scheduled task ${RULE_TAIL}`;
const taskNoun = r => (r.origin === 'delegate' ? 'background task' : 'scheduled task');
function checkpointRefusal(r) {
  if (r.watch) return 'A watch never asks: write to them only when the condition is met, otherwise reply NOTHING.';
  if (askedIn(r.id)) return `You already asked your one question in this ${taskNoun(r)}. Finish with what you have and say in one line what is left for them.`;
  const worked = JSON.parse(runs.getRun(r.id).steps || '[]').some(s => s.status === 'ok');
  if (!worked) return `Not yet: a ${taskNoun(r)} ${RULE_TAIL} Do the work first, assuming sensibly where needed, then ask only if a decision remains.`;
  return null;
}
const WATCH_FAIL_LIMIT = 3;

const giveUpLine = (s, why) => `I couldn’t check “${s.title}” ${WATCH_FAIL_LIMIT} times in a row${why ? ` (last time: ${oneLine(why, 200)})` : ''}. `
  + 'Want me to try another site or a different way? Tell me and I’ll change the watch.';

async function postWatchReply(runId, text, model) {
  const r = runs.getRun(runId);
  const reply = addMessage({ threadId: r.thread_id, runId, role: 'assistant', content: text, model });
  runs.setReplyMessage(runId, reply.id);
  await finish(runId, 'done');
}

async function finishWatch(runId, s, text, model) {
  const r = runs.getRun(runId);
  const { note, rest } = splitNote(text);
  const failed = !!note && FAILED_NOTE.test(note);
  const why = failed ? note.replace(FAILED_NOTE, '').replace(/^[\s—–-]+/, '') : null;
  const reported = !failed && !!rest && !SILENT.test(rest);
  const after = recordWatchCheck(s.id, { note: failed ? null : note, failed, reported, runId });
  if (failed && after.fail_streak === WATCH_FAIL_LIMIT) return postWatchReply(runId, giveUpLine(s, why), model);
  if (r.watch && !reported) return finishSilently(runId);
  // Reported, or checked by hand from Upcoming (not quiet): always a reply, without the NOTE line.
  return postWatchReply(runId, reported ? rest
    : failed ? `I couldn’t check this time${why ? `: ${why}` : '.'}` : note ? `Checked: ${note}. Nothing to report.` : 'Checked. Nothing to report.', model);
}

async function watchFailed(runId, s, error) {
  const after = recordWatchCheck(s.id, { failed: true, runId });
  if (after.fail_streak === WATCH_FAIL_LIMIT) return postWatchReply(runId, giveUpLine(s, error), null);
  return finishSilently(runId);
}

/**
 * Run a failed or stopped run again: a new run for the same trigger replaces it in place (the old bubble hides). auto: the
 * one automatic retry of an unattended run (the scheduler). The #114 guard spans both attempts, so nothing done is redone.
 */
export async function retryRun(oldId, { auto = false } = {}) {
  const old = runs.getRun(oldId);
  sql('UPDATE runs SET hidden = 1, retry_at = NULL WHERE id = ?', old.id);
  const r = runs.createRun({ threadId: old.thread_id, userId: old.user_id, triggerMessageId: old.trigger_message_id, model: llmSettings().model,
    origin: old.origin, originLabel: old.origin_label, goalId: old.goal_id, scheduleId: old.schedule_id, watch: !!old.watch, retryOf: old.id,
    parentRunId: old.parent_run_id, spendCap: old.spend_cap, toolAllow: runs.toolAllowOf(old) }); // same task, same limits
  if (old.schedule_id) sql('UPDATE schedules SET last_run_id = ? WHERE id = ? AND last_run_id = ?', r.id, old.schedule_id, old.id);
  for (const hook of retryHooks) { try { hook(old, r); } catch (err) { console.error('[agent] retry hook', err); } }
  const user = getUser(old.user_id);
  // Open pages swap the failed bubble for the new one in place.
  const runHtml = await renderFragment('chat/message', assistantView(runs.getRun(r.id), user), user).catch(() => null);
  publish(old.user_id, 'run.done', { status: old.status, hidden: true, replacedBy: { runId: r.id, html: runHtml } }, { threadId: old.thread_id, runId: old.id });
  if (auto) logActivity(old.user_id, { kind: 'task', icon: 'rotate-cw', runId: r.id, href: `/chat/${old.thread_id}`, title: `Trying “${old.origin_label || 'a task'}” again` });
  enqueueRun(r.id);
  return { run: runs.getRun(r.id), runHtml };
}

/** Automatic retries that are due (the scheduler's tick). */
export async function runDueRetries(now = new Date()) {
  const due = all(`SELECT id FROM runs WHERE retry_at IS NOT NULL AND retry_at <= ? AND status = 'error' AND hidden = 0`, now.toISOString());
  for (const r of due) await retryRun(r.id, { auto: true }).catch(e => console.error('[agent] retry', r.id, e));
  return due.length;
}
export const nextRetryAt = () => get(`SELECT MIN(retry_at) AS t FROM runs WHERE retry_at IS NOT NULL AND status = 'error' AND hidden = 0`)?.t || null;

// ---- Before a final reply counts (Phase 19 part B, decisions #176–#181) -----------------------------------------------
// What a reply's figures may rest on: what this chat's tools returned lately (full text, not the stubs), what the person
// wrote, the task's own instructions and the prompt's facts (the time, what's coming up).
function evidenceFor(r, user) {
  const rows = all(`SELECT content FROM messages WHERE thread_id = ? AND role IN ('tool', 'user') ORDER BY id DESC LIMIT 200`, r.thread_id).map(x => x.content);
  const trigger = r.trigger_message_id ? get('SELECT content FROM messages WHERE id = ?', r.trigger_message_id)?.content : null;
  return [...rows, trigger, timeBlock(user, null), upcomingBlock(user) || ''].filter(Boolean);
}
// Addresses the task could cite: its sources (and its earlier attempts'), anything a tool returned or the person wrote in this
// chat. Never her own replies: a link she made up doesn't become "seen" by being written once.
function seenUrls(r) {
  // (A system message inside a run is one of the checks' own nudges, which quote the links in question: not a source.)
  const seen = urlsSeenIn(all(`SELECT content FROM messages WHERE thread_id = ? AND (role IN ('tool', 'user') OR (role = 'system' AND run_id IS NULL))
    ORDER BY id DESC LIMIT 400`, r.thread_id)
    .map(x => x.content));
  for (const id of attemptsOf(r)) for (const s of sourcesOf(id)) seen.add(s.url);
  return seen;
}
const PUSH_DETAIL = { goal: 'that didn’t deliver what you asked for', audit: 'what I said didn’t match what I did',
  figures: 'some figures weren’t in what I read', constraints: 'not every requirement was met' };
const linksNudge = links => `[Check your links] Your reply links to pages you haven’t opened in this task: ${links.slice(0, 5).map(l => l.raw).join(', ')}. `
  + 'Open them now with web_read to check they exist and say what you claim, or take them out. Never write a link you haven’t seen.';

const REPLAN_LABEL = 'Several steps failed: re-planning';
const PUSH_LABELS = new Set(Object.values(CHECK_LABELS));
/** What the checks already did in this run, read back from its steps and system messages, so the limits hold across a pause
 *  for an OK (the loop starts over then): pushes (≤ MAX_PUSHES), the audit and figure pushes (once each), the links re-prompt,
 *  the wish, the re-plan, dead-end checks (≤ 2, ≥ 5 steps apart) and checkpoints. */
function checkState(r) {
  const steps = stepsOf(runs.getRun(r.id));
  const sys = all(`SELECT content FROM messages WHERE run_id = ? AND role = 'system'`, r.id).map(m => String(m.content));
  const lastDead = steps.findLastIndex(s => s.label === DEAD_END_LABEL);
  return {
    steps,
    pushes: steps.filter(s => PUSH_LABELS.has(s.label)).length,
    audited: sys.some(c => c.includes(`
- ${ISSUE_TAGS.audit}: `)),
    figured: sys.some(c => c.includes(`
- ${ISSUE_TAGS.figures}: `)),
    linksAsked: sys.some(c => c.startsWith('[Check your links]')),
    wished: !!get('SELECT 1 FROM wishes WHERE run_id = ?', r.id),
    replanned: steps.some(s => s.label === REPLAN_LABEL),
    deadEnds: steps.filter(s => s.label === DEAD_END_LABEL).length,
    deadEndAt: lastDead < 0 ? -Infinity : lastDead + 1,
    checkpoints: sys.filter(c => c.startsWith('[Checkpoint')).length,
  };
}

/**
 * The checks on a final reply → { action: 'push', nudge, label, iconName, detail, kinds } (back to work, one visible step) |
 * { action: 'links', nudge } (one re-prompt about links it never saw) | { action: 'finish', text } (the reply to post, unseen
 * links taken out when the re-prompt didn't fix them).
 */
async function checkReply({ run: r, user, text, step, signal }) {
  const state = checkState(r);
  const { steps } = state;
  const worked = steps.length > 0;
  // A request the person declined (or let expire) in this task was their decision: never pushed to try again (seen: denied →
  // "not done yet" → the same approval asked again). More asks after outside content (#124) made it common.
  const declined = !!get(`SELECT 1 FROM approvals WHERE run_id = ? AND status IN ('denied', 'expired') LIMIT 1`, r.id);
  const canPush = state.pushes < MAX_PUSHES && !declined && step < MAX_STEPS - 3;
  const toolsets = enabledToolsets(user);
  const succeeded = new Set(succeededCalls(attemptsOf(r)).map(c => c.name));
  const audit = canPush && !state.audited ? auditReply(text, { succeeded, toolsets }) : null;
  // Figures are checked after the task read outside content (web, email, files): that's where they come from.
  const figures = canPush && !state.figured && taintOf(r.id).level !== 'none' ? unmatchedFigures(text, evidenceFor(r, user)) : [];
  // The last thing that worked handed the next step to them (a card to press, #217): asking them to press it is the result.
  const lastDone = succeededCalls([r.id]).at(-1);
  const handedOver = !!(lastDone && getTool(lastDone.name)?.handsOver);
  const goal = canPush && r.origin !== 'checkin' && worked && !handedOver;
  const gap = r.origin === 'chat' && !state.wished && (goal || !!audit?.nonLatin || !!unmetAsk(text));
  const v = (canPush || gap) ? await goalCheck({ run: runs.getRun(r.id), user, reply: text, signal, goal, audit, figures, gap, succeeded, toolsets,
    failed: failedSteps(steps, 5) }) : { push: false };
  if (v.gap) {
    try { recordWish(user.id, v.gap, { runId: r.id }); } catch (err) { console.warn('[wishes]', err.message); }
  }
  if (v.push && canPush) {
    const kinds = new Set(v.issues.map(i => i.kind));
    return { action: 'push', nudge: v.nudge, label: v.label || CHECK_LABELS[v.kind], iconName: v.kind === 'goal' ? 'rotate-cw' : 'list-checks',
      detail: PUSH_DETAIL[v.kind] || PUSH_DETAIL.goal, kinds: [...kinds] };
  }
  // Links it never saw (#180): one re-prompt to read or remove them; still there after that → taken out, and logged.
  const unseen = unseenLinks(text, seenUrls(r));
  if (unseen.length && !state.linksAsked && step < MAX_STEPS - 2) return { action: 'links', nudge: linksNudge(unseen) };
  if (unseen.length) {
    console.warn(`[sources] run ${r.id}: took out ${unseen.length} link(s) the task never opened (${unseen.map(l => l.url.replace(/^https:\/\//, '').slice(0, 60)).join(', ')})`);
    return { action: 'finish', text: stripLinks(text, unseen) || text };
  }
  return { action: 'finish', text };
}

// ---- Long runs: breakers and checkpoints (#177) -------------------------------------------------------------------------
/** Before a full model call: one re-plan after an error streak, a dead-end check (≤ 2, ≥ 5 steps apart), a checkpoint every
 *  CHECKPOINT_EVERY steps. Adds system messages (and a visible step for the checks). */
function longRunChecks(r) {
  const state = checkState(r);
  const { steps } = state;
  if (!steps.length) return;
  const calls = callsOf([r.id]);
  const say = content => addMessage({ threadId: r.thread_id, runId: r.id, role: 'system', content });
  const visible = (label, detail) => {
    const id = runs.startStep(r.id, { label, iconName: 'compass', activity: 'thinking' });
    runs.endStep(r.id, id, { status: 'ok', detail });
  };
  if (!state.replanned && errorStreak(calls.map(c => c.content))) {
    say(REPLAN);
    visible(REPLAN_LABEL, 'The last 4 steps returned errors');
  } else if (state.deadEnds < MAX_DEAD_END_CHECKS && steps.length - state.deadEndAt >= DEAD_END_GAP) {
    const signal = stuckSignal({ steps: steps.filter(x => x.tool), searches: calls.filter(c => c.name === 'web_search').map(c => parseArgs(c.args).query || '') });
    if (signal) {
      say(deadEndNudge(signal));
      visible(DEAD_END_LABEL, signal.detail.replace(/^./, c => c.toUpperCase()));
    }
  }
  const due = Math.floor(steps.length / CHECKPOINT_EVERY);
  if (due > state.checkpoints) {
    say(checkpoint({ request: r.trigger_message_id ? get('SELECT content FROM messages WHERE id = ?', r.trigger_message_id)?.content || '' : '', steps }));
  }
}

async function execute(runId) {
  let r = runs.getRun(runId);
  if (!r || !['queued', 'running'].includes(r.status)) return;
  await slot();
  const ctrl = new AbortController();
  controllers.set(runId, ctrl);
  const user = getUser(r.user_id);
  const owner = getUser(get(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)?.id);
  const { model } = llmSettings();
  try {
    runs.setStatus(runId, 'running');
    runs.setActivity(runId, 'thinking');
    // Resuming after a question or an OK: re-send the bubble so open pages drop "Waiting for you" right away.
    if (get('SELECT 1 FROM questions WHERE run_id = ? UNION ALL SELECT 1 FROM approvals WHERE run_id = ? LIMIT 1', runId, runId)) {
      const html = await renderFragment('chat/message', assistantView(runs.getRun(runId), user), user).catch(() => null);
      if (html) publish(r.user_id, 'run.refresh', { html }, { threadId: r.thread_id, runId });
    }
    const sensed = await awaitSense(runId); // started with the message; usually already done
    // A tool paused the run (a question, or an OK): show it and stop here; answering resumes the same run.
    const pauseFor = async outcome => {
      runs.setStatus(runId, 'waiting');
      runs.setActivity(runId, 'waiting', outcome.approvalId ? 'your OK' : 'your answer');
      const view = assistantView(runs.getRun(runId), user);
      const html = await renderFragment('chat/message', view, user).catch(() => null);
      if (outcome.approvalId) { // resumeAfterApproval
        const a = getApproval(outcome.approvalId);
        await announceApproval(a, html);
        // Nobody is watching a task Jess started on her own (a schedule, a check-in, a goal step): reach the approver.
        if (r.origin !== 'chat') notify(a.approver_id, { kind: 'schedule', title: `${r.origin_label || 'A task'} needs your OK`, body: a.title, href: '/approvals', tag: `approval-${a.id}` });
        return;
      }
      const dock = view.question ? await renderFragment('chat/ask-dock', view.question, user).catch(() => null) : null;
      publish(user.id, 'question.created', { questionId: outcome.questionId, html, dock }, { threadId: r.thread_id, runId }); // resumeWithAnswer
      // A scheduled or background task's one closing question (#83 as amended, #197): they weren't watching, so reach them.
      if (ONE_QUESTION.has(r.origin) || r.origin === 'goal') {
        notify(user.id, { kind: 'schedule', title: `${r.origin_label || 'A task'}: one question for you`, body: view.question?.questions?.[0]?.question || '',
          href: `/chat/${r.thread_id}`, tag: `question-${outcome.questionId}` });
      }
    };
    let fastStreak = 0;
    let capped = 0; // the task's spend cap (#178), when it was reached
    // The reasoning effort the message sense chose for this message (#177), when the model takes one.
    const effort = senseOf(r.trigger_message_id)?.effort && (await supportsReasoning(model).catch(() => null)) === true
      ? senseOf(r.trigger_message_id).effort : null;
    for (let step = 0; step < MAX_STEPS; step++) {
      r = runs.getRun(runId);
      const thread = get('SELECT * FROM threads WHERE id = ?', r.thread_id);
      await maybeCompact(thread, { hard: true });
      // Weekly budget (policy) — checked before every model call.
      const budget = effectivePolicy(user).weeklyBudget;
      if (budget > 0 && spentThisWeek(user.id) >= budget) {
        await failRun(runId, `You've used this week's budget ($${budget.toFixed(2)}). The admin can raise it in Admin → People; it resets on Monday.`, 'budget');
        return;
      }
      // One task's spend cap (#178), checked before every model call too: reached → the closing call below (attended: asks
      // whether to keep going; unattended: stops with a note).
      const cap = runCap(r, user);
      if (cap > 0 && spentOnRuns([runId]) >= cap) { capped = cap; break; }
      // Fast step (decision model, #109): the obvious next click or scroll on the page she's working on, without a full
      // model call — through the same tool, policy and approval path. Unsure, or FAST_STREAK in a row: the model decides.
      if (step > 0 && fastStreak < FAST_STREAK) {
        const fast = await proposeFastStep({ run: r, user, signal: ctrl.signal });
        if (fast) {
          fastStreak++;
          const call = { id: `call_fast${runId}x${step}`, type: 'function', function: { name: fast.name, arguments: JSON.stringify(fast.args) } };
          addMessage({ threadId: r.thread_id, runId, role: 'assistant', content: '', toolCalls: [call], model: fast.model });
          const outcome = await runTool({ run: r, user, thread, call, signal: ctrl.signal, fast: true });
          if (outcome.pause) return await pauseFor(outcome);
          runs.setActivity(runId, 'thinking');
          continue;
        }
      }
      fastStreak = 0;
      longRunChecks(r); // an error streak, a dead end, a checkpoint (#177): system messages before the model reads the prompt
      r = runs.getRun(runId);
      const { messages } = buildPrompt({ user, thread: get('SELECT * FROM threads WHERE id = ?', r.thread_id), owner, run: r });
      // Nobody is there to answer a check-in, a quiet watch or overnight prep: they never get ask_user. A scheduled or
      // background task may end with ONE question (#83 as amended, Phase 19; #197): offered until it has asked, and runTool
      // refuses it before the work is done. Tools outside the run's own list, or not meant for this kind of task, aren't offered.
      // A reply that will already be spoken (voice note in, or asked once) doesn't get reply_by_voice again (seen: 17 calls in a row).
      const noAsk = r.origin === 'checkin' || NOBODY_TO_ASK.has(r.origin) || !!r.watch || (ONE_QUESTION.has(r.origin) && askedIn(runId));
      const tools = offeredTools(r, user)
        // …and when the message sense already decided about a spoken reply, the tool isn't needed at all.
        .filter(t => !(noAsk && t.function.name === 'ask_user') && !((r.voice || sensed) && t.function.name === 'reply_by_voice'));
      const raw = rawMessageTokens(messages);

      const result = await streamOnce({ run: r, user, model, messages, tools, signal: ctrl.signal, effort });
      const by = result.by; // the model that answered (the fallback chain, #179)
      if (result.usage?.prompt_tokens) {
        calibrate(by.model, raw, result.usage.prompt_tokens);
        sql('UPDATE threads SET last_prompt_tokens = ?, last_cached_tokens = ? WHERE id = ?',
          result.usage.prompt_tokens, result.usage.prompt_tokens_details?.cached_tokens || 0, r.thread_id);
      }

      if (!result.toolCalls.length) {
        if (r.origin === 'checkin' && SILENT.test(result.text || '')) { await finishSilently(runId); return; }
        // A watch check (quiet, or run by hand from Upcoming): NOTE kept, NOTHING silent, never goal-checked.
        const watched = watchScheduleOf(r);
        if (watched) { await finishWatch(runId, watched, result.text, by.model); return; }
        // Before it counts (#113, #176–#180): see it through, the reply audit, requirements and figures → ONE push (visible as a
        // step, ≤ MAX_PUSHES per task); links it never saw → one re-prompt, then taken out.
        const check = await checkReply({ run: r, user, text: result.text || '', step, signal: ctrl.signal });
        if (check.action === 'push' || check.action === 'links') {
          const tries = checkState(r).pushes + 1;
          addMessage({ threadId: r.thread_id, runId, role: 'assistant', content: result.text || '', model: by.model });
          addMessage({ threadId: r.thread_id, runId, role: 'system', content: check.nudge });
          const stepId = check.action === 'push'
            ? runs.startStep(runId, { label: check.label, iconName: check.iconName, activity: 'thinking' })
            : runs.startStep(runId, { label: 'Checking the links', iconName: 'link', activity: 'thinking' });
          runs.endStep(runId, stepId, { status: 'ok', detail: check.action === 'push' ? `Try ${tries + 1}: ${check.detail}` : 'Some links weren’t in what I read' });
          runs.setActivity(runId, 'thinking');
          continue;
        }
        const reply = addMessage({ threadId: r.thread_id, runId, role: 'assistant', content: check.text || '…', model: by.model });
        runs.setReplyMessage(runId, reply.id);
        await finish(runId, 'done');
        scheduleExtraction(r.thread_id, user.id);
        maybeCompact(thread).catch(e => console.error('[context] compaction failed', e));
        return;
      }

      // The model wants tools: store its message, run each tool as a visible step.
      addMessage({ threadId: r.thread_id, runId, role: 'assistant', content: result.text || '', toolCalls: result.toolCalls, model: by.model });
      for (const call of result.toolCalls) {
        const outcome = await runTool({ run: r, user, thread, call, signal: ctrl.signal });
        if (outcome.pause) return await pauseFor(outcome);
      }
      runs.setActivity(runId, 'thinking');
    }
    // Out of steps (or over the task's spend cap, #178): one last call without tools, so the person gets what was found and
    // what's left — not a canned line. Someone waiting in the chat is asked whether to keep going; an unattended task stops.
    r = runs.getRun(runId);
    const attended = r.origin === 'chat' || r.origin === 'project';
    if (capped) {
      const stepId = runs.startStep(runId, { label: 'Stopped at this task’s spending limit', iconName: 'badge-dollar-sign', activity: 'thinking' });
      runs.endStep(runId, stepId, { status: 'ok', detail: `$${capped.toFixed(2)} for one task` });
    }
    // Overnight prep's cap is the night's budget (#199): no closing call past it, just the line (what it saved stays saved).
    if (capped && r.origin === 'prep') {
      runs.setReplyMessage(runId, addMessage({ threadId: r.thread_id, runId, role: 'assistant', model: null,
        content: `I stopped here: tonight’s preparation budget ($${capped.toFixed(2)}) ran out.` }).id);
      await finish(runId, 'done');
      return;
    }
    const { messages } = buildPrompt({ user, thread: get('SELECT * FROM threads WHERE id = ?', r.thread_id), owner, run: r });
    messages.push({ role: 'system', content: capped
      ? `This task has reached its spending limit ($${capped.toFixed(2)} for one task). Without calling tools, tell the person briefly what you found or did `
        + `and what is still missing, ${attended ? 'and ask whether to keep going (it will cost more).' : 'and say it stopped at the limit. Don’t ask a question.'}`
      : 'You have used all the steps for this task. Without calling tools, tell the person briefly what you found or did, '
        + 'what is still missing, and ask whether to keep going.' });
    const last = await streamOnce({ run: r, user, model, messages, tools: offeredTools(r, user), toolChoice: 'none', signal: ctrl.signal });
    const watched = watchScheduleOf(r);
    if (watched) { await finishWatch(runId, watched, last.text, last.by.model); return; }
    const reply = addMessage({ threadId: r.thread_id, runId, role: 'assistant', model: last.by.model,
      content: last.text || (capped ? `I stopped here: this task reached its spending limit ($${capped.toFixed(2)}).` : "I've taken a lot of steps on this — want me to keep going?") });
    runs.setReplyMessage(runId, reply.id);
    await finish(runId, 'done');
  } catch (err) {
    if (ctrl.signal.aborted) {
      // Keep what was already written (the person saw it stream) as the reply of the stopped run.
      if (err?.partial?.trim()) runs.setReplyMessage(runId, addMessage({ threadId: r.thread_id, runId, role: 'assistant', content: err.partial, model }).id);
      await finish(runId, 'cancelled');
      return;
    }
    console.error('[agent] error in run', runId, err?.status || '', err?.message);
    await failRun(runId, friendlyError(err), errorKind(err));
  } finally {
    controllers.delete(runId);
    release();
  }
}

// One streamed model call. Text is pushed live (coalesced) and saved as a draft for refresh. On OpenRouter the fallback chain
// rides along (`models`, #179); the model that answered comes back in the chunks, and its usage is recorded under that model.
// effort: the message's reasoning effort from the sense (#177), else the install's default. Every outcome feeds the provider
// error streak (an admin alert after 5 in a row) and the person's budget alerts (75/90/100 %).
async function streamOnce({ run: r, user, model, messages, tools, signal, toolChoice = 'auto', effort = null }) {
  const params = {
    ...modelChoice(model), messages, stream: true, max_tokens: 4096,
    reasoning: { effort: effort || settings.get('llm', {}).reasoning || 'low' },
    user: `jessbot-u${user.id}`, session_id: `jessbot-t${r.thread_id}`,
    ...(tools.length ? { tools, tool_choice: toolChoice, ...(toolChoice === 'auto' ? { parallel_tool_calls: false } : {}) } : {}),
  };
  try {
    const out = await streamCall({ run: r, params, signal });
    const by = answeredBy(model, out.answered);
    // The run says which model answered (its reply's model): a fallback shows here, not the configured one.
    if (by.model !== r.model) sql('UPDATE runs SET model = ? WHERE id = ?', by.model, r.id);
    recordUsage({ userId: user.id, runId: r.id, model: by.model, fallback: by.fallback, usage: out.usage });
    providerOutcome(true);
    try { checkBudgetAlerts(user); } catch (err) { console.warn('[spend] alerts', err.message); }
    return { ...out, by };
  } catch (err) {
    if (!signal.aborted) providerOutcome(false, err);
    throw err;
  }
}

async function streamCall({ run: r, params, signal }) {
  const stream = await getClient().chat.completions.create(params, { signal });
  let text = '', buffer = '', usage = null, lastDraft = Date.now(), wroteAny = false, answered = null;
  const calls = [];
  const flush = () => {
    if (!buffer) return;
    runs.emitDelta(r, buffer);
    buffer = '';
    if (Date.now() - lastDraft > DRAFT_MS) { sql('UPDATE runs SET draft = ? WHERE id = ?', text, r.id); lastDraft = Date.now(); }
  };
  const timer = setInterval(flush, DELTA_MS);
  try {
    for await (const chunk of stream) {
      if (chunk.error) throw Object.assign(new Error(chunk.error.message || 'Provider error'), { status: chunk.error.code });
      if (chunk.usage) usage = chunk.usage;
      if (chunk.model) answered = chunk.model;
      const d = chunk.choices?.[0]?.delta;
      if (!d) continue;
      if (d.content) {
        if (!wroteAny) { wroteAny = true; runs.setActivity(r.id, 'writing'); }
        text += d.content;
        buffer += d.content;
      }
      for (const tc of d.tool_calls || []) {
        const c = (calls[tc.index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name += tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
      }
    }
  } catch (err) {
    if (signal.aborted) err.partial = text;
    throw err;
  } finally {
    clearInterval(timer);
    flush();
  }
  // Some SDK versions end the iterator quietly on abort instead of throwing — treat both the same.
  if (signal.aborted) throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError', partial: text });
  return { text, toolCalls: calls.filter(c => c.function.name), usage, answered };
}

// fast: a step the decision model chose (a zap in the timeline instead of the tool's own icon).
async function runTool({ run: r, user, thread, call, signal, fast = false }) {
  const tool = getTool(call.function.name);
  let args = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* handled below */ }
  const label = tool?.label ? tool.label(args) : call.function.name;
  const stepId = runs.startStep(r.id, { label, doing: tool?.doing?.(args), iconName: fast ? 'zap' : tool?.iconName, activity: tool?.activity || 'thinking',
    target: tool?.target?.(args) || null, tool: call.function.name });

  // Only the run's own tools, and only tools meant for this kind of task (#197, #199): a call outside them never runs.
  const off = toolRefusal(r, call.function.name);
  if (off) {
    addMessage({ threadId: r.thread_id, runId: r.id, role: 'tool', toolCallId: call.id, toolName: call.function.name, content: `Error: ${off}` });
    runs.endStep(r.id, stepId, { status: 'bad', detail: 'Not available in this task' });
    return { pause: false };
  }

  // The same change twice is never right (#114): an identical call (same tool, same arguments) that already succeeded in
  // this task and changed something (saved, sent, booked…) isn't run — or asked about — again; its earlier result stands.
  // Seen: after an approved shared save, the same save again, asking the person a second time. Retry makes a new run for
  // the same message, so the earlier attempts count too (Phase 19): a Retry after a failure never resends what went out.
  // An "outcome unknown" is not a success: after checking, doing it again goes through the normal gate.
  if (tool && riskOf(tool, args, { user, runId: r.id }) !== 'read') {
    const want = call.function.arguments || '{}';
    const prior = succeededCalls(attemptsOf(r)).filter(c => c.name === call.function.name && c.args === want).at(-1);
    if (prior) {
      const earlier = prior.runId !== r.id;
      const content = `${earlier ? 'Already done in the earlier attempt' : 'Already done earlier in this task'} — not repeated: ${String(prior.content).slice(0, 600)}`;
      addMessage({ threadId: r.thread_id, runId: r.id, role: 'tool', toolCallId: call.id, toolName: call.function.name, toolArgs: call.function.arguments?.slice(0, 120), content });
      runs.endStep(r.id, stepId, { status: 'ok', detail: earlier ? 'Already done in the earlier attempt' : 'Already done, not repeated' });
      return { pause: false };
    }
  }

  // The repeated-read breaker (#178): a read whose answer doesn't depend on the page open right now (a search, a page read, an
  // inbox listing…) already made REPEAT_LIMIT times in this task, identically, isn't made again: the result is above.
  const key = tool ? readKey(call.function.name, args) : null;
  if (key && callsOf([r.id]).filter(c => !String(c.content).startsWith('Already done') && readKey(c.name, parseArgs(c.args)) === key).length >= REPEAT_LIMIT) {
    addMessage({ threadId: r.thread_id, runId: r.id, role: 'tool', toolCallId: call.id, toolName: call.function.name, toolArgs: call.function.arguments?.slice(0, 120),
      content: REPEAT_REFUSAL });
    runs.endStep(r.id, stepId, { status: 'bad', detail: 'Already done twice, not repeated' });
    return { pause: false };
  }

  // A tool's own refusal that doesn't depend on anyone's OK (tool.precheck, e.g. delegate after a suspected injection or with two
  // background tasks already going, #197) comes before the gate: never a card to approve for a call that can't run.
  let pre = null;
  if (tool?.precheck) { try { pre = tool.precheck(args, { user, run: r }); } catch (err) { pre = err.message; } }
  if (pre) {
    addMessage({ threadId: r.thread_id, runId: r.id, role: 'tool', toolCallId: call.id, toolName: call.function.name, toolArgs: call.function.arguments?.slice(0, 120),
      content: `Error: ${pre}` });
    runs.endStep(r.id, stepId, { status: 'bad', detail: String(pre).split(/[:.]/)[0].slice(0, 80) });
    return { pause: false };
  }

  // A Markdown document written after reading pages gets a Sources section built in code when it has none (#180), before the
  // gate, so an approval card shows exactly what will be saved.
  if (call.function.name === 'library_create' && args.type === 'md' && typeof args.content === 'string' && !hasSourcesSection(args.content)) {
    const section = sourcesSection(sourcesOf(r.id));
    if (section) args = { ...args, content: `${args.content.trimEnd()}\n\n${section}\n` };
  }

  // A scheduled or background task's one closing question (#83 as amended, #197): once, and only after the work is done.
  // Overnight prep never asks (it isn't offered ask_user; a made-up call is refused too).
  if (call.function.name === 'ask_user' && (ONE_QUESTION.has(r.origin) || NOBODY_TO_ASK.has(r.origin))) {
    const refusal = NOBODY_TO_ASK.has(r.origin)
      ? 'Nobody is awake to answer during overnight preparation. Make a sensible assumption, say it in what you save, and carry on.'
      : checkpointRefusal(r);
    if (refusal) {
      addMessage({ threadId: r.thread_id, runId: r.id, role: 'tool', toolCallId: call.id, toolName: call.function.name, content: `Error: ${refusal}` });
      runs.endStep(r.id, stepId, { status: 'bad', detail: NOBODY_TO_ASK.has(r.origin) ? 'Not now: nobody is awake to answer'
        : `Not now: a ${taskNoun(r)} asks only at the end` });
      return { pause: false };
    }
  }

  // Outbound guard (decision #126): a call carrying one of this install's secrets (the model key, a saved password…) never
  // runs and is never offered for approval. The audit row names the tool and the kind of secret, never the value.
  const leaked = tool ? secretsIn(argText(args)) : [];
  if (leaked.length) {
    audit('secret_blocked', { actorId: user.id, targetType: 'run', targetId: r.id, detail: { tool: tool.name, secret: leaked.join(', ') } });
    addMessage({ threadId: r.thread_id, runId: r.id, role: 'tool', toolCallId: call.id, toolName: call.function.name, toolArgs: '(held back)',
      content: `Error: Blocked. This call contained ${leaked.join(' and ')}, which must never leave this app. It was NOT done. Don't try again or `
        + 'put it anywhere else; tell the person plainly that you stopped because the request would have sent a secret out.' });
    runs.endStep(r.id, stepId, { status: 'bad', detail: 'Stopped: it would have sent a secret out' });
    return { pause: false };
  }

  // Policy gate (decisions #13/#14, #124): run, ask first, or refuse. A tool's riskCheck (decision model) can only make it
  // stricter; so can what the task read before (taint) and where a URL would send data (policy.assess).
  let raised = null; // a riskCheck may return a value or a promise, and must never break the step
  if (tool?.riskCheck) { try { raised = await tool.riskCheck(args, { user, runId: r.id }); } catch { raised = null; } }
  const gate = tool ? assess(user, tool, args, r.id, { raised }) : { verdict: 'allow' };
  const verdict = gate.verdict;
  // Overnight prep (#199): nobody is awake to approve, and a push at night is exactly what it must not send.
  if (verdict === 'ask' && NOBODY_TO_ASK.has(r.origin)) {
    addMessage({ threadId: r.thread_id, runId: r.id, role: 'tool', toolCallId: call.id, toolName: call.function.name,
      content: 'Error: Not done: this needs the person’s OK, and nobody can approve anything during overnight preparation. Don’t try it again; '
        + 'list it as a next step for them in what you save.' });
    runs.endStep(r.id, stepId, { status: 'bad', detail: 'Needs their OK: left for the morning' });
    return { pause: false };
  }
  if (verdict === 'ask') {
    const a = createApproval({ run: r, user, tool, args, toolCallId: call.id, risk: gate.risk, why: gate.why });
    runs.endStep(r.id, stepId, { status: 'wait', detail: 'Waiting for approval' });
    return { pause: true, approvalId: a.id };
  }

  let content, status = 'ok', pause = false, questionId, step = {}, attach = null;
  try {
    if (!tool) throw new Error(`Unknown tool ${call.function.name}`);
    if (verdict === 'off') throw new Error(`${tool.name} isn't enabled for ${user.firstName} — the admin controls this in Admin → People.`);
    if (signal.aborted) throw new Error('cancelled');
    const out = await tool.run(args, { user, thread, run: r, toolCallId: call.id, signal });
    if (out && typeof out === 'object' && out.pause) { pause = true; questionId = out.questionId; }
    // A tool may return { content, step: { detail?, image?, status? } } to enrich its visible step.
    else if (out && typeof out === 'object' && typeof out.content === 'string') { content = out.content; step = out.step || {}; status = step.status || 'ok'; attach = out.attachments || null; }
    else content = typeof out === 'string' ? out : JSON.stringify(out);
  } catch (err) {
    status = 'bad';
    // Validation errors keep the specific reasons in err.errors — give the model those, not the generic line.
    content = `Error: ${err.errors ? Object.values(err.errors).join(' ') : err.message}`;
  }
  if (pause) { runs.endStep(r.id, stepId, { status: 'wait' }); return { pause, questionId }; }
  noteToolRead(r.id, call.function.name); // outside content read without guardOutside's own mark (agent/taint.js)
  if (status === 'ok') noteSources(r.id, call.function.name, args, content, step); // what it searched and read on the web (#180)
  addMessage({ threadId: r.thread_id, runId: r.id, role: 'tool', toolCallId: call.id, toolName: call.function.name,
    toolArgs: call.function.arguments?.slice(0, 120), content, attachments: attach }); // attach: an image shown this turn (view_image)
  runs.endStep(r.id, stepId, { status, detail: step.detail, image: step.image, href: step.href, handover: step.handover });
  logToolActivity(user, r, tool, args, label, status, step.href);
  return { pause: false };
}

// Meaningful actions (not reads) go to the activity feed.
function logToolActivity(user, r, tool, args, label, status, href) {
  if (!tool) return;
  if (riskOf(tool, args, { user, runId: r.id }) === 'read') return;
  logActivity(user.id, { kind: tool.activityKind || 'task', icon: tool.iconName || null, runId: r.id, href: href || `/chat/${r.thread_id}`,
    title: label, detail: tool.target?.(args) || null, status: status === 'ok' ? 'ok' : 'bad' });
}

// Tell the requester (their chat bubble + panel) and, if different, the approver (panel + badge).
async function announceApproval(a, bubbleHtml) {
  const requester = getUser(a.user_id);
  const approver = getUser(a.approver_id);
  const forRequester = await renderFragment('approval-card', { ...approvalView(a, requester), compact: true }, requester).catch(() => null);
  publish(requester.id, 'approval.created', { approvalId: a.id, html: bubbleHtml, cardHtml: forRequester,
    pendingCount: get(`SELECT COUNT(*) AS n FROM approvals WHERE approver_id = ? AND status = 'pending'`, requester.id).n },
  { threadId: a.thread_id, runId: a.run_id });
  if (approver && approver.id !== requester.id) {
    const forApprover = await renderFragment('approval-card', { ...approvalView(a, approver), compact: true }, approver).catch(() => null);
    publish(approver.id, 'approval.created', { approvalId: a.id, cardHtml: forApprover,
      pendingCount: get(`SELECT COUNT(*) AS n FROM approvals WHERE approver_id = ? AND status = 'pending'`, approver.id).n });
  }
}

// A decision (or expiry) arrived: run the exact stored call if approved, otherwise tell the model it was declined.
// From here the run is working again ("running", not "waiting"): a message sent meanwhile queues behind it instead of
// closing it as "moved on", and the call runs in the thread's queue (chain), before anything that came in since.
export async function resumeAfterApproval(approvalId) {
  const a = getApproval(approvalId);
  const r = a && runs.getRun(a.run_id);
  if (!r || r.status !== 'waiting' || a.status === 'pending') return;
  runs.setStatus(r.id, 'running');
  return chain(r.thread_id, async () => {
    if (runs.getRun(r.id).status !== 'running') return; // stopped while it waited its turn: the call never goes out
    await deliverDecision(a, runs.getRun(r.id));
    return execute(r.id);
  });
}

async function deliverDecision(a, r) {
  if (hasResult(r.id, a.tool_call_id)) return; // already delivered (a restart came between the result and going on)
  const user = getUser(a.user_id);
  const thread = get('SELECT * FROM threads WHERE id = ?', r.thread_id);
  const tool = getTool(a.tool);
  const args = JSON.parse(a.args);
  let content;
  if (a.status === 'approved' && tool) {
    const label = tool.label ? tool.label(args) : a.tool;
    const stepId = runs.startStep(r.id, { label, doing: tool.doing?.(args), iconName: tool.iconName, activity: tool.activity || 'thinking',
      target: tool.target?.(args) || null, tool: a.tool });
    // Intent first (Phase 19): a restart from here on is an unknown outcome (recoverRuns), never a silent redo.
    markExecuting(a.id);
    try {
      const out = await tool.run(args, { user, thread, run: r, toolCallId: a.tool_call_id });
      // Same result shape as runTool(): a string, or { content, step } that enriches the visible step.
      const step = out && typeof out === 'object' && typeof out.content === 'string' ? out.step || {} : {};
      content = typeof out === 'string' ? out : typeof out?.content === 'string' ? out.content : JSON.stringify(out);
      runs.endStep(r.id, stepId, { status: step.status || 'ok', detail: step.detail, image: step.image, href: step.href, handover: step.handover });
      if ((step.status || 'ok') === 'ok') noteSources(r.id, a.tool, args, content, step);
      logToolActivity(user, r, tool, args, label, 'ok', step.href);
    } catch (err) {
      content = `Error: ${err.errors ? Object.values(err.errors).join(' ') : err.message}`;
      runs.endStep(r.id, stepId, { status: 'bad' });
    }
  } else if (a.status === 'expired') {
    content = 'Nobody approved this in time, so it was NOT done. Tell the person briefly and offer to try again.';
  } else {
    content = `The person declined this action${a.reason ? ` (reason: ${a.reason})` : ''}. It was NOT done. Don't retry it — ask what they'd prefer instead.`;
  }
  logActivity(user.id, { kind: 'approval', icon: a.status === 'approved' ? 'shield-check' : 'shield-x', runId: r.id, href: `/chat/${r.thread_id}`,
    title: `${a.status === 'approved' ? 'Approved' : a.status === 'expired' ? 'Expired' : 'Declined'}: ${a.title}`, status: a.status === 'approved' ? 'ok' : 'warn' });
  addMessage({ threadId: r.thread_id, runId: r.id, role: 'tool', toolCallId: a.tool_call_id, toolName: a.tool, content });
}

// Unanswered approvals expire (→ treated as declined). Checked every minute.
export function startApprovalExpiry() {
  const tick = () => {
    for (const a of expiredApprovals()) { expireApproval(a); resumeAfterApproval(a.id).catch(e => console.error('[approvals] resume failed', e)); }
  };
  setInterval(tick, 60_000).unref();
  tick();
}

// Answers arrived for a paused run: add the tool result and continue the same run.
export function resumeWithAnswer(runId, toolCallId, answerText) {
  const r = runs.getRun(runId);
  addMessage({ threadId: r.thread_id, runId, role: 'tool', toolCallId, toolName: 'ask_user', content: answerText });
  sql(`UPDATE runs SET status = 'queued' WHERE id = ?`, runId);
  return enqueueRun(runId);
}
