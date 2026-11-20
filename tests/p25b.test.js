// Phase 25 part B (decisions #194–#196): the server side of the screens. The approval card's facts and injection level, the
// skills review (the recommended set, categories, grouped findings, the tracked trigger test), and the rest of part B as it
// lands. The interactions are covered by scripts/ui-flows.js against the styleguide's simulated API.
// Run: npm test  (node --test, throwaway data dir, no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-p25b-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';

const { openDb, closeDb, run, get, settings } = await import('../src/db/index.js');
const { ensureDirs, paths } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser, getUser } = await import('../src/services/users.js');
const { createApp } = await import('../src/app.js'); // registers the tools and configures the fragment renderer
const { createSession } = await import('../src/services/sessions.js');
const { getTool } = await import('../src/agent/tools/registry.js');
const approvals = await import('../src/services/approvals.js');
const { markRunTaint } = await import('../src/agent/taint.js');
const threads = await import('../src/services/threads.js');
const runs = await import('../src/services/runs.js');
const { addMessage } = await import('../src/services/messages.js');
const library = await import('../src/services/library.js');
const skills = await import('../src/services/skills.js');
const trigger = await import('../src/services/skill-trigger.js');
const { renderFragment } = await import('../src/views/render.js');

let alice, bob, base, server;
const tokens = {};
before(async () => {
  alice = await createUser({ name: 'Alice Owner', email: 'alice@p25b.dev', password: 'correct horse battery', role: 'admin', timezone: 'Europe/Paris' });
  bob = await createUser({ name: 'Bob Member', email: 'bob@p25b.dev', password: 'correct horse battery', timezone: 'Europe/Paris' });
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  for (const [k, u] of Object.entries({ alice, bob })) tokens[k] = createSession(u.id, { kind: 'app', device: 'test' });
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const call = async (who, method, url, body) => {
  const res = await fetch(base + url, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'jessbot' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
};
const page = async (who, url) => {
  const res = await fetch(base + url, { headers: { Authorization: `Bearer ${tokens[who]}`, Accept: 'text/html' } });
  return { status: res.status, html: await res.text() };
};
function newRun(user, text = 'Please help me with this.') {
  const t = threads.createSideThread(user.id, 'Test chat');
  const m = addMessage({ threadId: t.id, role: 'user', content: text });
  return runs.createRun({ threadId: t.id, userId: user.id, triggerMessageId: m.id, model: 'fake/model' });
}
const textItem = (user, title) => library.createFileItem({ user, title, type: 'md', ext: 'md', mime: 'text/markdown', buffer: Buffer.from(`# ${title}\n\nHello.`),
  text: `# ${title}\n\nHello.`, description: null, threadId: null, runId: null, sourceLabel: 'Made by Jess' });

// ---- 1. The approval card (#194) --------------------------------------------------------------------------------------
test('approval facts: an email lays out who, the subject and each file, naming only the requester’s own files', () => {
  const mine = textItem(alice, 'Big Sur itinerary');
  const theirs = textItem(bob, 'Bob’s tax return');
  const r = newRun(alice, 'Send Maya the plan');
  const a = approvals.createApproval({ run: r, user: alice, tool: getTool('email_send'), toolCallId: 'c1',
    args: { to: 'maya@example.com', subject: 'Our weekend', body: 'Hi Maya, the plan is attached.', attachments: [mine.public_id, theirs.public_id, 'nope'] } });
  const v = approvals.approvalView(a, alice);
  assert.deepEqual(v.facts.map(f => f.key), ['to', 'subject', 'files']);
  const files = v.facts.find(f => f.key === 'files').items;
  assert.equal(files[0].title, 'Big Sur itinerary');
  assert.equal(files[0].href, `/library/${mine.public_id}`);
  assert.equal(files[1].title, 'A file that isn’t yours', 'someone else’s file is never named on the card');
  assert.equal(files[1].href, null);
  assert.match(files[2].meta, /won’t be sent/);
  assert.equal(v.reachShown, false, 'the To fact already says who it reaches');
  assert.equal(v.provenanceLevel, null, 'a clean task has no provenance');
  assert.equal(v.previewLong, false);
});

test('approval facts: cleaned, masked and capped; a tool whose facts throw still asks, with none', () => {
  const card = '4111 1111 1111 1111';
  const tool = { name: 'demo_send', toolset: 'web', risk: 'external', approvalFacts: () => [
    { key: 'to', label: 'To', value: `  someone\n@example.com  card ${card}` }, { label: '', value: 'no label' }, { key: 'x', label: 'Empty' },
    { key: 'files', label: 'Attached', items: [{ title: 'a', href: 'javascript:alert(1)' }, { title: 'b', href: '/library/lib-9' }, { title: '' }] },
    ...Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, value: 'v' })),
  ] };
  const facts = approvals.factsOf(tool, {});
  assert.equal(facts.length, 6, 'empty facts are dropped, then at most six are kept');
  assert.ok(!facts[0].value.includes(card), 'a card number is masked like the preview');
  assert.doesNotMatch(facts[0].value, /\n/);
  assert.deepEqual(facts[1].items.map(i => i.href), [null, '/library/lib-9'], 'only Library links survive');
  assert.deepEqual(approvals.factsOf({ approvalFacts: () => { throw new Error('boom'); } }, {}), []);
  assert.deepEqual(approvals.factsOf({}, {}), []);
});

