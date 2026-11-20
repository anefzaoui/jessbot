// Phase 22 item 15 (decisions #182–#185): goals whose plan steps say when they're done (appended to the run, read by the
// goal gate) and run in order (a queued step starts by itself when the steps it waits for finish; loops are refused);
// real numbers (measures: computed progress, "4 of 3 this week", streaks by day or week, milestones once, one gentle
// nudge a day after a lapse); a second round of intake questions; and ideas that remember why they were turned down.
// Run: npm test (throwaway data dir; model calls go to a local fake OpenAI-compatible server, never the network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-unit-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env'); // keys the code makes (secrets, VAPID) never land in the real .env
process.env.JESSBOT_EMBED_OFF = '1'; // no embedding calls from unit tests
process.env.JESSBOT_DECIDE_OFF = '1'; // no decision-model calls either: every use takes its fallback
process.env.OPENROUTER_KEY = 'sk-or-v1-unit-test-model-key-p22i-0123456789';

const { openDb, closeDb, run, get, all, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser, getUser } = await import('../src/services/users.js');
const { getTool } = await import('../src/agent/tools/registry.js');
const { createApp } = await import('../src/app.js'); // registers the tools
createApp();
const policy = await import('../src/services/policy.js');
const runs = await import('../src/services/runs.js');
const threads = await import('../src/services/threads.js');
const loop = await import('../src/agent/loop.js');
const G = await import('../src/services/goals.js');
const I = await import('../src/services/ideas.js');
const A = await import('../src/agent/goals.js');

// ---- A local stand-in for the model --------------------------------------------------------------------------------
// JSON calls (askJson: intake, follow-ups, plan, review, reflect) take the next `json` item (an object, or { status } for
// an HTTP error); streamed calls (a step's run) answer with the next `replies` item, else "Done.". Every call is recorded.
const jsonCalls = [];
let json = [];
let replies = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    if (!j.stream) {
      jsonCalls.push({ system: j.messages[0].content, content: j.messages[1].content });
      const next = json.shift() ?? {};
      if (next.status) { res.writeHead(next.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'boom' } })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'fake', choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(next) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      return;
    }
    const text = replies.shift() || 'Done.';
    const chunk = delta => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ role: 'assistant', content: text }));
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});

let alice, bob;
before(async () => {
  alice = await createUser({ name: 'Alice Owner', email: 'alice@p22i.dev', password: 'correct horse battery', role: 'admin' });
  bob = await createUser({ name: 'Bob Member', email: 'bob@p22i.dev', password: 'correct horse battery' });
  // Goals on, no quiet hours (start = end), no budget, UTC days: nothing may depend on the wall clock or the machine's zone.
  for (const u of [alice, bob]) {
    policy.setPolicy('user', u.id, { toolsets: { core: 'allow', goals: 'allow', schedule: 'allow' }, quietStart: '12:00', quietEnd: '12:00', weeklyBudget: 0 }, alice.id);
    run(`UPDATE users SET timezone = 'UTC' WHERE id = ?`, u.id);
  }
  alice = getUser(alice.id); bob = getUser(bob.id);
  await listen(fake);
  settings.set('llm', { baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, model: 'fake/model' });
});
after(() => { fake.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 10000) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(20)) { await loop.drainRuns(); const v = fn(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
}
const task = id => G.getTask(id);
const titles = g => G.eventsOf(g).map(e => e.title);
const sqlAt = d => d.toISOString().replace('T', ' ').slice(0, 19);
const readyGoal = (user, title, fields = {}) => {
  const g = G.createGoal({ user, title, category: 'health' });
  G.setGoalFields(g.id, { stage: 'ready', answers: '[]', ...fields });
  return G.getGoal(g.id);
};
const PLAN = {
  summary: 'You want to run a 5k. We build up slowly.', status_line: 'Plan ready', next_step: 'Pick a plan',
  measure: { label: 'Weight', unit: 'kg', start: 92, target: 84, per_week: null },
  steps: [
    { title: 'Research beginner 5k plans', description: 'Three plans compared.', icon: 'search', kind: 'once', prompt: 'Compare three beginner 5k plans.',
      done_when: 'a Library doc comparing 3 plans with sources', after: [] },
    { title: 'Build your 8-week schedule', description: 'A week-by-week plan.', icon: 'calendar-clock', kind: 'once', prompt: 'Build an 8-week schedule.',
      done_when: 'a Library page with 8 weeks of runs', after: [1] },
    { title: 'Weekly progress check', description: 'Every Sunday.', icon: 'chart-line', kind: 'recurring', repeat: 'weekly', at: '18:00',
      prompt: 'Check how the week went.', done_when: 'one line on this week and the next run', after: [2] },
  ],
};

// ---- 1. done_when -----------------------------------------------------------------------------------------------------
test('done_when: stored from the plan, first in the step run (what the goal gate reads), in the schedule and the view', async () => {
  const g = G.createGoal({ user: alice, title: 'Run a 5k by spring', category: 'health' });
  G.setGoalFields(g.id, { stage: 'planning', answers: '[]' });
  json.push(PLAN);
  await A.buildPlan(G.getGoal(g.id));
  const [a, b, c] = G.tasksOf(g);
  assert.equal(a.done_when, 'a Library doc comparing 3 plans with sources');
  assert.deepEqual([G.afterIdsOf(a), G.afterIdsOf(b), G.afterIdsOf(c)], [[], [a.id], [b.id]]);
  assert.match(jsonCalls.at(-1).system, /"done_when"/);
  assert.match(jsonCalls.at(-1).system, /Each step delivers something usable on its own/);
  // The plan's measure became a real one (direction from start → target).
  assert.deepEqual(G.measuresOf(g).map(m => [m.label, m.unit, m.start, m.target, m.direction]), [['Weight', 'kg', 92, 84, 'down']]);

  const view = G.goalDetail(G.getGoal(g.id));
  assert.equal(view.plan[0].doneWhen, 'a Library doc comparing 3 plans with sources');

  // Switched on: the run's trigger text carries the step and "Done when" at the top (sense.goalCheck reads its first 3,000
  // characters as the request it checks the reply against), even with long answers.
  G.setGoalFields(g.id, { answers: JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ question: `Question ${i}? ${'x'.repeat(300)}`, answer: 'y'.repeat(300) }))) });
  replies.push('Saved the comparison to the Library.');
  const started = A.toggleTask(G.getGoal(g.id), a, true);
  const trigger = get('SELECT content FROM messages WHERE id = ?', runs.getRun(started.run_id).trigger_message_id).content;
  assert.ok(trigger.length > 3000, 'the test needs a long trigger');
  assert.match(trigger.slice(0, 3000), /Do this now: Compare three beginner 5k plans\.\nDone when: a Library doc comparing 3 plans with sources/);
  assert.match(trigger, /check the result against the "Done when" line/);
  await until(() => task(a.id).status === 'done', 'the first step to finish');

  // A recurring step's schedule says what "done" means each time.
  G.setTask(b.id, { status: 'done' });
  A.toggleTask(G.getGoal(g.id), task(c.id), true);
  const s = get('SELECT prompt FROM schedules WHERE id = ?', task(c.id).schedule_id);
  assert.match(s.prompt, /Done when \(each time\): one line on this week and the next run/);
});

