// Phase 22 part L (decisions #201–#202): what pictures cost and what the provider caches. Every image gets a model copy (at
// most 1568 px, a JPEG unless it is already a small JPEG or PNG) made when it is stored, attached or viewed, and the prompt
// sends that copy instead of the original; Anthropic models get two cache breakpoints and the per-step tail as a labelled user
// message (OpenRouter moves system messages before the turns). Run: npm test (throwaway data dir; the model is a local fake
// OpenAI-compatible server that records every request body, never the network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-p22l-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
process.env.OPENROUTER_KEY = 'sk-or-v1-unit-test-model-key-p22l-0123456789';

const { openDb, closeDb, run, get, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser, getUser } = await import('../src/services/users.js');
const { createApp } = await import('../src/app.js'); // registers the tools
const { createSession } = await import('../src/services/sessions.js');
const lib = await import('../src/services/library.js');
const { saveUpload } = await import('../src/services/uploads.js');
const { fitImage, MODEL_EDGE } = await import('../src/services/pdf-render.js');
const { withPromptCache, cachesByBreakpoint, APP_TAIL_LABEL } = await import('../src/services/llm.js');
const { buildPrompt } = await import('../src/agent/prompt.js');
const { rawMessageTokens, IMAGE_TOKENS } = await import('../src/lib/tokens.js');
const { addMessage } = await import('../src/services/messages.js');
const threads = await import('../src/services/threads.js');
const runs = await import('../src/services/runs.js');
const policy = await import('../src/services/policy.js');
const loop = await import('../src/agent/loop.js');
const { getTool } = await import('../src/agent/tools/registry.js');
const { createCanvas, loadImage } = await import('@napi-rs/canvas');
const { PDFDocument } = await import('@cantoo/pdf-lib');

// ---- A local stand-in for the model: records each streamed request body; script items are { tool, args } or { text } -------
const bodies = [];
let script = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    if (!j.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'fake', choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      return;
    }
    bodies.push(j);
    const next = script.shift() || { text: 'Done.' };
    const chunk = delta => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: j.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (next.tool) res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: 'function', function: { name: next.tool, arguments: JSON.stringify(next.args || {}) } }] }));
    else res.write(chunk({ role: 'assistant', content: next.text }));
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: j.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});

let ann, server, base, token;
before(async () => {
  ann = await createUser({ name: 'Ann Owner', email: 'ann@p22l.dev', password: 'correct horse battery', role: 'admin' });
  policy.setPolicy('user', ann.id, { toolsets: { core: 'allow', library: 'allow', memory: 'allow' }, quietStart: '12:00', quietEnd: '12:00', weeklyBudget: 0 }, ann.id);
  await listen(fake);
  useModel('fake/model');
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  token = createSession(ann.id, { kind: 'app', device: 'test' });
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await lib.modelImagesSettled();
  server?.close();
  fake.close();
  closeDb();
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 5 });
});

const useModel = model => settings.set('llm', { baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, model });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const threadRow = id => get('SELECT * FROM threads WHERE id = ?', id);
async function settle(runId, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    await loop.drainRuns();
    const r = runs.getRun(runId);
    if (['done', 'error', 'cancelled', 'waiting'].includes(r.status)) return r;
    await sleep(20);
  }
  throw new Error(`run ${runId} stuck in ${runs.getRun(runId).status}`);
}

// A photo-like picture: smooth colour fields with grain (it doesn't compress like a flat drawing would).
function photo(w, h, format = 'jpeg') {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, n = (rnd() - 0.5) * 60;
      img.data[i] = 120 + 100 * Math.sin(x / 150) + n;
      img.data[i + 1] = 110 + 90 * Math.cos(y / 110) + n;
      img.data[i + 2] = 128 + 80 * Math.sin((x + y) / 200) + n;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return format === 'png' ? c.encodeSync('png') : format === 'webp' ? c.encodeSync('webp', 90) : c.encodeSync('jpeg', 95);
}
const dims = async buf => { const i = await loadImage(buf); return [i.width, i.height]; };
const imageItem = (buffer, { ext = 'jpg', mime = 'image/jpeg', title = 'Photo' } = {}) =>
  lib.createFileItem({ user: getUser(ann.id), title, type: 'image', ext, mime, buffer, sourceLabel: 'Uploaded' });
