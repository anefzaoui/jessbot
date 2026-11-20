// Phase 25 part D (decisions #211–#213): a thumbs-down's "What was off?" and "Noted" chip; background work on screen (the
// delegate step and post-back, a side chat's brief, overnight prep's chat, the rail's marks, /chat/<thread>#run-<id>);
// overnight prep's switch, Ready card and nightly cap; notes for later; Admin → System's weekly self-review (change preview,
// evidence), How I'm doing and What's new, and the person's What's new card; the Library's kind filter; a goal's new number;
// the trust chip, a paused task's note, the picture price on its approval. These tests cover the data the screens are built
// from and the server-rendered pages and fragments; the interactions are in scripts/ui-flows.js (styleguide).
// Run: npm test  (node --test, throwaway data dir, no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-p25d-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
delete process.env.OPENROUTER_KEY; // no model call can happen (a post-mortem without a key finds nothing to learn)
delete process.env.LLM_API_KEY;

const { openDb, closeDb, get, run, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser, getUser } = await import('../src/services/users.js');
const { createApp } = await import('../src/app.js');
const { createSession } = await import('../src/services/sessions.js');
const { mainThread, createSideThread } = await import('../src/services/threads.js');
const { addMessage } = await import('../src/services/messages.js');
const runs = await import('../src/services/runs.js');
const { addLesson, notedChip, notedFor } = await import('../src/services/lessons.js');
const { assistantView } = await import('../src/services/chatview.js');
const { delegateTrigger, briefOf, backgroundOf, DELEGATE_RULES } = await import('../src/agent/tools/delegate.js');
const prep = await import('../src/services/prep.js');
const policy = await import('../src/services/policy.js');
const notes = await import('../src/services/notes.js');
const ideas = await import('../src/services/ideas.js');
const SR = await import('../src/agent/self-review.js');
const WN = await import('../src/services/whats-new.js');
const { libraryData, filtersFor, filterOf } = await import('../src/services/library.js');
const G = await import('../src/services/goals.js');
const schedules = await import('../src/services/schedules.js');
const { getTool } = await import('../src/agent/tools/registry.js');
await import('../src/agent/tools/index.js');
const { renderFragment } = await import('../src/views/render.js');

