// Phase 25 part C (decisions #203–#205): the screens for Admin → Models (fallback rows, background model, Pictures), Usage
// (balance, fallbacks, pictures and scans), System (the wish log), Overview (security), People / Groups (per-task budget),
// Personality → Lessons; You → Memory (lessons, the weekly tidy); the Feed's sources (OPML, muted words), reading diet and
// gone stories; and the reminder and consent cards in the chat. These tests cover the data the screens are built from and
// the server-rendered pages and fragments; the interactions are covered by scripts/ui-flows.js (styleguide).
// Run: npm test  (node --test, throwaway data dir, no network).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-p25c-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
delete process.env.OPENROUTER_KEY; // the model test answers "No API key yet." without a network call
delete process.env.LLM_API_KEY;

const { openDb, closeDb, get, all, run, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser, getUser } = await import('../src/services/users.js');
const { createGroup, addMember } = await import('../src/services/groups.js');
const { createApp } = await import('../src/app.js');
const { createSession } = await import('../src/services/sessions.js');
const { recordUsage, featureTotals, usageOverview } = await import('../src/services/usage.js');
const images = await import('../src/services/images.js');
const { recordWish, wishSummary } = await import('../src/services/wishes.js');
const { securityEvents } = await import('../src/services/security-events.js');
const { audit } = await import('../src/services/audit.js');
const { addLesson, personLessonsView } = await import('../src/services/lessons.js');
const { mainThread } = await import('../src/services/threads.js');
const { addMessage } = await import('../src/services/messages.js');
const runs = await import('../src/services/runs.js');
const alarms = await import('../src/services/alarms.js');
const R = await import('../src/agent/reminders.js');
const { assistantView } = await import('../src/services/chatview.js');
const { getPolicy } = await import('../src/services/policy.js');

let alice, bob, carol, family, base, server;
const tokens = {};
before(async () => {
  alice = await createUser({ name: 'Alice Owner', email: 'alice@p25c.dev', password: 'correct horse battery', role: 'admin', timezone: 'UTC' });
  bob = await createUser({ name: 'Bob Member', email: 'bob@p25c.dev', password: 'correct horse battery', timezone: 'UTC' });
  carol = await createUser({ name: 'Carol Other', email: 'carol@p25c.dev', password: 'correct horse battery', timezone: 'UTC' });
  family = createGroup({ name: 'Family' });
  for (const u of [alice, bob]) addMember(family.id, u.id);
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  for (const [k, u] of Object.entries({ alice, bob, carol })) tokens[k] = createSession(u.id, { kind: 'app', device: 'test' });
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });
afterEach(() => run(`UPDATE alarms SET status = 'cancelled' WHERE status IN ('scheduled', 'snoozed', 'ringing')`));

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

// ---- #203 Admin → Models / Usage ------------------------------------------------------------------------------------------
test('pictures and scans over 30 days: counts, cost, people; zero when unused; older rows left out', () => {
  const zero = featureTotals();
  assert.deepEqual([zero.image.count, zero.image.costLabel, zero.ocr.countLabel], [0, '$0.00', '0 model calls']);
  recordUsage({ userId: alice.id, purpose: 'image', model: 'fake/flux', usage: { cost: 0.015 } });
  recordUsage({ userId: bob.id, purpose: 'image', model: 'fake/flux', usage: { cost: 0.02 } });
  recordUsage({ userId: bob.id, purpose: 'ocr', model: 'fake/vision', usage: { cost: 0.4 } });
  recordUsage({ userId: bob.id, purpose: 'image', model: 'fake/flux', usage: { cost: 9 } });
  run(`UPDATE usage_events SET at = datetime('now', '-40 days') WHERE id = (SELECT MAX(id) FROM usage_events)`);
  const f = featureTotals();
  assert.deepEqual(f.image, { count: 2, cost: 0.035, costLabel: '$0.035', people: 2, countLabel: '2 pictures' });
  assert.equal(f.ocr.countLabel, '1 model call');
  assert.equal(f.ocr.costLabel, '$0.40');
  assert.deepEqual(usageOverview([]).features, f, 'Admin → Usage carries the same lines');
});

