// Host and origin checks (decision #220): DNS rebinding and forged Host headers, PUBLIC_URL and ALLOWED_ORIGINS for
// cookie-authenticated changes and WebSocket upgrades, and links built from PUBLIC_URL. Run: npm test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-origin-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
for (const k of ['PUBLIC_URL', 'ALLOWED_HOSTS', 'ALLOWED_ORIGINS', 'HOST']) delete process.env[k];

const { openDb, closeDb, settings } = await import('../src/db/index.js');
const { ensureDirs, config } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const O = await import('../src/lib/origin.js');
const { createUser } = await import('../src/services/users.js');
const { createSession } = await import('../src/services/sessions.js');
const { createApp } = await import('../src/app.js');

let server, port, cookie;
before(async () => {
  const admin = await createUser({ name: 'Alex Admin', email: 'alex@origin.test', password: 'correct horse battery', role: 'admin' });
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  cookie = `jb_session=${createSession(admin.id)}`;
  server = await listen(createApp());
  port = server.address().port;
});
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

// A raw request, so the Host header can be anything (fetch won't let us forge it).
const raw = (method, pathname, headers = {}, body = null) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { Cookie: cookie, ...headers } }, res => {
    let data = ''; res.on('data', d => { data += d; }); res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});
const post = (host, origin) => raw('POST', '/admin/oversight', { Host: host, Origin: origin, 'Content-Type': 'application/json',
  'X-Requested-With': 'jessbot' }, JSON.stringify({ readChats: false }));

test('listening on loopback (the default): loopback names pass, any other Host is refused (DNS rebinding)', async () => {
  assert.equal(O.hostAllowed(`127.0.0.1:${port}`), true);
  assert.equal(O.hostAllowed('localhost:3737'), true);
  assert.equal(O.hostAllowed('[::1]:3737'), true);
  assert.equal(O.hostAllowed('evil.example:3737'), false);
  assert.equal((await raw('GET', '/login', { Host: `evil.example:${port}` })).status, 421);
  assert.notEqual((await raw('GET', '/login', { Host: `localhost:${port}` })).status, 421);
});

test('cookie changes: the request’s own host passes, another origin is refused', async () => {
  assert.equal((await post(`127.0.0.1:${port}`, `http://127.0.0.1:${port}`)).status, 200);
  assert.equal((await post(`127.0.0.1:${port}`, 'http://evil.example')).status, 403);
  assert.equal(O.originAllowed('not a url', 'localhost'), false);
});

test('PUBLIC_URL: its host and origin are expected; links use it, not the Host header', async () => {
  process.env.PUBLIC_URL = 'https://jess.example.org';
  try {
    assert.equal(O.hostAllowed('jess.example.org'), true);
    assert.equal(O.hostAllowed('other.example.org'), false);
    assert.equal(O.originAllowed('https://jess.example.org', '127.0.0.1:3737'), true, 'behind a proxy that rewrites Host');
    assert.equal(O.originAllowed('http://jess.example.org', 'evil.example'), false, 'scheme counts');
    assert.equal(O.baseUrl({ protocol: 'http', get: () => 'evil.example' }), 'https://jess.example.org');
    assert.equal((await post('jess.example.org', 'https://jess.example.org')).status, 200);
  } finally { delete process.env.PUBLIC_URL; }
});

test('ALLOWED_HOSTS and ALLOWED_ORIGINS add names; listening on all interfaces without PUBLIC_URL accepts any Host', () => {
  process.env.ALLOWED_HOSTS = 'jessbot.lan, 192.168.1.20';
  process.env.ALLOWED_ORIGINS = 'http://jessbot.lan:3737';
  try {
    assert.equal(O.hostAllowed('jessbot.lan:3737'), true);
    assert.equal(O.hostAllowed('192.168.1.20:3737'), true);
    assert.equal(O.originAllowed('http://jessbot.lan:3737', 'other'), true);
  } finally { delete process.env.ALLOWED_HOSTS; delete process.env.ALLOWED_ORIGINS; }
  const before = config.host;
  config.host = '0.0.0.0';
  try { assert.equal(O.hostAllowed('192.168.1.20:3737'), true); assert.equal(O.hostAllowed('anything.example'), true); } finally { config.host = before; }
});
