// Goals (decision #55): what a person is working toward, the plan of things Jess can do about it (goal_tasks — the
// projects/tasks model), and a timeline of what happened. The model work (questions, plan, check-ins) lives in
// src/agent/goals.js; this file is data + views (contracts: partials/goal-card.hbs, pages/goal.hbs, pages/goals.hbs).
import { get, all, run, tx } from '../db/index.js';
import { invalid, notFound } from '../lib/errors.js';
import { publish } from '../lib/bus.js';
import { createSideThread } from './threads.js';
import { toIso } from './chatview.js';
import { getUser } from './users.js';
import { turnedDown } from './ideas.js';
import { dayKey, tzOf } from '../lib/when.js';
import { GOAL_CATEGORIES } from '../content/starters.js';

const CATEGORY = Object.fromEntries(GOAL_CATEGORIES.map(c => [c.value, c]));
export const categoryOf = key => CATEGORY[key] || { value: 'other', label: 'Other', hue: 285 };
export const REPEATS = ['daily', 'weekdays', 'weekly', 'monthly'];

// Icons the model may pick for a plan step (all in the sprite: build-assets scans these iconName literals).
export const TASK_ICONS = [
  { iconName: 'search' }, { iconName: 'file-text' }, { iconName: 'sparkles' }, { iconName: 'calendar-clock' }, { iconName: 'list-checks' },
  { iconName: 'pen-line' }, { iconName: 'chart-line' }, { iconName: 'lightbulb' }, { iconName: 'mail' }, { iconName: 'bell' },
  { iconName: 'map' }, { iconName: 'dumbbell' }, { iconName: 'wallet' }, { iconName: 'book-open' }, { iconName: 'users' },
  { iconName: 'megaphone' }, { iconName: 'shopping-cart' }, { iconName: 'heart-pulse' }, { iconName: 'graduation-cap' }, { iconName: 'house' },
].map(i => i.iconName);
const iconOr = (name, fallback = 'circle-dashed') => (TASK_ICONS.includes(name) ? name : fallback);

// ---- Goals --------------------------------------------------------------------------------------------------
export const getGoal = id => get('SELECT * FROM goals WHERE id = ?', id) || null;

export function goalForUser(user, id) {
  const g = /^\d+$/.test(String(id)) ? getGoal(Number(id)) : null;
  if (!g || g.user_id !== user.id || g.state === 'dismissed') throw notFound('That goal is gone.');
  return g;
}

const cleanTitle = t => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);

export function createGoal({ user, title, category = 'other', createdBy = 'user', state = 'active', why = null }) {
  const t = cleanTitle(title);
  if (t.length < 3) throw invalid({ title: 'Tell me a little more — a short sentence is plenty.' });
  const { lastInsertRowid } = run(`INSERT INTO goals (user_id, title, category, created_by, state, why) VALUES (?, ?, ?, ?, ?, ?)`,
    user.id, t, CATEGORY[category] ? category : 'other', createdBy, state, why ? String(why).slice(0, 240) : null);
  const g = getGoal(Number(lastInsertRowid));
  if (state === 'active') addEvent(g, { kind: 'milestone', iconName: 'flag', title: 'Goal set' });
  return g;
}

/** Title/category/horizon/state changes from the goal page. */
export function updateGoal(g, patch) {
  const next = { ...g };
  if (patch.title != null) { next.title = cleanTitle(patch.title); if (next.title.length < 3) throw invalid({ title: 'That title is too short.' }); }
  if (patch.category != null) next.category = CATEGORY[patch.category] ? patch.category : 'other';
  if (patch.horizon != null) next.horizon = patch.horizon === 'long' ? 'long' : 'now';
  if (patch.state != null) {
    if (!['active', 'paused', 'done', 'archived'].includes(patch.state)) throw invalid({ state: 'Unknown state.' });
    next.state = patch.state;
  }
  run(`UPDATE goals SET title = ?, category = ?, horizon = ?, state = ?, updated_at = datetime('now') WHERE id = ?`,
    next.title, next.category, next.horizon, next.state, g.id);
  if (next.state !== g.state) {
    const label = { active: 'Resumed', paused: 'Paused', done: 'Marked done', archived: 'Archived' }[next.state];
    addEvent(g, { kind: 'milestone', iconName: next.state === 'done' ? 'trophy' : 'flag', title: label });
    // Paused/finished goals stop their recurring work; resuming turns it back on.
    for (const t of tasksOf(g).filter(t => t.schedule_id && t.enabled)) {
      run('UPDATE schedules SET paused = ? WHERE id = ?', next.state === 'active' ? 0 : 1, t.schedule_id);
    }
  }
  if (next.horizon !== g.horizon) addEvent(g, { kind: 'note', iconName: 'calendar-range', title: next.horizon === 'long' ? 'Moved to the longer horizon' : 'Moved back to active goals' });
  return getGoal(g.id);
}