test('image model setting: the last check is kept for that model only (a manual change of model drops it)', () => {
  settings.set('images', { model: 'fake/flux', checked: { model: 'fake/flux', price: { label: 'about $0.015 a picture', source: 'list' }, warning: null, at: '2026-09-26T08:00:00.000Z' } });
  assert.deepEqual(images.imageSettings(), { model: 'fake/flux', checked: { price: { label: 'about $0.015 a picture', source: 'list' }, warning: null, at: '2026-09-26T08:00:00.000Z' } });
  settings.set('images', { model: 'fake/other', checked: { model: 'fake/flux', price: null, warning: null, at: 'x' } });
  assert.equal(images.imageSettings().checked, null, 'a check of another model is not shown');
  settings.set('images', { model: '' });
  assert.deepEqual(images.imageSettings(), { model: '', checked: null });
  assert.equal(images.imageModel(), null);
});

test('Admin → Models: fallback rows, background state, Pictures card; the per-model test (admin only, id checked, no key → says so)', async () => {
  settings.set('llm', { model: 'fake/main', fallbacks: ['fake/one', 'fake/two'], background: 'fake/cheap' });
  settings.set('images', { model: 'fake/flux', checked: { model: 'fake/flux', price: { label: 'about $0.015 a picture', source: 'history' }, warning: null, at: new Date().toISOString() } });
  const { html } = await page('alice', '/admin/model');
  assert.equal((html.match(/data-fb-row data-model="fake\/(one|two)"/g) || []).length, 2, 'one row per fallback');
  assert.match(html, /data-fb-value>|name="fallbacks" value="fake\/one, fake\/two"/);
  assert.match(html, /data-bg data-state="saved" data-saved="fake\/cheap"/);
  assert.match(html, /<template data-fb-template>/, 'new rows come from the server’s own partial');
  assert.match(html, /data-images-form data-state="on"/);
  assert.match(html, /about \$0\.015 a picture/);
  assert.match(html, /From what its pictures cost here lately/);
  assert.match(html, /2 pictures/, 'its 30-day usage');
  assert.ok(!/—/.test(html.slice(html.indexOf('data-fallbacks'), html.indexOf('</fieldset>', html.indexOf('data-fallbacks')))), 'no em-dash in the new copy');

  assert.equal((await call('bob', 'POST', '/admin/model/test', { model: 'fake/one' })).status, 403);
  const bad = await call('alice', 'POST', '/admin/model/test', { model: 'not a model' });
  assert.equal(bad.status, 422);
  assert.match(bad.body.errors.model, /model id/);
  const t = await call('alice', 'POST', '/admin/model/test', { model: 'fake/one' });
  assert.equal(t.status, 200);
  assert.deepEqual([t.body.ok, t.body.model, t.body.error], [false, 'fake/one', 'No API key yet.']);
});

test('Admin → Usage: the balance card (read, warn, gap) and its Read it now fragment; fallbacks and feature lines', async () => {
  settings.set('openrouter-balance', null);
  const none = await page('alice', '/admin/usage');
  assert.match(none.html, /Not read yet/);
  const r = await call('alice', 'GET', '/admin/usage/balance');
  assert.equal(r.status, 200);
  assert.equal(r.body.balance, null);
  assert.match(r.body.html, /data-balance /);
  assert.equal(r.body.gapHtml.trim(), '');
  assert.equal((await call('bob', 'GET', '/admin/usage/balance')).status, 403);
  // Fallback answers show as one line.
  run(`INSERT INTO usage_events (user_id, purpose, model, cost, fallback) VALUES (?, 'chat', 'fake/one', 0.01, 1)`, alice.id);
  const p = await page('alice', '/admin/usage');
  assert.match(p.html, /Answered by a fallback 1×/);
  assert.match(p.html, /Reading scans/);
  assert.match(p.html, /Pictures/);
});

