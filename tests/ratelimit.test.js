// Rate limits that survive a restart (decision #228, issue #6): counters live in SQLite, one middleware for routes.
// Run: npm test  (throwaway data dir; the restart check runs the real server twice on a free local port).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-ratelimit-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
fs.writeFileSync(path.join(HOME, '.env'), '');

const { openDb, closeDb, settings, get } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const RL = await import('../src/lib/ratelimit.js');
const { HttpError } = await import('../src/lib/errors.js');
const { createUser } = await import('../src/services/users.js');

before(async () => {
  await createUser({ name: 'Rate Owner', email: 'owner@ratelimit.test', password: 'correct horse battery', role: 'admin', timezone: 'UTC' });
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
});
after(() => { closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

test('hit: counts in the database, so closing and reopening it (a restart) keeps the count', async () => {
  for (let i = 0; i < 3; i++) assert.equal(RL.hit('t:persist', { limit: 3, windowMs: 60e3 }).allowed, true);
  closeDb(); await openDb(); // what a restart does to the process's state
  const over = RL.hit('t:persist', { limit: 3, windowMs: 60e3 });
  assert.equal(over.allowed, false);
  assert.ok(over.retryInMs > 50e3 && over.retryInMs <= 60e3, `retry in ${over.retryInMs} ms`);
  RL.reset('t:persist');
  assert.equal(RL.hit('t:persist', { limit: 3, windowMs: 60e3 }).allowed, true, 'reset clears it');
});

test('hit: a window ends; keys never mix', async () => {
  assert.equal(RL.hit('t:short', { limit: 1, windowMs: 150 }).allowed, true);
  assert.equal(RL.hit('t:short', { limit: 1, windowMs: 150 }).allowed, false);
  assert.equal(RL.hit('t:other', { limit: 1, windowMs: 150 }).allowed, true);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(RL.hit('t:short', { limit: 1, windowMs: 150 }).allowed, true, 'a new window');
});

test('limiter: over the limit is a 429 through the error handler, with Retry-After and RateLimit headers', async () => {
  const app = express();
  app.use(RL.limiter({ name: 'test', limit: 2, windowMs: 60e3, message: m => `Slow down for ${m} min.` }));
  app.get('/x', (req, res) => res.json({ ok: true }));
  app.use((err, req, res, _next) => res.status(err.status).json({ error: err.message, http: err instanceof HttpError }));
  const server = await listen(app);
  try {
    const url = `http://127.0.0.1:${server.address().port}/x`;
    assert.equal((await fetch(url)).status, 200);
    const second = await fetch(url);
    assert.equal(second.status, 200);
    assert.match(second.headers.get('ratelimit-policy') || '', /q=2/);
    const third = await fetch(url);
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0);
    assert.deepEqual(await third.json(), { error: 'Slow down for 1 min.', http: true });
    assert.ok(get(`SELECT hits FROM rate_limits WHERE key LIKE 'rl:test:%'`).hits >= 3, 'stored in the database');
  } finally { server.close(); }
});

test('the app-wide limiter covers every route, file downloads and sign-in included (code scanning 43–57)', async () => {
  const { createApp } = await import('../src/app.js');
  const { createSession } = await import('../src/services/sessions.js');
  const { run } = await import('../src/db/index.js');
  const owner = get(`SELECT id FROM users WHERE email = 'owner@ratelimit.test'`);
  const token = createSession(owner.id, { kind: 'app', device: 'test' });
  const server = await listen(createApp());
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = r => fetch(`${base}${r}`, { headers: { Authorization: `Bearer ${token}` } });
  // The routes code scanning flagged: Library files, screenshots, favicons, feed covers, voice clips, backups, logs,
  // admin pages. With this person's bucket full, each one answers 429 before its handler runs.
  const routes = ['/library/abc/raw', '/library/abc/download', '/library/abc/thumb.jpg', '/library/abc/pages/1.jpg',
    '/shots/u1-0123456789abcdef.jpg', '/favicons/example.com', '/feed/covers/0123456789abcdef0123.jpg', '/api/v1/voice/abc',
    '/admin/system/backups/jessbot-manual-2026-01-01T00-00-00.tar.gz', '/admin/system/logs/jessbot-2026-01-01.log', '/admin', '/chat'];
  try {
    assert.equal((await as('/api/v1/me')).status, 200, 'not limited before'); // (the routes themselves aren't called unlimited: favicons would go online)
    run('INSERT OR REPLACE INTO rate_limits (key, hits, reset_at) VALUES (?, ?, ?)', `rl:requests:u${owner.id}`, 1200, Date.now() + 60e3);
    for (const r of routes) {
      const res = await as(r);
      assert.equal(res.status, 429, r);
      assert.ok(Number(res.headers.get('retry-after')) > 0, r);
    }
    // Signed out, the address is the key: GET /login and the API sign-in count against it too.
    await fetch(`${base}/login`);
    const key = get(`SELECT key FROM rate_limits WHERE key LIKE 'rl:requests:%' AND key NOT LIKE 'rl:requests:u%' LIMIT 1`).key;
    run('UPDATE rate_limits SET hits = 1200, reset_at = ? WHERE key = ?', Date.now() + 60e3, key);
    assert.equal((await fetch(`${base}/login`)).status, 429);
    assert.equal((await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 429);
  } finally {
    server.close();
    run(`DELETE FROM rate_limits WHERE key LIKE 'rl:requests:%'`);
  }
});

test('sign-in limits survive a real restart of the server', async () => {
  closeDb(); // the server owns the database while it runs
  const port = await (async () => { const s = await listen(express()); const p = s.address().port; await new Promise(r => s.close(r)); return p; })();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test' };
  // Started is when the server says it listens (a latch, not a polling budget): on a loaded machine a start can take
  // many seconds, most of it loading modules (decision #256). The deadline only catches a server that hangs; a server
  // that exits fails at once, with what it printed.
  const start = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: path.join(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const fail = why => { clearTimeout(hang); child.kill(); reject(new Error(`${why}\n${out.slice(-2000)}`)); };
    const hang = setTimeout(() => fail('the server did not say it was listening within 3 minutes'), 180_000);
    child.stderr.on('data', d => { out += d; });
    child.stdout.on('data', d => {
      out += d;
      if (/\[jessbot\] listening on /.test(out)) { clearTimeout(hang); child.removeAllListeners('exit'); resolve(child); }
    });
    child.once('exit', code => fail(`the server exited (code ${code}) before it was listening`));
  });
  const stop = child => new Promise(r => { child.once('exit', r); child.kill(); });
  const login = () => fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@ratelimit.test', password: 'wrong password!' }) }).then(r => r.status);
  let child = await start();
  try {
    const first = [];
    for (let i = 0; i < 8; i++) first.push(await login());
    assert.deepEqual(first, Array(8).fill(401), 'eight wrong passwords are allowed');
    assert.equal(await login(), 429, 'the ninth is refused');
    await stop(child);
    child = await start(); // a fresh process: nothing in memory
    assert.equal(await login(), 429, 'still refused after the restart');
  } finally {
    await stop(child);
    await openDb();
  }
});
