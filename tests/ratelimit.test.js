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

test('sign-in limits survive a real restart of the server', async () => {
  closeDb(); // the server owns the database while it runs
  const port = await (async () => { const s = await listen(express()); const p = s.address().port; await new Promise(r => s.close(r)); return p; })();
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test' };
  const start = async () => {
    const child = spawn(process.execPath, ['server.js'], { cwd: path.join(import.meta.dirname, '..'), env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return child; } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 200));
    }
    child.kill(); throw new Error('server did not start');
  };
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