// ---- 2. Step order with a frontier ------------------------------------------------------------------------------------
test('frontier: a blocked step queues, starts by itself when its blocker finishes; next_step is the frontier head', async () => {
  const g = readyGoal(alice, 'Plan the summer party');
  const [shortlist, book, invite] = G.addTasks(g, [
    { title: 'Shortlist three venues', prompt: 'Find 3 venues.', done_when: 'a list of 3 venues with prices' },
    { title: 'Book the venue', prompt: 'Book the best venue.', after: [1] },
    { title: 'Send the invitations', prompt: 'Draft the invite.', after: [2] },
  ]);
  assert.equal(G.nextStepOf(G.getGoal(g.id)), 'Shortlist three venues');
  assert.equal(G.frontierStep(g).id, shortlist.id);

  // Switching on "Book the venue" first queues it: no run, visible as "After: Shortlist three venues".
  const queued = A.toggleTask(G.getGoal(g.id), book, true);
  assert.deepEqual(queued.queuedAfter, ['Shortlist three venues']);
  assert.equal(task(book.id).enabled, 1);
  assert.equal(task(book.id).status, 'todo');
  assert.equal(task(book.id).run_id, null);
  assert.ok(titles(g).includes('Queued “Book the venue”'));
  const item = G.goalDetail(G.getGoal(g.id)).plan.find(p => p.id === book.id);
  assert.deepEqual([item.after, item.blocked, item.queued], ['Shortlist three venues', true, true]);
  assert.equal(G.goalDetail(G.getGoal(g.id)).plan.find(p => p.id === invite.id).queued, false); // blocked, not switched on
  // Switching it on again doesn't queue it twice.
  A.toggleTask(G.getGoal(g.id), task(book.id), true);
  assert.equal(titles(g).filter(t => t === 'Queued “Book the venue”').length, 1);

  // The blocker runs and finishes → the queued step starts on its own; the frontier moves on.
  A.toggleTask(G.getGoal(g.id), shortlist, true);
  await until(() => task(shortlist.id).status === 'done', 'the shortlist to finish');
  await until(() => task(book.id).run_id, 'the queued step to start');
  assert.ok(titles(g).includes('“Book the venue” can start now'));
  await until(() => task(book.id).status === 'done', 'the queued step to finish');
  assert.equal(task(invite.id).status, 'todo'); // never switched on: not started
  assert.equal(G.nextStepOf(G.getGoal(g.id)), 'Send the invitations');
});

