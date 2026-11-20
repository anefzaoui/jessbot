// Outbound requests (decision #221, issue #9): every server-side fetch and mail/calendar connection refuses this machine
// and the local network unless the admin allowed it, connects to the address it checked (one lookup, no second one a
// changing DNS answer could slip through), and checks every redirect hop again.
// Run: npm test  (throwaway data dir; local test servers on 127.0.0.1 and a fake resolver, no internet needed).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-outbound-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';

const { openDb, closeDb, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const out = await import('../src/lib/outbound.js');

// Two local servers: A (the "admin's endpoint") and B (somewhere else on this machine). Each records what reached it.
const hits = { a: [], b: [] };
let A, B, baseA, baseB;
const server = name => http.createServer((req, res) => {
  hits[name].push({ url: req.url, headers: req.headers });
  const to = new URL(req.url, 'http://x').searchParams.get('to');
  if (to) { res.writeHead(302, { location: to }); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`hello from ${name}`);
});
before(async () => {
  A = await listen(server('a')); B = await listen(server('b'));
  baseA = `http://127.0.0.1:${A.address().port}`; baseB = `http://127.0.0.1:${B.address().port}`;
});
afterEach(() => { hits.a.length = 0; hits.b.length = 0; out.setResolver(null); settings.set('browser', { allowPrivate: false }); });
after(async () => {
  A.close(); B.close(); closeDb();
  fs.rmSync(HOME, { recursive: true, force: true });
});

/** A fake DNS: answers[i] for the i-th lookup (the last one repeats); counts lookups. */
function fakeDns(...answers) {
  const calls = [];
  out.setResolver((host, cb) => {
    calls.push(host);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    setImmediate(() => cb(null, [].concat(a).map(address => ({ address, family: address.includes(':') ? 6 : 4 }))));
  });
  return calls;
}

test('outbound: loopback, LAN, link-local and IPv4 hidden inside IPv6 are private; public addresses are not', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::1', '::',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '2002:7f00:1::1',
    '2002:c0a8:101::', 'fd00::1', 'fe80::1%eth0', '[::1]', 'ff02::1', '224.0.0.1', '255.255.255.255', 'not-an-ip', '']) {
    assert.equal(out.isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) {
    assert.equal(out.isPrivateIp(ip), false, ip);
  }
  for (const h of ['localhost', 'foo.localhost', 'printer.local', 'db.internal', 'nas.lan', 'box.home.arpa', 'intranet', 'localhost.']) {
    assert.equal(out.isPrivateName(h), true, h);
  }
  assert.equal(out.isPrivateName('example.com'), false);
});

test('outbound: a host name that resolves to 127.0.0.1 is refused, and nothing reaches the local server', async () => {
  fakeDns('127.0.0.1');
  const port = A.address().port;
  await assert.rejects(out.outboundFetch(`http://sneaky.example:${port}/`), err => err.code === 'EBLOCKED');
  await assert.rejects(out.outboundFetch(`${baseA}/`), err => err.code === 'EBLOCKED', 'an IP literal too');
  await assert.rejects(out.outboundFetch(`http://localhost:${port}/`), err => err.code === 'EBLOCKED', 'and localhost by name');
  await assert.rejects(out.outboundFetch(`http://[::ffff:7f00:1]:${port}/`), err => err.code === 'EBLOCKED', 'and IPv4-mapped IPv6');
  await assert.rejects(out.outboundFetch('file:///etc/passwd'), err => err.code === 'EBLOCKED', 'and anything not http(s)');
  fakeDns(['93.184.215.14', '127.0.0.1']);
  await assert.rejects(out.outboundFetch(`http://mixed.example:${port}/`), err => err.code === 'EBLOCKED', 'a mixed answer is refused whole');
  assert.equal(hits.a.length, 0);
});

test('outbound: a rebinding name cannot switch the address after the check (one lookup, the connection uses it)', async () => {
  // The old way checked a name, then let fetch look it up again. A name that answers "public" to the check and "127.0.0.1"
  // to the second lookup got through. Now there is one lookup, and the connection goes to what it answered.
  const calls = fakeDns('192.0.43.10', '127.0.0.1'); // a public address first (unreachable here), then this machine
  const port = A.address().port;
  await assert.rejects(out.outboundFetch(`http://rebind.example:${port}/`, { signal: AbortSignal.timeout(1500) }));
  assert.equal(calls.length, 1, 'the name was looked up once');
  assert.equal(hits.a.length, 0, 'the second answer (this machine) was never used');

  // And the lookup a connection makes is the one that was checked: with the local network allowed, a name answering
  // 127.0.0.1 first and 127.0.0.2 afterwards connects to 127.0.0.1 (where the server is) after a single lookup.
  settings.set('browser', { allowPrivate: true });
  const calls2 = fakeDns('127.0.0.1', '127.0.0.2');
  const res = await out.outboundFetch(`http://flip.example:${port}/`);
  assert.equal(await res.text(), 'hello from a');
  assert.equal(calls2.length, 1);
});

