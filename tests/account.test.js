// Account security (decision #225, issue #6): two-step sign-in (TOTP + recovery codes), password change with session
// rotation, admin-made password reset links, stronger password hashing with rehash on sign-in.
// Run: npm test  (throwaway data dir; the real app on a local port; codes made with the same TOTP library).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TOTP, Secret } from 'otpauth';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-account-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
fs.writeFileSync(path.join(HOME, '.env'), '');

const { openDb, closeDb, settings, get, all, run } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const { createUser } = await import('../src/services/users.js');
const { createSession } = await import('../src/services/sessions.js');
const { needsRehash } = await import('../src/services/passwords.js');
const { createApp } = await import('../src/app.js');

const PW = 'correct horse battery';
let server, base, owner, sam, robin;
before(async () => {
  owner = await createUser({ name: 'Olive Owner', email: 'owner@account.test', password: PW, role: 'admin', timezone: 'UTC' });
  sam = await createUser({ name: 'Sam Member', email: 'sam@account.test', password: PW, timezone: 'UTC' });
  robin = await createUser({ name: 'Robin Member', email: 'robin@account.test', password: PW, timezone: 'UTC' });
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

/** A tiny browser: keeps cookies, sends the same-origin headers forms.js sends. */
function browser() {
  const jar = new Map();
  const call = async (method, url, body, { json = true } = {}) => {
    const headers = { Origin: base, Accept: 'application/json', 'X-Requested-With': 'jessbot' };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body) { headers['Content-Type'] = json ? 'application/json' : 'application/x-www-form-urlencoded'; payload = json ? JSON.stringify(body) : new URLSearchParams(body).toString(); }
    const res = await fetch(`${base}${url}`, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (!v || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, data, text, location: res.headers.get('location') };
  };
  return { call, jar };
}
const totpOf = secret => new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret.replace(/\s+/g, '')) });
// The next step's code (the current one was just used to turn it on, and a code works once).
const nextCode = (t, steps = 1) => t.generate({ timestamp: Date.now() + steps * 30e3 });

test('hashing: today’s parameters are stronger; an older hash is redone at the next sign-in', async () => {
  const row = () => get('SELECT password_hash FROM users WHERE id = ?', robin.id).password_hash;
  assert.match(row(), /^argon2id\$v=19\$m=65536,t=3,p=4\$/);
  // An account from before: the old OWASP-minimum parameters.
  const crypto = await import('node:crypto');
  const nonce = crypto.randomBytes(16);
  const old = crypto.argon2Sync('argon2id', { message: PW, nonce, memory: 19456, passes: 2, parallelism: 1, tagLength: 32 });
  run('UPDATE users SET password_hash = ? WHERE id = ?', `argon2id$v=19$m=19456,t=2,p=1$${nonce.toString('base64')}$${old.toString('base64')}`, robin.id);
  assert.equal(needsRehash(row()), true);
  const b = browser();
  const r = await b.call('POST', '/login', { email: 'robin@account.test', password: PW });
  assert.equal(r.status, 200);
  assert.ok(b.jar.has('jb_session'), 'signed in with the old hash');
  assert.equal(needsRehash(row()), false, 'and the hash was redone');
});

test('two-step sign-in: set up with the password, confirmed with a code; recovery codes shown once; other devices signed out', async () => {
  const b = browser();
  await b.call('POST', '/login', { email: 'sam@account.test', password: PW });
  const otherDevice = createSession(sam.id, { device: 'Old laptop' });
  assert.equal((await b.call('POST', '/api/v1/me/2fa/setup', { password: 'wrong password!' })).status, 422, 'the password first');
  const setup = await b.call('POST', '/api/v1/me/2fa/setup', { password: PW });
  assert.equal(setup.status, 200);
  assert.match(setup.data.uri, /^otpauth:\/\/totp\/Jessbot:sam%40account\.test\?/);
  assert.match(setup.data.html, /<svg/, 'a QR code');
  assert.equal(get('SELECT totp_enabled_at FROM users WHERE id = ?', sam.id).totp_enabled_at, null, 'not on until confirmed');
  const t = totpOf(setup.data.secret);
  assert.equal((await b.call('POST', '/api/v1/me/2fa/confirm', { code: '000000' })).status, 422);
  const ok = await b.call('POST', '/api/v1/me/2fa/confirm', { code: t.generate() });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.codes.length, 10);
  assert.equal(new Set(ok.data.codes).size, 10);
  assert.match(ok.data.codes[0], /^[0-9a-v]{4}-[0-9a-v]{4}-[0-9a-v]{4}$/);
  const stored = get('SELECT totp_secret FROM users WHERE id = ?', sam.id).totp_secret;
  assert.match(stored, /^v1:/, 'the secret is sealed');
  assert.ok(!stored.includes(setup.data.secret.replace(/\s+/g, '')));
  assert.equal(get('SELECT revoked_at FROM sessions WHERE token_hash = (SELECT token_hash FROM sessions WHERE user_id = ? AND device = ?)', sam.id, 'Old laptop').revoked_at !== null, true, 'the other device is signed out');
  assert.equal((await b.call('GET', '/api/v1/me')).status, 200, 'this one stays signed in');
  void otherDevice;
  sam.secret = setup.data.secret; sam.codes = ok.data.codes;
});