test('frontier: nothing starts while the goal is paused; resuming starts what is ready; a step finished in chat frees it', async () => {
  const g = readyGoal(alice, 'Learn to bake sourdough');
  const [starter, loaf] = G.addTasks(g, [{ title: 'Make a starter guide', prompt: 'Guide.' }, { title: 'Plan the first loaf', prompt: 'Loaf.', after: [1] }]);
  A.toggleTask(G.getGoal(g.id), loaf, true);
  G.updateGoal(G.getGoal(g.id), { state: 'paused' });
  G.setTask(starter.id, { status: 'done' });
  assert.deepEqual(A.startReady(G.getGoal(g.id)), []);
  assert.equal(task(loaf.id).run_id, null);
  G.updateGoal(G.getGoal(g.id), { state: 'active' });
  assert.deepEqual(A.startReady(G.getGoal(g.id)).map(t => t.id), [loaf.id]);
  await until(() => task(loaf.id).status === 'done', 'the freed step to finish');

  // goal_progress step_done (done in chat) frees the steps queued after it.
  const g2 = readyGoal(alice, 'Sort the garage');
  const [clear, shelves] = G.addTasks(g2, [{ title: 'Make a clear-out list', prompt: 'List.' }, { title: 'Pick shelving', prompt: 'Shelves.', after: [1] }]);
  A.toggleTask(G.getGoal(g2.id), shelves, true);
  const t = threads.createSideThread(alice.id, 'Chat');
  await getTool('goal_progress').run({ goal_id: g2.id, note: 'Made the list together', step_done: clear.id }, { user: alice, thread: t, run: { id: null } });
  await until(() => task(shelves.id).run_id, 'the step after the chat-finished one to start');
  await until(() => task(shelves.id).status === 'done', 'it to finish');
});

test('frontier: an order that loops is refused (links dropped from a plan, an error when set directly); routines are never blockers', () => {
  const g = readyGoal(bob, 'Redo the kitchen');
  const [x, y, z] = G.addTasks(g, [
    { title: 'Measure the kitchen', prompt: 'Measure.', after: [2] },
    { title: 'Pick the cabinets', prompt: 'Cabinets.', after: [1] },  // 2 → 1 would close the loop: dropped
    { title: 'Weekly budget check', prompt: 'Budget.', kind: 'recurring', repeat: 'weekly', at: '09:00' },
  ]);
  assert.deepEqual([G.afterIdsOf(x), G.afterIdsOf(y)], [[y.id], []]);
  assert.equal(G.hasCycle(new Map([[1, [2]], [2, [3]], [3, [1]]])), true);
  assert.equal(G.hasCycle(new Map([[1, [2]], [2, [3]], [3, []]])), false);
  assert.throws(() => G.setTaskAfter(g, task(y.id), [x.id]), err => /circle/.test(err.errors.after));
  assert.throws(() => G.setTaskAfter(g, task(y.id), [y.id]), err => /other steps/.test(err.errors.after));
  assert.throws(() => G.setTaskAfter(g, task(y.id), [z.id]), err => /repeats/.test(err.errors.after));
  const other = readyGoal(alice, 'Someone else’s goal');
  const [foreign] = G.addTasks(other, [{ title: 'Foreign step', prompt: 'x' }]);
  assert.throws(() => G.setTaskAfter(g, task(y.id), [foreign.id]), err => /same goal/.test(err.errors.after));
  // A valid change is saved; a plan step pointing at a routine keeps no link.
  assert.deepEqual(G.afterIdsOf(G.setTaskAfter(g, task(x.id), [])), []);
  const [w] = G.addTasks(g, [{ title: 'Order the cabinets', prompt: 'Order.', after: [3] }], 'agent', { refsTo: 'existing' });
  assert.deepEqual(G.afterIdsOf(w), []);
  const [v] = G.addTasks(g, [{ title: 'Book a fitter', prompt: 'Fitter.', after: [2] }], 'agent', { refsTo: 'existing' });
  assert.deepEqual(G.afterIdsOf(v), [y.id]);
});

