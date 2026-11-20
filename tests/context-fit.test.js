// Ollama's context window (#69, decision #252): Ollama loads a model with a context the server sets (4,096 tokens by default
// on most graphics cards) and silently cuts a longer prompt, so the model loses Jessbot's instructions and calls tools at
// random. Jessbot reads the context Ollama reports (/api/ps, a Modelfile's num_ctx in /api/show), warns in the connection
// test, stops a run whose request can't fit before calling the model, stops a run whose prompt the provider reports as
// cut before any tool it asked for runs, asks every non-OpenRouter stream for its usage, and compacts sooner in a small
// window. Run: npm test (a throwaway data dir; a local fake Ollama, never the network).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-context-fit-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
for (const k of ['OPENROUTER_KEY', 'LLM_API_KEY', 'LLM_BASE_URL']) delete process.env[k];

const { openDb, closeDb, settings, all, get } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const { createUser, getUser } = await import('../src/services/users.js');
const { registerTool } = await import('../src/agent/tools/registry.js');
const { createApp } = await import('../src/app.js'); // registers the tools and configures the fragment renderer
createApp();
const policy = await import('../src/services/policy.js');
const threads = await import('../src/services/threads.js');
const runs = await import('../src/services/runs.js');
const { addMessage } = await import('../src/services/messages.js');
const loop = await import('../src/agent/loop.js');
const F = await import('../src/services/context-fit.js');
const { compactionLimits } = await import('../src/services/context.js');

// ---- A fake Ollama -----------------------------------------------------------------------------------------------------
// /api/ps reports `ps` (the loaded models), /api/show `show`; /v1/chat/completions streams the next `script` item
// ({ tool } or { text }) with `promptTokens` as its usage, and records every body.
let ps = { models: [] }, show = {}, promptTokens = 10, script = [];
const bodies = [];
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/ps') return res.end(JSON.stringify(ps));
    if (req.url === '/api/show') return res.end(JSON.stringify(show));
    bodies.push(body);
    if (!body.stream) {
      return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 2 } }));
    }
    const next = script.shift() || { text: 'Done.' };
    const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (next.tool) res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: 'function', function: { name: next.tool, arguments: '{}' } }] }));
    else res.write(chunk({ role: 'assistant', content: next.text }));
    // Ollama sends usage only when asked (stream_options.include_usage), in a last chunk without choices.
    if (body.stream_options?.include_usage) {
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 } })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
});

let executed = 0;
registerTool({ name: 'test_ctx_note', toolset: 'core', risk: 'write', description: 'Save a private test note.', label: () => 'Saved a note',
  parameters: { type: 'object', properties: {} }, run: () => { executed++; return 'Saved.'; } });

