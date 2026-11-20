// Model providers (#11): OpenRouter, Ollama and any OpenAI-compatible service. Ollama needs no key; OpenRouter-only request
// fields never reach another service; features only OpenRouter offers (voice, pictures, scans, quick decisions) are off,
// not failing; Ollama's model list leaves out embedding models. Run: npm test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-providers-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
for (const k of ['OPENROUTER_KEY', 'LLM_API_KEY', 'LLM_BASE_URL']) delete process.env[k];

const { openDb, closeDb, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const P = await import('../src/services/providers.js');
const L = await import('../src/services/llm.js');
const { allTools } = await import('../src/agent/tools/registry.js');
await import('../src/agent/tools/index.js');
const voice = await import('../src/services/voice.js');
const { ocrOffer } = await import('../src/services/ocr.js');
const { embedModel } = await import('../src/services/embeddings.js');
const { setSecret } = await import('../src/services/stored-secrets.js');
const { createUser } = await import('../src/services/users.js');

// A fake Ollama: /api/tags, and /v1/chat/completions that records each body and refuses a "think" request like Ollama.
const bodies = [];
let ollama, OLLAMA;
before(async () => {
  ollama = await listen(http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') {
        return res.end(JSON.stringify({ models: [
          { name: 'qwen2.5:7b', size: 4.7e9, modified_at: '2026-11-19T10:00:00Z', details: { family: 'qwen2', families: ['qwen2'] } },
          { name: 'nomic-embed-text:latest', size: 2.7e8, modified_at: '2026-11-20T10:00:00Z', details: { family: 'nomic-bert', families: ['nomic-bert'] } },
          { name: 'llama3.1:8b', size: 4.9e9, modified_at: '2026-11-18T10:00:00Z', details: { family: 'llama' } },
        ] }));
      }
      const body = JSON.parse(raw || '{}');
      bodies.push({ url: req.url, auth: req.headers.authorization, body });
      if ('reasoning' in body) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: `"${body.model}" does not support thinking` } })); }
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
    });
  }));
  OLLAMA = `http://127.0.0.1:${ollama.address().port}`;
  await createUser({ name: 'Alex Admin', email: 'alex@providers.test', password: 'correct horse battery', role: 'admin' });
});
after(() => { ollama?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });
const use = (provider, baseUrl, model = 'qwen2.5:7b') => settings.set('llm', { provider, baseUrl, model });
const offered = name => allTools().some(t => t.name === name && (!t.available || t.available({ id: 1 })));