let alice, bob, base, server;
const tokens = {};
before(async () => {
  alice = await createUser({ name: 'Alice Owner', email: 'alice@p25d.dev', password: 'correct horse battery', role: 'admin', timezone: 'UTC' });
  bob = await createUser({ name: 'Bob Member', email: 'bob@p25d.dev', password: 'correct horse battery', timezone: 'UTC' });
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  for (const [k, u] of Object.entries({ alice, bob })) tokens[k] = createSession(u.id, { kind: 'app', device: 'test' });
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const call = async (who, method, url, body) => {
  const res = await fetch(base + url, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json', Accept: 'application/json',
    'X-Requested-With': 'jessbot' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
};
const page = async (who, url) => {
  const res = await fetch(base + url, { headers: { Authorization: `Bearer ${tokens[who]}`, Accept: 'text/html' } });
  return { status: res.status, html: await res.text() };
};
/** A finished reply in a thread: its run and the message. */
function reply(user, threadId, text, runExtra = {}) {
  const trigger = addMessage({ threadId, role: 'user', content: 'Which train?' });
  const r = runs.createRun({ threadId, userId: user.id, triggerMessageId: trigger.id, model: 'fake/model', ...runExtra });
  const m = addMessage({ threadId, role: 'assistant', content: text, runId: r.id });
  run(`UPDATE runs SET status = 'done', ended_at = datetime('now'), reply_message_id = ? WHERE id = ?`, m.id, r.id);
  return { run: runs.getRun(r.id), message: get('SELECT * FROM messages WHERE id = ?', m.id) };
}
const noEmDash = (html, from, to) => { const i = html.indexOf(from); return !/—/.test(html.slice(i, to ? html.indexOf(to, i) : i + 4000)); };

// ---- #211 Thumbs-down: "What was off?" and the Noted chip -------------------------------------------------------------------
test('the Noted chip: one shape for the post-mortem, the chat and the page; a guess waits for Keep, their words don’t', () => {
  const t = mainThread(alice.id);
  const { message } = reply(alice, t.id, 'Here are all 14 trains…');
  assert.equal(notedFor(alice.id, message.id), null, 'no lesson, no chip');
  const guess = addLesson({ scope: 'person', user: alice, rule: 'When I compare trains, lead with my pick', source: 'thumbs_down', sourceMessageId: message.id, status: 'proposed' }).lesson;
  assert.deepEqual(notedFor(alice.id, message.id), { text: 'Noted: When I compare trains, lead with my pick', rule: 'When I compare trains, lead with my pick', lessonId: guess.id, keep: true });
  assert.deepEqual(notedChip(guess), notedFor(alice.id, message.id));
  assert.equal(notedFor(bob.id, message.id), null, 'only its owner');
  const r = runs.getRun(message.run_id);
  assert.deepEqual(assistantView(r).noted, notedFor(alice.id, message.id), 'the chat renders it on load');
  run(`UPDATE lessons SET status = 'active' WHERE id = ?`, guess.id);
  assert.equal(notedFor(alice.id, message.id).keep, false, 'kept: no Keep button any more');
  run(`UPDATE lessons SET status = 'rejected' WHERE id = ?`, guess.id);
  assert.equal(notedFor(alice.id, message.id), null, 'a rejected guess shows nothing');
});

test('POST feedback: noteFirst saves the thumbs-down and waits; Skip / Send return the chip with its html; taking it back withdraws a guess', async () => {
  const t = mainThread(alice.id);
  const { message } = reply(alice, t.id, 'A very long answer about trains.');
  const first = await call('alice', 'POST', `/api/v1/messages/${message.id}/feedback`, { feedback: 'down', noteFirst: true });
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.waiting, first.body.lesson, first.body.chip, first.body.html], [true, null, null, null]);
  assert.equal(get('SELECT feedback FROM messages WHERE id = ?', message.id).feedback, 'down', 'saved at once');
  assert.equal(get(`SELECT COUNT(*) AS n FROM lessons WHERE source_message_id = ?`, message.id).n, 0, 'no post-mortem yet');
  // No model key: the post-mortem finds nothing, and says so with nulls (the page thanks them).
  const skip = await call('alice', 'POST', `/api/v1/messages/${message.id}/feedback`, { feedback: 'down' });
  assert.deepEqual([skip.status, skip.body.lesson, skip.body.chip, skip.body.html], [200, null, null, null]);
  // A guess made earlier comes back as the chip, rendered by the chat's own partial.
  const g = addLesson({ scope: 'person', user: alice, rule: 'Keep train answers to one pick', source: 'thumbs_down', sourceMessageId: message.id, status: 'proposed' }).lesson;
  const again = await call('alice', 'POST', `/api/v1/messages/${message.id}/feedback`, { feedback: 'down' });
  assert.equal(again.body.chip.lessonId, g.id);
  assert.equal(again.body.chip.keep, true);
  assert.match(again.body.html, new RegExp(`data-noted="${g.id}" data-state="proposed"`));
  assert.match(again.body.html, /data-noted-keep/);
  assert.match(again.body.html, /Keep train answers to one pick/);
  assert.ok(!/—/.test(again.body.html), 'no em-dash in the chip');
  // No on the chip = DELETE { reject: true }: kept as rejected so it isn't guessed again.
  const no = await call('alice', 'DELETE', `/api/v1/me/lessons/${g.id}`, { reject: true });
  assert.equal(no.status, 200);
  assert.equal(get('SELECT status FROM lessons WHERE id = ?', g.id).status, 'rejected');
  // Taking the thumbs-down back withdraws a guess they never kept.
  const g2 = addLesson({ scope: 'person', user: alice, rule: 'Say the price first', source: 'thumbs_down', sourceMessageId: message.id, status: 'proposed' }).lesson;
  await call('alice', 'POST', `/api/v1/messages/${message.id}/feedback`, { feedback: null });
  assert.equal(get('SELECT id FROM lessons WHERE id = ?', g2.id), undefined);
  assert.equal(get('SELECT feedback FROM messages WHERE id = ?', message.id).feedback, null);
  assert.equal((await call('bob', 'POST', `/api/v1/messages/${message.id}/feedback`, { feedback: 'down', noteFirst: true })).status, 404, 'not theirs');
});

test('the chat page: every reply is an anchor (#run-<id>), the chip renders on load, the "What was off?" template is there for the owner only', async () => {
  const t = mainThread(bob.id);
  const { message, run: r } = reply(bob, t.id, 'Answer for Bob.');
  addLesson({ scope: 'person', user: bob, rule: 'Use 24-hour times', source: 'thumbs_down', sourceMessageId: message.id, status: 'active' });
  const own = await page('bob', '/chat');
  assert.match(own.html, new RegExp(`id="run-${r.id}"`));
  assert.match(own.html, /data-noted="\d+" data-state="active"/);
  assert.match(own.html, /data-noted-no="remove"/);
  assert.match(own.html, /<template data-fb-note-template>/);
  assert.ok(noEmDash(own.html, 'data-fb-note-template', '</template>'), 'no em-dash in the form');
  const asAdmin = await page('alice', `/chat/${t.id}`);
  assert.match(asAdmin.html, new RegExp(`id="run-${r.id}"`), 'evidence links open under the usual rules (read-only, audited)');
  assert.ok(!asAdmin.html.includes('data-fb-note-template'), 'read-only: no form');
  assert.ok(!asAdmin.html.includes('data-noted-no='), 'read-only: no chip buttons');
});

// ---- #212 Background work ----------------------------------------------------------------------------------------------------
test('the delegate brief reads back exactly as it was written, with and without a skill; anything else is not a brief', () => {
  const brief = 'Compare three desks.\n\nUnder €450, quiet motor.\nUse skill-like words: call use_skill("x") first.';
  assert.deepEqual(briefOf(delegateTrigger({ title: 'Desks', brief, skill: 'buying-guide' })), { brief, skill: 'buying-guide' });
  assert.deepEqual(briefOf(delegateTrigger({ title: 'Desks', brief })), { brief, skill: null });
  assert.equal(briefOf('Just a message.'), null);
  assert.equal(briefOf(`[Background task “x”: …]\nbrief without the rules`), null);
  assert.equal(briefOf(null), null);
  assert.ok(delegateTrigger({ title: 't', brief: 'b' }).endsWith(DELEGATE_RULES));
});

test('backgroundOf: a delegate chat says what it was asked and links back to the run it came from; prep says which idea; other chats nothing', async () => {
  const home = mainThread(alice.id);
  const parent = reply(alice, home.id, 'I’m on it in the background.');
  const side = createSideThread(alice.id, 'Working on: Desks');
  const trig = addMessage({ threadId: side.id, role: 'system', content: delegateTrigger({ title: 'Desks', brief: 'Compare three desks under €450.', skill: 'buying-guide' }) });
  const d = runs.createRun({ threadId: side.id, userId: alice.id, triggerMessageId: trig.id, model: 'fake/model', origin: 'delegate', originLabel: 'Desks', parentRunId: parent.run.id });
  const bg = backgroundOf(side.id);
  assert.deepEqual([bg.kind, bg.title, bg.brief, bg.skill, bg.status], ['delegate', 'Desks', 'Compare three desks under €450.', 'buying-guide', 'queued']);
  assert.deepEqual(bg.from, { href: `/chat/${home.id}#run-${parent.run.id}`, label: 'your main chat' });
  assert.equal(backgroundOf(home.id), null);
  assert.equal(backgroundOf(createSideThread(alice.id, 'Plain').id), null);
  // The side chat's page: the folded brief, the link back, the rocket on the run and in the rail.
  run(`UPDATE runs SET status = 'done', ended_at = datetime('now') WHERE id = ?`, d.id);
  const { html } = await page('alice', `/chat/${side.id}`);
  assert.match(html, /data-bg-brief="delegate"/);
  assert.match(html, /<details class="bg-brief-fold">/);
  assert.match(html, /Compare three desks under €450\./);
  assert.match(html, new RegExp(`href="/chat/${home.id}#run-${parent.run.id}"`));
  assert.match(html, /Done: the result was posted back there\./);
  assert.match(html, /class="rail-bg-tag"[^>]*>Background</);
  assert.ok(noEmDash(html, 'data-bg-brief', '</section>'));
  // The parent chat is gone: the result went to the main chat, and the card says so.
  const home2 = createSideThread(alice.id, 'Started here');
  const p2 = reply(alice, home2.id, 'On it.');
  const side2 = createSideThread(alice.id, 'Working on: Gone');
  const trig2 = addMessage({ threadId: side2.id, role: 'system', content: delegateTrigger({ title: 'Gone', brief: 'A brief long enough to count.' }) });
  runs.createRun({ threadId: side2.id, userId: alice.id, triggerMessageId: trig2.id, model: 'fake/model', origin: 'delegate', originLabel: 'Gone', parentRunId: p2.run.id });
  run(`UPDATE threads SET deleted_at = datetime('now') WHERE id = ?`, home2.id);
  assert.equal(backgroundOf(side2.id).from, null);
  // Overnight prep's chat: the idea and the draft.
  const idea = ideas.addIdea(alice, { title: 'Fence permit', why: 'The city site timed out.', prompt: 'Help me with the fence permit.', category: 'Home' });
  const prepSide = createSideThread(alice.id, 'Prepared overnight: Fence permit');
  const pt = addMessage({ threadId: prepSide.id, role: 'system', content: prep.prepPrompt(idea) });
  const pr = runs.createRun({ threadId: prepSide.id, userId: alice.id, triggerMessageId: pt.id, model: 'fake/model', origin: 'prep', originLabel: 'Fence permit' });
  const lib = run(`INSERT INTO library_items (public_id, owner_id, title, type, ext, mime, run_id) VALUES ('p25dfence', ?, 'Fence permit checklist', 'md', 'md', 'text/markdown', ?)`, alice.id, pr.id);
  run('UPDATE ideas SET prep_run_id = ?, prepared_item_id = ? WHERE id = ?', pr.id, Number(lib.lastInsertRowid), idea.id);
  const pb = backgroundOf(prepSide.id);
  assert.deepEqual([pb.kind, pb.idea.title, pb.idea.why, pb.item.href], ['prep', 'Fence permit', 'The city site timed out.', '/library/p25dfence']);
});

test('run views carry what the screens need: the delegate step’s tool (its link stays visible), a paused task’s state', () => {
  const t = mainThread(bob.id);
  const { run: r } = reply(bob, t.id, 'On it.');
  const s = runs.startStep(r.id, { iconName: 'rocket', label: 'Started “Desks” in the background', tool: 'delegate' });
  runs.endStep(r.id, s, { detail: 'Side chat “Working on: Desks”', href: '/chat/99' });
  const step = runs.runView(runs.getRun(r.id)).steps[0];
  assert.deepEqual([step.tool, step.href, step.status], ['delegate', '/chat/99', 'ok']);
  // Paused after 3 failures (#178): the note's Resume shows only while the task is paused; Upcoming says why it is paused.
  const sch = schedules.createSchedule({ user: getUser(bob.id), title: 'Pharmacy check', prompt: 'Check the pharmacy stock.', cron: '0 9 * * *' });
  for (let i = 0; i < schedules.FAIL_PAUSE; i++) schedules.recordTaskOutcome(sch.id, false);
  schedules.pauseSchedule(schedules.getSchedule(sch.id), true);
  const note = reply(bob, t.id, 'I’ve paused it.', { origin: 'schedule', scheduleId: sch.id });
  run(`UPDATE runs SET error_kind = 'paused' WHERE id = ?`, note.run.id); // as proactive.js postNote writes it
  assert.equal(runs.runView(runs.getRun(note.run.id)).schedulePaused, true);
  const job = schedules.jobView(schedules.getSchedule(sch.id));
  assert.deepEqual([job.paused, job.pausedByFailures, job.failStreak], [true, true, 3]);
  schedules.pauseSchedule(schedules.getSchedule(sch.id), false);
  assert.equal(runs.runView(runs.getRun(note.run.id)).schedulePaused, false);
  assert.equal(runs.runView(r).schedulePaused, null, 'only on a paused note');
  schedules.pauseSchedule(schedules.getSchedule(sch.id), true); // paused by hand: not "after failures"
  schedules.recordTaskOutcome(sch.id, true);
  assert.equal(schedules.jobView(schedules.getSchedule(sch.id)).pausedByFailures, false);
});

test('the trust chip and the paused note render in the reply (server partials)', async () => {
  const html = await renderFragment('chat/message', { id: 'm1', messageId: 1, role: 'assistant', createdAt: new Date().toISOString(), html: '<p>Take the 17:04.</p>',
    run: { id: 5, status: 'done', startedAt: new Date().toISOString(), steps: [], origin: 'schedule', scheduleId: 3, errorKind: 'paused', schedulePaused: true,
      sources: { checked: 2, found: 3, sites: 2, newestDays: 1, label: 'Checked 2 sources · 2 sites · newest 1 day old',
        items: [{ url: 'https://a.example/x', host: 'a.example', title: 'A page', date: '2026-09-25', kind: 'read' }, { url: 'https://b.example', host: 'b.example', title: null, date: null, kind: 'found' }] } } }, alice);
  assert.match(html, /data-trust data-checked="2"/);
  assert.match(html, /Checked 2 sources · 2 sites · newest 1 day old/);
  assert.match(html, /2026-09-25/);
  assert.match(html, /search result/);
  assert.match(html, /data-schedule-resume="3"/);
  assert.ok(!/id="run-/.test(html), 'no runId (an optimistic bubble): no anchor');
  assert.match(await renderFragment('chat/message', { id: 'm2', runId: 5, role: 'assistant', createdAt: new Date().toISOString(), html: '<p>x</p>' }, alice), /id="run-5"/);
});

// ---- #212 Overnight prep and notes -------------------------------------------------------------------------------------------
test('prepView says what would stop it before they switch it on; PUT /me/prep returns it; the admin view counts nights and drafts', async () => {
  const u = getUser(bob.id);
  policy.setPolicy('user', bob.id, { toolsets: { web: 'allow', goals: 'allow', library: 'ask' }, quietStart: '23:00', quietEnd: '07:00', weeklyBudget: 0 }, alice.id);
  let v = prep.prepView(getUser(bob.id));
  assert.equal(v.value, 'off');
  assert.equal(v.quiet, '23:00 to 07:00');
  assert.equal(v.capLabel, '$0.05');
  assert.match(v.stopped, /Library needs your OK/);
  policy.setPolicy('user', bob.id, { toolsets: { web: 'allow', goals: 'allow', library: 'allow' }, quietStart: '23:00', quietEnd: '07:00', weeklyBudget: 0 }, alice.id);
  assert.equal(prep.prepView(getUser(bob.id)).stopped, null, 'awake / busy are not reasons to warn');
  prep.savePrepSettings({ dailyCap: 0 });
  assert.match(prep.prepView(getUser(bob.id)).stopped, /switched off for everyone/);
  prep.savePrepSettings({ dailyCap: 0.004 });
  assert.equal(prep.prepView(getUser(bob.id)).capLabel, '$0.004');
  prep.savePrepSettings({ dailyCap: 0.05 });
  const put = await call('bob', 'PUT', '/api/v1/me/prep', { prep: 'ideas' });
  assert.deepEqual([put.status, put.body.prep, put.body.view.value, put.body.view.stopped], [200, 'ideas', 'ideas', null]);
  assert.equal((await call('bob', 'PUT', '/api/v1/me/prep', { prep: 'always' })).status, 422);
  assert.equal(prep.prepBlocker(u, new Date(), { assumeOn: false }) !== undefined, true);
  const a = prep.prepAdminView();
  assert.deepEqual(a.people.map(p => p.name), ['Bob Member']);
  assert.equal(a.capLabel, '$0.05');
  assert.equal(typeof a.nights, 'number');
  assert.equal((await call('bob', 'PUT', '/api/v1/admin/prep', { dailyCap: 0.1 })).status, 403);
  const bad = await call('alice', 'PUT', '/api/v1/admin/prep', { dailyCap: 5 });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors.dailyCap);
});

test('You → Notifications: the prep switch and the notes list; Admin → Usage: the nightly cap card', async () => {
  notes.addNote({ user: getUser(bob.id), text: 'The desk drops to €399 on Friday.', sourceLabel: 'Desks' });
  notes.addNote({ user: getUser(bob.id), text: 'The permit office closes at noon.', priority: 'high', sourceLabel: 'Permit' });
  const { html } = await page('bob', '/me/notifications');
  assert.match(html, /data-prep data-value="ideas"/);
  assert.match(html, /data-prep-switch checked/);
  assert.match(html, /Notes for your next check-in/);
  assert.match(html, /The desk drops to €399 on Friday\./);
  assert.match(html, /data-priority="high"/);
  assert.match(html, /2 waiting/);
  assert.ok(noEmDash(html, 'While you sleep', 'data-notes'));
  const usage = await page('alice', '/admin/usage');
  assert.match(usage.html, /data-prep-admin/);
  assert.match(usage.html, /name="dailyCap"[^>]*value="0\.05"/);
  assert.match(usage.html, /On for <a href="\/admin\/people\/\d+"[^>]*>Bob Member<\/a>/);
});

test('Ideas: a draft made overnight shows as "Ready for you", not twice; the page says whether overnight prep is on', async () => {
  const i = ideas.addIdea(getUser(bob.id), { title: 'Plan a picnic', why: 'You mentioned Sunday.', prompt: 'Plan a picnic for Sunday.', category: 'Family' });
  const lib = run(`INSERT INTO library_items (public_id, owner_id, title, type, ext, mime) VALUES ('p25dpicnic', ?, 'Picnic plan', 'md', 'md', 'text/markdown')`, bob.id);
  run(`UPDATE ideas SET prepared_item_id = ?, ready_at = ? WHERE id = ?`, Number(lib.lastInsertRowid), new Date().toISOString(), i.id);
  ideas.addIdea(getUser(bob.id), { title: 'Sort the garage', why: 'Boxes.', prompt: 'Help me sort the garage.', category: 'Home' });
  const { html } = await page('bob', '/ideas');
  assert.match(html, /Ready for you/);
  assert.match(html, /data-ready/);
  assert.match(html, /href="\/library\/p25dpicnic"/);
  assert.equal((html.match(new RegExp(`data-idea-id="${i.public_id}"`, 'g')) || []).length, 1, 'once: in the Ready card, not in the grid');
  assert.match(html, /data-prep-hint="ideas"/);
});

// ---- #212 Admin → System: the weekly self-review, How I'm doing ----------------------------------------------------------------
test('previewOf: every kind says where it lands and shows the change as a small diff', () => {
  const add = SR.previewOf('agents_rule', { section: '## How I answer', text: 'Lead with the pick.' });
  assert.equal(add.where, 'AGENTS.md, under “How I answer”');
  assert.deepEqual(add.lines, [{ mark: 'same', text: '## How I answer' }, { mark: 'add', text: '- Lead with the pick.' }]);
  assert.deepEqual(SR.previewOf('agents_rule', { find: '- Old line.', text: '- New line.' }).lines, [{ mark: 'del', text: '- Old line.' }, { mark: 'add', text: '- New line.' }]);
  assert.equal(SR.previewOf('agents_rule', { section: null, text: '- x' }).where, 'AGENTS.md, at the end');
  assert.deepEqual(SR.previewOf('removal', { find: '- Gone.' }).lines, [{ mark: 'del', text: '- Gone.' }]);
  assert.equal(SR.previewOf('instruction', { user_id: 2, text: 'Dinars first.' }, { name: 'Maya Ben' }).where, 'Maya’s instructions, added at the end');
  assert.match(SR.previewOf('memory', { text: 'Wrong birthday.' }, { name: 'Maya' }).note, /Memory page/);
  const skill = SR.previewOf('skill', { name: 'train-pick', description: 'Pick one train.', tests: ['which train?'] });
  assert.deepEqual([skill.lines.length, skill.skill.name, skill.skill.tests[0]], [0, 'train-pick', 'which train?']);
  assert.equal(SR.previewOf('developer', { text: 'Search fails on names.' }).where, 'For the developer');
});

test('the self-review page: a review cut off by a restart says so; evidence links carry a label and whose; summaryFor clamps the period', async () => {
  const t = mainThread(bob.id);
  const { run: r } = reply(bob, t.id, 'Reply.', { origin: 'schedule', originLabel: 'Morning brief' });
  const old = new Date(Date.now() - 30 * 60e3).toISOString().replace('T', ' ').slice(0, 19);
  const rv = Number(run(`INSERT INTO self_reviews (period_start, period_end, origin, status, created_at) VALUES (?, ?, 'weekly', 'running', ?)`, old, old, old).lastInsertRowid);
  let pg = SR.selfReviewPage();
  assert.equal(pg.running, false);
  assert.deepEqual([pg.latest.id, pg.latest.status], [rv, 'error']);
  assert.match(pg.latest.note, /server restarted/);
  run(`UPDATE self_reviews SET status = 'done' WHERE id = ?`, rv);
  run(`INSERT INTO self_review_proposals (review_id, kind, title, why, change, evidence) VALUES (?, 'agents_rule', 'Lead with the pick', 'Three thumbs-down.', ?, ?)`,
    rv, JSON.stringify({ section: '## How I answer', text: 'Lead with the pick.' }), JSON.stringify([r.id, 999999]));
  pg = SR.selfReviewPage();
  const p = pg.latest.proposals[0];
  assert.equal(pg.pending, 1);
  assert.deepEqual(p.evidence[0], { runId: r.id, href: `/chat/${t.id}#run-${r.id}`, label: 'Morning brief', person: 'Bob', at: r.started_at });
  assert.deepEqual([p.evidence[1].href, p.evidence[1].label], [null, 'A task that is gone']);
  assert.equal(p.preview.lines.at(-1).text, '- Lead with the pick.');
  const s = SR.summaryFor(99);
  assert.equal(s.days, 31);
  assert.equal(SR.summaryFor('x').days, 7);
  assert.match(s.spendLabel, /^\$\d+\.\d{2}$/);
  // The pages and fragments (admin only), and the API summary with its labels.
  const sys = await page('alice', '/admin/system');
  assert.match(sys.html, /id="self-review"/);
  assert.match(sys.html, /data-rv-prop="\d+" data-status="pending"/);
  assert.match(sys.html, /AGENTS\.md, under “How I answer”/);
  assert.match(sys.html, new RegExp(`href="/chat/${t.id}#run-${r.id}"`));
  assert.match(sys.html, /data-doing data-days="7"/);
  assert.match(sys.html, /id="whats-new"/);
  assert.ok(noEmDash(sys.html, 'id="self-review"', 'id="wishes"'), 'no em-dash in the new cards');
  const frag = await call('alice', 'GET', '/admin/system/self-review');
  assert.deepEqual([frag.status, frag.body.running, frag.body.pending], [200, false, 1]);
  assert.match(frag.body.html, /data-self-review/);
  const sum = await call('alice', 'GET', '/admin/system/summary?days=30');
  assert.deepEqual([sum.body.days, /data-days="30"/.test(sum.body.html)], [30, true]);
  const api = await call('alice', 'GET', '/api/v1/admin/self-review/summary?days=3');
  assert.deepEqual([api.body.summary.days, typeof api.body.summary.spendLabel], [3, 'string']);
  assert.equal((await call('bob', 'GET', '/admin/system/self-review')).status, 403);
});

// ---- #213 What's new --------------------------------------------------------------------------------------------------------
test('What’s new: the admin editor renders drafts and published notes; the person sees a published note once in the main chat', async () => {
  run(`INSERT INTO whats_new (commit_ref, subjects, lines) VALUES ('abc1234', ?, ?)`, JSON.stringify(['Phase 25: thumbs-down asks what was off']), JSON.stringify(['You can say what was off.']));
  const id = get(`SELECT id FROM whats_new WHERE commit_ref = 'abc1234'`).id;
  const frag = await call('alice', 'GET', '/admin/system/whats-new');
  assert.match(frag.body.html, new RegExp(`data-wn-entry="${id}" data-status="draft"`));
  assert.match(frag.body.html, /data-max="6"/);
  assert.match(frag.body.html, /Phase 25: thumbs-down asks what was off/);
  assert.ok(!(await page('bob', '/chat')).html.includes('data-whats-new='), 'a draft is not shown');
  WN.publishEntry(id);
  run(`UPDATE whats_new SET published_at = datetime('now', '+1 minute') WHERE id = ?`, id); // published after Bob joined
  const shown = await page('bob', '/chat');
  assert.match(shown.html, new RegExp(`data-whats-new="${id}"`));
  assert.match(shown.html, /You can say what was off\./);
  const side = createSideThread(bob.id, 'Other');
  assert.ok(!(await page('bob', `/chat/${side.id}`)).html.includes('data-whats-new='), 'only in the main chat');
  assert.equal((await call('bob', 'POST', `/api/v1/whats-new/${id}/seen`)).status, 200);
  assert.ok(!(await page('bob', '/chat')).html.includes('data-whats-new='), 'seen: never again');
  const done = await call('alice', 'GET', '/admin/system/whats-new');
  assert.match(done.body.html, new RegExp(`data-wn-entry="${id}" data-status="published"`));
});

// ---- #212 Library, goals, pictures ------------------------------------------------------------------------------------------------
test('Library filters: a chip per kind with counts; ?type= takes a chip or an item type; empty kinds hide unless chosen', async () => {
  const items = [{ type: 'pdf' }, { type: 'pdf' }, { type: 'md' }, { type: 'slides' }];
  const f = filtersFor(items, 'md');
  const by = k => f.find(x => x.key === k);
  assert.deepEqual([by('all').count, by('pdf').count, by('doc').count, by('sheet').count], [4, 2, 1, 1]);
  assert.equal(by('doc').chosen, true, 'md opens Documents');
  assert.equal(by('image').empty, true);
  assert.equal(filtersFor(items, 'image').find(x => x.key === 'image').empty, false, 'chosen: shown even when empty');
  assert.equal(filterOf('nonsense').key, 'all');
  assert.equal(by('doc').types, 'doc md');
  run(`INSERT INTO library_items (public_id, owner_id, title, type, ext, mime) VALUES ('p25dpdf', ?, 'Lease scan', 'pdf', 'pdf', 'application/pdf')`, alice.id);
  assert.equal(libraryData(getUser(alice.id), { type: 'pdf' }).filter, 'pdf');
  const { html } = await page('alice', '/library?type=pdf');
  assert.match(html, /aria-pressed="true" data-library-filter="pdf" data-filter-key="pdf"/);
  assert.match(html, /data-library-filter="image" data-filter-key="image" hidden/);
  assert.match(html, /data-library-search-state/);
});

test('POST /goals/:id/measures: a new number to track (201 with its card); what’s missing is said; not someone else’s goal', async () => {
  const g = G.createGoal({ user: getUser(bob.id), title: 'Read more books', category: 'learning', state: 'active' });
  const ok = await call('bob', 'POST', `/api/v1/goals/${g.id}/measures`, { label: 'Pages read', per_week: 5 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.measure.label, 'Pages read');
  assert.match(ok.body.html, /data-measure-id=/);
  const missing = await call('bob', 'POST', `/api/v1/goals/${g.id}/measures`, { label: 'Minutes' });
  assert.equal(missing.status, 422);
  assert.match(missing.body.errors.measure, /target, a number per week, or both/);
  const dup = await call('bob', 'POST', `/api/v1/goals/${g.id}/measures`, { label: 'pages read', target: 300 });
  assert.match(dup.body.errors.measure, /already counts/);
  assert.equal((await call('alice', 'POST', `/api/v1/goals/${g.id}/measures`, { label: 'X', target: 2 })).status, 404);
  const { html } = await page('bob', `/goals/${g.id}`);
  assert.match(html, /data-measure-new-open/);
  assert.match(html, /data-measure-new hidden/);
});

test('make_image’s approval card shows what a picture costs, when Admin → Models worked it out', () => {
  const tool = getTool('make_image');
  settings.set('images', { model: 'fake/flux', checked: { model: 'fake/flux', price: { label: 'about $0.015 a picture', source: 'list' }, warning: null, at: new Date().toISOString() } });
  const facts = tool.approvalFacts({ prompt: 'a cat', size: 'square' }, { user: getUser(alice.id) });
  assert.deepEqual(facts.find(f => f.key === 'price'), { key: 'price', label: 'Cost', value: 'about $0.015 a picture' });
  settings.set('images', { model: 'fake/flux' });
  assert.equal(tool.approvalFacts({ prompt: 'a cat' }, { user: getUser(alice.id) }).find(f => f.key === 'price'), undefined, 'no check yet: no price');
});