let admin, BASE;
const loaded = context => ({ models: [{ name: 'qwen2.5:7b', model: 'qwen2.5:7b', size: 4.7e9, context_length: context }] });
const QWEN_INFO = { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 };
before(async () => {
  await listen(fake);
  BASE = `http://127.0.0.1:${fake.address().port}`;
  admin = getUser((await createUser({ name: 'Casey Admin', email: 'casey@context.test', password: 'correct horse battery', role: 'admin' })).id);
  policy.setPolicy('user', admin.id, { toolsets: { core: 'allow' }, quietStart: '12:00', quietEnd: '12:00', weeklyBudget: 0 }, admin.id);
});
after(() => { fake.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });
beforeEach(() => {
  settings.set('llm', { provider: 'ollama', baseUrl: `${BASE}/v1`, model: 'qwen2.5:7b' });
  ps = { models: [] }; show = { model_info: QWEN_INFO, parameters: '' }; promptTokens = 10; script = []; bodies.length = 0; executed = 0;
  F.forgetContext();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
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
function chatRun(text = 'What can you help me with?') {
  const t = threads.createSideThread(admin.id, 'Context test');
  const m = addMessage({ threadId: t.id, role: 'user', content: text });
  const r = runs.createRun({ threadId: t.id, userId: admin.id, triggerMessageId: m.id, model: 'qwen2.5:7b', origin: 'chat' });
  loop.enqueueRun(r.id);
  return r.id;
}
const streamed = () => bodies.filter(b => b.stream);

test('what Ollama reports: the loaded context first, else a Modelfile’s num_ctx; the trained length; nulls when it says nothing', async () => {
  ps = loaded(4096);
  assert.deepEqual(await F.ollamaContext(`${BASE}/v1`, 'qwen2.5:7b', { fresh: true }).then(c => [c.context, c.trained, c.source]), [4096, 32768, 'loaded']);
  ps = { models: [{ name: 'qwen2.5:7b', model: 'qwen2.5:7b' }] }; // an older Ollama: no context_length
  show = { model_info: QWEN_INFO, parameters: 'stop "<|im_end|>"\nnum_ctx 16384\ntemperature 0.7' };
  assert.deepEqual(await F.ollamaContext(`${BASE}/v1`, 'qwen2.5:7b', { fresh: true }).then(c => [c.context, c.source]), [16384, 'modelfile']);
  show = { model_info: QWEN_INFO };
  assert.deepEqual(await F.ollamaContext(`${BASE}/v1`, 'qwen2.5:7b', { fresh: true }).then(c => [c.context, c.trained, c.source]), [null, 32768, null],
    'not loaded, no Modelfile setting: the server default applies, which no API reports');
  ps = { models: [{ name: 'qwen2.5:latest', model: 'qwen2.5:latest', context_length: 8192 }] };
  assert.equal((await F.ollamaContext(`${BASE}/v1`, 'qwen2.5', { fresh: true })).context, 8192, 'a name without a tag is its :latest');
  const gone = await F.ollamaContext('http://127.0.0.1:9/v1', 'qwen2.5:7b');
  assert.deepEqual([gone.context, gone.trained, gone.source], [null, null, null], 'an Ollama that doesn’t answer: unknown, never an error');
});

test('a known context is kept for a minute (read before every step), an unknown one asked again', async () => {
  ps = loaded(4096);
  assert.equal((await F.ollamaContext(`${BASE}/v1`, 'qwen2.5:7b')).context, 4096);
  ps = loaded(32768);
  assert.equal((await F.ollamaContext(`${BASE}/v1`, 'qwen2.5:7b')).context, 4096, 'cached');
  assert.equal(F.knownContext(), 4096, 'the sync read compaction uses');
  assert.equal((await F.ollamaContext(`${BASE}/v1`, 'qwen2.5:7b', { fresh: true })).context, 32768);
  settings.set('llm', { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6-luna' });
  assert.equal(F.knownContext(), null, 'only Ollama reports its window');
  assert.equal(await F.currentContext(), null);
});

test('fit and cut: room for the reply; a prompt count far below what was sent is a cut prompt, a different tokenizer isn’t', () => {
  assert.equal(F.fitOf(24_600, null), null, 'unknown: not judged');
  assert.equal(F.fitOf(24_600, 32_768), null);
  const misfit = F.fitOf(24_600, 4096);
  assert.equal(misfit.context, 4096);
  assert.match(misfit.message, /Ollama gives it 4,096 tokens and this needs about 26,648/);
  assert.match(misfit.message, /OLLAMA_CONTEXT_LENGTH=32768/);
  assert.ok(F.fitOf(31_000, 32_768), 'no room left for the reply');
  assert.equal(F.promptWasCut({ sent: 24_599, reported: 2_050 }), true, 'the measured case: 2,050 of 24,599');
  assert.equal(F.promptWasCut({ sent: 24_599, reported: 21_000 }), false, 'another tokenizer counts a little differently');
  assert.equal(F.promptWasCut({ sent: 24_599, reported: 0 }), false, 'no usage reported: nothing to judge');
  assert.equal(F.promptWasCut({ sent: 1_500, reported: 300 }), false, 'too short to tell');
  assert.match(F.cutMessage({ sent: 24_599, reported: 2_050 }), /only read 2,050 of the about 24,599 tokens/);
});

test('the prompt is measured with its tool list, and pictures don’t count toward the cut check', () => {
  const tokens = F.promptTokensFor(admin);
  assert.ok(tokens > 5_000, `the tools and instructions are thousands of tokens (${tokens})`);
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hello there' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];
  assert.equal(F.requestTokens(msgs) - F.textTokens(msgs), 1600);
});

test('connection test: a 4,096 context warns with what to set; 32,768 doesn’t; unknown says so; other providers aren’t asked', async () => {
  ps = loaded(4096);
  const small = await F.connectionFit(admin);
  assert.equal(small.context, 4096);
  assert.equal(small.fits, false);
  assert.match(small.warning, /context of 4,096 tokens/);
  assert.match(small.warning, /OLLAMA_CONTEXT_LENGTH=32768/);
  assert.match(small.warning, /OLLAMA_FLASH_ATTENTION=1 and OLLAMA_KV_CACHE_TYPE=q8_0/);
  ps = loaded(32768);
  const ok = await F.connectionFit(admin);
  assert.equal(ok.fits, true);
  assert.equal(ok.warning, null);
  ps = { models: [] };
  const unknown = await F.connectionFit(admin);
  assert.equal(unknown.context, null);
  assert.match(unknown.warning, /didn’t say how much context/);
  ps = loaded(65536);
  show = { model_info: { 'general.architecture': 'llama', 'llama.context_length': 8192 } };
  assert.match((await F.connectionFit(admin)).warning, /was trained for 8,192 tokens/, 'a model that can’t hold the prompt at all');
  settings.set('llm', { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6-luna' });
  assert.equal(await F.connectionFit(admin), null);
});

test('a run whose request can’t fit the known context stops before the model is called, with what to set', async () => {
  ps = loaded(4096);
  const id = chatRun();
  const r = await settle(id);
  assert.equal(r.status, 'error');
  assert.match(r.error, /context window is too small/);
  assert.match(r.error, /OLLAMA_CONTEXT_LENGTH=32768/);
  assert.equal(streamed().length, 0, 'no model call on a prompt that would be cut');
});

test('a prompt the provider reports as cut stops the run, and the tool it asked for never runs', async () => {
  // The model isn't loaded yet (no context known), so the call goes out; Ollama answers from 2,050 tokens with a tool call.
  promptTokens = 2050;
  script = [{ tool: 'test_ctx_note' }];
  const id = chatRun();
  const r = await settle(id);
  assert.equal(r.status, 'error');
  assert.match(r.error, /only read 2,050 of the about [\d,]+ tokens/);
  assert.equal(executed, 0, 'nothing a cut prompt asked for runs');
  assert.equal(all(`SELECT 1 FROM messages WHERE run_id = ? AND role = 'tool'`, id).length, 0);
  assert.equal(streamed()[0].stream_options?.include_usage, true, 'Ollama is asked for its usage');
});

test('a prompt that fits runs as usual, its usage asked for, without OpenRouter’s fields', async () => {
  ps = loaded(32768);
  promptTokens = 26_000; // its own tokenizer: close to what was sent
  script = [{ tool: 'test_ctx_note' }, { text: 'Saved it.' }];
  const r = await settle(chatRun('Save a note.'));
  assert.equal(r.status, 'done', r.error);
  assert.equal(executed, 1);
  assert.equal(get('SELECT content FROM messages WHERE id = ?', r.reply_message_id).content, 'Saved it.');
  assert.ok(streamed().every(b => b.stream_options?.include_usage === true));
  for (const k of ['reasoning', 'models']) assert.ok(!(k in streamed()[0]), `no ${k} for Ollama`);
});

test('compaction aims below a small known window, and keeps the usual limits otherwise', () => {
  const usual = compactionLimits(null);
  assert.deepEqual([usual.target, usual.hard, usual.tail, usual.minMsgs, usual.small], [120_000, 200_000, 30_000, 20, false]);
  assert.equal(compactionLimits(1_000_000).small, false, 'a huge window: the usual numbers');
  const k32 = compactionLimits(32_768);
  assert.equal(k32.small, true);
  assert.equal(k32.hard, 32_768 - F.REPLY_ROOM);
  assert.equal(k32.target, Math.floor((32_768 - F.REPLY_ROOM) * 0.9));
  assert.ok(k32.tail < 3_000 && k32.tail >= 1_000, `a short verbatim tail (${k32.tail})`);
  assert.equal(k32.minMsgs, 6);
  const k128 = compactionLimits(131_072);
  assert.ok(k128.target < 120_000 && k128.minMsgs === 20);
});

test('a small reading kept from before Ollama was restarted with a bigger context doesn’t block the next run', async () => {
  ps = loaded(4096);
  assert.equal((await F.ollamaContext(`${BASE}/v1`, 'qwen2.5:7b')).context, 4096); // kept for a minute
  ps = loaded(32768); // the admin set OLLAMA_CONTEXT_LENGTH and restarted Ollama
  promptTokens = 26_000;
  script = [{ text: 'Hello again.' }];
  const r = await settle(chatRun('Hello?'));
  assert.equal(r.status, 'done', r.error);
  assert.equal(F.knownContext(), 32768);
});