export function setGoalFields(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  run(`UPDATE goals SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map(k => fields[k]), id);
}

/** The side chat where Jess works on this goal (made on first use). */
export function goalThread(g) {
  const t = g.thread_id && get('SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL', g.thread_id);
  if (t) return t;
  const thread = createSideThread(g.user_id, `Goal: ${g.title}`.slice(0, 60));
  run('UPDATE goals SET thread_id = ? WHERE id = ?', thread.id, g.id);
  return thread;
}

export const announceGoal = (userId, goalId, extra = {}) => publish(userId, 'goal.updated', { id: goalId, ...extra }, { persist: false });

// ---- Tasks (plan steps) -------------------------------------------------------------------------------------
export const tasksOf = g => all('SELECT * FROM goal_tasks WHERE goal_id = ? ORDER BY position, id', g.id);
export const getTask = id => get('SELECT * FROM goal_tasks WHERE id = ?', id) || null;

export function taskOfGoal(g, taskId) {
  const t = getTask(Number(taskId));
  if (!t || t.goal_id !== g.id) throw notFound('That step is gone.');
  return t;
}

/**
 * Normalize model- or agent-proposed steps and add them after the existing ones. Each step may say when it's done
 * (`done_when`, one checkable line) and which steps it waits for (`after`: step numbers, 1 = the first — of this batch
 * when `refsTo` is 'batch' (a new plan), of the goal's existing steps when 'existing' (a check-in's new steps)). A step
 * only waits for one-off steps (a routine never finishes), and an order that loops is refused: those links are dropped.
 */
export function addTasks(g, tasks, createdBy = 'plan', { refsTo = 'batch' } = {}) {
  let pos = get('SELECT COALESCE(MAX(position), -1) AS p FROM goal_tasks WHERE goal_id = ?', g.id).p + 1;
  const existing = tasksOf(g);
  const have = new Set(existing.map(t => t.title.toLowerCase()));
  const list = (Array.isArray(tasks) ? tasks : []).slice(0, 10);
  const idOfBatch = new Map(); // batch number (1-based) → the id it got
  const added = [];
  tx(() => {
    list.forEach((t, i) => {
      const title = cleanTitle(t?.title).slice(0, 100);
      const prompt = String(t?.prompt || t?.description || '').trim().slice(0, 1500);
      if (title.length < 3 || !prompt || have.has(title.toLowerCase())) return;
      have.add(title.toLowerCase());
      const recurring = t.kind === 'recurring' && REPEATS.includes(t.repeat);
      const at = /^\d{1,2}:\d{2}$/.test(String(t.at || '')) ? t.at : '09:00';
      const doneWhen = String(t.done_when || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
      const { lastInsertRowid } = run(`INSERT INTO goal_tasks (goal_id, title, description, icon, prompt, kind, repeat, at, position, created_by, done_when)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, g.id, title, t.description ? String(t.description).slice(0, 300) : null, iconOr(t.icon),
      prompt, recurring ? 'recurring' : 'once', recurring ? t.repeat : null, recurring ? at : null, pos++, createdBy, doneWhen);
      idOfBatch.set(i + 1, Number(lastInsertRowid));
      added.push(Number(lastInsertRowid));
    });
    // Order links, once every step of the batch has its id.
    const current = tasksOf(g);
    const byId = new Map(current.map(t => [t.id, t]));
    const edges = new Map(current.map(t => [t.id, afterIdsOf(t)]));
    list.forEach((t, i) => {
      const id = idOfBatch.get(i + 1);
      if (!id || !Array.isArray(t.after)) return;
      const want = [];
      for (const n of t.after.map(Number).filter(Number.isInteger)) {
        const ref = refsTo === 'existing' ? existing[n - 1]?.id : idOfBatch.get(n);
        if (!ref || ref === id || byId.get(ref)?.kind !== 'once' || want.includes(ref)) continue;
        edges.set(id, [...want, ref]);
        if (hasCycle(edges)) { edges.set(id, want); continue; } // this link would make the order loop: dropped
        want.push(ref);
      }
      if (want.length) run('UPDATE goal_tasks SET after_ids = ? WHERE id = ?', JSON.stringify(want), id);
    });
  });
  return added.map(getTask);
}

