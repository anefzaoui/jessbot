// Runs: one reply cycle. State lives in the `runs` row; every change is also published as an event (bus.js) so
// every open screen (and a reconnecting one) stays in sync. Views match partials/chat/run-steps.hbs.
import { get, all, run } from '../db/index.js';
import { publish } from '../lib/bus.js';
import { activityOf } from '../../public/js/activities.js';
import { progressive } from '../lib/verbs.js';
import { faviconPath, iconUrl } from './favicons.js';
import { sourcesOf, trustChip } from './sources.js';

const now = () => new Date().toISOString();
const parseSteps = r => (r?.steps ? JSON.parse(r.steps) : []);

// origin: chat (typed message) | schedule | checkin | reminder | goal | project | delegate (a background task, #197) | prep
// (overnight prep, #199) — non-chat runs start from a hidden system message.
// scheduleId: the schedule that started it (its outcome is recorded there when it finishes); watch: a quiet watch check;
// retryOf: the failed run this one replaces (Retry, or the one automatic retry of an unattended run); parentRunId: the run
// whose `delegate` call started it; spendCap: what it may spend instead of the person's per-task cap; toolAllow: the only
// tool names it may use (the loop offers and allows nothing else).
export function createRun({ threadId, userId, triggerMessageId, model, origin = 'chat', originLabel = null, goalId = null,
  scheduleId = null, watch = false, retryOf = null, parentRunId = null, spendCap = null, toolAllow = null }) {
  const { lastInsertRowid } = run(
    `INSERT INTO runs (thread_id, user_id, trigger_message_id, model, status, activity, origin, origin_label, goal_id, schedule_id, watch, retry_of,
       parent_run_id, spend_cap, tool_allow)
     VALUES (?, ?, ?, ?, 'queued', 'thinking', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    threadId, userId, triggerMessageId, model, origin, originLabel, goalId, scheduleId, watch ? 1 : 0, retryOf,
    parentRunId, spendCap == null ? null : Number(spendCap), toolAllow ? JSON.stringify([...toolAllow]) : null);
  return getRun(Number(lastInsertRowid));
}

/** The only tools a run may use (a Set of names), or null when its person's toolsets decide (runs.tool_allow). */
export function toolAllowOf(r) {
  if (!r?.tool_allow) return null;
  try { return new Set(JSON.parse(r.tool_allow)); } catch { return new Set(); } // unreadable: nothing, never everything
}

export const getRun = id => get('SELECT * FROM runs WHERE id = ?', id) || null;
export const activeRuns = userId => all(`SELECT * FROM runs WHERE user_id = ? AND status IN ('queued','running','waiting') ORDER BY id`, userId);
export const lastRunOfThread = threadId => get('SELECT * FROM runs WHERE thread_id = ? ORDER BY id DESC LIMIT 1', threadId) || null;

function emit(r, type, data) {
  return publish(r.user_id, type, { runId: r.id, ...data }, { threadId: r.thread_id, runId: r.id });
}

export function setStatus(runId, status, { error = null } = {}) {
  const ended = ['done', 'error', 'cancelled'].includes(status);
  run(`UPDATE runs SET status = ?, error = COALESCE(?, error), ended_at = CASE WHEN ? THEN datetime('now') ELSE ended_at END WHERE id = ?`,
    status, error, ended ? 1 : 0, runId);
  const r = getRun(runId);
  emit(r, 'run.status', { status, error: r.error });
  // A goal step's run starting or stopping to ask something changes what its goal page says. Its end is announced by the
  // goal hook AFTER the timeline entry is written (announcing here too made the page reload early and miss that entry).
  if (r.goal_id && (status === 'waiting' || status === 'running')) publish(r.user_id, 'goal.updated', { id: r.goal_id }, { persist: false });
  publishAgentState(r.user_id);
  return r;
}

// What Jess is doing for this person right now (status strip, avatar, tab title).
export function setActivity(runId, activity, target = null) {
  run('UPDATE runs SET activity = ?, activity_target = ? WHERE id = ?', activity, target, runId);
  publishAgentState(getRun(runId).user_id);
}

export function setReplyMessage(runId, messageId) {
  run('UPDATE runs SET reply_message_id = ? WHERE id = ?', messageId, runId);
}

// Steps: the visible lineage of a run ("Searched…", "Read…"). Returns the step id.
// label is past tense ("Typed “Lisbon” in From"); while the step runs it reads in the present ("Typing … …", lib/verbs.js).
// tool: the tool behind the step (stored, not shown): the dead-end detector groups steps by tool and site (#177).
export function startStep(runId, { iconName, label, doing = null, detail = null, activity = null, target = null, tool = null }) {
  const r = getRun(runId);
  const steps = parseSteps(r);
  const step = { id: `s${steps.length + 1}`, iconName: iconName || activityOf(activity || 'thinking').iconName,
    label: doing || progressive(label), doneLabel: label, detail, status: 'run', startedAt: now(), activity: activity || 'thinking', target, ...(tool ? { tool } : {}) };
  steps.push(step);
  run('UPDATE runs SET steps = ? WHERE id = ?', JSON.stringify(steps), runId);
  if (activity) setActivity(runId, activity, target);
  emit(r, 'run.step', { step: stepView(step) });
  return step.id;
}

export function endStep(runId, stepId, { status = 'ok', detail, image, href, handover } = {}) {
  const r = getRun(runId);
  const steps = parseSteps(r);
  const s = steps.find(x => x.id === stepId);
  if (!s) return;
  s.status = status;
  s.endedAt = now();
  if (s.doneLabel) s.label = s.doneLabel;
  if (detail !== undefined) s.detail = detail;
  if (image) s.image = image;
  if (href) s.href = href;
  if (handover) s.handover = true; // "Take over" Jess's browser tab from this step (decision #61)
  run('UPDATE runs SET steps = ? WHERE id = ?', JSON.stringify(steps), runId);
  emit(r, 'run.step', { step: stepView(s) });
}

// Streaming text for the reply (coalesced by the loop); persisted so a reconnect can catch up.
export const emitDelta = (r, text) => emit(r, 'run.delta', { text });

// ---- Views ------------------------------------------------------------------------------------
const secs = (a, b) => Math.max(0, Math.round((new Date(b || Date.now()) - new Date(a)) / 1000));
export const durationLabel = s => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);

function stepView(s) {
  return { id: s.id, iconName: s.iconName, label: s.label, detail: s.detail, status: s.status, image: s.image || null, href: s.href || null,
    handover: !!s.handover, activity: s.activity || null, tool: s.tool || null, // tool: the delegate step's link stays visible (#212) favicon: faviconPath(s.href) || (s.target && /^[\w.-]+\.[a-z]{2,}$/i.test(s.target) ? iconUrl(s.target) : null),
    durationLabel: s.endedAt ? durationLabel(secs(s.startedAt, s.endedAt)) : null };
}

export function runView(r, lastSeq = 0) {
  if (!r) return null;
  const iso = v => (v ? new Date(v.replace(' ', 'T') + (v.includes('T') ? '' : 'Z')).toISOString() : null);
  const steps = parseSteps(r).map(stepView);
  return {
    id: r.id, status: r.status, startedAt: iso(r.started_at), lastSeq, origin: r.origin || 'chat', originLabel: r.origin_label,
    elapsedLabel: durationLabel(secs(iso(r.started_at), iso(r.ended_at))),
    steps, error: r.error,
    // Phase 19: what kind of failure (transient | permanent | interrupted | budget), when the one automatic retry is due,
    // and the schedule behind it (a "Run it now" for a failed or missed task; the screen is Phase 25).
    errorKind: r.error_kind || null, retryAt: iso(r.retry_at), scheduleId: r.schedule_id || null,
    // A "paused after 3 failures" note (#178): is that task still paused? (Resume shows only while it is, Phase 25 #212.)
    schedulePaused: r.error_kind === 'paused' && r.schedule_id ? !!get('SELECT paused FROM schedules WHERE id = ?', r.schedule_id)?.paused : null,
    // A background task (#197): the run that started it (its chat gets the result); the link screens are Phase 25.
    parentRunId: r.parent_run_id || null,
    // The live card: what's happening now, and the sites visited so far (a favicon stack, like sources).
    current: steps.findLast(x => x.status === 'run' || x.status === 'wait') || null,
    // What the task searched and read on the web (#180): the trust chip, "Checked 4 sources · 3 sites · newest 2 days old"
    // with the list behind it (null when it used none; the screen is Phase 25).
    sources: trustChip(sourcesOf(r)),
    sites: [...new Map(steps.filter(x => x.favicon).map(x => [x.favicon, { favicon: x.favicon, host: hostOf(x.href) || x.detail }])).values()].slice(0, 5),
  };
}
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

// ---- Person-level state ------------------------------------------------------------------------
export function agentState(userId) {
  const active = activeRuns(userId);
  const waiting = active.find(r => r.status === 'waiting');
  const busy = active.find(r => r.status === 'running' || r.status === 'queued');
  const doneToday = get(`SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND status = 'done' AND ended_at >= date('now')`, userId).n;
  const toIso = v => new Date(v.replace(' ', 'T') + 'Z').toISOString();
  if (waiting) return { activity: 'waiting', target: 'your answer', since: toIso(waiting.started_at), doneToday, upcomingCount: 0 };
  if (busy) return { activity: busy.activity || 'thinking', target: busy.activity_target, since: toIso(busy.started_at), doneToday, upcomingCount: 0 };
  return { activity: 'resting', doneToday, upcomingCount: 0 };
}

export function publishAgentState(userId) {
  publish(userId, 'agent.state', agentState(userId), { persist: false });
}