// ---- 3. Measures, streaks, milestones, lapses -------------------------------------------------------------------------
test('measures: progress = (value − start)/(target − start); milestones at 25/50/75% once; start from the first reading', () => {
  const g = readyGoal(alice, 'Lose 8 kg');
  const m = G.addMeasure(g, { label: 'Weight', unit: 'kg', start: 92, target: 84 });
  assert.equal(m.direction, 'down');
  assert.equal(G.measureProgress(g), null); // no reading yet
  G.logMeasure(g, m, { value: 90 });
  assert.equal(G.getGoal(g.id).progress, 25);
  G.logMeasure(G.getGoal(g.id), m, { value: 88 });
  assert.equal(G.getGoal(g.id).progress, 50);
  G.logMeasure(G.getGoal(g.id), m, { value: 91 });   // a bad week: progress follows, nothing announced
  G.logMeasure(G.getGoal(g.id), m, { value: 88 });   // back to halfway: not announced again
  G.logMeasure(G.getGoal(g.id), m, { value: 95 });   // above the start: clamped at 0
  assert.equal(G.getGoal(g.id).progress, 0);
  G.logMeasure(G.getGoal(g.id), m, { value: 82 });   // past the target: 100, no milestone (reaching it is its own moment)
  assert.equal(G.getGoal(g.id).progress, 100);
  const miles = G.eventsOf(g).filter(e => e.kind === 'milestone').map(e => e.title).reverse();
  assert.deepEqual(miles, ['Goal set', 'A quarter of the way there', 'Halfway there']);

  // A jump announces only the highest milestone crossed.
  const g2 = readyGoal(alice, 'Save 5,000 EUR');
  const s = G.addMeasure(g2, { label: 'Savings', unit: 'EUR', target: 5000 });
  G.logMeasure(g2, s, { value: 1000 });            // no start: the first reading is the start
  assert.equal(G.measuresOf(g2)[0].start, 1000);
  G.logMeasure(G.getGoal(g2.id), s, { value: 4200 });
  assert.equal(G.getGoal(g2.id).progress, 80);
  assert.deepEqual(G.eventsOf(g2).filter(e => e.kind === 'milestone').map(e => e.title), ['Three quarters of the way there', 'Goal set']);

  // Bad input is refused with a reason.
  assert.throws(() => G.addMeasure(g, { label: 'Steps' }), err => /target, a number per week/.test(err.errors.measure));
  assert.throws(() => G.addMeasure(g, { label: 'weight', target: 80 }), err => /already counts/.test(err.errors.measure));
  assert.throws(() => G.addMeasure(g, { label: 'Waist', start: 90, target: 90 }), err => /same number/.test(err.errors.measure));
  assert.throws(() => G.logMeasure(g, m, { value: 'lots' }), err => /number/.test(err.errors.value));
});

test('measures: "4 of 3 this week" counts the current week (Monday first) in their timezone', () => {
  const g = readyGoal(alice, 'Run three times a week');
  const m = G.addMeasure(g, { label: 'Runs', per_week: 3 });
  const now = new Date('2026-09-24T12:00:00Z'); // a Thursday
  for (const d of ['2026-09-20T09:00:00Z', '2026-09-21T07:00:00Z', '2026-09-22T07:00:00Z', '2026-09-23T07:00:00Z', '2026-09-24T07:00:00Z']) {
    G.logMeasure(G.getGoal(g.id), m, { value: 1, at: d });
  }
  assert.equal(G.weekCount(m, { now, tz: 'UTC' }), 4); // Sunday the 20th belongs to last week
  const v = G.measureView(m, { now, tz: 'UTC' });
  assert.equal(v.weekLabel, '4 of 3 this week');
  assert.equal(v.points.length, 5);
  // In Honolulu, Monday 07:00 UTC is still Sunday evening: that run moves to last week.
  assert.equal(G.weekCount(m, { now, tz: 'Pacific/Honolulu' }), 3);
});

test('streaks: consecutive days or weeks with something done; today never breaks it; a miss starts again quietly', () => {
  const now = new Date('2026-09-24T12:00:00Z'); // Thursday
  const addAt = (g, kind, iso) => run('INSERT INTO goal_events (goal_id, kind, title, at) VALUES (?, ?, ?, ?)', g.id, kind, 'x', sqlAt(new Date(iso)));
  // Daily cadence (a rhythm of 7 a week): the 21st–23rd, nothing yet today → 3; something today → 4.
  const d = readyGoal(bob, 'Meditate daily');
  G.addMeasure(d, { label: 'Sessions', per_week: 7 });
  assert.equal(G.cadenceOf(d), 'day');
  for (const day of ['2026-09-19', '2026-09-21', '2026-09-22', '2026-09-23']) addAt(d, 'reply', `${day}T08:00:00Z`);
  addAt(d, 'checkin', '2026-09-20T08:00:00Z'); // a check-in isn't something they did: the 20th stays a gap
  assert.deepEqual(G.streakOf(d, { now, tz: 'UTC' }), { count: 3, cadence: 'day', label: '3-day streak' });
  addAt(d, 'action', '2026-09-24T07:00:00Z');
  assert.equal(G.streakOf(d, { now, tz: 'UTC' }).count, 4);
  // Two days later with nothing since: back to zero, no label (never shamed).
  assert.deepEqual(G.streakOf(d, { now: new Date('2026-09-26T12:00:00Z'), tz: 'UTC' }), { count: 0, cadence: 'day', label: null });

  // Weekly cadence (the default): weeks of 7, 14 and 21 Sep have something; the current week (21st) has an artifact.
  const w = readyGoal(bob, 'Write a blog post weekly');
  assert.equal(G.cadenceOf(w), 'week');
  addAt(w, 'artifact', '2026-09-08T10:00:00Z');
  addAt(w, 'reply', '2026-09-14T10:00:00Z');
  const m = G.addMeasure(w, { label: 'Posts', per_week: 1 });
  G.logMeasure(G.getGoal(w.id), m, { value: 1, at: '2026-09-22T10:00:00Z' }); // a logged number counts too
  assert.deepEqual(G.streakOf(w, { now, tz: 'UTC' }), { count: 3, cadence: 'week', label: '3-week streak' });
  addAt(w, 'reply', '2026-08-25T10:00:00Z'); // the week of 31 Aug is empty: the older one doesn't join
  assert.equal(G.streakOf(w, { now, tz: 'UTC' }).count, 3);
  // A daily routine switched on makes it daily.
  G.addTasks(w, [{ title: 'Daily writing prompt', prompt: 'Prompt me.', kind: 'recurring', repeat: 'daily', at: '08:00' }]);
  run(`UPDATE goal_tasks SET enabled = 1 WHERE goal_id = ? AND kind = 'recurring'`, w.id);
  assert.equal(G.cadenceOf(G.getGoal(w.id)), 'day');

  // goalsBlock shows the streak and the week's count to the model.
  const block = G.goalsBlock(bob, { now });
  assert.match(block, /Meditate daily/);
  assert.match(block, /Posts · 1 of 1 this week/);
});