// ---- Step order (a frontier) ----------------------------------------------------------------------------------------
export const afterIdsOf = t => { try { return (JSON.parse(t.after_ids || '[]') || []).map(Number).filter(Number.isInteger); } catch { return []; } };

/** Does this step graph (id → the ids it waits for) loop anywhere? */
export function hasCycle(edges) {
  const state = new Map(); // id → 1 visiting · 2 done
  const visit = id => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const next of edges.get(id) || []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  return [...edges.keys()].some(visit);
}

/** The steps this one still waits for (not done yet), in plan order. */
export function blockersOf(t, tasks = null) {
  const ids = afterIdsOf(t);
  if (!ids.length) return [];
  const list = tasks || all(`SELECT * FROM goal_tasks WHERE goal_id = ?`, t.goal_id);
  return list.filter(x => ids.includes(x.id) && x.status !== 'done');
}

/** Change what a step waits for (the API). Refused: other goals' steps, routines, itself, and any order that loops. */
export function setTaskAfter(g, t, ids) {
  const tasks = tasksOf(g);
  const byId = new Map(tasks.map(x => [x.id, x]));
  const want = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  for (const id of want) {
    const x = byId.get(id);
    if (!x || id === t.id) throw invalid({ after: 'A step can only wait for other steps of the same goal.' });
    if (x.kind !== 'once') throw invalid({ after: `“${x.title}” repeats and never finishes, so nothing can wait for it.` });
  }
  const edges = new Map(tasks.map(x => [x.id, afterIdsOf(x)]));
  edges.set(t.id, want);
  if (hasCycle(edges)) throw invalid({ after: 'That order goes round in a circle: a step would end up waiting for itself.' });
  return setTask(t.id, { after_ids: JSON.stringify(want) });
}

/** The frontier's head: the first step (plan order) not done or under way whose earlier steps are all done. */
export function frontierStep(g, tasks = tasksOf(g)) {
  return tasks.find(t => t.status !== 'done' && t.status !== 'doing' && !blockersOf(t, tasks).length) || null;
}

