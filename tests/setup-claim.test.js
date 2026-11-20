// First-run safety: the setup code is needed to create the first admin from ANY device, including requests that arrive
// from 127.0.0.1 (a reverse proxy on the same machine makes every request look local). TRUST_PROXY decides who may set
// X-Forwarded-For. Run: npm test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-claim-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
delete process.env.JESSBOT_SETUP_CODE;
delete process.env.TRUST_PROXY;

const { openDb, closeDb } = await import('../src/db/index.js');
const { ensureDirs, parseTrustProxy, parseSetupCode } = await import('../src/config/index.js');
const { claimCodeIfNeeded } = await import('../src/services/setup.js');
const { countUsers } = await import('../src/services/users.js');
const { createApp } = await import('../src/app.js');
ensureDirs();
await openDb();

let server, base;
before(async () => { server = await listen(createApp()); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const account = (body, headers = {}) => fetch(`${base}/setup/account`, { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'jessbot', Origin: base, ...headers },
  body: JSON.stringify({ name: 'Owner', email: 'owner@claim.test', password: 'correct horse battery', ...body }) });

test('config: TRUST_PROXY and JESSBOT_SETUP_CODE are parsed strictly', () => {
  assert.equal(parseTrustProxy(undefined), 'loopback');
  assert.equal(parseTrustProxy('off'), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.deepEqual(parseTrustProxy('10.0.0.2, 172.16.0.0/12'), ['10.0.0.2', '172.16.0.0/12']);
  assert.throws(() => parseTrustProxy('true'), /would trust any client/);
  assert.deepEqual(parseSetupCode(''), {});
  assert.deepEqual(parseSetupCode('off'), { off: true });
  assert.deepEqual(parseSetupCode('my-long-code'), { fixed: 'MY-LONG-CODE' });
  assert.throws(() => parseSetupCode('short'), /at least 8/);
});

test('the setup page asks for the code even from this machine', async () => {
  const html = await (await fetch(`${base}/setup/account`)).text();
  assert.match(html, /name="claim"/);
});

test('no code, a wrong code, or a forwarded "local" request: no admin is created', async () => {
  for (const [body, headers] of [[{}, {}], [{ claim: 'WRONG-00000' }, {}], [{}, { 'X-Forwarded-For': '127.0.0.1' }]]) {
    const res = await account(body, headers);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.match((await res.json()).errors.claim, /doesn’t match/);
  }
  assert.equal(countUsers(), 0);
});

test('the right code (any case) creates the admin; the code is gone afterwards', async () => {
  const code = claimCodeIfNeeded();
  assert.match(code, /^[0-9A-F]{5}-[0-9A-F]{5}$/);
  const res = await account({ claim: code.toLowerCase() });
  assert.ok([200, 302, 303].includes(res.status), `status ${res.status}`);
  assert.equal(countUsers(), 1);
  assert.equal(claimCodeIfNeeded(), null);
});
