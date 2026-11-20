// Phase 22 part H (decisions #169–#170): make_image. Off until the admin picks an image model AND turns the person's
// 'images' toolset on; the cost is estimated and checked against the weekly budget before the call; the picture lands in
// the Library ("Made by Jess", the prompt as its description) with the provider's reported cost in usage_events; a source
// picture must be the person's own; a likeness of someone else real is refused; provider refusals are said plainly.
// Run: npm test (throwaway data dir; the image model is a local fake OpenRouter server, never the network).
import { test, before, after, beforeEach } from 'node:test';
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
process.env.OPENROUTER_KEY = 'sk-or-v1-unit-test-image-key-0123456789abcdef';

const { openDb, closeDb, run, get, all, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser } = await import('../src/services/users.js');
const { createApp } = await import('../src/app.js'); // registers the tools and configures the fragment renderer
createApp();
const { getTool, toolSchemasFor } = await import('../src/agent/tools/registry.js');
const policy = await import('../src/services/policy.js');
const images = await import('../src/services/images.js');
const library = await import('../src/services/library.js');
const threads = await import('../src/services/threads.js');
const runs = await import('../src/services/runs.js');
const { addMessage } = await import('../src/services/messages.js');
const { weeklyUsage, usageOverview } = await import('../src/services/usage.js');

const reasons = err => (err.errors ? Object.values(err.errors).join(' ') : err.message);
const rejectsWith = (p, re) => assert.rejects(p, err => { assert.match(reasons(err), re); return true; });

// A 2×1 PNG (so width and height are told apart).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8Dwn4GBgYEBAB4MAv+Nw8wWAAAAAElFTkSuQmCC', 'base64');

// ---- The fake OpenRouter: image model endpoints (prices, parameters) and POST /images --------------------------------
const posts = [];
let endpoints = {};            // model id → endpoints body, or a status number
let answer = null;             // () → { status, body } for POST /images
const okAnswer = (cost = 0.014) => () => ({ status: 200, body: { created: 0, data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }],
  usage: { prompt_tokens: 21, completion_tokens: 4096, total_tokens: 4117, ...(cost == null ? {} : { cost }) } } });
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const send = (status, j) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    const m = req.url.match(/^\/v1\/images\/models\/(.+)\/endpoints$/);
    if (req.method === 'GET' && m) {
      const e = endpoints[decodeURIComponent(m[1])];
      if (e == null) return send(404, { error: { message: `No image model found for "${m[1]}"`, code: 404 } });
      if (typeof e === 'number') return send(e, { error: { message: 'down' } });
      return send(200, e);
    }
    if (req.method === 'POST' && req.url === '/v1/images') {
      posts.push(JSON.parse(body || '{}'));
      const a = answer();
      return send(a.status, a.body);
    }
    send(404, { error: { message: 'unknown' } });
  });
});