test('outbound: the checked lookup hands the socket only the addresses it checked', async () => {
  fakeDns('8.8.8.8', '127.0.0.1');
  const lookup = out.checkedLookup();
  const got = await new Promise((resolve, reject) => lookup('flip.example', { all: true }, (e, list) => (e ? reject(e) : resolve(list))));
  assert.deepEqual(got, [{ address: '8.8.8.8', family: 4 }]);
  const second = await new Promise(resolve => lookup('flip.example', {}, (e, a) => resolve(e || a)));
  assert.equal(second.code, 'EBLOCKED', 'the next lookup is checked again, never trusted from before');
});

test('outbound: the admin switch allows the local network; an admin endpoint is trusted for its own origin only', async () => {
  await assert.rejects(out.outboundFetch(`${baseA}/`), err => err.code === 'EBLOCKED');
  const res = await out.outboundFetch(`${baseA}/x`, {}, { trustedOrigin: baseA });
  assert.equal(await res.text(), 'hello from a');
  // A redirect from the admin's endpoint to another local address is held to the public-only rule.
  await assert.rejects(out.outboundFetch(`${baseA}/r?to=${encodeURIComponent(`${baseB}/secret`)}`, {}, { trustedOrigin: baseA }),
    err => err.code === 'EBLOCKED');
  assert.equal(hits.b.length, 0, 'the redirect target was never contacted');
  // A redirect inside the same origin is fine.
  const same = await out.outboundFetch(`${baseA}/r?to=/inside`, {}, { trustedOrigin: baseA });
  assert.equal(same.status, 200);
  assert.equal(hits.a.at(-1).url, '/inside');

  settings.set('browser', { allowPrivate: true });
  const open = await out.outboundFetch(`${baseB}/`);
  assert.equal(await open.text(), 'hello from b', 'the admin allowed the local network');
});

test('outbound: credentials never follow a redirect to another origin; redirects are capped', async () => {
  settings.set('browser', { allowPrivate: true });
  const res = await out.outboundFetch(`${baseA}/r?to=${encodeURIComponent(`${baseB}/landing`)}`,
    { headers: { Authorization: 'Bearer test-only', Cookie: 'a=b', 'X-Keep': '1' } });
  assert.equal(res.status, 200);
  const landed = hits.b.at(-1);
  assert.equal(landed.headers.authorization, undefined);
  assert.equal(landed.headers.cookie, undefined);
  assert.equal(landed.headers['x-keep'], '1');
  assert.equal(hits.a[0].headers.authorization, 'Bearer test-only', 'the first hop had it');
  const twice = `${baseA}/r?to=${encodeURIComponent('/r?to=/x')}`; // two redirects in a row
  await assert.rejects(out.outboundFetch(twice, {}, { maxRedirects: 1 }), /too many redirects/);
  assert.equal((await out.outboundFetch(twice, {}, { maxRedirects: 2 })).status, 200);
  const manual = await out.outboundFetch(`${baseA}/r?to=/x`, { redirect: 'manual' });
  assert.equal(manual.status, 302, 'redirect: manual hands back the redirect');
});

test('outbound: mail servers resolve once and connect to the checked address, name kept for TLS', async () => {
  const { reachableTarget } = await import('../src/services/connections.js');
  fakeDns('127.0.0.1');
  await assert.rejects(reachableTarget('imap.sneaky.example'), err => err.code === 'EBLOCKED' && err.status === 400 && /local network/.test(err.message));
  await assert.rejects(reachableTarget('10.0.0.5'), err => err.code === 'EBLOCKED');
  fakeDns('203.0.114.7', '127.0.0.1');
  assert.deepEqual(await reachableTarget('imap.example.com'), { host: '203.0.114.7', servername: 'imap.example.com', address: '203.0.114.7' });
  settings.set('browser', { allowPrivate: true });
  fakeDns('127.0.0.1');
  assert.equal((await reachableTarget('mail.home.example')).host, '127.0.0.1');
});

test('outbound: a calendar server on the local network is refused through its fetch, redirects included', async () => {
  const { serverFetch } = await import('../src/services/connections.js');
  await assert.rejects(serverFetch()(`${baseA}/dav/`), err => err.code === 'EBLOCKED' && err.status === 400);
  assert.equal(hits.a.length, 0);
});

test('outbound: a push endpoint whose name resolves to this machine is skipped, never contacted', async () => {
  const { pushTo } = await import('../src/services/push.js');
  fakeDns('127.0.0.1');
  const device = { id: 1, push_kind: 'unifiedpush', push_token: `https://push.sneaky.example:${A.address().port}/up/1` };
  assert.equal(await pushTo(device, { title: 'Hi' }), 'skipped');
  assert.equal(await pushTo({ ...device, push_token: `http://push.example.com/up/1` }, { title: 'Hi' }), 'skipped', 'plain http is refused');
  assert.equal(hits.a.length, 0);
});