test('the balance card words: amount, days at this pace, under a week warns, the gap note', async () => {
  const key = (await import('../src/services/spend-watch.js'));
  // A read with a key limit: $3 left; spending $1 a day over two weeks → 3 days → warn.
  settings.set('llm', { model: 'fake/main' });
  run(`INSERT INTO usage_events (user_id, purpose, model, cost) VALUES (?, 'chat', 'fake/main', 14)`, alice.id);
  settings.set('openrouter-balance', { at: new Date().toISOString(), credits: null, key: { limit: 10, remaining: 3, usage: 7, daily: 1, weekly: 30, monthly: 7 } });
  assert.equal(key.balanceView().balance, 3);
  const r = await call('alice', 'GET', '/admin/usage/balance');
  assert.equal(r.body.balance.amount, '$3.00');
  assert.match(r.body.html, /Under a week left/);
  assert.match(r.body.html, /About \d+ days? at this pace/);
  assert.match(r.body.gapHtml, /OpenRouter counts/);
});

// ---- #203 Admin → System / Overview / People -------------------------------------------------------------------------------
test('the wish log on Admin → System: most asked first, counts, Arabic kept; removing one', async () => {
  recordWish(bob.id, 'Book me a taxi to the airport');
  recordWish(bob.id, 'Book me a taxi to the airport, please');
  const ar = recordWish(alice.id, 'اطلب لي بيتزا من المطعم');
  assert.deepEqual({ ...wishSummary() }, { wishes: 2, asks: 3, people: 2 });
  const { html } = await page('alice', '/admin/system');
  assert.match(html, /Asked for, can’t do yet/);
  assert.match(html, /2 wishes · asked 3 times/);
  assert.ok(html.indexOf('Book me a taxi') < html.indexOf('اطلب لي'), 'most asked first');
  assert.match(html, /data-wish="\d+" data-count="2"/);
  assert.match(html, /dir="auto">اطلب لي بيتزا من المطعم/);
  assert.equal((await call('alice', 'DELETE', `/api/v1/admin/wishes/${ar.id}`)).status, 200);
  assert.equal((await call('alice', 'DELETE', `/api/v1/admin/wishes/${ar.id}`)).status, 404, 'a second delete says it is gone');
  const empty = await page('alice', '/admin/system');
  assert.ok(!/اطلب لي/.test(empty.html));
});

test('security events: grouped by where they came from, for whom and when; old rows and excerpts never shown', async () => {
  const runId = null;
  for (let i = 0; i < 3; i++) audit('injection_suspected', { actorId: bob.id, targetType: 'run', targetId: runId, detail: { source: 'email_read', from: 'Deals@Shop.example', sha256: 'abc', via: 'pattern', hidden: i ? 0 : 2 } });
  audit('injection_suspected', { actorId: alice.id, detail: { source: 'web_read', from: 'recipes.example', sha256: 'def', via: 'jev', hidden: 0 } });
  audit('secret_blocked', { actorId: alice.id, detail: { tool: 'email_send', secret: 'OpenAI API key' } });
  audit('injection_suspected', { actorId: alice.id, detail: { source: 'web_read', from: 'old.example' } });
  run(`UPDATE audit_log SET at = datetime('now', '-45 days') WHERE id = (SELECT MAX(id) FROM audit_log)`);
  const e = securityEvents();
  assert.equal(e.total, 5);
  assert.equal(e.injections.total, 4);
  const mail = e.injections.groups.find(g => g.tool === 'email_read');
  assert.deepEqual([mail.count, mail.from, mail.people, mail.hidden], [3, 'Deals@Shop.example', ['Bob Member'], 1]);
  assert.ok(mail.toolLabel && mail.toolLabel !== 'email_read', 'the tool by its display name');
  assert.ok(!e.injections.groups.some(g => g.from === 'old.example'), 'older than 30 days is left out');
  assert.deepEqual(e.secrets.groups.map(g => [g.kinds, g.count, g.people[0]]), [['OpenAI API key', 1, 'Alice Owner']]);
  assert.ok(!JSON.stringify(e).includes('sha256') && !JSON.stringify(e).includes('abc'), 'no hashes or excerpts');
  assert.equal(securityEvents({ limit: 1 }).injections.more, 1);

  const { html } = await page('alice', '/admin');
  assert.match(html, /Stopped in the last 30 days/);
  assert.match(html, /From <span class="font-medium" dir="auto">Deals@Shop.example<\/span>/);
  assert.match(html, /OpenAI API key<\/span> stopped on the way out/);
  assert.match(html, /Hidden instructions<\/span>/, 'the audit row reads in words');
  assert.match(html, /Password key/, 'the standing security checks');
  assert.ok(!/abc|def/.test(html.replace(/[\s\S]*data-security/, '').slice(0, 20000).match(/sha|abc\b/g)?.join('') || ''));
});