const FLUX = { id: 'fake/flux', endpoints: [{ provider_name: 'A', supported_parameters: {
  aspect_ratio: { type: 'enum', values: ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', 'auto'] }, output_format: { type: 'enum', values: ['png', 'jpeg'] } },
pricing: [{ billable: 'output_image', unit: 'megapixel', cost_usd: 0.014 }] }] };
const GEMINI = { id: 'fake/gemini', endpoints: [
  { provider_name: 'A', supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1', '3:4', '4:3', '16:9'] } },
    pricing: [{ billable: 'output_image', unit: 'token', cost_usd: 0.00003 }] },
  { provider_name: 'B', supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1', '3:4', '4:3', '9:16', '16:9'] } },
    pricing: [{ billable: 'output_image', unit: 'token', cost_usd: 0.00004 }, { billable: 'input_image', unit: 'token', cost_usd: 0.000001 }] }] };

let alice, bob, carol;
const newCtx = (user, text = 'Make me a picture.') => {
  const t = threads.createSideThread(user.id, 'Pictures');
  const m = addMessage({ threadId: t.id, role: 'user', content: text });
  const r = runs.createRun({ threadId: t.id, userId: user.id, triggerMessageId: m.id, model: 'fake/model' });
  return { user, thread: t, run: r, toolCallId: 'call_1' };
};
const usageRows = userId => all(`SELECT * FROM usage_events WHERE user_id = ? AND purpose = 'image' ORDER BY id`, userId);

before(async () => {
  alice = await createUser({ name: 'Alice Owner', email: 'alice@p22h.dev', password: 'correct horse battery', role: 'admin' });
  bob = await createUser({ name: 'Bob Member', email: 'bob@p22h.dev', password: 'correct horse battery' });
  carol = await createUser({ name: 'Carol Other', email: 'carol@p22h.dev', password: 'correct horse battery' });
  policy.setPolicy('global', null, { toolsets: { core: 'allow', memory: 'allow', library: 'allow' } }, alice.id);
  await listen(fake);
  // A fake of OpenRouter's image API, chosen as the provider (#11: pictures are OpenRouter's).
  settings.set('llm', { provider: 'openrouter', baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, model: 'fake/model' });
});
after(() => { fake.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });
beforeEach(() => {
  posts.length = 0;
  endpoints = { 'fake/flux': FLUX, 'fake/gemini': GEMINI };
  answer = okAnswer();
  images.resetImageInfo();
  settings.set('images', { model: 'fake/flux' });
  run(`DELETE FROM usage_events`);
  for (const u of [alice, bob, carol]) policy.setPolicy('user', u.id, { toolsets: { images: 'allow' }, weeklyBudget: 5 }, alice.id);
});

// ---- 1. Offered only when a model is set AND the person's toolset is on ---------------------------------------------
test('make_image: off by default for everyone; offered only with an image model AND the images toolset on', () => {
  const tool = getTool('make_image');
  assert.equal(tool.toolset, 'images');
  assert.equal(tool.risk, 'write');
  assert.ok(policy.TOOLSETS.images, 'a toolset of its own, so Admin → People lists it');
  const offered = u => toolSchemasFor(u, { toolsets: policy.enabledToolsets(u) }).some(t => t.function.name === 'make_image');

  // No override for Carol: the global policy never names 'images', so it resolves to off (like any toolset nobody set).
  policy.setPolicy('user', carol.id, { toolsets: {} }, alice.id);
  assert.equal(policy.effectivePolicy(carol).toolsets.images, 'off');
  assert.equal(offered(carol), false, 'toolset off → not offered');
  assert.equal(policy.decide(carol, tool, { prompt: 'x', depicts: 'no_real_people' }, null), 'off', 'and refused if called anyway');

  assert.equal(offered(bob), true, 'model set + toolset on → offered');
  settings.set('images', { model: '' });
  assert.equal(offered(bob), false, 'no image model → not offered, even with the toolset on');

  // Ask vs allow follows the person's setting, like any write.
  settings.set('images', { model: 'fake/flux' });
  policy.setPolicy('user', bob.id, { toolsets: { images: 'ask' } }, alice.id);
  assert.equal(policy.decide(bob, tool, { prompt: 'x', depicts: 'no_real_people' }, null), 'ask');
  policy.setPolicy('user', bob.id, { toolsets: { images: 'allow' } }, alice.id);
  assert.equal(policy.decide(bob, tool, { prompt: 'x', depicts: 'no_real_people' }, null), 'allow');
});

test('make_image: with no model set, a call is refused plainly and nothing is sent', async () => {
  settings.set('images', { model: '' });
  await rejectsWith(images.makeImage(bob, { prompt: 'A cat', depicts: 'no_real_people' }), /Pictures are off.*Admin → Models/);
  assert.equal(posts.length, 0);
});

// ---- 2. A picture, end to end through the tool ------------------------------------------------------------------------
test('make_image: the picture is saved to the Library (PNG, prompt as description, "Made by Jess") with the reported cost', async () => {
  const ctx = newCtx(bob);
  const out = await getTool('make_image').run({ prompt: 'A smiling cat with a party hat', depicts: 'no_real_people', size: 'portrait',
    style: 'colouring_page', title: 'Cat colouring page' }, ctx);
  // What went to the model: the model id, the shape it knows, PNG (listed), the preset written into the prompt.
  assert.equal(posts.length, 1);
  assert.equal(posts[0].model, 'fake/flux');
  assert.equal(posts[0].aspect_ratio, '2:3');
  assert.equal(posts[0].output_format, 'png');
  assert.equal(posts[0].n, 1);
  assert.match(posts[0].prompt, /^A black-and-white colouring page: .*A smiling cat with a party hat$/);
  assert.equal(posts[0].input_references, undefined);

  const item = get(`SELECT * FROM library_items WHERE owner_id = ? ORDER BY id DESC LIMIT 1`, bob.id);
  assert.equal(item.type, 'image');
  assert.equal(item.ext, 'png');
  assert.equal(item.mime, 'image/png');
  assert.equal(item.title, 'Cat colouring page');
  assert.equal(item.description, 'A smiling cat with a party hat');
  assert.equal(item.source_label, 'Made by Jess');
  assert.equal(item.thread_id, ctx.thread.id);
  assert.equal(item.run_id, ctx.run.id);
  assert.equal(library.originOf(item), 'made');
  assert.deepEqual(library.readBytes(item), PNG, 'kept byte for byte');
  const meta = library.metaOf(item);
  assert.equal(meta.prompt, 'A smiling cat with a party hat');
  assert.equal(meta.model, 'fake/flux');
  assert.equal(meta.cost, 0.014);
  assert.equal(meta.width, 2);
  assert.equal(meta.height, 1);
  assert.equal(library.listItems(bob, { query: 'party hat' })[0]?.id, item.id, 'searchable by its prompt');

  // The result links it; the step shows the picture.
  assert.match(out.content, new RegExp(`\\[Cat colouring page\\]\\(/library/${item.public_id}\\)`));
  assert.match(out.content, /cost \$0\.014/);
  assert.equal(out.step.image, `/library/${item.public_id}/raw?v=1`);
  assert.equal(out.step.href, `/library/${item.public_id}`);

  // Usage: the provider's reported cost, on the run, under 'image' → in the budget meter and Admin → Usage.
  const rows = usageRows(bob.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost, 0.014);
  assert.equal(rows[0].model, 'fake/flux');
  assert.equal(rows[0].run_id, ctx.run.id);
  assert.equal(rows[0].completion_tokens, 4096);
  assert.equal(weeklyUsage(bob.id, 5).spentLabel, '$0.01');
  const overview = usageOverview([{ id: bob.id, name: 'Bob', role: 'member', budget: 5 }]);
  assert.equal(overview.purposes.find(p => p.key === 'image')?.label, 'Pictures');
});

test('make_image: when the endpoint reports no cost, the estimate is recorded (never zero)', async () => {
  answer = okAnswer(null);
  const out = await images.makeImage(bob, { prompt: 'A lighthouse at dusk', depicts: 'no_real_people' });
  const expected = 0.014 * 1.05;
  assert.ok(Math.abs(out.cost - expected) < 1e-9);
  assert.ok(Math.abs(usageRows(bob.id)[0].cost - expected) < 1e-9);
  assert.equal(out.item.title, 'A lighthouse at dusk', 'title defaults to the prompt');
});

// ---- 3. The budget, before anything is spent -----------------------------------------------------------------------
test('make_image: refused before the call when the estimate would pass this week’s budget', async () => {
  policy.setPolicy('user', bob.id, { toolsets: { images: 'allow' }, weeklyBudget: 1 }, alice.id);
  run(`INSERT INTO usage_events (user_id, purpose, model, cost) VALUES (?, 'chat', 'fake/model', 0.99)`, bob.id);
  await rejectsWith(images.makeImage(bob, { prompt: 'A dragon', depicts: 'no_real_people' }),
    /Not made: this picture would cost about \$0\.015, and only \$0\.010 is left of this week’s \$1\.00 budget.*Nothing was spent/);
  assert.equal(posts.length, 0, 'the model was never called');
  assert.equal(usageRows(bob.id).length, 0);
  // With room for it, it goes through; a budget of 0 means no limit.
  policy.setPolicy('user', bob.id, { toolsets: { images: 'allow' }, weeklyBudget: 0 }, alice.id);
  await images.makeImage(bob, { prompt: 'A dragon', depicts: 'no_real_people' });
  assert.equal(posts.length, 1);
});

test('estimate: per-megapixel exact; per-token from history first, then the list; unknown → cautious flat figure', async () => {
  const flux = await images.estimateImageCost('fake/flux');
  assert.equal(flux.source, 'list');
  assert.ok(Math.abs(flux.cost - 0.014 * 1.05) < 1e-12);
  // Token-priced: the highest provider price × a picture's tokens (+ a source picture's input tokens).
  const gem = await images.estimateImageCost('fake/gemini');
  assert.equal(gem.source, 'list');
  assert.ok(Math.abs(gem.cost - 0.00004 * 1600) < 1e-12);
  const gemSrc = await images.estimateImageCost('fake/gemini', { sources: 1 });
  assert.ok(Math.abs(gemSrc.cost - (0.00004 * 1600 + 0.000001 * 1600)) < 1e-12);
  // What it actually cost here beats a token guess.
  run(`INSERT INTO usage_events (user_id, purpose, model, cost) VALUES (?, 'image', 'fake/gemini', 0.039), (?, 'image', 'fake/gemini', 0.041)`, bob.id, bob.id);
  const hist = await images.estimateImageCost('fake/gemini');
  assert.equal(hist.source, 'history');
  assert.ok(Math.abs(hist.cost - 0.04) < 1e-12);
  // The list unreachable and no history → the flat figure.
  endpoints['fake/other'] = 500;
  assert.deepEqual(await images.estimateImageCost('fake/other'), { cost: images.FALLBACK_ESTIMATE, source: 'fallback' });
});

test('shape: a model without the wanted ratio gets its nearest listed one; PNG asked only when listed', async () => {
  assert.equal(images.pickAspectRatio('2:3', ['1:1', '3:4', '4:3', '16:9']), '3:4');
  assert.equal(images.pickAspectRatio('16:9', ['1:1', '3:2', '2:3']), '3:2');
  assert.equal(images.pickAspectRatio('9:16', null), '9:16');
  settings.set('images', { model: 'fake/gemini' });
  await images.makeImage(bob, { prompt: 'A tall tower', depicts: 'no_real_people', size: 'portrait' });
  assert.equal(posts[0].aspect_ratio, '3:4', 'only ratios every provider accepts are used (9:16 is B-only)');
  assert.equal(posts[0].output_format, undefined);
});

// ---- 4. A source picture: theirs only -----------------------------------------------------------------------------------
test('make_image: a source picture must be the person’s own image; it is sent as a data URL and linked', async () => {
  (await import('../src/services/oversight.js')).setOversight(true, null); // admins view others' things only with oversight on (#219)
  const mine = library.createFileItem({ user: alice, title: 'Our dog', type: 'image', ext: 'png', mime: 'image/png', buffer: PNG });
  const out = await images.makeImage(alice, { prompt: 'Turn this into a colouring page', depicts: 'no_real_people', style: 'colouring_page', sourceImageId: mine.public_id });
  assert.equal(posts[0].input_references.length, 1);
  assert.equal(posts[0].input_references[0].type, 'image_url');
  assert.equal(posts[0].input_references[0].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.match(posts[0].prompt, /Work from the attached picture\. Turn this into a colouring page$/);
  assert.equal(out.item.source_item_id, mine.id, 'the new picture points back at the one it was made from');
  assert.equal(library.metaOf(out.item).source, mine.public_id);

  // Bob's photo: Alice is the admin and may VIEW it, but never make a picture from it.
  const bobs = library.createFileItem({ user: bob, title: 'Bob at the beach', type: 'image', ext: 'png', mime: 'image/png', buffer: PNG });
  posts.length = 0;
  await rejectsWith(images.makeImage(alice, { prompt: 'A cartoon of this', depicts: 'consenting_people', sourceImageId: bobs.public_id }),
    /Only their own pictures can be used/);
  // Carol (not an admin) can't even see it.
  await rejectsWith(images.makeImage(carol, { prompt: 'A cartoon of this', depicts: 'consenting_people', sourceImageId: bobs.public_id }),
    /isn’t in the library/);
  // Not a picture.
  const doc = library.createFileItem({ user: alice, title: 'Notes', type: 'md', ext: 'md', mime: 'text/markdown; charset=utf-8', buffer: Buffer.from('# hi') });
  await rejectsWith(images.makeImage(alice, { prompt: 'Illustrate', depicts: 'no_real_people', sourceImageId: doc.public_id }), /isn’t a PNG, JPEG or WebP picture/);
  assert.equal(posts.length, 0);
});

// ---- 5. Real people ------------------------------------------------------------------------------------------------------
test('make_image: a likeness of someone else real is always refused; who is shown must be said', async () => {
  await rejectsWith(images.makeImage(bob, { prompt: 'A famous singer riding a unicorn', depicts: 'someone_else' }),
    /Not made: I don’t make pictures that look like a real person other than the one asking/);
  await rejectsWith(images.makeImage(bob, { prompt: 'A cat' }), /Say who the picture shows \(depicts: no_real_people, requester, consenting_people, someone_else\)/);
  assert.equal(posts.length, 0, 'refused before anything was sent or spent');
  assert.equal(usageRows(bob.id).length, 0);
  // Themselves (they said so), and their own photo of people who agreed, are allowed.
  await images.makeImage(bob, { prompt: 'Me as an astronaut, cartoon style', depicts: 'requester' });
  assert.equal(posts.length, 1);
  // The tool's schema carries the rule to the model.
  const schema = getTool('make_image');
  assert.deepEqual(schema.parameters.required, ['prompt', 'depicts']);
  assert.match(schema.description, /someone_else: that is always refused/);
});

test('make_image: bad input is refused with the reason', async () => {
  await rejectsWith(images.makeImage(bob, { prompt: '   ', depicts: 'no_real_people' }), /Say what the picture should show/);
  await rejectsWith(images.makeImage(bob, { prompt: 'x'.repeat(2001), depicts: 'no_real_people' }), /too long \(2001 characters; at most 2000\)/);
  await rejectsWith(images.makeImage(bob, { prompt: 'A cat', depicts: 'no_real_people', size: 'huge' }), /Unknown size “huge”/);
  await rejectsWith(images.makeImage(bob, { prompt: 'A cat', depicts: 'no_real_people', style: 'oil' }), /Unknown style “oil”/);
  assert.equal(posts.length, 0);
});

// ---- 6. Provider failures, plainly ----------------------------------------------------------------------------------------
test('make_image: provider refusals and failures are said plainly; a billed answer without a picture is still recorded', async () => {
  answer = () => ({ status: 403, body: { error: { message: 'Your prompt was flagged by the moderation system', code: 403 } } });
  await rejectsWith(images.makeImage(bob, { prompt: 'Something', depicts: 'no_real_people' }),
    /The image model refused this picture \(its safety rules\): Your prompt was flagged by the moderation system.*don't reword/);
  answer = () => ({ status: 402, body: { error: { message: 'Insufficient credits', code: 402 } } });
  await rejectsWith(images.makeImage(bob, { prompt: 'Something', depicts: 'no_real_people' }), /out of credits/);
  answer = () => ({ status: 400, body: { error: { message: 'Request blocked by content policy', code: 400 } } });
  await rejectsWith(images.makeImage(bob, { prompt: 'Something', depicts: 'no_real_people' }), /refused this picture \(its safety rules\)/);
  answer = () => ({ status: 500, body: { error: { message: 'Upstream exploded', code: 500 } } });
  await rejectsWith(images.makeImage(bob, { prompt: 'Something', depicts: 'no_real_people' }), /image model failed \(500\): .*Upstream exploded/);
  assert.equal(posts.length, 4, 'never retried (a retry could bill twice)');
  assert.equal(usageRows(bob.id).length, 0, 'errors bill nothing');

  answer = () => ({ status: 200, body: { data: [], usage: { prompt_tokens: 20, completion_tokens: 0, cost: 0.002 } } });
  const before = all('SELECT id FROM library_items WHERE owner_id = ?', bob.id).length;
  await rejectsWith(images.makeImage(bob, { prompt: 'Something', depicts: 'no_real_people' }), /answered without a picture/);
  assert.equal(usageRows(bob.id)[0].cost, 0.002, 'what the provider billed is recorded');
  answer = () => ({ status: 200, body: { data: [{ b64_json: Buffer.from('not a picture at all').toString('base64') }], usage: { cost: 0.01 } } });
  await rejectsWith(images.makeImage(bob, { prompt: 'Something', depicts: 'no_real_people' }), /isn’t a picture/);
  assert.equal(all('SELECT id FROM library_items WHERE owner_id = ?', bob.id).length, before, 'nothing saved');
});

// ---- 7. Admin → Models ------------------------------------------------------------------------------------------------------
test('image model setting: checked against the image model list; unknown refused; empty = off; unreachable saved with a warning', async () => {
  settings.set('images', {});
  assert.equal(images.imageModel(), null, 'off by default');
  await assert.rejects(images.saveImageSettings({ model: 'fake/unknown' }), err => { assert.match(err.errors.model, /isn’t an image model on this endpoint/); return true; });
  await assert.rejects(images.saveImageSettings({ model: 'not a model id' }), err => { assert.match(err.errors.model, /Use an image model id/); return true; });
  assert.equal(images.imageModel(), null, 'nothing saved on an error');
  const ok = await images.saveImageSettings({ model: ' fake/flux ' });
  assert.equal(ok.settings.model, 'fake/flux');
  assert.equal(ok.price.label, 'about $0.015 a picture');
  assert.equal(ok.warning, null);
  endpoints['fake/offline'] = 503;
  const warned = await images.saveImageSettings({ model: 'fake/offline' });
  assert.equal(warned.settings.model, 'fake/offline');
  assert.match(warned.warning, /couldn’t be reached/);
  const off = await images.saveImageSettings({ model: '' });
  assert.equal(off.settings.model, '');
  assert.equal(images.imageModel(), null);
});

// ---- 8. Over HTTP: the admin route, the Models page, and the permission row ------------------------------------------------
test('web: POST /api/v1/admin/images saves (admin only, field errors), Admin → Models shows it, People lists "Pictures"', async () => {
  const { createSession } = await import('../src/services/sessions.js');
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  const server = await listen(createApp());
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = { Authorization: `Bearer ${createSession(alice.id, { kind: 'app', device: 'test' })}` };
  const member = { Authorization: `Bearer ${createSession(bob.id, { kind: 'app', device: 'test' })}` };
  const post = (headers, body) => fetch(`${base}/api/v1/admin/images`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(member, { model: 'fake/flux' })).status, 403, 'members can’t choose the model');
    const bad = await post(admin, { model: 'fake/unknown' });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).errors.model, /isn’t an image model/);
    const ok = await (await post(admin, { model: 'fake/flux' })).json();
    assert.deepEqual({ ok: ok.ok, model: ok.settings.model, price: ok.price.label }, { ok: true, model: 'fake/flux', price: 'about $0.015 a picture' });
    assert.equal(get(`SELECT detail FROM audit_log WHERE action = 'images.settings' ORDER BY id DESC LIMIT 1`)?.detail, JSON.stringify({ model: 'fake/flux' }));
    const page = await (await fetch(`${base}/admin/model`, { headers: admin })).text();
    assert.match(page, /id="f-imodel" name="model"[^>]*value="fake\/flux"/);
    const person = await (await fetch(`${base}/admin/people/${bob.id}`, { headers: admin })).text();
    assert.match(person, /toolsets\[images\]/, 'the per-person permission row exists');
    const off = await (await post(admin, { model: '' })).json();
    assert.equal(off.settings.model, '');
  } finally { server.close(); }
});