test('lapses: one gentle nudge per lapse, at most one a day per person, never with check-ins off', async () => {
  const u = await createUser({ name: 'Cara Lapse', email: 'cara@p22i.dev', password: 'correct horse battery' });
  policy.setPolicy('user', u.id, { toolsets: { core: 'allow', goals: 'allow' }, quietStart: '12:00', quietEnd: '12:00', weeklyBudget: 0 }, alice.id);
  run(`UPDATE users SET timezone = 'UTC' WHERE id = ?`, u.id);
  const user = getUser(u.id);
  const t0 = new Date('2026-09-17T08:00:00Z');
  const g1 = readyGoal(user, 'Run three times a week');
  const runsM = G.addMeasure(g1, { label: 'Runs', per_week: 3 });
  G.logMeasure(g1, runsM, { value: 1, at: t0.toISOString() });
  const g2 = readyGoal(user, 'Swim weekly');
  const swims = G.addMeasure(g2, { label: 'Swims', per_week: 1 });
  run('UPDATE goal_measures SET created_at = ? WHERE id = ?', sqlAt(new Date('2026-09-01T08:00:00Z')), swims.id);
  const mine = async at => (await A.nudgeLapses(at)).filter(id => G.getGoal(id).user_id === user.id); // other tests' goals lapse too
  const notifies = () => all(`SELECT data FROM events WHERE user_id = ? AND type = 'notify'`, user.id).map(e => JSON.parse(e.data));

  // Two days after a run isn't a lapse for "3 a week" (usual gap 2.3 days → 4.7 days).
  assert.equal(G.lapseOf(G.getGoal(g1.id), { now: new Date('2026-09-19T09:00:00Z'), tz: 'UTC' }), null);
  // Six days later: both goals have lapsed, but only one nudge goes out today.
  const day1 = new Date('2026-09-23T09:00:00Z');
  assert.deepEqual(await mine(day1), [g1.id]);
  assert.equal(notifies().length, 1);
  assert.match(notifies()[0].title, /How’s “Run three times a week” going\?/);
  assert.doesNotMatch(notifies()[0].body, /—/); // UI copy never uses em-dashes (#116)
  assert.ok(titles(g1).includes('Checked in gently'));
  assert.deepEqual(await mine(new Date(day1.getTime() + 3 * 3600e3)), []); // same day: nothing more
  // The next day: the other goal; the first one was already nudged for this lapse.
  const day2 = new Date(day1.getTime() + 25 * 3600e3);
  assert.deepEqual(await mine(day2), [g2.id]);
  assert.deepEqual(await mine(new Date(day2.getTime() + 25 * 3600e3)), []);
  assert.equal(notifies().length, 2);
  // They run again, then go quiet again: a new lapse may be nudged (once).
  G.logMeasure(G.getGoal(g1.id), runsM, { value: 1, at: '2026-09-25T08:00:00Z' });
  const later = new Date('2026-10-02T09:00:00Z');
  run(`UPDATE users SET checkins = 'off' WHERE id = ?`, user.id);
  assert.deepEqual(await mine(later), []); // check-ins off: never
  run(`UPDATE users SET checkins = 'normal' WHERE id = ?`, user.id);
  assert.deepEqual(await mine(later), [g1.id]);
  // A week already on target is never a lapse.
  const g3 = readyGoal(bob, 'Stretch twice a week');
  const st = G.addMeasure(g3, { label: 'Stretches', per_week: 2 });
  run('UPDATE goal_measures SET created_at = ? WHERE id = ?', sqlAt(new Date('2026-09-01T08:00:00Z')), st.id);
  G.logMeasure(g3, st, { value: 1, at: '2026-09-21T08:00:00Z' });
  G.logMeasure(G.getGoal(g3.id), st, { value: 1, at: '2026-09-21T18:00:00Z' });
  assert.equal(G.lapseOf(G.getGoal(g3.id), { now: new Date('2026-09-27T20:00:00Z'), tz: 'UTC' }), null);
});