test('People and Groups: the per-task budget field (inherit, a value, 0 = no cap) and the Pictures row', async () => {
  const p = await page('alice', `/admin/people/${bob.id}`);
  assert.match(p.html, /name="taskBudget"/);
  assert.match(p.html, /placeholder="Inherit \(\$0\.50\)"/);
  assert.match(p.html, /Pictures/, 'the images toolset has its row');
  const save = body => call('alice', 'POST', `/admin/policy/user/${bob.id}`, body);
  assert.equal((await save({ approver: '', weeklyBudget: '', taskBudget: '0.25' })).status, 200);
  assert.equal(getPolicy('user', bob.id).task_budget_usd, 0.25);
  assert.match((await page('alice', `/admin/people/${bob.id}`)).html, /name="taskBudget"[^>]*value="0.25"/);
  await save({ taskBudget: '0' });
  assert.equal(getPolicy('user', bob.id).task_budget_usd, 0, '0 = no cap for a single task');
  await save({ taskBudget: '' });
  assert.equal(getPolicy('user', bob.id).task_budget_usd, null, 'empty = inherit');
  await save({ taskBudget: '0.4' });
  await save({ approver: 'admin' });
  assert.equal(getPolicy('user', bob.id).task_budget_usd, 0.4, 'a form without the field keeps it');
  const g = await page('alice', '/admin/groups');
  assert.match(g.html, /name="taskBudget"/);
  assert.match(g.html, /Inherit \(\$0\.50\)/);
  const t = await page('alice', '/admin/tools');
  assert.match(t.html, /Default \(up to \$0\.50\)/);
});