test('two-step sign-in: the password alone gets only to the code page; a code works once; recovery codes work once', async () => {
  const t = totpOf(sam.secret);
  const b = browser();
  const first = await b.call('POST', '/login', { email: 'sam@account.test', password: PW, next: '/library' });
  assert.equal(first.status, 200);
  assert.equal(first.data.redirect, '/login/code');
  assert.ok(!b.jar.has('jb_session'), 'no session yet');
  assert.ok(b.jar.has('jb_2fa'));
  assert.equal((await b.call('GET', '/api/v1/me')).status, 401);
  assert.equal((await b.call('POST', '/login/code', { code: '123456' })).status, 401);
  const code = nextCode(t);
  const done = await b.call('POST', '/login/code', { code });
  assert.equal(done.status, 200);
  assert.equal(done.data.redirect, '/library', 'back where they were going');
  assert.ok(b.jar.has('jb_session'));
  assert.ok(!b.jar.has('jb_2fa'), 'the challenge is gone');

  // The same code again (another device, same 30 seconds) is refused.
  const b2 = browser();
  await b2.call('POST', '/login', { email: 'sam@account.test', password: PW });
  const again = await b2.call('POST', '/login/code', { code });
  assert.equal(again.status, 401);
  assert.match(again.data.error, /just used/);
  // A recovery code works, once.
  const rc = await b2.call('POST', '/login/code', { code: sam.codes[0].toUpperCase().replace(/-/g, ' ') });
  assert.equal(rc.status, 200);
  assert.equal(rc.data.redirect, '/me/devices?recovery=used');
  const b3 = browser();
  await b3.call('POST', '/login', { email: 'sam@account.test', password: PW });
  assert.equal((await b3.call('POST', '/login/code', { code: sam.codes[0] })).status, 401, 'a used recovery code is spent');
  // Without the password step there is no code page.
  const b4 = browser();
  assert.equal((await b4.call('GET', '/login/code')).location, '/login');
});

test('two-step sign-in: five wrong codes and the sixth is refused for a while (stored, like every limit)', async () => {
  const b = browser();
  await b.call('POST', '/login', { email: 'sam@account.test', password: PW });
  run(`DELETE FROM rate_limits WHERE key = ?`, `2fa:${sam.id}`);
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await b.call('POST', '/login/code', { code: String(100000 + i) })).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  assert.ok(get('SELECT hits FROM rate_limits WHERE key = ?', `2fa:${sam.id}`).hits >= 6);
  run(`DELETE FROM rate_limits WHERE key = ?`, `2fa:${sam.id}`);
});

test('two-step sign-in in the app API: without a code a 401 that says so; with one, a token', async () => {
  const t = totpOf(sam.secret);
  const api = body => fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, data: await r.json() }));
  run('UPDATE users SET totp_last_step = NULL WHERE id = ?', sam.id); // as if a minute had passed since the last code
  const no = await api({ email: 'sam@account.test', password: PW });
  assert.equal(no.status, 401);
  assert.equal(no.data.code, 'two_factor_required');
  assert.ok(!no.data.token);
  const yes = await api({ email: 'sam@account.test', password: PW, code: nextCode(t, -1) });
  assert.equal(yes.status, 200);
  assert.ok(yes.data.token);
});

test('changing the password: needs the current one; signs out every device and gives this one a new session', async () => {
  const b = browser();
  await b.call('POST', '/login', { email: 'robin@account.test', password: PW });
  const oldCookie = b.jar.get('jb_session');
  const app = createSession(robin.id, { kind: 'app', device: 'Phone' });
  const bad = await b.call('POST', '/api/v1/me/password', { current: 'nope nope nope', password: 'a brand new phrase', confirm: 'a brand new phrase' });
  assert.equal(bad.status, 422);
  assert.ok(bad.data.errors.current);
  const mismatch = await b.call('POST', '/api/v1/me/password', { current: PW, password: 'a brand new phrase', confirm: 'something else' });
  assert.equal(mismatch.status, 422);
  const ok = await b.call('POST', '/api/v1/me/password', { current: PW, password: 'a brand new phrase', confirm: 'a brand new phrase' });
  assert.equal(ok.status, 200);
  assert.notEqual(b.jar.get('jb_session'), oldCookie, 'a fresh session here');
  assert.equal((await b.call('GET', '/api/v1/me')).status, 200);
  const stale = await fetch(`${base}/api/v1/me`, { headers: { Cookie: `jb_session=${oldCookie}` } });
  assert.equal(stale.status, 401, 'the old session token is dead');
  const phone = await fetch(`${base}/api/v1/me`, { headers: { Authorization: `Bearer ${app}` } });
  assert.equal(phone.status, 401, 'the app is signed out too');
  run('UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE id = ?) WHERE id = ?', owner.id, robin.id); // back to PW
});