test('goal_progress: logs a number against a measure, starts a new one with a target, says when it can’t tell which', async () => {
  const g = readyGoal(bob, 'Get down to 80 kg');
  const t = threads.createSideThread(bob.id, 'Chat');
  const ctx = { user: bob, thread: t, run: { id: null } };
  const tool = getTool('goal_progress');
  const first = await tool.run({ goal_id: g.id, note: 'Weighed in at 90', measure: 'Weight', value: 90, target: 80, unit: 'kg' }, ctx);
  assert.match(first.content, /Weight: 90 kg \(start 90 kg, target 80 kg\) \(0% of the way\)/);
  const second = await tool.run({ goal_id: g.id, note: '85 today', value: 85 }, ctx); // one measure: no name needed
  assert.match(second.content, /50% of the way/);
  assert.equal(G.getGoal(g.id).progress, 50);
  assert.ok(G.eventsOf(g).some(e => e.title === '85 today' && /Weight: 85 kg/.test(e.detail)));
  G.addMeasure(G.getGoal(g.id), { label: 'Gym visits', per_week: 3 });
  const unclear = await tool.run({ goal_id: g.id, note: 'Went to the gym', value: 1 }, ctx);
  assert.match(unclear, /Not recorded: this goal counts “Weight”, “Gym visits”/);
  assert.ok(!G.eventsOf(g).some(e => e.title === 'Went to the gym')); // nothing half-recorded
  const gym = await tool.run({ goal_id: g.id, note: 'Went to the gym', measure: 'gym visits', value: 1 }, ctx);
  assert.match(gym.content, /Gym visits · 1 of 3 this week/);
});

test('review: a measure’s progress beats the estimate; the prompt carries done-when, order and numbers; new steps can wait', async () => {
  const g = readyGoal(bob, 'Run a half marathon');
  const [base] = G.addTasks(g, [{ title: 'Build a base plan', prompt: 'Plan.', done_when: 'a 6-week base plan in the Library' }]);
  const m = G.addMeasure(g, { label: 'Long run', unit: 'km', start: 5, target: 21 });
  G.logMeasure(g, m, { value: 13 });
  json.push({ progress: 10, status_line: 'Long runs are growing', summary: 'Going well.', next_step: 'Keep going',
    new_steps: [{ title: 'Pick a race', prompt: 'Find a race.', done_when: 'a shortlist of 2 races', after: [1] }] });
  await A.reviewGoal(G.getGoal(g.id));
  const call = jsonCalls.at(-1);
  assert.match(call.content, /1\. \[todo\] Build a base plan · done when: a 6-week base plan in the Library/);
  assert.match(call.content, /MEASURES:\n- Long run: 13 km \(start 5 km, target 21 km\) → 50% of the way/);
  assert.equal(G.getGoal(g.id).progress, 50); // computed, not the model's 10
  assert.equal(G.getGoal(g.id).status_line, 'Long runs are growing');
  const race = G.tasksOf(g).find(t => t.title === 'Pick a race');
  assert.deepEqual([race.done_when, G.afterIdsOf(race)], ['a shortlist of 2 races', [base.id]]);
});

// ---- 4. Intake round 2 ------------------------------------------------------------------------------------------------
const Q = (header, labels) => ({ header, question: `${header}?`, kind: 'single', options: labels.map(label => ({ label })) });
const answerAll = qs => qs.map(q => ({ questionId: q.id, value: q.options[0].value }));

test('intake round 2: follow-ups after the first answers; planning waits for them; answers from both rounds reach the plan', async () => {
  const g = G.createGoal({ user: bob, title: 'Get fit for a trek', category: 'health' });
  json.push({ questions: [Q('Where now', ['Walk sometimes', 'Run weekly']), Q('Which trek', ['A day hike', 'Kilimanjaro'])] });
  A.kick(g);
  const round1 = await until(() => G.getGoal(g.id).intake && JSON.parse(G.getGoal(g.id).intake), 'the first questions');
  assert.equal(G.goalDetail(G.getGoal(g.id)).pendingQuestion.round, 1);

  json.push({ questions: [Q('Trek date', ['This summer', 'Next year']), Q('Altitude', ['Never been high', 'Done 3,000 m']), Q('Gear', ['Have boots', 'Need everything']), Q('Extra', ['a', 'b'])] });
  A.saveIntakeAnswers(G.getGoal(g.id), answerAll(round1));
  const round2 = await until(() => G.getGoal(g.id).intake && JSON.parse(G.getGoal(g.id).intake), 'the follow-ups');
  assert.equal(round2.length, 3); // never more than three
  assert.match(jsonCalls.at(-1).system, /follow-up/);
  assert.match(jsonCalls.at(-1).content, /Where now\? → Walk sometimes/);
  let now = G.getGoal(g.id);
  assert.deepEqual([now.stage, now.intake_round], ['intake', 2]);
  assert.equal(G.goalDetail(now).pendingQuestion.round, 2);
  assert.ok(titles(g).includes('You answered a few questions'));

  json.push(PLAN);
  A.saveIntakeAnswers(now, answerAll(round2));
  await until(() => G.getGoal(g.id).stage === 'ready', 'the plan');
  assert.match(jsonCalls.at(-1).content, /Where now\? → Walk sometimes[\s\S]*Trek date\? → This summer/);
  now = G.getGoal(g.id);
  assert.equal(JSON.parse(now.answers).length, 5);
  assert.ok(titles(g).includes('You answered a couple more'));
});