// An image as it was before model copies existed: stored, and its copy removed.
async function legacyImage(buffer, opts) {
  const item = imageItem(buffer, opts);
  await lib.modelImage(item);
  fs.rmSync(path.join(path.dirname(lib.fileOf(item)), `v${item.version}.model`));
  assert.equal(lib.modelImageOf(item), null);
  return item;
}
const dataUrlBytes = url => Buffer.from(url.split(',')[1], 'base64');
const breakpoints = messages => messages.flatMap((m, i) => (Array.isArray(m.content) ? m.content.map((p, j) => (p.cache_control ? [i, j] : null)).filter(Boolean) : []));

// ---- Item 1: model copies ------------------------------------------------------------------------------------------------
test('upload: a big photo gets a model copy at 1568 px (JPEG, far fewer bytes) before the upload answers; the original is kept', async () => {
  const original = photo(2400, 1800);
  const view = await saveUpload(getUser(ann.id), { buffer: original, originalname: 'garden.jpg' });
  const item = lib.getItem(get('SELECT id FROM library_items WHERE public_id = ?', view.id).id);
  const copy = lib.modelImageOf(item);
  assert.ok(copy, 'made before saveUpload returned');
  assert.equal(copy.mime, 'image/jpeg');
  assert.deepEqual(await dims(copy.buffer), [MODEL_EDGE, 1176], 'longer side 1568, proportions kept');
  assert.ok(copy.buffer.length < original.length / 3, `bytes shrink (${original.length} → ${copy.buffer.length})`);
  assert.ok(lib.readBytes(item).equals(original), 'the original file is untouched: what the person sees and downloads');
  assert.equal(item.size_bytes, original.length);
  // A tall one: the longer side is the height.
  const tall = imageItem(photo(900, 2600));
  const t = await lib.modelImage(tall);
  assert.deepEqual(await dims(t.buffer), [543, MODEL_EDGE]);
});

test('model copy: a small JPEG or PNG is copied as it is; WebP, GIF and PNGs over 1 MB become a JPEG on white', async () => {
  const small = photo(800, 600);
  assert.ok((await lib.modelImage(imageItem(small))).buffer.equals(small), 'a small JPEG goes as it is');
  const png = photo(640, 400, 'png');
  const p = await lib.modelImage(imageItem(png, { ext: 'png', mime: 'image/png' }));
  assert.equal(p.mime, 'image/png');
  assert.ok(p.buffer.equals(png));
  const webp = await lib.modelImage(imageItem(photo(1000, 700, 'webp'), { ext: 'webp', mime: 'image/webp' }));
  assert.equal(webp.mime, 'image/jpeg', 'not every provider takes WebP');
  assert.deepEqual(await dims(webp.buffer), [1000, 700], 'not enlarged');
  const gifCanvas = createCanvas(300, 200);
  gifCanvas.getContext('2d').fillStyle = '#cc0000';
  gifCanvas.getContext('2d').fillRect(0, 0, 300, 200);
  const gif = await lib.modelImage(imageItem(gifCanvas.encodeSync('gif'), { ext: 'gif', mime: 'image/gif' }));
  assert.equal(gif.mime, 'image/jpeg');
  assert.deepEqual(await dims(gif.buffer), [300, 200]);
  const bigPng = photo(1400, 1000, 'png');
  assert.ok(bigPng.length > 1048576, 'fixture: a PNG over 1 MB');
  const bp = await lib.modelImage(imageItem(bigPng, { ext: 'png', mime: 'image/png' }));
  assert.equal(bp.mime, 'image/jpeg');
  assert.ok(bp.buffer.length < bigPng.length / 3);
  // A transparent PNG lands on white, not black.
  const clear = await lib.modelImage(imageItem(createCanvas(1800, 900).encodeSync('png'), { ext: 'png', mime: 'image/png' })); // all transparent
  const px = (await loadImage(clear.buffer));
  const g = createCanvas(px.width, px.height).getContext('2d');
  g.drawImage(px, 0, 0);
  assert.ok(g.getImageData(10, 10, 1, 1).data[0] > 240, 'white where the picture is transparent');
});

