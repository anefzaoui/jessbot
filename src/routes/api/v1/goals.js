// Goals & Ideas (Phase 8, decision #55). Model work runs in the background and reports through `goal.updated`
// / `ideas.updated` frames; the pages re-render from the database, so a refresh loses nothing.
import { Router } from 'express';
import * as G from '../../../services/goals.js';
import { resolveIdea, setIdeaState, ideaView, ideasData } from '../../../services/ideas.js';
import { setPrep, prepView } from '../../../services/prep.js';
import { validateAnswers } from '../../../services/questions.js';
import { mainThread } from '../../../services/threads.js';
import { kick, checkInNow, toggleTask, startReady, saveIntakeAnswers, skipIntake, reflect, busyKind, busyGoals, canWork } from '../../../agent/goals.js';
import { startTurn } from '../../../agent/loop.js';
import { badRequest, notFound } from '../../../lib/errors.js';
import { tzOf } from '../../../lib/when.js';
import { enabledToolsets } from '../../../services/policy.js';
import { renderFragment } from '../../../views/render.js';

const router = Router();
// Model work needs Goals & ideas switched on and budget left; say which one is missing.
const needWork = user => {
  if (canWork(user)) return;
  throw badRequest(enabledToolsets(user).has('goals') ? 'This week’s budget is used up — it resets on Monday.'
    : 'Goals & ideas are turned off for you (Admin → People).');
};

// ---- Goals ------------------------------------------------------------------------------------------------------
router.get('/goals', (req, res) => res.json(G.goalsData(req.user, busyGoals())));

router.post('/goals', (req, res) => {
  needWork(req.user);
  const g = G.createGoal({ user: req.user, title: req.body?.title, category: req.body?.category });
  kick(g);
  res.status(201).json({ goal: G.goalCard(g), redirect: `/goals/${g.id}` });
});

router.get('/goals/:id', (req, res) => {
  const g = G.goalForUser(req.user, req.params.id);
  res.json({ goal: G.goalDetail(g, { busy: busyKind(g.id) }) });
});

router.patch('/goals/:id', (req, res) => {
  const before = G.goalForUser(req.user, req.params.id);
  const g = G.updateGoal(before, req.body || {});
  if (before.state !== 'active' && g.state === 'active') startReady(g); // queued steps whose earlier steps finished meanwhile
  G.announceGoal(req.user.id, g.id);
  res.json({ goal: G.goalCard(g), redirect: g.state === 'archived' ? '/goals' : null });
});

// Suggested goals: accept (becomes active; questions next) or dismiss (never suggested again).
router.post('/goals/:id/adopt', (req, res) => {
  needWork(req.user);
  const g = G.goalForUser(req.user, req.params.id);
  if (g.state !== 'suggested') throw badRequest('That goal is already set.');
  G.setGoalFields(g.id, { state: 'active' });
  G.addEvent(g, { kind: 'milestone', iconName: 'flag', title: 'Goal set' });
  kick(G.getGoal(g.id));
  res.json({ ok: true, redirect: `/goals/${g.id}` });
});
router.post('/goals/:id/dismiss', (req, res) => {
  const g = G.goalForUser(req.user, req.params.id);
  if (g.state !== 'suggested') throw badRequest('Only suggestions can be dismissed — archive a goal instead.');
  G.setGoalFields(g.id, { state: 'dismissed' });
  res.json({ ok: true });
});
router.post('/goals/:id/restore', (req, res) => {
  const g = G.getGoal(Number(req.params.id));
  if (!g || g.user_id !== req.user.id || g.state !== 'dismissed') throw badRequest('Nothing to undo.');
  G.setGoalFields(g.id, { state: 'suggested' });
  res.json({ ok: true });
});

// Intake questions (ask-dock posts { answers }) and "skip the questions".
router.post('/goals/:id/answers', (req, res) => {
  const g = G.goalForUser(req.user, req.params.id);
  if (g.stage !== 'intake' || !g.intake) throw badRequest('Those questions were already answered.');
  saveIntakeAnswers(g, validateAnswers({ questions: JSON.parse(g.intake) }, req.body?.answers));
  res.json({ ok: true });
});
router.post('/goals/:id/skip', (req, res) => {
  const g = G.goalForUser(req.user, req.params.id);
  if (g.stage !== 'intake') throw badRequest('Already past the questions.');
  skipIntake(g);
  res.json({ ok: true });
});

router.post('/goals/:id/checkin', (req, res) => {
  needWork(req.user);
  checkInNow(G.goalForUser(req.user, req.params.id));
  res.status(202).json({ ok: true });
});

// A failed background job (questions / plan): clear the error and go again.
router.post('/goals/:id/retry', (req, res) => {
  needWork(req.user);
  const g = G.goalForUser(req.user, req.params.id);
  G.setGoalFields(g.id, { error: null });
  kick(G.getGoal(g.id));
  res.status(202).json({ ok: true });
});

