// Scheduled tasks ("every weekday at 7, brief me") and each person's proactive check-in (decisions #28, #48).
// A due schedule becomes an agent run in the person's chat, started by a hidden system message with its instructions.
import { get, all, run } from '../db/index.js';
import { invalid, notFound } from '../lib/errors.js';
import { tzOf, nextFromCron, localToDate, describeCron, localLabel } from '../lib/when.js';
import { toIso } from './chatview.js';

export const CHECKIN_CRON = { normal: '0 9,13,18 * * *', light: '0 9 * * *' };
export const FAIL_PAUSE = 3; // a scheduled task that fails this many times in a row pauses (decision #178; agent/proactive.js)
const TITLE_MAX = 80;
// Watches (Phase 19): quiet checks that write only when their condition is met. At most every 2 hours (a page checked more
// often is noise and cost), at most 10 active per person (≈ $0.03–0.08 a week each, docs/DECISIONS.md).
export const WATCH_MIN_GAP_MS = 2 * 3600000;
export const WATCH_MAX = 10;
export const MEMO_MAX = 500;

export const getSchedule = id => get('SELECT * FROM schedules WHERE id = ?', id) || null;

export function scheduleForUser(user, id) {
  const s = getSchedule(Number(id));
  if (!s || s.user_id !== user.id) throw notFound('That scheduled task doesn’t exist.');
  return s;
}

export const isWatch = s => s?.notify === 'changes';

// The next occurrence. With an end date: a watch fires once more AT its end (its closing note), other tasks just stop.
function nextRun(s, from = new Date()) {
  const next = s.cron ? nextFromCron(s.cron, s.timezone, from)?.toISOString() || null
    : s.run_at && new Date(s.run_at) > from ? s.run_at : null;
  if (next && s.ends_at && next > s.ends_at) return isWatch(s) && new Date(s.ends_at) > from ? s.ends_at : null;
  return next;
}

// The shortest gap between the next few occurrences of a cron pattern (watches may not run more often than every 2 h).
function minGapMs(cron, tz, from = new Date()) {
  let prev = nextFromCron(cron, tz, from), gap = Infinity;
  for (let i = 0; i < 6 && prev; i++) {
    const n = nextFromCron(cron, tz, new Date(prev.getTime() + 1000));
    if (!n) break;
    gap = Math.min(gap, n - prev);
    prev = n;
  }
  return gap;
}

const activeWatches = userId => get(`SELECT COUNT(*) AS n FROM schedules WHERE user_id = ? AND notify = 'changes' AND paused = 0
  AND next_run_at IS NOT NULL`, userId).n;

/**
 * cron (5-field, in the person's timezone) for a rhythm, or `at` ("YYYY-MM-DDTHH:mm" local) for once.
 * A watch (Phase 19): `onlyWhen` (the condition in words) and/or `watchUrl` (a page checked in code first) → it writes only
 * when the condition is met. `until` ("YYYY-MM-DD" local): no runs after the end of that day.
 */