test('model copy: made once (callers share the work), per version, never for other items; an unreadable picture is not retried', async () => {
  const item = imageItem(photo(2400, 1800));
  const [a, b] = await Promise.all([lib.modelImage(item), lib.modelImage(item)]);
  assert.ok(a.buffer.equals(b.buffer));
  const v2 = lib.addFileVersion(item, { buffer: photo(2000, 3000) });
  await lib.modelImagesSettled();
  assert.deepEqual(await dims(lib.modelImageOf(v2).buffer), [1045, MODEL_EDGE], 'the new version has its own copy (started by addFileVersion)');
  assert.deepEqual(await dims(lib.modelImageOf(v2, 1).buffer), [MODEL_EDGE, 1176], 'the old version keeps its own');
  const doc = lib.createItem({ user: getUser(ann.id), title: 'Notes', type: 'md', content: 'hello' });
  assert.equal(await lib.modelImage(doc), null);
  assert.equal(lib.modelImageOf(doc), null);
  const broken = imageItem(Buffer.from('not a picture at all'), { title: 'Broken' });
  await lib.modelImagesSettled();
  assert.equal(await lib.modelImage(broken), null, 'unreadable → null, never a throw');
  const warn = console.warn; let warned = 0;
  console.warn = () => { warned++; };
  try { assert.equal(await lib.modelImage(broken), null); } finally { console.warn = warn; }
  assert.equal(warned, 0, 'not tried again');
  // Anything else (here: the file briefly missing) is tried again on the next use.
  const bytes = photo(1800, 1200);
  const later = await legacyImage(bytes, { title: 'Moved' });
  fs.rmSync(lib.fileOf(later));
  console.warn = () => {};
  try { assert.equal(await lib.modelImage(later), null); } finally { console.warn = warn; }
  fs.writeFileSync(lib.fileOf(later), bytes);
  assert.equal((await lib.modelImage(later)).mime, 'image/jpeg', 'made once the file is back');
});

