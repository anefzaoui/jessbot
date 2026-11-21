// Small code/doc mismatches found while writing the user guide (#55): what each page, hint and the doctor say exists under
// that name today, and the web app manifest the docs and the roadmap promised (decision #253). Run: npm test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-docs-code-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
for (const k of ['OPENROUTER_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL']) delete process.env[k];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { openDb, closeDb, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
const { createApp } = await import('../src/app.js');
const { doctor } = await import('../src/services/system.js');
const { llmSettings } = await import('../src/services/llm.js');
ensureDirs();
await openDb();

let server, base;
before(async () => { server = await listen(createApp()); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the manifest is served before setup and sign-in, names the assistant, and its icons are public files', async () => {
  const res = await fetch(`${base}/manifest.webmanifest`, { redirect: 'manual' });
  assert.equal(res.status, 200, 'not sent to /setup: the browser fetches it without the session cookie');
  assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
  const m = await res.json();
  assert.equal(m.name, 'Jessbot', 'before the identity step: the page title’s own default');
  assert.deepEqual([m.start_url, m.scope, m.display], ['/', '/', 'standalone']);
  assert.ok(m.icons.some(i => i.sizes === '192x192') && m.icons.some(i => i.sizes === '512x512'), 'the sizes installing needs');
  for (const icon of m.icons) {
    const r = await fetch(`${base}${icon.src}`);
    assert.equal(r.status, 200, `${icon.src} is served`);
    assert.equal(r.headers.get('content-type'), icon.type);
  }
  settings.set('bot', { name: 'Robin', variant: 'male' });
  const robin = await (await fetch(`${base}/manifest.webmanifest`)).json();
  assert.equal(robin.name, 'Robin');
  assert.ok(robin.icons.every(i => i.src.startsWith('/img/avatars/male/')), 'another look: its own portrait, not Jess');
  settings.set('bot', { name: 'Robin', variant: 'female' });
  assert.ok((await (await fetch(`${base}/manifest.webmanifest`)).json()).icons.every(i => i.src.startsWith('/img/app/')));
});

test('every page links the manifest and the home-screen icon', () => {
  const head = read('src/views/partials/shell/head.hbs');
  assert.match(head, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(head, /<link rel="apple-touch-icon" href="\/img\/app\/apple-touch-icon\.png">/);
  for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
    assert.ok(fs.readFileSync(path.join(ROOT, 'public/img/app', f)).equals(fs.readFileSync(path.join(ROOT, 'docs/images/brand', f))), `${f}: the logo's own file`);
  }
});

test('the doctor names the tab as it is (Admin → Models) and the key of the provider in use', () => {
  settings.set('llm', { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6-luna' });
  const model = doctor().checks.find(c => c.id === 'model');
  assert.equal(model.status, 'bad');
  assert.equal(model.fix, 'Add the OpenRouter key in Admin → Models.');
});

test('LLM_BASE_URL and LLM_MODEL only fill in setup: once a provider is saved, it wins (and the docs say so)', async () => {
  const { config } = await import('../src/config/index.js');
  settings.set('llm', {});
  assert.equal(llmSettings().model, config.llm.model, 'nothing saved yet: the .env default (LLM_MODEL, else the built-in one)');
  settings.set('llm', { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' });
  assert.deepEqual([llmSettings().baseUrl, llmSettings().model], ['http://127.0.0.1:11434/v1', 'qwen2.5:7b'], 'saved: .env is not read');
  assert.match(read('.env.example'), /saved ones are used and these lines are ignored/);
  assert.match(read('docs/guide/providers.md'), /those two lines are ignored/);
});

test('texts that named things that don’t exist: the approvals empty state, HOST, the backups card', () => {
  const approvals = read('src/views/pages/approvals.hbs');
  assert.doesNotMatch(approvals, /in your profile/, 'there is no approvals control in the profile');
  assert.match(approvals, /Always allow/);
  assert.doesNotMatch(read('.env.example'), /HOST=0\.0\.0\.0 only behind a reverse proxy/, 'the README and the guide: 0.0.0.0 for the home network');
  assert.match(read('src/views/pages/admin/system.hbs'), /neither is the install key/);
});
