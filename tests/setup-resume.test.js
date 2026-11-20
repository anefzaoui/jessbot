// Coming back to an unfinished setup (#50): the owner who made their account with the setup code and then lost the
// session (closed the browser, cleared cookies) is asked to sign in, and lands back in the wizard; nothing loops between
// /setup and /login, for a signed-out visitor or for a member who joined by invite before setup finished. Run: npm test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-resume-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
process.env.JESSBOT_SETUP_CODE = 'resume-setup-code';
delete process.env.TRUST_PROXY;

const { openDb, closeDb } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
const { claimCodeIfNeeded } = await import('../src/services/setup.js');
const { createUser } = await import('../src/services/users.js');
const { createSession } = await import('../src/services/sessions.js');
const { createApp } = await import('../src/app.js');
ensureDirs();
await openDb();

let server, base;
before(async () => { claimCodeIfNeeded(); server = await listen(createApp()); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const cookieOf = res => (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).find(c => c.startsWith('jb_session=')) || null;
// Follow redirects by hand like a browser (it gives up after 20), recording each address.
async function visit(pathname, cookie = null) {
  const hops = [];
  let url = `${base}${pathname}`;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(url, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
    hops.push(`${res.status} ${new URL(url).pathname}${new URL(url).search}`);
    if (res.status < 300 || res.status >= 400) return { res, hops, html: await res.text() };
    url = new URL(res.headers.get('location'), url).href;
  }
  return { res: null, hops, html: '' };
}
const post = (pathname, body, cookie = null) => fetch(`${base}${pathname}`, { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'jessbot', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body) });

test('before any account: sign-in pages still lead to the wizard', async () => {
  const { res, hops } = await visit('/login');
  assert.equal(res.status, 200);
  assert.match(hops.at(-1), /\/setup\/account/);
});

test('the owner closes the browser mid-setup, comes back, signs in, and is back in the wizard (no loop)', async () => {
  const made = await post('/setup/account', { name: 'Sam Rivera', email: 'owner@resume.test', password: 'correct horse battery', claim: 'resume-setup-code' });
  assert.equal(made.status, 200, await made.clone().text());
  const first = cookieOf(made);
  assert.ok(first, 'signed in by making the account');
  assert.match((await visit('/setup', first)).hops.at(-1), /^200 \/setup\/model/, 'on the next step');

  // The browser is closed: no cookie any more.
  for (const start of ['/setup', '/', '/chat', '/login']) {
    const { res, hops, html } = await visit(start);
    assert.ok(res, `${start} loops: ${hops.join(' → ')}`);
    assert.equal(res.status, 200, `${start}: ${hops.join(' → ')}`);
    assert.match(hops.at(-1), /^200 \/login/, `${start} ends on the sign-in page`);
    assert.match(html, /Setup isn’t finished yet/);
    assert.doesNotMatch(html, /Ask the person who runs this/, 'no invite hint for the owner');
  }
  const signedIn = await post('/login', { email: 'owner@resume.test', password: 'correct horse battery', next: '/setup' });
  assert.equal(signedIn.status, 200);
  assert.equal((await signedIn.json()).redirect, '/setup');
  const back = cookieOf(signedIn);
  const { hops } = await visit('/setup', back);
  assert.match(hops.at(-1), /^200 \/setup\/model/, 'where they left off');
  // A wrong password is an ordinary refusal, not a loop.
  assert.ok([401, 422].includes((await post('/login', { email: 'owner@resume.test', password: 'wrong password here', next: '/setup' })).status));
});

test('a member who joined before setup finished gets a plain "not ready" page, not a loop', async () => {
  const member = await createUser({ name: 'Maya Member', email: 'maya@resume.test', password: 'correct horse battery' });
  const cookie = `jb_session=${createSession(member.id)}`;
  for (const start of ['/setup', '/chat', '/login']) {
    const { res, hops, html } = await visit(start, cookie);
    assert.ok(res, `${start} loops: ${hops.join(' → ')}`);
    assert.equal(res.status, 403, `${start}: ${hops.join(' → ')}`);
    assert.match(html, /The owner is still setting things up/);
  }
});