test('prompt: an attached image goes to the model as its copy; an old image sends its original once and its copy from then on', async () => {
  const thread = threads.createSideThread(ann.id, 'Pictures');
  const original = photo(2400, 1600);
  const item = await legacyImage(original);
  addMessage({ threadId: thread.id, role: 'user', content: 'What is in this?', attachments: [item.public_id] });
  const partOf = () => buildPrompt({ user: getUser(ann.id), thread: threadRow(thread.id), owner: null }).messages.findLast(m => m.role === 'user').content[1];
  const first = partOf();
  assert.equal(first.type, 'image_url');
  assert.match(first.image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(dataUrlBytes(first.image_url.url).length, original.length, 'no copy yet: the original, this once');
  await lib.modelImagesSettled();
  const second = partOf();
  const sent = dataUrlBytes(second.image_url.url);
  assert.ok(sent.equals(lib.modelImageOf(item).buffer), 'the copy (the prompt started making it)');
  assert.ok(sent.length < original.length / 3);
  // An image over 8 MB that has no copy yet can't be sent this time (said so); its copy makes it viewable after.
  const huge = await legacyImage(photo(2400, 1800, 'png'), { ext: 'png', mime: 'image/png', title: 'Huge' });
  assert.ok(lib.readBytes(huge).length > 8 * 1048576, 'fixture: over 8 MB');
  const t2 = threads.createSideThread(ann.id, 'Huge');
  addMessage({ threadId: t2.id, role: 'user', content: 'And this one?', attachments: [huge.public_id] });
  const text = buildPrompt({ user: getUser(ann.id), thread: threadRow(t2.id), owner: null }).messages.findLast(m => m.role === 'user').content;
  assert.match(text, /“Huge” — image .*can’t be shown right now \(view_image tries again\)/);
  await lib.modelImagesSettled();
  const now = buildPrompt({ user: getUser(ann.id), thread: threadRow(t2.id), owner: null }).messages.findLast(m => m.role === 'user').content;
  assert.equal(now[1].type, 'image_url', 'shown once its copy exists');
  assert.ok(dataUrlBytes(now[1].image_url.url).length < 2 * 1048576);
});

test('view_image makes the copy of an old image before the model sees it; the step images use it', async () => {
  const item = await legacyImage(photo(2000, 1600));
  const thread = threads.createSideThread(ann.id, 'Look again');
  const m = addMessage({ threadId: thread.id, role: 'user', content: 'Look at the garden photo again.' });
  const r = runs.createRun({ threadId: thread.id, userId: ann.id, triggerMessageId: m.id, model: 'fake/model', origin: 'chat' });
  const out = await getTool('view_image').run({ id: item.public_id }, { user: getUser(ann.id), thread, run: runs.getRun(r.id) });
  assert.deepEqual(out.attachments, [item.public_id]);
  assert.ok(lib.modelImageOf(item), 'made by the tool, before its result is read');
  const call = { id: 'call_v1', type: 'function', function: { name: 'view_image', arguments: JSON.stringify({ id: item.public_id }) } };
  addMessage({ threadId: thread.id, runId: r.id, role: 'assistant', content: '', toolCalls: [call] });
  addMessage({ threadId: thread.id, runId: r.id, role: 'tool', toolCallId: 'call_v1', toolName: 'view_image', content: out.content, attachments: out.attachments });
  const msgs = buildPrompt({ user: getUser(ann.id), thread: threadRow(thread.id), owner: null, run: runs.getRun(r.id) }).messages;
  const step = msgs.find(x => Array.isArray(x.content) && x.content[0]?.text === '(images from the steps above)');
  assert.ok(dataUrlBytes(step.content[1].image_url.url).equals(lib.modelImageOf(item).buffer));
});

test('PDF page pictures for the model are capped at 1568 px too (a very tall page)', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 1000]);
  const item = lib.createFileItem({ user: getUser(ann.id), title: 'Receipt', type: 'pdf', ext: 'pdf', mime: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  const pic = await lib.pagePicture(item, 1);
  assert.equal(Math.max(pic.width, pic.height), MODEL_EDGE);
  await lib.previewsSettled();
});