test('approval: the injection level is stored when it asks, a long preview folds, and old rows still read', () => {
  const r = newRun(alice);
  markRunTaint(r.id, 'low', { tool: 'web_read', label: 'page on example.com' });
  markRunTaint(r.id, 'high', { tool: 'web_read', label: 'page on evil.example' });
  const body = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of the letter.`).join('\n');
  const a = approvals.createApproval({ run: r, user: alice, tool: getTool('email_send'), toolCallId: 'c2', args: { to: 'x@example.com', subject: 'Letter', body } });
  assert.equal(a.provenance_level, 'high');
  const v = approvals.approvalView(a, alice);
  assert.equal(v.provenanceLevel, 'high');
  assert.equal(v.previewLong, true, 'over ten lines folds');
  assert.equal(v.previewFoldsCompact, true);
  run('UPDATE approvals SET provenance_level = NULL, facts = NULL WHERE id = ?', a.id); // a row from before migration 048
  const old = approvals.approvalView(approvals.getApproval(a.id), alice);
  assert.equal(old.provenanceLevel, 'low');
  assert.deepEqual(old.facts, []);
});

test('approval card: renders every state with its stamp, the fold and the facts', async () => {
  const r = newRun(alice);
  const a = approvals.createApproval({ run: r, user: alice, tool: getTool('make_image') || { name: 'make_image', toolset: 'images', risk: 'write' }, toolCallId: 'c3',
    args: { prompt: 'A fox reading under a lamp', depicts: 'no_real_people', size: 'portrait', style: 'storybook' } });
  const v = approvals.approvalView(a, alice);
  const html = await renderFragment('approval-card', v, alice);
  assert.match(html, /data-status="pending"/);
  assert.match(html, /data-stamp="approved"/);
  assert.doesNotMatch(html, /—/, 'no em-dashes in the card');
  if (getTool('make_image')) assert.match(html, /Portrait \(2:3\) · storybook/);
  const closed = await renderFragment('approval-card', { ...v, status: 'expired', resultLabel: 'Expired: you moved on, so it was not done', compact: true }, alice);
  assert.match(closed, /Expired: you moved on/);
  assert.match(closed, /class="approval-actions"\s+hidden/);
});

// ---- 2. Admin → Skills (#195) -----------------------------------------------------------------------------------------
test('skills: every recommended name is a built-in skill, and every built-in skill has exactly one category', () => {
  const names = fs.readdirSync(paths.skills).filter(n => fs.existsSync(path.join(paths.skills, n, 'SKILL.md')));
  for (const n of skills.RECOMMENDED) assert.ok(names.includes(n), `recommended skill “${n}” doesn’t exist`);
  assert.equal(new Set(skills.RECOMMENDED).size, skills.RECOMMENDED.length);
  const listed = skills.CATEGORIES.flatMap(c => c.names);
  assert.equal(new Set(listed).size, listed.length, 'a skill is in two categories');
  for (const n of names) assert.notEqual(skills.categoryOf(n), 'other', `“${n}” has no category`);
  for (const n of listed) assert.ok(names.includes(n), `category lists “${n}”, which doesn’t exist`);
  assert.equal(skills.categoryOf('made-up-skill'), 'other');
});

test('skills review: an undeclared toolset counts as an optional tool, not a warning', () => {
  const f = [{ level: 'warn', code: 'undeclared-toolset' }, { level: 'warn', code: 'description-long' }, { level: 'bad', code: 'hidden-text' }, { level: 'info', code: 'code-block' }];
  assert.deepEqual(skills.reviewSummary(f), { bad: 1, warn: 1, optional: 1, info: 1 });
  assert.equal(skills.findingGroup(f[0]), 'optional');
});

test('skills pages: the list offers the filters and the recommended set; a skill’s review page renders its sections', async () => {
  const list = await page('alice', '/admin/skills');
  assert.equal(list.status, 200);
  assert.match(list.html, /data-skill-filters/);
  assert.match(list.html, /Recommended to switch on/);
  assert.match(list.html, new RegExp(`Approve these ${skills.RECOMMENDED.length}`), 'on a fresh install every recommended skill waits');
  assert.match(list.html, /data-category="travel"/);
  const rev = await page('alice', '/admin/skills/trip-planner');
  assert.equal(rev.status, 200);
  assert.match(rev.html, /open it at the right moment/);
  assert.match(rev.html, /What changed since you approved it/);
  assert.match(rev.html, /Recommended/);
  assert.doesNotMatch(rev.html.replace(/<pre class="skr-raw"[\s\S]*?<\/pre>/, ''), /—/, 'no em-dashes in the page copy');
  assert.equal((await page('bob', '/admin/skills/trip-planner')).status, 403, 'members never see it');
  assert.equal((await page('alice', '/admin/skills/no-such-skill')).status, 404);
});

test('trigger test: one tracked test per skill; a second waits (409); the result and a failure are kept', async () => {
  trigger.resetTriggerTests();
  let release;
  const first = trigger.trackTriggerTest('trip-planner', { calls: 6 }, () => new Promise(r => { release = r; }));
  assert.equal(trigger.lastTriggerTest('trip-planner').status, 'running');
  assert.equal(trigger.lastTriggerTest('trip-planner').calls, 6);
  await assert.rejects(trigger.trackTriggerTest('trip-planner', {}, async () => ({})), err => err.status === 409);
  const got = await call('alice', 'GET', '/admin/skills/trip-planner/trigger-test');
  assert.equal(got.body.test.status, 'running', 'a reloaded page sees it running');
  const blocked = await call('alice', 'POST', '/admin/skills/trip-planner/trigger-test', { queries: [{ text: 'plan a trip to Lyon', expect: 'use' }] });
  assert.equal(blocked.status, 409);
  release({ summary: { total: 1, passed: 1 } });
  assert.deepEqual((await first).summary, { total: 1, passed: 1 });
  assert.equal(trigger.lastTriggerTest('trip-planner').status, 'done');
  await assert.rejects(trigger.trackTriggerTest('trip-planner', {}, async () => { throw Object.assign(new Error('The model didn’t answer'), { status: 502 }); }));
  assert.equal(trigger.lastTriggerTest('trip-planner').status, 'error');
  assert.match(trigger.lastTriggerTest('trip-planner').error, /didn’t answer/);
});

// ---- 3. Upcoming (#196) -----------------------------------------------------------------------------------------------
test('upcoming: a retrying task says when it tries again; its runs link to their chat; dates soon come from memories', async () => {
  const schedules = await import('../src/services/schedules.js');
  const memory = await import('../src/services/memory.js');
  const { datesSoon } = await import('../src/services/upcoming.js');
  const s = schedules.createSchedule({ user: alice, title: 'Permit slots', prompt: 'Check the permit office for a slot.', cron: '0 * * * *' });
  const r = newRun(alice);
  run(`UPDATE runs SET status = 'error', retry_at = ? WHERE id = ?`, '2026-09-26T12:05:00.000Z', r.id);
  run('UPDATE schedules SET last_run_id = ? WHERE id = ?', r.id, s.id);
  const v = schedules.jobView(schedules.scheduleForUser(alice, s.id));
  assert.equal(v.lastStatus, 'retrying');
  assert.equal(v.retryLabel, '14:05', 'in the schedule’s own time zone (Paris)');
  assert.equal(v.threadHref, '/chat');
  run(`UPDATE runs SET status = 'done', retry_at = NULL WHERE id = ?`, r.id);
  assert.equal(schedules.jobView(schedules.scheduleForUser(alice, s.id)).retryLabel, null);

  const now = new Date('2026-09-26T09:00:00Z');
  memory.addFact({ user: alice, text: 'Maya’s birthday', date: '2016-09-27', recurs: 'yearly' });
  memory.addFact({ user: alice, text: 'Dentist for Priya', date: '2026-10-01' });
  memory.addFact({ user: alice, text: 'Old dentist visit', date: '2026-09-20' });
  memory.addFact({ user: alice, text: 'Far away trip', date: '2026-12-20' });
  const dates = datesSoon(getUser(alice.id), now);
  assert.deepEqual(dates.map(d => d.text), ['Maya’s birthday', 'Dentist for Priya'], 'past and far dates are left out');
  assert.equal(dates[0].relLabel, 'Tomorrow');
  assert.equal(dates[0].soon, true);
  assert.equal(dates[0].age, 10);
  assert.equal(dates[0].yearly, true);
  assert.equal(dates[1].relLabel, 'Thursday, in 5 days');
  assert.deepEqual([dates[1].day, dates[1].month], ['1', 'Oct']);
});

// ---- 4. Goals (#196) ----------------------------------------------------------------------------------------------------
test('goals: logging a number answers with the measure’s card (a sparkline from two readings); a bad value is refused', async () => {
  const G = await import('../src/services/goals.js');
  const g = G.createGoal({ user: alice, title: 'Run a 10k', category: 'health' });
  const m = G.addMeasure(g, { label: 'Runs', per_week: 3 });
  const first = await call('alice', 'POST', `/api/v1/goals/${g.id}/measures/${m.id}/logs`, { value: 1 });
  assert.equal(first.status, 201);
  assert.match(first.body.html, new RegExp(`data-measure-id="${m.id}"`));
  assert.doesNotMatch(first.body.html, /class="spark"/, 'one reading draws no line');
  assert.match(first.body.html, /1 of 3 this week/);
  const second = await call('alice', 'POST', `/api/v1/goals/${g.id}/measures/${m.id}/logs`, { value: 1, note: 'easy 5k' });
  assert.match(second.body.html, /<svg class="spark"/);
  assert.match(second.body.html, /aria-label="2 readings, from 1 to 1"/);
  assert.doesNotMatch(second.body.html, /—/);
  const bad = await call('alice', 'POST', `/api/v1/goals/${g.id}/measures/${m.id}/logs`, { value: 'lots' });
  assert.equal(bad.status, 422);
  assert.equal((await call('bob', 'POST', `/api/v1/goals/${g.id}/measures/${m.id}/logs`, { value: 2 })).status, 404, 'someone else’s goal');
});

test('sparkline helper: nothing for fewer than two readings; hover titles carry value, unit and day; escaped', async () => {
  const { default: helpers } = await import('../src/views/helpers.js');
  const opts = unit => ({ hash: { unit }, data: { root: { user: { timezone: 'Europe/Paris' } } } });
  assert.equal(helpers.sparkline([{ at: '2026-09-01T10:00:00Z', value: 3 }], opts()), '');
  const svg = String(helpers.sparkline([{ at: '2026-09-01T10:00:00Z', value: 80 }, { at: '2026-09-08T10:00:00Z', value: 78.5 }], opts('kg<')));
  assert.match(svg, /<title>80 kg&lt; · 1 Sept<\/title>/);
  assert.match(svg, /<title>78.5 kg&lt; · 8 Sept<\/title>/);
  assert.match(svg, /class="spark-dot"/);
});

// ---- 5. Library: Listen and reading a scan (#196) ---------------------------------------------------------------------------
test('listen: the estimate first; a recording job reports its parts and the new audio; refused when over budget or too long', async () => {
  const ra = await import('../src/services/read-aloud.js');
  const { recordUsage } = await import('../src/services/usage.js');
  const policy = await import('../src/services/policy.js');
  ra.resetListenJobs();
  const doc = textItem(alice, 'Lyon plan');
  const est = await call('alice', 'POST', `/api/v1/library/${doc.public_id}/listen`, {});
  assert.equal(est.status, 200);
  assert.deepEqual(Object.keys(est.body.estimate).sort(), ['limit', 'minutes', 'minutesLabel', 'overBudget', 'parts', 'tooLong']);
  assert.equal(est.body.estimate.minutesLabel, 'about a minute');
  assert.equal(est.body.estimate.overBudget, false);
  assert.equal((await call('bob', 'POST', `/api/v1/library/${doc.public_id}/listen`, {})).status, 404, 'someone else’s item');

  // A fake recorder: two parts, then the audio item.
  let finish;
  const job = ra.startListen(getUser(alice.id), library.getItem(doc.id), { record: async (user, { item, onProgress }) => {
    onProgress(1, 2);
    await new Promise(r => { finish = r; });
    onProgress(2, 2);
    const saved = library.createFileItem({ user, title: item.title, type: 'audio', ext: 'wav', mime: 'audio/wav', buffer: Buffer.alloc(64), sourceLabel: 'Read aloud by Jess' });
    return { item: saved, view: library.itemView(saved), length: '0:42', partial: false };
  } });
  assert.equal(job.status, 'recording');
  await new Promise(r => setImmediate(r));
  assert.equal(ra.listenJob(alice, doc).part, 1);
  assert.throws(() => ra.startListen(getUser(alice.id), library.getItem(doc.id)), err => err.status === 409);
  const reloaded = await call('alice', 'GET', `/api/v1/library/${doc.public_id}/listen`);
  assert.equal(reloaded.body.job.status, 'recording', 'a reloaded page sees it recording');
  finish();
  await new Promise(r => setTimeout(r, 20));
  const done = ra.listenJob(alice, doc);
  assert.equal(done.status, 'done');
  assert.equal(done.audio.length, '0:42');
  assert.match(done.audio.href, /^\/library\//);

  const pic = library.createFileItem({ user: alice, title: 'Photo', type: 'image', ext: 'png', mime: 'image/png', buffer: Buffer.alloc(10) });
  assert.equal((await call('alice', 'POST', `/api/v1/library/${pic.public_id}/listen`, {})).status, 400, 'a picture has nothing to read');

  policy.setPolicy('user', alice.id, { weeklyBudget: 1 }, alice.id);
  recordUsage({ userId: alice.id, purpose: 'chat', model: 'fake/model', usage: { cost: 5 } });
  const other = textItem(alice, 'Another doc');
  assert.equal((await call('alice', 'POST', `/api/v1/library/${other.public_id}/listen`, {})).body.estimate.overBudget, true);
  const refused = await call('alice', 'POST', `/api/v1/library/${other.public_id}/listen`, { confirm: true });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /budget is used up/);
  assert.equal(ra.listenJob(alice, other), null, 'nothing started');
  run('DELETE FROM usage_events WHERE user_id = ?', alice.id);
  policy.setPolicy('user', alice.id, { weeklyBudget: 10 }, alice.id);
});

test('read this scan: offered for a PDF without text and quietly for a picture; a reading in progress is remembered', async () => {
  const ocr = await import('../src/services/ocr.js');
  const pdf = library.createFileItem({ user: alice, title: 'Scanned lease', type: 'pdf', ext: 'pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-1.4'), text: '--- page 1 ---\n\n--- page 2 ---' });
  assert.equal(ocr.ocrOffer(pdf), 'scan');
  const withText = library.createFileItem({ user: alice, title: 'Letter', type: 'pdf', ext: 'pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-1.4'), text: '--- page 1 ---\nDear Theo, thank you.' });
  assert.equal(ocr.ocrOffer(withText), null);
  const pic = library.createFileItem({ user: alice, title: 'Receipt', type: 'image', ext: 'png', mime: 'image/png', buffer: Buffer.alloc(10) });
  assert.equal(ocr.ocrOffer(pic), 'picture');
  assert.equal(ocr.ocrOffer(textItem(alice, 'Notes')), null);
  assert.equal(ocr.ocrReading(alice, pdf), null);
  const got = await call('alice', 'GET', `/api/v1/library/${pdf.public_id}/ocr`);
  assert.deepEqual(got.body, { reading: null });
  const view = await page('alice', `/library/${pdf.public_id}`);
  assert.match(view.html, /This PDF is a scan/);
  assert.match(view.html, /data-library-ocr-box data-state="offer"/);
});

// ---- 6. Admin → Browser (#195) --------------------------------------------------------------------------------------------
test('admin browser: learned recipes are listed and forgotten; blocking comes back on for a site; a wrong LibreOffice path is refused', async () => {
  const { learnRecipe } = await import('../src/browser/recipes.js');
  const { switchOffFor, adblockOffFor } = await import('../src/browser/adblock.js');
  const r = learnRecipe('https://www.leboncoin.fr/recherche?text=velo+enfant&locations=Lyon', ['velo enfant', 'Lyon']);
  assert.ok(r, 'a search address becomes a recipe');
  switchOffFor('www.lemonde.fr');
  const page1 = await page('alice', '/admin/browser');
  assert.equal(page1.status, 200);
  assert.match(page1.html, /Learned search pages/);
  assert.match(page1.html, /leboncoin\.fr/);
  assert.match(page1.html, /data-off-host="lemonde\.fr"/);
  assert.doesNotMatch(page1.html, /velo enfant/, 'what was searched is never kept or shown');
  const del = await call('alice', 'DELETE', `/admin/browser/recipes/${r.id}`);
  assert.equal(del.status, 200);
  assert.doesNotMatch(del.body.html, /leboncoin/);
  assert.equal((await call('alice', 'DELETE', `/admin/browser/recipes/${r.id}`)).status, 404);
  assert.equal(adblockOffFor('lemonde.fr'), true);
  const on = await call('alice', 'DELETE', '/admin/browser/adblock-off/lemonde.fr');
  assert.equal(on.status, 200);
  assert.equal(adblockOffFor('lemonde.fr'), false);
  const bad = await call('alice', 'POST', '/admin/browser/office', { previews: true, soffice: path.join(HOME, 'no-such-soffice.exe') });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors.soffice);
  const off = await call('alice', 'POST', '/admin/browser/office', { previews: false, soffice: '' });
  assert.equal(off.status, 200);
  assert.equal(off.body.office.previews, false);
  assert.equal(off.body.office.detail, 'Switched off in settings');
  assert.deepEqual(settings.get('office'), { previews: false });
  await call('alice', 'POST', '/admin/browser/office', { previews: true, soffice: '' });
  assert.equal((await call('bob', 'DELETE', '/admin/browser/adblock-off/x.fr')).status, 403, 'members never reach it');
});

// ---- 7. Reply actions: Simpler, follow-up chips, the once-a-day nudge (#196) ---------------------------------------------------
test('follow-ups: only the exact lead-in alone on its line, followed by nothing but bullets, becomes chips', async () => {
  const { splitFollowUps, NUDGE_LEAD } = await import('../src/lib/follow-ups.js');
  const reply = `The deposit is refundable until Thursday.\n\n${NUDGE_LEAD}\n- Do they take cards?\n* Is there parking?\n1. What if we run late?\n`;
  const out = splitFollowUps(reply);
  assert.deepEqual(out.items, ['Do they take cards?', 'Is there parking?', 'What if we run late?']);
  assert.equal(out.body, 'The deposit is refundable until Thursday.');
  const whole = t => assert.deepEqual(splitFollowUps(t).items, [], t);
  whole('A few things worth a closer look:\n- one');                       // other wording
  whole(`**${NUDGE_LEAD}**\n- one`);                                       // decorated
  whole(`${NUDGE_LEAD}\n- one\n\nAnd a paragraph after.`);                 // not the end of the reply
  whole(`Intro. ${NUDGE_LEAD}\n- one`);                                    // not alone on its line
  whole(`${NUDGE_LEAD}\n`);                                               // no bullets
  whole('No list at all.');
  assert.equal(splitFollowUps(`${NUDGE_LEAD}\n${Array.from({ length: 8 }, (_, i) => `- q${i}`).join('\n')}`).items.length, 5, 'at most five');
});

test('nudge: a reply with follow-ups records the time; the main chat keeps one a day, a side chat any number; exposed on /threads', async () => {
  const { settleNudge, nudgeAllowed, lastNudgeAt, NUDGE_GAP_MS } = await import('../src/services/reply-actions.js');
  const { NUDGE_LEAD } = await import('../src/lib/follow-ups.js');
  const main = threads.mainThread(bob.id);
  const side = threads.createSideThread(bob.id, 'Trip');
  const reply = `Booked.\n\n${NUDGE_LEAD}\n- Add it to the calendar?`;
  const t0 = Date.parse('2026-09-26T08:00:00Z');
  assert.equal(nudgeAllowed(main.id, t0), true);
  assert.equal(settleNudge(main.id, reply, t0), reply, 'the first one stays');
  assert.equal(lastNudgeAt(main.id), '2026-09-26T08:00:00.000Z');
  assert.equal(nudgeAllowed(main.id, t0 + 3600e3), false);
  assert.equal(settleNudge(main.id, reply, t0 + 3600e3), 'Booked.', 'a second within a day is taken out');
  assert.equal(lastNudgeAt(main.id), '2026-09-26T08:00:00.000Z', 'and not recorded');
  assert.equal(settleNudge(main.id, reply, t0 + NUDGE_GAP_MS + 1), reply, 'a day later it may');
  assert.equal(settleNudge(side.id, reply, t0 + 60e3), reply);
  assert.equal(settleNudge(side.id, reply, t0 + 120e3), reply, 'side chats have no daily limit');
  assert.equal(settleNudge(main.id, 'Plain reply.', t0), 'Plain reply.');
  // Stored replies go through it (services/messages.js addMessage): a final reply, not a tool-calling step.
  // (A nudge a minute ago, on the real clock, so the stored reply below falls inside the day.)
  assert.equal(settleNudge(main.id, reply, Date.now() - 60e3), reply);
  const m = addMessage({ threadId: main.id, role: 'assistant', content: reply });
  assert.equal(m.content, 'Booked.', 'stored without the list: the last one was under a day ago');
  const listed = await call('bob', 'GET', '/api/v1/threads');
  const row = listed.body.threads.find(t => t.id === 'main');
  assert.equal(typeof row.nudgeAllowed, 'boolean');
  assert.ok('lastNudgeAt' in row);
});

test('simpler: the send route adds the plain-words note server side, right before the visible turn; chips come from the reply', async () => {
  const { SIMPLER_TEXT, SIMPLER_NOTE } = await import('../src/services/reply-actions.js');
  settings.set('llm', { baseUrl: 'http://127.0.0.1:9/v1', model: 'fake/model' }); // any run fails fast, offline
  const res = await call('bob', 'POST', '/api/v1/threads/main/messages', { simpler: true, clientId: 'simpler-1' });
  assert.equal(res.status, 200);
  const main = threads.mainThread(bob.id);
  const rows = (await import('../src/db/index.js')).all('SELECT role, content FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 2', main.id).reverse();
  assert.deepEqual(rows.map(r => r.role), ['system', 'user']);
  assert.equal(rows[0].content, SIMPLER_NOTE);
  assert.equal(rows[1].content, SIMPLER_TEXT);
  assert.match(SIMPLER_NOTE, /same language/);
  // A retried send (same clientId) adds nothing twice.
  await call('bob', 'POST', '/api/v1/threads/main/messages', { simpler: true, clientId: 'simpler-1' });
  assert.equal((await import('../src/db/index.js')).get(`SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND role = 'system' AND content = ?`, main.id, SIMPLER_NOTE).n, 1);
  // A client can't inject the note: without the flag its text is just its text.
  const plain = await call('bob', 'POST', '/api/v1/threads/main/messages', { text: 'hello', clientId: 'plain-1' });
  assert.equal(plain.status, 200);
  assert.equal((await import('../src/db/index.js')).get(`SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND role = 'system' AND content = ?`, main.id, SIMPLER_NOTE).n, 1);
});

test('chat view: a finished reply shows its body and the follow-ups as chips; the markdown (copy, voice, API) keeps the list', async () => {
  const { assistantView } = await import('../src/services/chatview.js');
  const { NUDGE_LEAD } = await import('../src/lib/follow-ups.js');
  const r = newRun(alice, 'Book the table');
  addMessage({ threadId: r.thread_id, runId: r.id, role: 'assistant', content: `Done, Friday at 8.\n\n${NUDGE_LEAD}\n- Add it to the calendar?\n- Tell Maya?` });
  const v = assistantView(runs.getRun(r.id));
  assert.deepEqual(v.followUps, ['Add it to the calendar?', 'Tell Maya?']);
  assert.doesNotMatch(v.html, /second look/);
  assert.match(v.markdown, /second look/);
  assert.ok(v.simplerText.startsWith('Explain that again'));
  const html = await renderFragment('chat/message', v, alice);
  assert.match(html, /data-follow-up="Add it to the calendar\?"/);
  assert.match(html, /data-message-simpler=/);
});

// ---- 8. Who looked at my availability; fair draws on the record (#196) --------------------------------------------------------
test('availability lookups: a person sees only the lookups of their own calendar, newest first, with the hours in their zone', async () => {
  const { busyLookupsFor } = await import('../src/services/calendar.js');
  const { audit } = await import('../src/services/audit.js');
  audit('calendar.busy_lookup', { actorId: bob.id, targetType: 'user', targetId: alice.id, detail: { from: '2026-10-03T07:00:00.000Z', to: '2026-10-03T16:00:00.000Z', blocks: 2 } });
  audit('calendar.busy_lookup', { actorId: alice.id, targetType: 'user', targetId: bob.id, detail: { from: '2026-10-01T07:00:00.000Z', to: '2026-10-05T16:00:00.000Z', blocks: 0 } });
  audit('calendar.event_create', { actorId: bob.id, targetType: 'user', targetId: alice.id, detail: {} });
  const mine = busyLookupsFor(getUser(alice.id));
  assert.equal(mine.length, 1, 'only lookups of my calendar, only that action');
  assert.equal(mine[0].who, 'Bob Member');
  assert.equal(mine[0].rangeLabel, 'Sat 3 Oct, 09:00 to 18:00', 'Paris time');
  assert.equal(mine[0].blocks, 2);
  const his = busyLookupsFor(getUser(bob.id));
  assert.equal(his.length, 1);
  assert.equal(his[0].who, 'Alice Owner');
  assert.equal(his[0].rangeLabel, 'Thu 1 Oct to Mon 5 Oct');
  const pageHtml = (await page('alice', '/me/connections')).html;
  assert.match(pageHtml, /Who looked at my availability/);
  assert.match(pageHtml, /Bob Member/);
  assert.doesNotMatch(pageHtml, /Thu 1 Oct to Mon 5 Oct/, 'never someone else’s lookups');
});

test('draw history: readable summaries per mode; a private Secret Santa shows no matches; only the person’s own draws', async () => {
  const D = await import('../src/services/draws.js');
  D.recordDraw(alice, { mode: 'pick', input: { items: ['Maya', 'Priya', 'Amara'] }, result: ['Priya'] });
  D.recordDraw(alice, { mode: 'teams', input: { items: ['A', 'B', 'C', 'D'], teams: 2 }, result: [['A', 'C'], ['B', 'D']] });
  D.recordDraw(alice, { mode: 'dice', input: { dice: '2d6' }, result: { expr: '2d6', rolls: [{ term: '2d6', values: [3, 5] }], modifier: 0, total: 8 } });
  D.recordDraw(alice, { mode: 'secret_santa', input: { people: ['A', 'B', 'C'], reveal: 'private' }, result: null });
  D.recordDraw(bob, { mode: 'pick', input: { items: ['x', 'y'] }, result: ['y'] });
  const h = D.drawHistory(alice, 10);
  assert.equal(h.length, 4);
  const [santa, dice, teams, pick] = h;
  assert.equal(santa.private, true);
  assert.match(santa.detail, /privately/);
  assert.doesNotMatch(santa.detail, /→/);
  assert.equal(dice.headline, 'Rolled 2d6: 8');
  assert.equal(dice.from, null);
  assert.equal(teams.detail, 'Team 1: A, C · Team 2: B, D');
  assert.equal(pick.headline, 'Picked Priya');
  assert.equal(pick.from, 'Maya, Priya, Amara');
  const html = (await page('alice', '/activity')).html;
  assert.match(html, /Fair draws/);
  assert.match(html, /Picked Priya/);
  assert.doesNotMatch(html, />Picked y</);
});