test('which provider: the admin’s choice, else what the address says', () => {
  assert.equal(P.providerFor('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(P.providerFor('http://127.0.0.1:11434/v1'), 'ollama');
  assert.equal(P.providerFor('https://api.openai.com/v1'), 'compatible');
  settings.set('llm', { baseUrl: 'https://api.openai.com/v1' });
  assert.equal(P.currentProvider('https://api.openai.com/v1'), 'compatible', 'no choice saved (an older install)');
  settings.set('llm', { provider: 'ollama', baseUrl: 'http://ollama.lan:8080/v1' });
  assert.equal(P.currentProvider('http://ollama.lan:8080/v1'), 'ollama', 'Ollama on another port, chosen by name');
});

test('providerInput: each provider’s address and model rules, with plain field errors', () => {
  assert.deepEqual(L.providerInput({ provider: 'openrouter', baseUrl: 'https://evil.example/v1' }),
    { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6-luna' }, 'OpenRouter is its own address; its default model');
  assert.deepEqual(L.providerInput({ provider: 'ollama', model: 'qwen2.5:7b' }), { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' });
  const fails = (body, field, re) => assert.throws(() => L.providerInput(body), err => err.status === 422 && re.test(err.errors?.[field] || ''));
  fails({ provider: 'ollama' }, 'model', /Pick one of the models Ollama has/);
  fails({ provider: 'compatible', model: 'gpt-4o' }, 'baseUrl', /Enter the service’s address/);
  fails({ provider: 'compatible', baseUrl: 'ftp://x', model: 'gpt-4o' }, 'baseUrl', /isn’t a web address/);
  fails({ provider: 'compatible', baseUrl: 'https://x.example/v1', model: 'bad model id!' }, 'model', /model id/);
});

test('Ollama needs no key: ready without one, and the client sends a placeholder; another service still needs one', () => {
  use('ollama', `${OLLAMA}/v1`);
  assert.equal(L.llmState().ready, true);
  assert.equal(L.llmState().needsKey, false);
  use('compatible', 'https://api.example.com/v1', 'gpt-4o');
  assert.equal(L.llmState().ready, false);
  use('compatible', 'http://192.168.1.20:1234/v1', 'local-model');
  assert.equal(L.llmState().ready, true, 'a server on the local network (LM Studio) usually takes none');
  use('openrouter', 'https://openrouter.ai/api/v1', 'openai/gpt-6-luna');
  assert.equal(L.llmState().ready, false);
  setSecret('llm.apiKey', 'sk-or-v1-providers-test-key-0000000000000000');
  assert.equal(L.llmState().ready, true);
});

test('with Ollama: a real call works, without OpenRouter’s fields (Ollama refuses "reasoning")', async () => {
  use('ollama', `${OLLAMA}/v1`);
  bodies.length = 0;
  const t = await L.testConnection();
  assert.equal(t.ok, true, t.error);
  const sent = bodies.at(-1);
  assert.equal(sent.body.model, 'qwen2.5:7b');
  for (const k of ['reasoning', 'models', 'provider']) assert.ok(!(k in sent.body), `no ${k}`);
  assert.equal(sent.auth, 'Bearer no-key-needed');
  // The same strip for any request body (background jobs, OCR, tool calls…), not only the test.
  const seen = [];
  const f = L.withoutOpenRouterFields(async (url, init) => { seen.push(JSON.parse(init.body)); return new Response('{}'); });
  await f('http://x/v1/chat/completions', { body: JSON.stringify({ model: 'm', reasoning: { effort: 'low' }, models: ['a', 'b'], messages: [] }) });
  assert.deepEqual(seen[0], { model: 'm', messages: [] });
});

test('Ollama’s model list: chat models only, newest first; an unreachable Ollama says so', async () => {
  assert.deepEqual((await P.ollamaModels(`${OLLAMA}/v1`)).map(m => m.name), ['qwen2.5:7b', 'llama3.1:8b']);
  await assert.rejects(P.ollamaModels('http://127.0.0.1:9/v1'), /Ollama didn’t answer at http:\/\/127\.0\.0\.1:9/);
});

test('a saved key goes only to the address it was entered for; switching services asks for a new one', () => {
  settings.set('llm', { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6-luna', keyFor: 'https://openrouter.ai' });
  setSecret('llm.apiKey', 'sk-or-v1-providers-test-key-0000000000000000');
  assert.equal(L.llmSettings().apiKey, 'sk-or-v1-providers-test-key-0000000000000000');
  settings.set('llm', { ...settings.get('llm'), provider: 'compatible', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o' });
  assert.equal(L.llmSettings().apiKey, '', 'not sent to another service');
  assert.equal(L.llmState().ready, false);
  settings.set('llm', { ...settings.get('llm'), provider: 'ollama', baseUrl: `${OLLAMA}/v1`, keyFor: null });
  assert.equal(L.llmSettings().apiKey, '', 'Ollama never gets one');
});

test('features only OpenRouter offers are off with Ollama: tools not offered, voice refused plainly, no scan offer', async () => {
  use('ollama', `${OLLAMA}/v1`);
  settings.set('images', { model: 'google/gemini-image' });
  assert.equal(offered('reply_by_voice'), false);
  assert.equal(offered('make_image'), false);
  assert.equal(offered('ocr_document'), false);
  assert.equal(voice.voiceOn(), false);
  await assert.rejects(voice.transcribe(Buffer.alloc(100)), /Voice notes need OpenRouter as the model provider/);
  assert.equal(ocrOffer({ type: 'image', ext: 'png' }), null);
  assert.equal(embedModel().model, 'nomic-embed-text', 'Ollama’s embedding model by default');
  use('openrouter', 'https://openrouter.ai/api/v1', 'openai/gpt-6-luna');
  assert.equal(offered('reply_by_voice'), true);
  assert.equal(offered('make_image'), true);
  assert.equal(voice.voiceOn(), true);
  assert.equal(ocrOffer({ type: 'image', ext: 'png' }), 'picture');
  assert.equal(embedModel().model, 'openai/text-embedding-3-small');
  use('compatible', 'https://api.example.com/v1', 'gpt-4o');
  assert.equal(embedModel().model, '', 'an unknown service: memories found by their words');
  settings.set('images', {});
});

test('the feature table: every feature says what it needs for every provider, and why when it is off', () => {
  for (const f of P.FEATURES) {
    for (const p of Object.keys(P.PROVIDERS)) {
      assert.ok([true, false, 'model'].includes(f.on[p]), `${f.id} for ${p}`);
      if (f.on[p] !== true) assert.ok(f.without, `${f.id} says what happens without it`);
    }
  }
  assert.ok(P.featureSupport('ollama').some(f => f.id === 'voice' && f.on === false && /text only/.test(f.note)));
});
