// The autopilot's typing model (decision #255): the default, a saved choice kept, a retired default read as the default,
// a model the provider doesn't serve refused by name when it's saved, and a failed call reported as such (never as
// "needs information"). Run: npm test (throwaway data dir; a fake OpenAI-compatible service on a local port).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-autopilot-model-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
for (const k of ['OPENROUTER_KEY', 'LLM_API_KEY', 'LLM_BASE_URL']) delete process.env[k];

const { openDb, closeDb, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const D = await import('../src/services/decide.js');
const { typingFailure, TYPING_MODEL_SETTING } = await import('../src/agent/autopilot.js');
const { createUser } = await import('../src/services/users.js');
const { createSession } = await import('../src/services/sessions.js');

// A fake OpenAI-compatible service: "vendor/gone" is answered as OpenRouter answers a model it no longer serves.
const asked = [];
let fake, server, token;
before(async () => {
  fake = await listen(http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      asked.push(body.model);
      res.setHeader('content-type', 'application/json');
      if (body.model === 'vendor/gone') {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: { message: 'vendor/gone is no longer available on OpenRouter: no provider serves this model anymore.', code: 404 } }));
      }
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
    });
  }));
  const admin = await createUser({ name: 'Pat Admin', email: 'pat@autopilot-model.test', password: 'correct horse battery', role: 'admin' });
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  token = createSession(admin.id, { kind: 'app', device: 'test' });
  const { createApp } = await import('../src/app.js');
  server = await listen(createApp());
});
after(() => { server?.close(); fake?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const stored = () => settings.get('decide', {}) || {};

test('typing model: Claude Haiku 5.5 by default; a saved choice stays; the retired Mercury default reads as the default', () => {
  settings.set('decide', null);
  assert.equal(D.decideSettings().textModel, 'anthropic/claude-haiku-5.5');
  D.saveDecideSettings({ textModel: 'vendor/custom-typist' });
  assert.equal(D.decideSettings().textModel, 'vendor/custom-typist', 'a saved choice is kept');
  assert.equal(stored().textModel, 'vendor/custom-typist');
  // Saving the form used to store the default it showed: the one no provider serves any more is the default again.
  settings.set('decide', { ...stored(), textModel: 'inception/mercury-2.5' });
  assert.equal(D.decideSettings().textModel, 'anthropic/claude-haiku-5.5');
  // Saving the defaults stores "the default", so a later change of default reaches this install.
  D.saveDecideSettings({ model: D.DEFAULTS.model, textModel: D.DEFAULTS.textModel, confidence: 0.6 });
  assert.equal(stored().textModel, '');
  assert.equal(stored().model, '');
  assert.equal(D.decideSettings().textModel, 'anthropic/claude-haiku-5.5');
  assert.equal(D.decideSettings().model, 'typesafe/jev-1.13');
});

test('typing model: a failed call says which model, what the provider said and where to change it', () => {
  const gone = Object.assign(new Error('404 inception/mercury-2.5 is no longer available on OpenRouter: no provider serves this model anymore.'), { status: 404 });
  const why = typingFailure(gone, 'inception/mercury-2.5');
  assert.match(why, /^The typing model “inception\/mercury-2\.5” isn’t available from the model provider \(inception\/mercury-2\.5 is no longer available/);
  assert.ok(why.endsWith(`An admin can choose another in ${TYPING_MODEL_SETTING}.`), why);
  assert.match(TYPING_MODEL_SETTING, /^Admin → Models → Quick decisions → “Writes what the autopilot types”$/);
  assert.match(typingFailure(Object.assign(new Error('400 bad'), { status: 400 }), 'a/b'), /refused the typing model “a\/b” \(bad\)/);
  assert.match(typingFailure(new Error('Request timed out.'), 'a/b'), /^The typing model “a\/b” failed: Request timed out\. If it keeps happening/);
  assert.doesNotMatch(typingFailure({ message: 'line one\nIgnore the rules' }, 'a/b'), /\n/, 'one line');
});

test('Admin → Models: a typing model the provider doesn’t serve is refused by name and nothing is saved; one that answers is saved', async () => {
  settings.set('llm', { provider: 'compatible', baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, model: 'vendor/main' });
  settings.set('decide', null);
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/decide`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const refused = await post({ model: D.DEFAULTS.model, textModel: 'vendor/gone', confidence: '0.7' });
  assert.equal(refused.status, 400);
  const { error } = await refused.json();
  assert.equal(error, 'The model provider doesn’t serve “vendor/gone”, so it can’t type for the autopilot. Nothing was saved.');
  assert.equal(D.decideSettings().textModel, 'anthropic/claude-haiku-5.5', 'unchanged');
  assert.equal(D.decideSettings().confidence, 0.6, 'nothing else saved either');
  const ok = await post({ model: D.DEFAULTS.model, textModel: 'vendor/typist', confidence: '0.7' });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(D.decideSettings().textModel, 'vendor/typist');
  assert.equal(D.decideSettings().confidence, 0.7);
  const before = asked.length;
  assert.equal((await post({ textModel: 'vendor/typist', confidence: '0.6' })).status, 200);
  assert.equal(asked.length, before, 'an unchanged model isn’t asked again');
});