test('intake round 2: Skip keeps the first answers; no follow-ups or a failed call goes straight to planning; skipping round 1 skips both', async () => {
  // Skip in round 2.
  const g = G.createGoal({ user: bob, title: 'Learn Spanish', category: 'learning' });
  G.setGoalFields(g.id, { intake: JSON.stringify([{ id: 'level', header: 'Level', question: 'Level?', kind: 'single', allowOther: true, options: [{ value: 'none', label: 'None' }] }]) });
  json.push({ questions: [Q('Why', ['Travel', 'Work'])] });
  A.saveIntakeAnswers(G.getGoal(g.id), [{ questionId: 'level', value: 'none' }]);
  await until(() => G.getGoal(g.id).intake, 'the follow-ups');
  json.push(PLAN);
  A.skipIntake(G.getGoal(g.id));
  await until(() => G.getGoal(g.id).stage === 'ready', 'the plan after Skip');
  assert.deepEqual(JSON.parse(G.getGoal(g.id).answers), [{ question: 'Level?', answer: 'None' }]);

  // No follow-ups: straight to the plan.
  const g2 = G.createGoal({ user: bob, title: 'Declutter the flat', category: 'home' });
  G.setGoalFields(g2.id, { intake: JSON.stringify([{ id: 'rooms', header: 'Rooms', question: 'Rooms?', kind: 'single', allowOther: true, options: [{ value: 'all', label: 'All' }] }]) });
  json.push({ questions: [] }, PLAN);
  A.saveIntakeAnswers(G.getGoal(g2.id), [{ questionId: 'rooms', value: 'all' }]);
  await until(() => G.getGoal(g2.id).stage === 'ready', 'the plan with no follow-ups');

  // The follow-up call fails: planning goes ahead, no error on the goal.
  const g3 = G.createGoal({ user: bob, title: 'Plant a vegetable patch', category: 'home' });
  G.setGoalFields(g3.id, { intake: JSON.stringify([{ id: 'space', header: 'Space', question: 'Space?', kind: 'single', allowOther: true, options: [{ value: 'yard', label: 'Yard' }] }]) });
  json.push({ status: 400 }, PLAN);
  A.saveIntakeAnswers(G.getGoal(g3.id), [{ questionId: 'space', value: 'yard' }]);
  await until(() => G.getGoal(g3.id).stage === 'ready', 'the plan after a failed follow-up call');
  assert.equal(G.getGoal(g3.id).error, null);

  // Skipping the first round skips everything (no follow-up call).
  const g4 = G.createGoal({ user: bob, title: 'Read 12 books this year', category: 'learning' });
  G.setGoalFields(g4.id, { intake: JSON.stringify([{ id: 'genre', header: 'Genre', question: 'Genre?', kind: 'single', options: [{ value: 'any', label: 'Any' }] }]) });
  const before = jsonCalls.length;
  json.push(PLAN);
  A.skipIntake(G.getGoal(g4.id));
  await until(() => G.getGoal(g4.id).stage === 'ready', 'the plan after skipping round 1');
  assert.equal(jsonCalls.length, before + 1);
  assert.equal(G.getGoal(g4.id).answers, '[]');
});