test('reset link: only an admin makes one; it works once, signs out everywhere, and keeps two-step sign-in', async () => {
  const admin = browser();
  await admin.call('POST', '/login', { email: 'owner@account.test', password: PW });
  const member = browser();
  await member.call('POST', '/login', { email: 'robin@account.test', password: PW });
  assert.equal((await member.call('POST', `/admin/people/${sam.id}/reset-link`)).status, 403, 'members can’t');
  assert.equal((await admin.call('POST', `/admin/people/${owner.id}/reset-link`)).status, 400, 'not for yourself');
  const made = await admin.call('POST', `/admin/people/${sam.id}/reset-link`);
  assert.equal(made.status, 200);
  const link = new URL(made.data.link);
  assert.match(link.pathname, /^\/reset\/[\w-]{43}$/);
  const token = link.pathname.split('/').pop();
  assert.equal(get('SELECT COUNT(*) AS n FROM password_resets WHERE token_hash = ?', token).n, 0, 'only a hash is stored');
  const samSession = createSession(sam.id, { device: 'Sam laptop' });

  const page = await fetch(`${base}${link.pathname}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const guest = browser();
  const weak = await guest.call('POST', link.pathname, { password: 'short', confirm: 'short' });
  assert.equal(weak.status, 422);
  const set = await guest.call('POST', link.pathname, { password: 'sam picks a new one', confirm: 'sam picks a new one' });
  assert.equal(set.status, 200);
  assert.equal(set.data.redirect, '/login?reset=1');
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: { Authorization: `Bearer ${samSession}` } })).status, 401, 'signed out everywhere');
  assert.equal((await fetch(`${base}${link.pathname}`)).status, 410, 'used once');
  assert.equal((await guest.call('POST', link.pathname, { password: 'another new one!', confirm: 'another new one!' })).status, 410);
  // The new password works, and two-step sign-in is still asked for.
  const b = browser();
  const r = await b.call('POST', '/login', { email: 'sam@account.test', password: 'sam picks a new one' });
  assert.equal(r.data.redirect, '/login/code');
  // A newer link replaces an older one; an expired one is dead.
  const a1 = new URL((await admin.call('POST', `/admin/people/${robin.id}/reset-link`)).data.link);
  const a2 = new URL((await admin.call('POST', `/admin/people/${robin.id}/reset-link`)).data.link);
  assert.equal((await fetch(`${base}${a1.pathname}`)).status, 410);
  run(`UPDATE password_resets SET expires_at = datetime('now', '-1 minute') WHERE user_id = ? AND used_at IS NULL`, robin.id);
  assert.equal((await fetch(`${base}${a2.pathname}`)).status, 410);
});

test('an admin can turn off someone’s two-step sign-in (lost phone and codes); it is audited and signs them out', async () => {
  const admin = browser();
  await admin.call('POST', '/login', { email: 'owner@account.test', password: PW });
  const s = createSession(sam.id, { device: 'Sam tablet' });
  const r = await admin.call('POST', `/admin/people/${sam.id}/2fa-off`, {});
  assert.equal(r.status, 200);
  assert.equal(get('SELECT totp_enabled_at FROM users WHERE id = ?', sam.id).totp_enabled_at, null);
  assert.equal(get('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?', sam.id).n, 0);
  assert.equal((await fetch(`${base}/api/v1/me`, { headers: { Authorization: `Bearer ${s}` } })).status, 401);
  const rows = all(`SELECT action, actor_id, target_id FROM audit_log WHERE action LIKE 'auth.2fa%'`);
  assert.ok(rows.some(a => a.action === 'auth.2fa_off' && a.target_id === String(sam.id) && a.actor_id === owner.id), JSON.stringify(rows));
});

test('npm run reset-link prints a working link for the owner (the locked-out case)', () => {
  closeDb();
  try {
    const out = spawnSync(process.execPath, ['scripts/reset-link.js', 'owner@account.test'], { cwd: path.join(import.meta.dirname, '..'), env: process.env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /\/reset\/[\w-]{43}/);
    const none = spawnSync(process.execPath, ['scripts/reset-link.js', 'nobody@account.test'], { cwd: path.join(import.meta.dirname, '..'), env: process.env, encoding: 'utf8' });
    assert.equal(none.status, 1);
  } finally { openDb(); }
});