// ---- #203 Admin → Personality → Lessons -----------------------------------------------------------------------------------
test('Lessons: a tab under Personality with the waiting count; cards with evidence; actions answer with the re-rendered card', async () => {
  const thread = mainThread(bob.id);
  const trig = addMessage({ threadId: thread.id, role: 'user', content: 'Find a hotel' });
  const r = runs.createRun({ threadId: thread.id, userId: bob.id, triggerMessageId: trig.id, model: null });
  const { lesson: prop } = addLesson({ scope: 'household', user: bob, rule: 'When a booking site hides tax, add it before comparing prices.', source: 'pushed', runId: r.id, status: 'proposed' });
  const { lesson: act } = addLesson({ scope: 'household', rule: 'Confirm the restaurant time zone before booking a table.', source: 'owner', status: 'active' });

  const soul = await page('alice', '/admin/personality/soul');
  assert.match(soul.html, /href="\/admin\/personality\/lessons"[^>]*>Lessons <span class="count count-warn/);
  const p = await page('alice', '/admin/personality/lessons');
  assert.equal(p.status, 200);
  assert.match(p.html, /Household lessons/);
  assert.match(p.html, new RegExp(`data-lesson="${prop.id}" data-status="proposed"`));
  assert.match(p.html, /Bob Member’s task/);
  assert.ok(!/href="\/chat\/\d+"[^>]*>Open that chat/.test(p.html.slice(p.html.indexOf(`data-lesson="${prop.id}"`), p.html.indexOf(`data-lesson="${act.id}"`))),
    'a member’s chat is not linked for the admin');
  assert.match(p.html, /Came up 1 time in 1 task this month/);
  assert.match(p.html, /data-lesson-action="approve"/);
  assert.equal((await page('alice', '/admin/personality/nope')).status, 404);

  const ok = await call('alice', 'POST', `/admin/lessons/${prop.id}/approve?fragment=1`, { rule: 'When a booking site hides tax, add it before comparing.' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.lesson.status, 'active');
  assert.equal(ok.body.lesson.fromName, 'Bob Member', 'who taught it survives the action');
  assert.equal(ok.body.waiting, 0);
  assert.match(ok.body.html, /data-status="active"/);
  assert.match(ok.body.html, /add it before comparing\./);
  const retired = await call('alice', 'POST', `/admin/lessons/${act.id}/retire?fragment=1`);
  assert.match(retired.body.html, /Use again/);
  const promote = await call('alice', 'POST', `/admin/lessons/${prop.id}/promote?fragment=1`);
  assert.equal(promote.status, 422, 'promote needs the evidence');
  const personal = await call('alice', 'POST', '/admin/lessons?fragment=1', { rule: 'Email bob@p25c.dev before booking.' });
  assert.equal(personal.status, 422);
  assert.ok(personal.body.errors.rule);
  const made = await call('alice', 'POST', '/admin/lessons?fragment=1', { rule: 'Ask which child before filling in a school form.', domain: '' });
  assert.equal(made.body.lesson.status, 'active');
  assert.match(made.body.html, /Added by an admin/);
  assert.equal((await call('bob', 'POST', `/admin/lessons/${prop.id}/retire`)).status, 403);
});

// ---- #204 You → Memory --------------------------------------------------------------------------------------------------------
test('You → Memory: "How I work with you" (proposed first with Keep / No, retired folded) and its fragment', async () => {
  const { lesson: kept } = addLesson({ scope: 'person', user: carol, rule: 'Give temperatures in Celsius.', source: 'said' });
  const { lesson: guess } = addLesson({ scope: 'person', user: carol, rule: 'Keep replies to three lines on weekdays.', why: 'You said long replies were too much.', source: 'thumbs_down', status: 'proposed' });
  const { lesson: old } = addLesson({ scope: 'person', user: carol, rule: 'Sign school emails with both names.', source: 'said' });
  run(`UPDATE lessons SET status = 'retired' WHERE id = ?`, old.id);
  const view = personLessonsView(getUser(carol.id));
  assert.deepEqual(view.map(l => [l.id, l.status]), [[guess.id, 'proposed'], [kept.id, 'active'], [old.id, 'retired']]);
  assert.deepEqual(view.map(l => l.sourceLabel), ['From a thumbs-down', 'You told me', 'You told me']);
  const { html } = await page('carol', '/me/memory');
  assert.match(html, /How I work with you/);
  assert.match(html, new RegExp(`data-my-lesson="${guess.id}" data-status="proposed"`));
  assert.match(html, /I noted this after you pointed something out\. Keep it\?/);
  assert.match(html, /Retired <span class="tabular text-ink-3">1<\/span>/);
  const f = await call('carol', 'GET', '/api/v1/me/lessons?fragment=1');
  assert.equal(f.body.lessons.length, 3);
  assert.match(f.body.html, /data-lessons-body/);
  const plain = await call('carol', 'GET', '/api/v1/me/lessons');
  assert.equal(plain.body.html, undefined, 'additive: no html without ?fragment=1');
  const none = await call('bob', 'GET', '/api/v1/me/lessons?fragment=1');
  assert.ok(!none.body.html.includes('Give temperatures'), 'each person sees only their own');
});

test('You → Memory: the weekly tidy card (?tidy=<id> opens it), Undo re-renders it; a gone tidy says so; the latest one folded', async () => {
  const me = getUser(carol.id);
  const memory = await import('../src/services/memory.js');
  const scope = memory.userScope(me).id;
  const mk = text => Number(run(`INSERT INTO memories (scope_id, text, kind, status) VALUES (?, ?, 'fact', 'active')`, scope, text).lastInsertRowid);
  const a = mk('The car MOT is due in March.'), b = mk('MOT for the Clio: March.'), merged = mk('The Clio’s MOT is due in March.');
  run(`UPDATE memories SET status = 'superseded' WHERE id IN (?, ?)`, a, b);
  const tidy = Number(run(`INSERT INTO memory_tidies (user_id, status, merged, archived) VALUES (?, 'done', 1, 0)`, me.id).lastInsertRowid);
  const change = Number(run(`INSERT INTO memory_tidy_changes (tidy_id, op, memory_ids, new_memory_id, why) VALUES (?, 'merge', ?, ?, 'The same thing twice.')`,
    tidy, JSON.stringify([a, b]), merged).lastInsertRowid);

  const opened = await page('carol', `/me/memory?tidy=${tidy}`);
  assert.match(opened.html, new RegExp(`id="tidy-${tidy}" data-tidy="${tidy}" open`));
  assert.match(opened.html, /Merged 2 into one/);
  assert.match(opened.html, /The Clio’s MOT is due in March\./);
  const folded = await page('carol', '/me/memory');
  assert.match(folded.html, new RegExp(`data-tidy="${tidy}" >`), 'without ?tidy the latest recent one shows folded');
  const gone = await page('carol', '/me/memory?tidy=99999');
  assert.match(gone.html, /That tidy isn’t here any more/);
  assert.ok(!(await page('bob', `/me/memory?tidy=${tidy}`)).html.includes('The Clio’s MOT'), 'someone else’s tidy never shows');

  assert.equal((await call('carol', 'POST', `/api/v1/me/memory-tidies/changes/${change}/undo`)).status, 200);
  const f = await call('carol', 'GET', `/api/v1/me/memory-tidies/${tidy}?fragment=1`);
  assert.match(f.body.html, /data-undone="true"/);
  assert.ok(!/data-tidy-undo/.test(f.body.html), 'no Undo on an undone change');
  assert.equal(memory.listTidies(me, { id: tidy })[0].changes[0].undone, true);
  assert.equal((await call('bob', 'GET', `/api/v1/me/memory-tidies/${tidy}?fragment=1`)).status, 404);
});

// ---- #204 Feed -------------------------------------------------------------------------------------------------------------
test('Sources page: OPML card and muted words (Arabic, the limit, fragments); OPML summary fragment groups what was skipped', async () => {
  const p = await page('alice', '/feed/sources');
  assert.match(p.html, /Bring your feeds/);
  assert.match(p.html, /href="\/api\/v1\/feed\/opml"[^>]*download/);
  assert.match(p.html, /Muted words/);
  assert.match(p.html, /0 of 100/);
  const add = await call('alice', 'POST', '/api/v1/feed/mutes?fragment=1', { kind: 'word', value: 'كرة القدم' });
  assert.equal(add.status, 201);
  assert.match(add.body.html, /data-mute="كرة القدم" data-kind="word"/);
  assert.match(add.body.html, /1 of 100/);
  const bad = await call('alice', 'POST', '/api/v1/feed/mutes?fragment=1', { kind: 'word', value: 'one two three four five six' });
  assert.equal(bad.status, 422);
  const del = await call('alice', 'DELETE', '/api/v1/feed/mutes?fragment=1', { kind: 'word', value: 'كرة القدم' });
  assert.match(del.body.html, /No muted words yet/);
  const plain = await call('alice', 'GET', '/api/v1/feed/mutes');
  assert.equal(plain.body.html, undefined);

  const opml = `<?xml version="1.0"?><opml version="2.0"><head><title>Mine</title></head><body><outline text="Tech">
    <outline text="Ars" xmlUrl="https://arstechnica.example/feed/"/><outline text="Ars again" xmlUrl="https://arstechnica.example/feed/"/>
    <outline text="Broken" xmlUrl="notaurl"/></outline></body></opml>`;
  const r = await call('alice', 'POST', '/api/v1/feed/opml?fragment=1', { opml });
  run(`UPDATE feed_sources SET next_fetch_at = '2099-01-01T00:00:00.000Z'`); // never due: the scheduler must not fetch them (no browser here)
  assert.equal(r.status, 201);
  assert.equal(r.body.added.length, 1);
  assert.match(r.body.html, /Added 1 feed, skipped 2/);
  assert.match(r.body.html, /Tech <span class="tabular text-ink-3">\+1<\/span><span class="badge badge-accent ms-1">New topic/);
  assert.match(r.body.html, /Skipped 1: Listed twice in the file/);
  assert.match(r.body.html, /Skipped 1: Not a web address/);
  assert.ok(!/<a /.test(r.body.html), 'addresses from the file are text, never links');
  const s = await call('alice', 'GET', '/api/v1/feed/sources?fragment=1');
  assert.match(s.body.html, /data-topic=/);
  assert.equal(s.body.counts.sources, 1);
  assert.equal((await call('alice', 'POST', '/api/v1/feed/opml', { opml })).body.html, undefined, 'additive');
});

test('Feed: a story link whose story is gone explains itself; no diet card until there is enough to say', async () => {
  const gone = await page('alice', '/feed?story=i999999');
  assert.match(gone.html, /That story isn’t here any more/);
  assert.match(gone.html, /Back to your feed/);
  const home = await page('alice', '/feed');
  assert.ok(!/data-diet /.test(home.html), 'no diet card on a quiet month');
});

// ---- #205 Reminder cards -------------------------------------------------------------------------------------------------------
test('migration 051: reminder posts can carry the consent request they ask', () => {
  assert.ok(all('PRAGMA table_info(reminder_posts)').some(c => c.name === 'consent_id'));
  assert.equal(all('PRAGMA foreign_key_check').length, 0);
});

test('reminder cards: the newest post of a follow-up offers Done ("Nudge 1 of 3 · next at …"), older posts fold; Done closes it', async () => {
  const u = getUser(bob.id);
  const T = new Date('2030-03-04T12:00:00Z');
  const a = alarms.createAlarm({ user: u, kind: 'reminder', label: 'Take your pills', inMinutes: 1, followUp: {}, threadId: mainThread(u.id).id, now: new Date(T.getTime() - 60000) });
  await R.fireReminder(u, alarms.getAlarm(a.id), T);
  const first = get(`SELECT * FROM reminder_posts WHERE alarm_id = ? ORDER BY id`, a.id);
  let card = alarms.reminderCard(runs.getRun(first.run_id));
  assert.equal(card.kind, 'reminder');
  assert.equal(card.latest, true);
  assert.match(card.alarm.followUp.line, /^Waiting for your Done · first nudge at \d{1,2}:\d{2} [AP]M$/);
  assert.ok(get(`SELECT 1 FROM events WHERE user_id = ? AND type = 'run.refresh' AND run_id = ?`, u.id, first.run_id), 'the note is redrawn with its card');

  await R.fireReminder(u, alarms.getAlarm(a.id), new Date(T.getTime() + 15 * 60000));
  const posts = all(`SELECT * FROM reminder_posts WHERE alarm_id = ? ORDER BY id`, a.id);
  assert.equal(posts.length, 2);
  const older = alarms.reminderCard(runs.getRun(posts[0].run_id));
  const newest = alarms.reminderCard(runs.getRun(posts[1].run_id));
  assert.deepEqual([older.latest, newest.latest, newest.level], [false, true, 1]);
  assert.match(newest.alarm.followUp.line, /^Nudge 1 of 3 · next at /);
  const view = assistantView(runs.getRun(posts[1].run_id));
  assert.equal(view.reminder.kind, 'reminder');

  const chat = await page('bob', '/chat');
  assert.match(chat.html, new RegExp(`data-reminder-card data-alarm-id="${a.id}" data-post="${posts[1].message_id}" data-latest="true"`));
  assert.match(chat.html, /data-latest="false"/);

  const done = await call('bob', 'POST', `/api/v1/alarms/${a.id}/done`);
  assert.equal(done.status, 200);
  assert.equal(done.body.alarm.followUp.closed.how, 'card');
  assert.equal(done.body.alarm.followUp.closed.done, true);
  assert.equal(done.body.alarm.followUp.line, null);
  const after = await page('bob', '/chat');
  assert.match(after.html, /data-state="closed" data-done="true"/);
  // Someone else's reminder note never gets a card for them.
  assert.equal(alarms.reminderCard({ ...runs.getRun(posts[1].run_id), user_id: carol.id }), null);
  // A plain reminder (no follow-ups) and an ordinary reply carry no card.
  const plain = alarms.createAlarm({ user: u, kind: 'reminder', label: 'Water plants', inMinutes: 1, now: new Date(T.getTime() - 60000) });
  await R.fireReminder(u, alarms.getAlarm(plain.id), T);
  const pp = get(`SELECT * FROM reminder_posts WHERE alarm_id = ?`, plain.id);
  assert.equal(alarms.reminderCard(runs.getRun(pp.run_id)), null);
});

test('a reminder that ran out unconfirmed says so and can still be marked done (one-offs)', () => {
  const u = getUser(bob.id);
  const a = alarms.createAlarm({ user: u, kind: 'reminder', label: 'Call the school', inMinutes: 5, followUp: { max: 1 } });
  let x = alarms.startFollowUp(alarms.getAlarm(a.id), { now: new Date() });
  x = alarms.closeReminder(x, 'unconfirmed');
  const v = alarms.alarmView(x).followUp;
  assert.deepEqual([v.awaiting, v.closed.how, v.closed.done, v.closed.canMarkDone, v.closed.label], [false, 'unconfirmed', false, true, 'Not confirmed']);
  const d = alarms.alarmView(alarms.closeReminder(alarms.getAlarm(a.id), 'card')).followUp;
  assert.deepEqual([d.closed.how, d.closed.done, d.closed.canMarkDone], ['card', true, false]);
});

test('consent card: the request note carries its consent; Yes / No over the API repaints every open chat (reminder.consent)', async () => {
  const consent = await R.requestConsent(getUser(alice.id), getUser(bob.id));
  const post = get(`SELECT * FROM reminder_posts WHERE kind = 'consent_request' AND consent_id = ?`, consent.id);
  assert.ok(post, 'the post holds the consent id');
  const card = alarms.reminderCard(runs.getRun(post.run_id));
  assert.deepEqual(card, { kind: 'consent', consent: { id: consent.id, status: 'pending', answeredAt: null, fromName: 'Alice' } });
  const chat = await page('bob', '/chat');
  assert.match(chat.html, new RegExp(`data-consent-card data-consent-id="${consent.id}" data-status="pending"`));
  assert.match(chat.html, /May I tell you here when Alice doesn’t confirm a reminder\?/);
  assert.equal((await call('alice', 'POST', `/api/v1/alarms/consents/${consent.id}`, { allow: true })).status, 403, 'only the person asked answers');
  const yes = await call('bob', 'POST', `/api/v1/alarms/consents/${consent.id}`, { allow: true });
  assert.equal(yes.body.consent.status, 'granted');
  const ev = get(`SELECT data FROM events WHERE user_id = ? AND type = 'reminder.consent' ORDER BY id DESC LIMIT 1`, bob.id);
  assert.equal(JSON.parse(ev.data).consent.status, 'granted');
  assert.match((await page('bob', '/chat')).html, /data-status="granted"/);
  // A card is only for the person the request asks.
  assert.equal(alarms.reminderCard({ ...runs.getRun(post.run_id), user_id: alice.id }), null);
});