// A step: switch it on/off ({ enabled }), and/or change which earlier steps it waits for ({ after: [step ids] }; an order
// that loops is a 422). A step switched on before its earlier steps are done is queued: `queued` + `after` (their titles).
router.post('/goals/:id/tasks/:taskId', (req, res) => {
  const g = G.goalForUser(req.user, req.params.id);
  let t = G.taskOfGoal(g, req.params.taskId);
  const body = req.body || {};
  if ('after' in body) t = G.setTaskAfter(g, t, body.after);
  if ('enabled' in body || !('after' in body)) t = toggleTask(g, t, !!body.enabled);
  G.announceGoal(req.user.id, g.id);
  const waits = t.queuedAfter || (t.enabled && t.status !== 'done' ? G.blockersOf(t).map(b => b.title) : []);
  res.json({ ok: true, task: { id: t.id, enabled: !!t.enabled, status: t.status, queued: !!t.enabled && waits.length > 0,
    after: waits.length ? waits : null, afterIds: G.afterIdsOf(t) } });
});

// Numbers: a new measure to track ({ label, unit?, start?, target?, per_week? }: a target, a number per week, or both; Phase 25
// #212). 201 { measure, html (its card, partials/goal-measure.hbs) }; 422 { errors: { measure } } says what's missing.
router.post('/goals/:id/measures', async (req, res) => {
  const g = G.goalForUser(req.user, req.params.id);
  const b = req.body || {};
  const m = G.addMeasure(g, { label: b.label, unit: b.unit, start: b.start, target: b.target, per_week: b.per_week });
  const view = G.measureView(m, { tz: tzOf(req.user) });
  G.addEvent(g, { kind: 'reply', iconName: 'chart-line', title: `Tracking ${m.label.toLowerCase()}`, detail: view.line });
  G.announceGoal(req.user.id, g.id);
  res.status(201).json({ measure: view, html: await renderFragment('goal-measure', { ...view, goalId: g.id }, req.user).catch(() => null) });
});

// Numbers: log one against a measure ({ value, note? }); progress and milestones follow.
router.post('/goals/:id/measures/:measureId/logs', async (req, res) => {
  const g = G.goalForUser(req.user, req.params.id);
  const m = G.measuresOf(g).find(x => String(x.id) === String(req.params.measureId));
  if (!m) throw notFound('That measure is gone.');
  const view = G.measureView(G.logMeasure(g, m, { value: req.body?.value, note: req.body?.note }), { tz: tzOf(req.user) });
  G.addEvent(g, { kind: 'reply', iconName: 'chart-line', title: `Logged ${m.label.toLowerCase()}`, detail: view.line });
  G.announceGoal(req.user.id, g.id);
  // html: the measure's card again (partials/goal-measure.hbs), so the page swaps it in place (#196).
  res.status(201).json({ measure: view, progress: G.getGoal(g.id).progress,
    html: await renderFragment('goal-measure', { ...view, goalId: g.id }, req.user).catch(() => null) });
});

// ---- Ideas ------------------------------------------------------------------------------------------------------
// The Ideas page's data: open ideas (each with `prepared` when overnight prep made a draft, #199), the "Ready for you" ones,
// the dismiss reasons, starters, and this person's overnight prep setting.
router.get('/ideas', (req, res) => res.json(ideasData(req.user)));

// Overnight prep (#199): off (default) | ideas — one of their Ideas prepared as a Library draft during their quiet hours.
// `view` (Phase 25 #212): the You card's data again (services/prep.js prepView), so the switch can say what would stop it.
router.put('/me/prep', (req, res) => {
  const prep = setPrep(req.user, req.body?.prep);
  res.json({ ok: true, prep, view: prepView(req.user) });
});

// "Let's do it": the idea's prompt goes to Jess in the main chat as the person's own message.
router.post('/ideas/:id/start', (req, res) => {
  const idea = resolveIdea(req.user, req.params.id);
  setIdeaState(idea, 'started');
  startTurn({ user: req.user, thread: mainThread(req.user.id), text: idea.prompt });
  res.json({ ok: true, redirect: '/chat' });
});

// Dismiss may say why ({ reason: not_for_me | already_doing | not_now, note? }); "not_now" snoozes instead, and the
// answer says which state the idea is in now.
for (const [action, state] of [['snooze', 'snoozed'], ['dismiss', 'dismissed'], ['restore', 'seen']]) {
  router.post(`/ideas/:id/${action}`, (req, res) => {
    const why = action === 'dismiss' ? { reason: req.body?.reason || null, note: req.body?.note || null } : {};
    res.json({ ok: true, state: setIdeaState(resolveIdea(req.user, req.params.id), state, why) });
  });
}

// "Think of more": reflect now (a few seconds) and hand back the new cards.
router.post('/ideas/generate', async (req, res) => {
  needWork(req.user);
  const ideas = await reflect(req.user, { force: true });
  const html = await Promise.all(ideas.map(i => renderFragment('idea-card', ideaView(i), req.user)));
  res.json({ added: ideas.length, itemsHtml: html.join(''),
    message: ideas.length ? null : 'No new ideas right now — the more we talk, the more I’ll spot.' });
});

export default router;