test('token estimates: a picture counts as IMAGE_TOKENS, not as its base64; content parts count by their text', () => {
  const big = Buffer.alloc(600_000, 7).toString('base64');
  const withImage = [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${big}` } }] }];
  const textOnly = [{ role: 'user', content: 'What is this?' }];
  assert.equal(rawMessageTokens(withImage), rawMessageTokens(textOnly) + IMAGE_TOKENS);
  const marked = withPromptCache([{ role: 'system', content: 'Stable rules.' }, ...textOnly, { role: 'system', content: 'Now: noon.' }], ['anthropic/claude-haiku-4.5']);
  const plain = [{ role: 'system', content: 'Stable rules.' }, ...textOnly, { role: 'user', content: `${APP_TAIL_LABEL}\n\nNow: noon.` }];
  assert.equal(rawMessageTokens(marked), rawMessageTokens(plain), 'a breakpoint adds no tokens to the estimate');
  assert.equal(rawMessageTokens([{ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }] }]) > 4, true);
});

// ---- Item 2: prompt caching -----------------------------------------------------------------------------------------------
test('withPromptCache: only Anthropic models; two breakpoints (system, last turn with content); the tail as a labelled user message', () => {
  const call = { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } };
  const msgs = [
    { role: 'system', content: 'SOUL and AGENTS…' },
    { role: 'user', content: 'Find flights.' },
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', tool_call_id: 'c1', content: 'Found 3 flights.' },
    { role: 'system', content: '## Right now\n- noon' },
  ];
  const frozen = structuredClone(msgs);
  for (const m of ['openai/gpt-6-luna', 'google/gemini-3-flash', 'deepseek/deepseek-v4', 'fake/model', '', null, 'anthropicish/x']) {
    assert.equal(withPromptCache(msgs, [m]), msgs, `${m}: the same array, untouched`);
  }
  assert.ok(cachesByBreakpoint('anthropic/claude-sonnet-4.6') && cachesByBreakpoint('~anthropic/claude-sonnet-latest'));
  const out = withPromptCache(msgs, ['anthropic/claude-haiku-4.5']);
  assert.deepEqual(msgs, frozen, 'the input is never modified');
  assert.deepEqual(out[0], { role: 'system', content: [{ type: 'text', text: 'SOUL and AGENTS…', cache_control: { type: 'ephemeral' } }] });
  assert.deepEqual(out[1], msgs[1], 'turns before the last one are as they were');
  assert.deepEqual(out[2], msgs[2]);
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'Found 3 flights.', cache_control: { type: 'ephemeral' } }] });
  assert.deepEqual(out[4], { role: 'user', content: `${APP_TAIL_LABEL}\n\n## Right now\n- noon` });
  assert.deepEqual(breakpoints(out), [[0, 0], [3, 0]], 'two of the four allowed');
  // The answering model counts too (a fallback that answered), and a tool-only assistant message is skipped for the one before.
  const tail = withPromptCache([msgs[0], msgs[1], msgs[2], msgs[4]], ['openai/gpt-6-luna', 'anthropic/claude-sonnet-4.6']);
  assert.deepEqual(breakpoints(tail), [[0, 0], [1, 0]]);
  // A picture message: the breakpoint goes on its last part (the picture), so the picture is inside the cached prefix.
  const img = { role: 'user', content: [{ type: 'text', text: '(images from the steps above)' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] };
  const withImg = withPromptCache([msgs[0], msgs[1], img, msgs[4]], ['anthropic/claude-haiku-4.5']);
  assert.deepEqual(withImg[2].content[1], { ...img.content[1], cache_control: { type: 'ephemeral' } });
  assert.equal(img.content[1].cache_control, undefined, 'parts are copied, not marked in place');
  // No turns yet: the system message only. No trailing tail: nothing converted.
  assert.deepEqual(breakpoints(withPromptCache([msgs[0], msgs[4]], ['anthropic/x'])), [[0, 0]]);
  const noTail = withPromptCache([msgs[0], msgs[1]], ['anthropic/x']);
  assert.equal(noTail[1].role, 'user');
  assert.deepEqual(breakpoints(noTail), [[0, 0], [1, 0]]);
});

test('buildPrompt: breakpoints only when the configured model (or the run’s answering model) is Anthropic', async () => {
  const thread = threads.createSideThread(ann.id, 'Cache');
  addMessage({ threadId: thread.id, role: 'user', content: 'Plan my week.' });
  const build = (r = null) => buildPrompt({ user: getUser(ann.id), thread: threadRow(thread.id), owner: null, run: r }).messages;
  useModel('fake/model');
  const plain = build();
  assert.equal(typeof plain[0].content, 'string');
  assert.equal(plain.at(-1).role, 'system', 'other models: exactly as before');
  assert.deepEqual(breakpoints(plain), []);
  useModel('anthropic/claude-haiku-4.5');
  const cached = build();
  assert.equal(cached[0].content[0].text, plain[0].content, 'the same system text, as one part');
  assert.deepEqual(breakpoints(cached), [[0, 0], [1, 0]]);
  assert.equal(cached.at(-1).role, 'user');
  assert.ok(cached.at(-1).content.startsWith(`${APP_TAIL_LABEL}\n\n## Right now`));
  useModel('fake/model');
  const m = addMessage({ threadId: thread.id, role: 'user', content: 'And next week?' });
  const r = runs.createRun({ threadId: thread.id, userId: ann.id, triggerMessageId: m.id, model: 'anthropic/claude-sonnet-4.6', origin: 'chat' });
  assert.deepEqual(breakpoints(build(runs.getRun(r.id))), [[0, 0], [2, 0]], 'a run answered by an Anthropic fallback');
  run(`UPDATE runs SET status = 'done' WHERE id = ?`, r.id);
});

// ---- End to end: the chat route, the loop and the request body the provider gets ---------------------------------------------
test('end to end: sending an old image in chat makes its copy first; an Anthropic run sends it with breakpoints; others untouched', async () => {
  useModel('anthropic/claude-haiku-4.5');
  const original = photo(2400, 1800);
  const item = await legacyImage(original, { title: 'Receipt photo' });
  const viewed = await legacyImage(photo(2000, 2000), { title: 'Shelf photo' });
  bodies.length = 0;
  script = [{ tool: 'view_image', args: { id: viewed.public_id } }, { text: 'It is a receipt and a shelf.' }];
  const res = await fetch(`${base}/api/v1/threads/main/messages`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text: 'What do these show?', attachments: [item.public_id], clientId: 'p22l-1' }) });
  assert.equal(res.status, 200);
  const { runId } = await res.json();
  assert.equal((await settle(runId)).status, 'done');
  assert.equal(bodies.length, 2);
  const [first, second] = bodies;
  assert.equal(first.model, 'anthropic/claude-haiku-4.5');
  // Pictures: the copies, from the very first call.
  const attached = first.messages.findLast(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
  const sent = dataUrlBytes(attached.content.find(p => p.type === 'image_url').image_url.url);
  assert.ok(sent.equals(lib.modelImageOf(item).buffer), 'the copy made by the route, not the original');
  assert.ok(sent.length < original.length / 3, `${original.length} → ${sent.length} bytes per call`);
  const step = second.messages.find(m => Array.isArray(m.content) && m.content[0]?.text === '(images from the steps above)');
  assert.ok(dataUrlBytes(step.content[1].image_url.url).equals(lib.modelImageOf(viewed).buffer), 'view_image: the copy');
  // Breakpoints: system + the last turn; the tail is the labelled user message at the end; at most four; valid parts.
  for (const b of bodies) {
    const marks = breakpoints(b.messages);
    assert.equal(marks.length, 2);
    assert.deepEqual(marks[0], [0, 0]);
    assert.equal(marks[1][0], b.messages.length - 2, 'the last message before the tail');
    assert.equal(b.messages.at(-1).role, 'user');
    assert.ok(b.messages.at(-1).content.startsWith(APP_TAIL_LABEL));
    assert.equal(b.messages.filter(m => m.role === 'system').length, 1, 'one system message: the stable one');
    for (const m of b.messages) if (Array.isArray(m.content)) for (const p of m.content) assert.ok(['text', 'image_url'].includes(p.type) && (p.type !== 'text' || typeof p.text === 'string'));
    assert.equal(JSON.stringify(b).split('"cache_control"').length - 1, 2, 'no cache_control anywhere else in the body');
  }
  assert.equal(second.messages[second.messages.length - 2].content.at(-1).type, 'image_url', 'step two: the breakpoint is on the picture');
  // Another model: the same run shape, no breakpoints, the tail a system message.
  useModel('fake/model');
  bodies.length = 0;
  script = [{ text: 'Fine.' }];
  const res2 = await fetch(`${base}/api/v1/threads/main/messages`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text: 'Thanks!', clientId: 'p22l-2' }) });
  const { runId: r2 } = await res2.json();
  assert.equal((await settle(r2)).status, 'done');
  assert.equal(bodies.length, 1);
  assert.ok(!JSON.stringify(bodies[0]).includes('cache_control'));
  assert.equal(bodies[0].messages.at(-1).role, 'system');
  assert.equal(typeof bodies[0].messages[0].content, 'string');
});

test('fitImage keeps its contract for other callers (OCR, thumbnails): default edge, small PNG/JPEG as is', async () => {
  const small = photo(500, 300);
  const kept = await fitImage(small, { mime: 'image/jpeg' });
  assert.ok(kept.buffer.equals(small));
  const big = await fitImage(photo(2400, 1200), { mime: 'image/jpeg' });
  assert.equal(big.width, 1600, 'default maxEdge unchanged (1600)');
});