export function createSchedule({ user, title, prompt, cron = null, at = null, threadId = null, createdBy = 'agent', kind = 'task',
  onlyWhen = null, until = null, watchUrl = null }) {
  const tz = tzOf(user);
  const errors = {};
  const t = String(title || '').trim();
  if (!t) errors.title = 'Give the task a short title.';
  else if (t.length > TITLE_MAX) errors.title = `Keep the title under ${TITLE_MAX} characters.`;
  if (kind === 'task' && !String(prompt || '').trim()) errors.prompt = 'Say what should happen each time.';
  const condition = String(onlyWhen || '').replace(/\s+/g, ' ').trim();
  if (condition.length > 300) errors.only_when = 'Keep the condition under 300 characters.';
  let url = null;
  if (watchUrl) {
    try {
      const u = new URL(String(watchUrl).trim());
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('scheme');
      url = u.href.slice(0, 2000);
    } catch { errors.watch_url = 'Give the full address of the page to watch (https://…).'; }
  }
  const watch = kind === 'task' && !!(condition || watchUrl);
  let runAt = null, next = null, endsAt = null;
  if (cron) {
    try { next = nextFromCron(cron, tz); } catch { errors.cron = 'That schedule pattern isn’t valid (use 5-field cron, e.g. "0 7 * * 1-5").'; }
    if (!errors.cron && !next) errors.cron = 'That schedule never happens.';
    if (!errors.cron && watch && minGapMs(cron, tz) < WATCH_MIN_GAP_MS) errors.cron = 'A watch checks at most every 2 hours (for example "0 8,14,20 * * *").';
  } else if (at) {
    next = localToDate(at, tz);
    runAt = next?.toISOString();
    if (!next) errors.at = 'That time is in the past or not a valid date.';
  } else errors.cron = 'Say when: a repeating pattern or a date and time.';
  if (until) {
    const day = String(until).trim();
    const end = /^\d{4}-\d{2}-\d{2}$/.test(day) ? localToDate(`${day}T23:59:59`, tz) : null;
    if (!end) errors.until = 'Give the last day as YYYY-MM-DD, today or later.';
    else if (next && next > end) errors.until = 'That ends before it would first run.';
    else endsAt = end.toISOString();
  }
  if (watch && activeWatches(user.id) >= WATCH_MAX) errors.only_when = `There are already ${WATCH_MAX} active watches; stop one first (Upcoming).`;
  if (Object.keys(errors).length) throw invalid(errors);
  const { lastInsertRowid } = run(
    `INSERT INTO schedules (user_id, kind, title, prompt, cron, run_at, timezone, next_run_at, thread_id, created_by, notify, only_when, ends_at, watch_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    user.id, kind, t, String(prompt || '').trim().slice(0, 4000), cron, runAt, tz, next.toISOString(), threadId, createdBy,
    watch ? 'changes' : 'always', condition || null, endsAt, url);
  return getSchedule(Number(lastInsertRowid));
}

export const listSchedules = (user, { includeCheckin = false } = {}) => all(
  `SELECT * FROM schedules WHERE user_id = ? ${includeCheckin ? '' : `AND kind = 'task'`} AND (next_run_at IS NOT NULL OR paused = 1)
   ORDER BY paused, next_run_at`, user.id);
export const dueSchedules = (now = new Date()) => all(`SELECT * FROM schedules WHERE paused = 0 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`, now.toISOString());
export const nextScheduleAt = () => get('SELECT MIN(next_run_at) AS t FROM schedules WHERE paused = 0 AND next_run_at IS NOT NULL')?.t || null;

/**
 * After firing (or skipping): move to the next occurrence. status: 'skipped' | 'silent' (decided now) or null (a run was
 * started: its outcome is recorded when it FINISHES, recordRunResult). check: a watch's last_check when known now.
 */
export function advance(s, { status = null, runId = null, now = new Date(), check = null }) {
  run(`UPDATE schedules SET last_run_at = ?, last_status = ?, last_run_id = COALESCE(?, last_run_id), next_run_at = ?,
       last_check = COALESCE(?, last_check), checked_at = CASE WHEN ? IS NULL THEN checked_at ELSE ? END, updated_at = datetime('now') WHERE id = ?`,
    now.toISOString(), status, runId, nextRun(s, now), check, check, now.toISOString(), s.id);
  return getSchedule(s.id);
}

/** A run of this schedule finished: 'ok' | 'bad' | 'silent' (older runs have no schedule_id: matched by last_run_id). */
export function recordRunResult(r, status) {
  if (r.schedule_id) run(`UPDATE schedules SET last_status = ?, last_run_id = ?, updated_at = datetime('now') WHERE id = ?`, status, r.id, r.schedule_id);
  else run('UPDATE schedules SET last_status = ? WHERE last_run_id = ?', status, r.id);
}

/** A scheduled task's run finished (not a watch: they count their own failed checks): a final failure adds one to fail_streak,
 *  a success resets it. Returns the new streak (three in a row pause it, decision #178: agent/proactive.js). */
export function recordTaskOutcome(scheduleId, ok) {
  run(`UPDATE schedules SET fail_streak = CASE WHEN ? THEN 0 ELSE fail_streak + 1 END, updated_at = datetime('now') WHERE id = ?`, ok ? 1 : 0, scheduleId);
  return getSchedule(scheduleId)?.fail_streak ?? 0;
}

/** A watch past its end date: no more runs. */
export const endSchedule = s => run(`UPDATE schedules SET next_run_at = NULL, updated_at = datetime('now') WHERE id = ?`, s.id);

// ---- Watches: what the last check saw (the NOTE line), failures in a row, the page's fingerprint ---------------------------
// The page hash found before a watch run is committed only when that run's check succeeded, so a failed check never hides
// a change from the next one (a restart loses at most one saved model call, never a change).
const stagedHashes = new Map(); // runId → SHA-256
export const stageWatchHash = (runId, hash) => stagedHashes.set(runId, hash);

/**
 * A watch run's NOTE line (already cleaned to one line by the loop). failed: "NOTE: failed — why", or the run errored.
 * reported: the condition was met and they were told. Returns the updated schedule (fail_streak: when to speak up).
 */
export function recordWatchCheck(scheduleId, { note = null, failed = false, reported = false, runId = null, now = new Date() }) {
  const hash = stagedHashes.get(runId);
  stagedHashes.delete(runId);
  const at = now.toISOString();
  if (failed) {
    run(`UPDATE schedules SET fail_streak = fail_streak + 1, last_check = 'failed', checked_at = ?, updated_at = datetime('now') WHERE id = ?`, at, scheduleId);
  } else {
    const memo = note ? String(note).slice(0, MEMO_MAX) : null;
    run(`UPDATE schedules SET fail_streak = 0, last_check = ?, checked_at = ?, memo = COALESCE(?, memo), memo_at = CASE WHEN ? IS NULL THEN memo_at ELSE ? END,
         watch_hash = COALESCE(?, watch_hash), updated_at = datetime('now') WHERE id = ?`,
    reported ? 'reported' : 'noted', at, memo, memo, at, hash || null, scheduleId);
  }
  return getSchedule(scheduleId);
}

// Resuming starts the count of failures in a row over (else one more failure would pause it again at once).
export function pauseSchedule(s, paused) {
  run(`UPDATE schedules SET paused = ?, next_run_at = ?, fail_streak = CASE WHEN ? THEN fail_streak ELSE 0 END, updated_at = datetime('now') WHERE id = ?`,
    paused ? 1 : 0, paused ? s.next_run_at : nextRun(s), paused ? 1 : 0, s.id);
  return getSchedule(s.id);
}

export const deleteSchedule = s => run('DELETE FROM schedules WHERE id = ?', s.id);

// ---- Check-ins: one row per person, kept in line with their preference -------------------------------------
export function ensureCheckin(user) {
  const pref = user.checkins || 'normal';
  const row = get(`SELECT * FROM schedules WHERE user_id = ? AND kind = 'checkin'`, user.id);
  if (pref === 'off' || user.status !== 'active') {
    if (row && !row.paused) run(`UPDATE schedules SET paused = 1, updated_at = datetime('now') WHERE id = ?`, row.id);
    return row ? getSchedule(row.id) : null;
  }
  const cron = CHECKIN_CRON[pref];
  const tz = tzOf(user);
  const next = nextFromCron(cron, tz).toISOString();
  if (!row) {
    run(`INSERT INTO schedules (user_id, kind, title, prompt, cron, timezone, next_run_at, created_by) VALUES (?, 'checkin', 'Check-in', '', ?, ?, ?, 'system')`,
      user.id, cron, tz, next);
  } else if (row.cron !== cron || row.timezone !== tz || row.paused) {
    run(`UPDATE schedules SET cron = ?, timezone = ?, next_run_at = ?, paused = 0, updated_at = datetime('now') WHERE id = ?`, cron, tz, next, row.id);
  }
  return get(`SELECT * FROM schedules WHERE user_id = ? AND kind = 'checkin'`, user.id);
}

// ---- Views (contract: partials/job-card.hbs) ---------------------------------------------------------------
const CHECKED = { unchanged: 'no change', noted: 'nothing to report', reported: 'told you', failed: 'couldn’t check', missed: 'missed' };

/**
 * lastStatus: ok | bad | silent (nothing worth saying) | skipped (not run: offline, quiet hours, budget) | running | retrying
 * | null (never ran). watch: the "Watching · last: … · checked 07:00" data for Upcoming (the screen is Phase 25).
 */
export function jobView(s, now = new Date()) {
  const last = s.last_run_id ? get('SELECT status, retry_at FROM runs WHERE id = ?', s.last_run_id) : null;
  const lastStatus = last && ['queued', 'running', 'waiting'].includes(last.status) ? 'running'
    : last?.status === 'error' && last.retry_at ? 'retrying' : s.last_status || null;
  const time = v => new Intl.DateTimeFormat('en-GB', { timeZone: s.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(v));
  const watch = isWatch(s) ? {
    condition: s.only_when || null, url: s.watch_url || null, lastNote: s.memo || null, notedAt: toIso(s.memo_at),
    checkedAt: toIso(s.checked_at), checkedLabel: s.checked_at ? localLabel(s.checked_at, s.timezone, now) : null,
    lastCheck: s.last_check || null, failStreak: s.fail_streak || 0,
    line: ['Watching', s.memo ? `last: ${s.memo.slice(0, 80)}` : 'no check yet',
      s.checked_at ? `checked ${time(s.checked_at)}${CHECKED[s.last_check] ? `, ${CHECKED[s.last_check]}` : ''}` : null].filter(Boolean).join(' · '),
  } : null;
  return {
    id: s.id, title: s.title, iconName: s.kind === 'checkin' ? 'hand-heart' : 'calendar-clock', kind: s.kind,
    scheduleLabel: s.cron ? describeCron(s.cron) : `Once · ${localLabel(s.run_at, s.timezone, now)}`,
    nextRunAt: toIso(s.next_run_at), nextLabel: s.next_run_at ? localLabel(s.next_run_at, s.timezone, now) : null,
    paused: !!s.paused, lastStatus,
    // Phase 25 (#212): failures in a row, and whether that's why it is paused ("Paused after 3 failures in a row").
    failStreak: s.fail_streak || 0, pausedByFailures: !!s.paused && (s.fail_streak || 0) >= FAIL_PAUSE, lastRunAt: toIso(s.last_run_at), lastRunId: s.last_run_id || null, prompt: s.prompt,
    endsAt: toIso(s.ends_at), endsLabel: s.ends_at ? localLabel(s.ends_at, s.timezone, now) : null, watch,
    // Phase 25 (#196): when the one automatic retry is due ("Trying again at 14:05"), and the chat its runs post in.
    retryAt: lastStatus === 'retrying' ? toIso(last.retry_at) : null, retryLabel: lastStatus === 'retrying' ? time(toIso(last.retry_at)) : null,
    threadHref: s.thread_id ? `/chat/${s.thread_id}` : '/chat',
  };
}
