// The browser's pinned way out (decision #222, issue #9): every browser context goes through guard-proxy.js, so the
// browser never resolves a host name itself; the proxy resolves once with the checked lookup and connects to that address.
// Run: npm test  (needs the browser: npm run browser:install; local servers and a fake resolver, no internet).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-bproxy-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';

const { openDb, closeDb, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const out = await import('../src/lib/outbound.js');
const browser = await import('../src/browser/index.js');
const { guardProxy, stopGuardProxy, proxyRefused } = await import('../src/browser/guard-proxy.js');
const BROWSER = browser.browserStatus().installed;
const skip = !BROWSER && 'the browser is not installed (npm run browser:install)';

const hits = [];
let site, port;
before(async () => {
  site = await listen(http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>local page</title><p>reached</p>'); }));
  port = site.address().port;
});
afterEach(() => { hits.length = 0; out.setResolver(null); settings.set('browser', { allowPrivate: false }); });
after(async () => {
  await browser.closeBrowser().catch(() => {});
  await stopGuardProxy();
  site.close(); closeDb();
  fs.rmSync(HOME, { recursive: true, force: true });
});

const fakeDns = (...answers) => {
  const calls = [];
  out.setResolver((host, cb) => { calls.push(host); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; setImmediate(() => cb(null, [{ address: a, family: 4 }])); });
  return calls;
};

/** Talk to the proxy directly, the way the browser does. */
async function proxyRequest(lines, { auth = true } = {}) {
  const p = new URL((await guardProxy()).server);
  const { username, password } = await guardProxy();
  const cred = Buffer.from(`${username}:${password}`).toString('base64');
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(p.port), '127.0.0.1', () => s.write(`${lines.join('\r\n')}\r\n${auth ? `Proxy-Authorization: Basic ${cred}\r\n` : ''}\r\n`));
    let data = '';
    s.on('data', d => { data += d; if (/\r\n\r\n/.test(data)) { s.destroy(); resolve(data.split('\r\n')[0]); } });
    s.on('error', reject);
    s.setTimeout(5000, () => { s.destroy(); resolve(data.split('\r\n')[0] || 'timeout'); });
  });
}

test('guard proxy: listens on 127.0.0.1 only, needs its credential, refuses the local network', async () => {
  const p = await guardProxy();
  assert.match(p.server, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(p.bypass, '<-loopback>', 'localhost goes through the proxy too');
  assert.match(await proxyRequest([`CONNECT example.com:443 HTTP/1.1`, 'Host: example.com:443'], { auth: false }), / 407 /);
  fakeDns('127.0.0.1');
  const before = proxyRefused();
  assert.match(await proxyRequest([`CONNECT sneaky.example:${port} HTTP/1.1`, `Host: sneaky.example:${port}`]), / 403 /);
  assert.match(await proxyRequest([`CONNECT 127.0.0.1:${port} HTTP/1.1`, `Host: 127.0.0.1:${port}`]), / 403 /);
  assert.match(await proxyRequest([`GET http://127.0.0.1:${port}/x HTTP/1.1`, `Host: 127.0.0.1:${port}`]), / 403 /);
  assert.match(await proxyRequest([`GET http://sneaky.example:${port}/x HTTP/1.1`, `Host: sneaky.example:${port}`]), / 403 /);
  assert.equal(proxyRefused() - before, 4);
  assert.equal(hits.length, 0, 'nothing reached the local server');
});

test('browser (real): host names are resolved by the checked lookup, never by the browser itself', { skip }, async () => {
  // "site.test" exists only in the fake resolver: if the page loads, the browser asked our lookup, not the system's DNS.
  settings.set('browser', { allowPrivate: true });
  const calls = fakeDns('127.0.0.1');
  const title = await browser.withPage(async page => { await page.goto(`http://site.test:${port}/hello`); return page.title(); });
  assert.equal(title, 'local page');
  assert.ok(calls.includes('site.test'));
  assert.deepEqual(hits, ['/hello']);
});

test('browser (real): a name that passes the request guard and then answers 127.0.0.1 is refused at the connection', { skip }, async () => {
  // The request guard's lookup sees a public address; the next answer is this machine. Before, the browser made that next
  // lookup itself and connected; now the proxy makes it, checks it, and refuses.
  const calls = fakeDns('93.184.215.14', '127.0.0.1');
  const err = await browser.withPage(async page => page.goto(`http://rebind.test:${port}/secret`, { timeout: 10000 }).then(() => null, e => e));
  assert.ok(err, 'the page did not load');
  assert.ok(calls.length >= 2, 'the guard looked, then the proxy looked again (and checked)');
  assert.equal(hits.length, 0, 'the local server was never reached');
});

test('browser (real): loopback addresses are refused even without the request guard (no built-in bypass)', { skip }, async () => {
  const session = await browser.openSessionContext();
  const ctx = await session.browser().newContext({ proxy: await guardProxy() }); // a bare context: no route guard
  try {
    const page = await ctx.newPage();
    const err = await page.goto(`http://127.0.0.1:${port}/direct`, { timeout: 10000 }).then(r => (r && r.status() === 403 ? 'refused' : null), e => e);
    assert.ok(err, 'loopback did not load');
    const viaName = await page.goto(`http://localhost:${port}/direct`, { timeout: 10000 }).then(r => (r && r.status() === 403 ? 'refused' : null), e => e);
    assert.ok(viaName, 'localhost did not load');
    assert.equal(hits.length, 0);
  } finally { await ctx.close(); await session.close(); }
});