// ---- 5. Why an idea was turned down -----------------------------------------------------------------------------------
test('ideas: durable reasons feed reflection and the chat prompt; "Not now" snoozes and is never recorded', async () => {
  const u = await createUser({ name: 'Dee Ideas', email: 'dee@p22i.dev', password: 'correct horse battery' });
  policy.setPolicy('user', u.id, { toolsets: { core: 'allow', goals: 'allow' }, quietStart: '12:00', quietEnd: '12:00', weeklyBudget: 0 }, alice.id);
  const user = getUser(u.id);
  const workout = I.addIdea(user, { title: 'Home workout plan', why: 'You want to get fit.', prompt: 'Make me a home workout plan' });
  const meals = I.addIdea(user, { title: 'Weekly meal prep', why: 'Busy weeks.', prompt: 'Plan my meal prep' });
  const budget = I.addIdea(user, { title: 'Monthly budget sheet', why: 'Money talk.', prompt: 'Make a budget sheet' });
  const quiet = I.addIdea(user, { title: 'Garden planner', why: 'Spring.', prompt: 'Plan my garden' });

  assert.equal(I.setIdeaState(workout, 'dismissed', { reason: 'already_doing', note: 'I have a personal trainer' }), 'dismissed');
  assert.equal(I.setIdeaState(meals, 'dismissed', { reason: 'not_for_me' }), 'dismissed');
  assert.equal(I.setIdeaState(budget, 'dismissed', { reason: 'not_now' }), 'snoozed'); // a deferral, not a rejection
  I.setIdeaState(quiet, 'dismissed'); // no reason: title dedupe only, as before
  const row = get('SELECT state, snooze_until, dismiss_reason FROM ideas WHERE id = ?', budget.id);
  assert.equal(row.state, 'snoozed');
  assert.ok(row.snooze_until);
  assert.equal(row.dismiss_reason, null);
  assert.throws(() => I.setIdeaState(meals, 'dismissed', { reason: 'meh' }), err => /reasons/.test(err.errors.reason));
  assert.deepEqual(I.turnedDown(user), ['Weekly meal prep (not for me)', 'Home workout plan (already doing it: I have a personal trainer)']);
  assert.deepEqual(I.ideasData(user).dismissReasons.map(r => r.label), ['Not for me', 'Already doing it', 'Not now']);

  // Reflection sees them with why, and is told to avoid anything like them.
  json.push({ ideas: [], goals: [] });
  await A.reflect(user, { force: true });
  const call = jsonCalls.at(-1);
  assert.match(call.system, /Never suggest anything like what is listed under TURNED DOWN/);
  assert.match(call.content, /TURNED DOWN \(with why\)[^\n]*\n- Weekly meal prep \(not for me\)\n- Home workout plan \(already doing it: I have a personal trainer\)/);
  assert.doesNotMatch(call.content, /TURNED DOWN[^]*Monthly budget sheet \(/);
  // The chat prompt (where goal_suggest is decided) carries the same block, even with no active goals.
  assert.match(G.goalsBlock(user), /\(no active goals\)\nTURNED DOWN \(with why\)[^]*Home workout plan/);
  assert.match(getTool('goal_suggest').description, /turned down/);
  // Undo (restore) clears the reason.
  I.setIdeaState(workout, 'seen');
  assert.deepEqual(I.turnedDown(user), ['Weekly meal prep (not for me)']);
});

// ---- 6. Over HTTP: the step, measure and idea routes; the goal page shows the order ------------------------------------
test('web: queue a step, refuse a looping order (422), log a number, dismiss an idea with why; the page says "After:"', async () => {
  const { createSession } = await import('../src/services/sessions.js');
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  const server = await listen(createApp());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Bearer ${createSession(alice.id, { kind: 'app', device: 'test' })}` };
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const g = readyGoal(alice, 'Host a family reunion');
    const [venue, book] = G.addTasks(g, [{ title: 'Shortlist reunion venues', prompt: 'Venues.' }, { title: 'Book the reunion venue', prompt: 'Book.', after: [1] }]);
    const queued = await (await post(`/api/v1/goals/${g.id}/tasks/${book.id}`, { enabled: true })).json();
    assert.deepEqual(queued.task, { id: book.id, enabled: true, status: 'todo', queued: true, after: ['Shortlist reunion venues'], afterIds: [venue.id] });
    const loopy = await post(`/api/v1/goals/${g.id}/tasks/${venue.id}`, { after: [book.id] });
    assert.equal(loopy.status, 422);
    assert.match((await loopy.json()).errors.after, /circle/);
    assert.equal(G.getTask(book.id).enabled, 1, 'changing the order alone never switches a step');
    const page = await (await fetch(`${base}/goals/${g.id}`, { headers: auth })).text();
    assert.match(page, /After: Shortlist reunion venues, then it starts by itself/);
    const detail = await (await fetch(`${base}/api/v1/goals/${g.id}`, { headers: auth })).json();
    assert.equal(detail.goal.nextStep, 'Shortlist reunion venues');
    assert.equal(detail.goal.plan[1].queued, true);

    const m = G.addMeasure(g, { label: 'Guests confirmed', target: 40, start: 0 });
    const logged = await post(`/api/v1/goals/${g.id}/measures/${m.id}/logs`, { value: 10 });
    assert.equal(logged.status, 201);
    const lj = await logged.json();
    assert.deepEqual([lj.progress, lj.measure.latest, lj.measure.progress], [25, 10, 25]);
    assert.equal((await post(`/api/v1/goals/${g.id}/measures/${m.id}/logs`, { value: 'x' })).status, 422);
    assert.equal((await post(`/api/v1/goals/${g.id}/measures/999999/logs`, { value: 1 })).status, 404);

    const idea = I.addIdea(alice, { title: 'Reunion photo book', why: 'Memories.', prompt: 'Make a photo book' });
    const later = await (await post(`/api/v1/ideas/${idea.public_id}/dismiss`, { reason: 'not_now' })).json();
    assert.deepEqual(later, { ok: true, state: 'snoozed' });
    const gone = await (await post(`/api/v1/ideas/${idea.public_id}/dismiss`, { reason: 'not_for_me', note: 'We did one last year' })).json();
    assert.equal(gone.state, 'dismissed');
    assert.deepEqual(I.turnedDown(alice), ['Reunion photo book (not for me: We did one last year)']);
    assert.equal((await post(`/api/v1/ideas/${idea.public_id}/dismiss`, { reason: 'whatever' })).status, 422);
    assert.deepEqual(await (await post(`/api/v1/ideas/${idea.public_id}/dismiss`, {})).json(), { ok: true, state: 'dismissed' }); // no reason: as before
  } finally { server.close(); }
});