export function setTask(id, fields) {
  const keys = Object.keys(fields);
  run(`UPDATE goal_tasks SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => fields[k]), id);
  return getTask(id);
}

// ---- Timeline -----------------------------------------------------------------------------------------------
export function addEvent(g, { kind, iconName = null, title, detail = null, href = null, runId = null }) {
  run('INSERT INTO goal_events (goal_id, kind, icon, title, detail, href, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    g.id, kind, iconName, String(title).slice(0, 160), detail ? String(detail).slice(0, 400) : null, href, runId);
}
export const eventsOf = (g, limit = 60) => all('SELECT * FROM goal_events WHERE goal_id = ? ORDER BY at DESC, id DESC LIMIT ?', g.id, limit);

// ---- Measures, streaks, milestones ----------------------------------------------------------------------------
// Real numbers when a goal has them (volt C7): a level from start to target ("weight 92 → 84 kg") and/or a rhythm ("runs,
// 3 per week"). With a start and a target, progress is computed, not estimated; the model still writes the status line.
export const measuresOf = g => all('SELECT * FROM goal_measures WHERE goal_id = ? ORDER BY id', g.id);
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const tzOfGoal = g => tzOf(getUser(g.user_id));

/** A measure from the plan or from chat. Direction follows start → target (down when the target is lower). */
export function addMeasure(g, { label, unit = null, start = null, target = null, per_week: perWeek = null, direction = null }) {
  const l = cleanTitle(label).slice(0, 60);
  if (l.length < 2) throw invalid({ measure: 'Give the number a short name, like "Weight" or "Runs".' });
  const s = num(start), t = num(target);
  const pw = num(perWeek) == null ? null : Math.max(1, Math.min(21, Math.round(num(perWeek))));
  if (t == null && pw == null) throw invalid({ measure: 'A measure needs a target, a number per week, or both.' });
  if (s != null && t != null && s === t) throw invalid({ measure: 'The start and the target are the same number.' });
  if (all('SELECT label FROM goal_measures WHERE goal_id = ?', g.id).some(m => m.label.toLowerCase() === l.toLowerCase())) {
    throw invalid({ measure: `This goal already counts “${l}”.` });
  }
  const dir = direction === 'down' || direction === 'up' ? direction : s != null && t != null && t < s ? 'down' : 'up';
  const { lastInsertRowid } = run('INSERT INTO goal_measures (goal_id, label, unit, start, target, direction, per_week) VALUES (?, ?, ?, ?, ?, ?, ?)',
    g.id, l, unit ? String(unit).trim().slice(0, 20) || null : null, s, t, dir, pw);
  return get('SELECT * FROM goal_measures WHERE id = ?', Number(lastInsertRowid));
}

/** The goal's measure by name (any case); with no name, its only measure. */
export function findMeasure(g, label) {
  const ms = measuresOf(g);
  if (!label) return ms.length === 1 ? ms[0] : null;
  return ms.find(m => m.label.toLowerCase() === String(label).trim().toLowerCase()) || null;
}

export const logsOf = (m, limit = 400) => all('SELECT * FROM goal_logs WHERE measure_id = ? ORDER BY at DESC, id DESC LIMIT ?', m.id, limit);
const latestLog = m => get('SELECT * FROM goal_logs WHERE measure_id = ? ORDER BY at DESC, id DESC LIMIT 1', m.id) || null;

/** Record a number. A level measure without a start takes its first reading as the start. Progress follows. */
export function logMeasure(g, m, { value, note = null, runId = null, at = null }) {
  const v = num(value);
  if (v == null) throw invalid({ value: 'That needs a number.' });
  if (m.start == null && m.target != null && !latestLog(m)) {
    if (v === m.target) throw invalid({ value: 'That is already the target: tell me where you are starting from.' });
    run('UPDATE goal_measures SET start = ?, direction = ? WHERE id = ?', v, m.target < v ? 'down' : 'up', m.id);
  }
  run(`INSERT INTO goal_logs (measure_id, value, note, run_id, at) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    m.id, v, note ? String(note).slice(0, 200) : null, runId, at ? new Date(at).toISOString().replace('T', ' ').slice(0, 19) : null);
  const p = measureProgress(getGoal(g.id));
  if (p != null) setProgress(getGoal(g.id), p);
  return get('SELECT * FROM goal_measures WHERE id = ?', m.id);
}

/** (latest − start) / (target − start) as 0–100 for this measure, or null when it has no start, target or reading. */
export function progressOf(m) {
  if (m.start == null || m.target == null || m.start === m.target) return null;
  const last = latestLog(m);
  if (!last) return null;
  return Math.max(0, Math.min(100, Math.round(((last.value - m.start) / (m.target - m.start)) * 100)));
}
/** The goal's computed progress: its first measure that has a start, a target and a reading (null = none; estimate instead). */
export function measureProgress(g) {
  for (const m of measuresOf(g)) { const p = progressOf(m); if (p != null) return p; }
  return null;
}

// Periods in the person's timezone: a day (YYYY-MM-DD) or a week (the Monday it starts on).
const shiftDay = (key, days) => new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10) + days)).toISOString().slice(0, 10);
const mondayOf = key => shiftDay(key, -((new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7));
const periodKey = (iso, cadence, tz) => (cadence === 'day' ? dayKey(iso, tz) : mondayOf(dayKey(iso, tz)));

/** Logs of a rhythm measure in the current week (Monday first, their timezone): "4 of 3 this week". */
export function weekCount(m, { now = new Date(), tz } = {}) {
  const week = periodKey(now.toISOString(), 'week', tz);
  const since = new Date(now.getTime() - 8 * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  return all('SELECT at FROM goal_logs WHERE measure_id = ? AND at >= ?', m.id, since)
    .filter(l => periodKey(toIso(l.at), 'week', tz) === week).length;
}

/** Days when the goal expects something daily (a rhythm of 7+ a week, a daily routine switched on), otherwise weeks. */
export function cadenceOf(g) {
  if (measuresOf(g).some(m => (m.per_week || 0) >= 7)) return 'day';
  return get(`SELECT 1 FROM goal_tasks WHERE goal_id = ? AND kind = 'recurring' AND repeat = 'daily' AND enabled = 1 LIMIT 1`, g.id) ? 'day' : 'week';
}

/**
 * Consecutive days or weeks (their timezone) with something done for the goal: a reply, an action, something made, or a
 * number logged. The current period counts once it has something and never breaks the streak while it is still going;
 * a missed period simply starts again from zero (never shamed, never announced).
 */
export function streakOf(g, { now = new Date(), tz = tzOfGoal(g) } = {}) {
  const cadence = cadenceOf(g);
  const since = new Date(now.getTime() - 400 * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  const times = [
    ...all(`SELECT at FROM goal_events WHERE goal_id = ? AND kind IN ('reply', 'action', 'artifact') AND at >= ?`, g.id, since),
    ...all('SELECT l.at FROM goal_logs l JOIN goal_measures m ON m.id = l.measure_id WHERE m.goal_id = ? AND l.at >= ?', g.id, since),
  ];
  const active = new Set(times.map(r => periodKey(toIso(r.at), cadence, tz)));
  const step = cadence === 'day' ? 1 : 7;
  let key = periodKey(now.toISOString(), cadence, tz);
  if (!active.has(key)) key = shiftDay(key, -step); // today / this week isn't over yet
  let count = 0;
  while (active.has(key)) { count++; key = shiftDay(key, -step); }
  return { count, cadence, label: count >= 2 ? `${count}-${cadence} streak` : null };
}

const MILESTONES = [[75, 'Three quarters of the way there'], [50, 'Halfway there'], [25, 'A quarter of the way there']];
/** Set the progress %; crossing 25/50/75% for the first time puts one milestone on the timeline (the highest crossed). */
export function setProgress(g, pct) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  setGoalFields(g.id, { progress: p });
  const hit = MILESTONES.find(([m]) => p >= m && (g.milestone || 0) < m);
  if (hit && p < 100) {
    setGoalFields(g.id, { milestone: hit[0] });
    addEvent(g, { kind: 'milestone', iconName: 'trophy', title: hit[1], detail: `${p}% toward “${g.title}”` });
  }
  return p;
}

/**
 * A lapse: a rhythm measure ("3 runs a week") with nothing logged for twice its usual gap (at least two days), while
 * this week's count is still short. One nudge per lapse: none again until something new is logged.
 */
export function lapseOf(g, { now = new Date(), tz = tzOfGoal(g) } = {}) {
  let worst = null;
  for (const m of measuresOf(g).filter(x => x.per_week)) {
    if (weekCount(m, { now, tz }) >= m.per_week) continue;
    const last = latestLog(m);
    const since = new Date(toIso(last?.at || m.created_at));
    const idleDays = (now - since) / 864e5;
    if (idleDays < Math.max(2, (2 * 7) / m.per_week)) continue;
    if (g.lapse_hint_at && new Date(g.lapse_hint_at) > since) continue; // already nudged for this lapse
    if (!worst || idleDays > worst.idleDays) worst = { measure: m, idleDays: Math.floor(idleDays), lastAt: last ? toIso(last.at) : null };
  }
  return worst;
}

const fmtNum = v => (v == null ? '?' : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
/** One measure for the page, the API and the prompt. `points` = the last 30 readings, oldest first (a sparkline). */
export function measureView(m, { now = new Date(), tz } = {}) {
  const logs = logsOf(m, 30).reverse();
  const last = logs.at(-1) || null;
  const thisWeek = m.per_week ? weekCount(m, { now, tz }) : null;
  const unit = m.unit ? ` ${m.unit}` : '';
  return {
    id: m.id, label: m.label, unit: m.unit, start: m.start, target: m.target, direction: m.direction, perWeek: m.per_week,
    latest: last ? last.value : null, latestAt: last ? toIso(last.at) : null, progress: progressOf(m),
    thisWeek, weekLabel: m.per_week ? `${thisWeek} of ${m.per_week} this week` : null,
    line: [m.target != null ? `${m.label}: ${last ? fmtNum(last.value) : 'not logged yet'}${unit} (start ${fmtNum(m.start)}${unit}, target ${fmtNum(m.target)}${unit})` : m.label,
      m.per_week ? `${thisWeek} of ${m.per_week} this week` : null].filter(Boolean).join(' · '),
    points: logs.map(l => ({ at: toIso(l.at), value: l.value })),
  };
}

// ---- Views --------------------------------------------------------------------------------------------------
const liveRun = g => get(`SELECT activity FROM runs WHERE goal_id = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1`, g.id);

/** The next thing to do: the frontier's head (plan order, earlier steps done), else what the last check-in said. */
export const nextStepOf = (g, tasks = tasksOf(g)) => frontierStep(g, tasks)?.title || g.next_step || null;

/** goal-card contract. `busy` = a background job (questions / plan / check-in) is running for it right now. */
export function goalCard(g, { busy = false } = {}) {
  const c = categoryOf(g.category);
  const needsInput = g.state === 'active' && g.stage === 'intake' && !!g.intake;
  return {
    id: g.id, title: g.title, category: c.label, hue: c.hue, progress: g.progress,
    statusLine: g.state === 'suggested' ? g.why : g.state === 'paused' ? 'Paused — I’m not working on this right now.'
      : g.status_line || (g.stage === 'intake' ? (needsInput ? 'A few quick questions and I’ll get going.' : 'Thinking of a few questions…')
        : g.stage === 'planning' ? 'Laying out everything I can do…' : null),
    nextStep: g.state === 'active' ? nextStepOf(g) : null, lastCheckIn: toIso(g.last_review_at),
    state: g.state === 'suggested' ? 'suggested' : g.state === 'done' ? 'done' : needsInput ? 'needs_input' : 'active',
    activity: busy ? 'thinking' : liveRun(g)?.activity || null,
    streak: g.state === 'active' ? streakOf(g).label : null, // "6-day streak" (≥ 2 in a row), else null
  };
}

const EVENT_ICON = { checkin: { iconName: 'refresh-cw' }, action: { iconName: 'zap' }, reply: { iconName: 'message-circle' },
  artifact: { iconName: 'sparkles' }, milestone: { iconName: 'flag' }, note: { iconName: 'info' } };

export function goalDetail(g, { busy = null } = {}) {
  const card = goalCard(g, { busy: !!busy });
  const tasks = tasksOf(g);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const intake = g.intake ? JSON.parse(g.intake) : null;
  const tz = tzOfGoal(g);
  // A step's run that stopped to ask something: say so on the step (it isn't "working", it's waiting on them).
  const runIds = tasks.map(t => t.run_id).filter(Boolean);
  const waiting = new Set(runIds.length ? all(`SELECT id FROM runs WHERE status = 'waiting' AND id IN (${runIds.map(() => '?').join(',')})`, ...runIds).map(x => x.id) : []);
  return {
    ...card, summary: g.summary, state: g.state, horizon: g.horizon, categoryKey: g.category, stage: g.stage,
    error: g.error, threadHref: g.thread_id ? `/chat/${g.thread_id}` : null, intakeRound: g.intake_round,
    busyNote: busy === 'review' ? 'Checking in on this goal…'
      : g.state === 'active' && g.stage === 'intake' && !intake && !g.error
        ? (g.intake_round >= 2 ? 'Seeing if your answers raise anything else to ask…' : 'Thinking of a few questions to ask you…')
        : g.state === 'active' && g.stage === 'planning' && !g.error ? 'Laying out everything I can do for this…' : null,
    pendingQuestion: g.state === 'active' && g.stage === 'intake' && intake
      ? { id: `goal-${g.id}`, round: g.intake_round, questions: intake, answerUrl: `/api/v1/goals/${g.id}/answers`, skipUrl: `/api/v1/goals/${g.id}/skip` } : null,
    plan: tasks.map(t => {
      const blockers = blockersOf(t, tasks);
      return {
        id: t.id, title: t.title, description: t.description, iconName: t.icon || 'circle-dashed', enabled: !!t.enabled,
        status: t.status === 'failed' ? 'todo' : t.status, failed: t.status === 'failed', waiting: t.status === 'doing' && waiting.has(t.run_id),
        when: t.kind === 'recurring' ? `${t.repeat[0].toUpperCase()}${t.repeat.slice(1)} at ${t.at}` : null,
        href: t.run_id ? `/chat/${g.thread_id}` : null,
        doneWhen: t.done_when || null,
        afterIds: afterIdsOf(t).filter(id => byId.has(id)),
        after: blockers.length ? blockers.map(b => b.title).join(', ') : null, // the earlier steps it still waits for
        blocked: blockers.length > 0, queued: blockers.length > 0 && !!t.enabled && t.status !== 'done', // switched on, starts after them
      };
    }),
    measures: measuresOf(g).map(m => measureView(m, { tz })),
    streakDetail: streakOf(g, { tz }),
    timeline: eventsOf(g).map(e => ({ id: e.id, at: toIso(e.at), kind: e.kind, iconName: e.icon || EVENT_ICON[e.kind].iconName, title: e.title, detail: e.detail, href: e.href })),
  };
}

export function goalsData(user, busyIds = new Set()) {
  const rows = all(`SELECT * FROM goals WHERE user_id = ? AND state IN ('suggested', 'active', 'paused', 'done') ORDER BY
    CASE state WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, updated_at DESC`, user.id);
  const card = g => goalCard(g, { busy: busyIds.has(g.id) });
  return {
    suggested: rows.filter(g => g.state === 'suggested').slice(0, 4).map(card),
    active: rows.filter(g => g.state !== 'suggested' && g.horizon === 'now').map(card),
    longTerm: rows.filter(g => g.state !== 'suggested' && g.horizon === 'long').map(card),
  };
}

/** Ideas they turned down, with why — never suggest anything like these (reflection, goal_suggest via the prompt). */
export function turnedDownBlock(user, limit = 10) {
  const rows = turnedDown(user, limit);
  return rows.length ? `TURNED DOWN (with why), don't suggest anything like these, even in other words:\n${rows.map(r => `- ${r}`).join('\n')}` : null;
}

/** For the prompt: what this person is working toward, so conversations connect to it (+ what they turned down). */
export function goalsBlock(user, { now = new Date() } = {}) {
  const rows = all(`SELECT * FROM goals WHERE user_id = ? AND state = 'active' ORDER BY horizon, updated_at DESC LIMIT 8`, user.id);
  const down = turnedDownBlock(user, 8);
  if (!rows.length && !down) return null;
  const tz = tzOf(user);
  const line = g => {
    const tasks = tasksOf(g);
    const next = nextStepOf(g, tasks);
    const streak = streakOf(g, { now, tz }).label;
    const numbers = measuresOf(g).map(m => measureView(m, { now, tz }).line);
    return `- [goal ${g.id}] ${g.title}${g.horizon === 'long' ? ' (longer horizon)' : ''}${g.status_line ? ` — ${g.status_line}` : ''}`
      + `${next ? ` Next: ${next}` : ''}${[streak && `🔥 ${streak}`, ...numbers].filter(Boolean).map(s => ` · ${s}`).join('')}`;
  };
  return `## Their goals (Goals page)\n${rows.length ? rows.map(line).join('\n') : '(no active goals)'}${down ? `\n${down}` : ''}`;
}
