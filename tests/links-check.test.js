// links:check against local stand-ins for real sites (decision #164; the live run is npm run links:check and test:chat's
// check). The check runs the way the command runs it — Jess's own browser, consent and wall probes, the verdict, the
// state file — on recipes that point at a local server, so the result never depends on what google.com or
// api.crossref.org said today. Pages open in a plain context of that browser: the guard proxy and the request guard,
// which withPage adds in the real run, have their own tests (browser-proxy.test.js, p18d…).
// Run: npm test  (needs the browser: npm run browser:install; a local server, no internet).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-links-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';

const { openDb, closeDb } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const browser = await import('../src/browser/index.js');
const { stopGuardProxy } = await import('../src/browser/guard-proxy.js');
const L = await import('../src/browser/links.js');
const skip = !browser.browserStatus().installed && 'the browser is not installed (npm run browser:install)';

const RESULTS = `<title>Lamps — 42 results</title><h1>42 results for lamps</h1>${'<p>Desk lamp, brass, 34 € · in stock</p>'.repeat(20)}`;
const HOME_PAGE = `<title>Shop</title><h1>Welcome</h1>${'<p>Everything for the house, delivered.</p>'.repeat(20)}`;
const hits = [];
let site, port, session;
before(async () => {
  site = await listen(http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(`${String(req.headers.host).split(':')[0]}${url.pathname}`);
    const page = (status, html) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); };
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };
    if (url.pathname === '/') return page(200, HOME_PAGE);
    if (url.pathname === '/shop/search') return page(200, RESULTS);
    if (url.pathname === '/moved/search') { res.writeHead(302, { location: '/' }); return res.end(); } // the recipe stopped working
    if (url.pathname === '/busy/search') return page(429, '<title>Too many requests</title><p>Slow down.</p>'); // the site says no today
    if (url.pathname === '/mirror-a/works') return json(503, '{"error":"overloaded"}');
    if (url.pathname === '/mirror-b/works') return json(200, JSON.stringify({ message: { items: [{ DOI: '10.0000/x', title: ['A paper'] }] } }));
    return page(404, 'not here');
  }));
  port = site.address().port;
});
after(async () => {
  await session?.close().catch(() => {});
  await browser.closeBrowser().catch(() => {});
  await stopGuardProxy();
  site.close(); closeDb();
  fs.rmSync(HOME, { recursive: true, force: true });
});

/** withPage's shape, on a plain context of Jess's own browser. */
async function open(fn) {
  session ||= await browser.openSessionContext();
  const ctx = await session.browser().newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', serviceWorkers: 'block' });
  try { const page = await ctx.newPage(); page.setDefaultTimeout(30000); return await fn(page); } finally { await ctx.close(); }
}

// Recipes shaped like lib/deeplinks.js SITES, pointing at the local server (the two mirrors under two host names).
const at = (p, host = '127.0.0.1') => `http://${host}:${port}${p}`;
const recipes = () => ({
  shop: { label: 'Shop', area: 'shopping', home: at('/'), build: f => ({ url: at(`/shop/search?q=${encodeURIComponent(f.query)}`) }), sample: () => ({ query: 'lamps' }), expect: /results/i },
  moved: { label: 'Moved', area: 'shopping', home: at('/'), build: () => ({ url: at('/moved/search?q=lamps') }), sample: () => ({}) },
  busy: { label: 'Busy', area: 'shopping', home: at('/'), build: () => ({ url: at('/busy/search?q=lamps') }), sample: () => ({}) },
  data: { label: 'Data', area: 'scholarly', kind: 'json', home: at('/'),
    build: () => ({ url: at('/mirror-a/works?q=x'), alternates: [at('/mirror-b/works?q=x', 'localhost')] }), sample: () => ({}) },
  nosample: { label: 'No sample', area: 'shopping', home: at('/'), build: () => { throw new Error('a field is missing'); }, sample: () => ({}) },
});

test('links:check (real browser, local sites): results, a recipe gone to the home page, a 429, a JSON mirror; the verdicts are saved', { skip, timeout: 120000 }, async () => {
  const seen = [];
  const results = await L.checkLinks(['shop', 'moved', 'busy', 'data'], { recipes: recipes(), open, onResult: r => seen.push(r.site) });
  const by = Object.fromEntries(results.map(r => [r.site, r]));
  assert.deepEqual(seen, ['shop', 'moved', 'busy', 'data'], 'one verdict per site, in order, as each finishes');
  assert.deepEqual([by.shop.status, by.shop.detail], ['ok', 'Lamps — 42 results']);
  assert.deepEqual([by.moved.status, by.moved.detail], ['broken', 'it went to the home page']);
  assert.equal(by.busy.status, 'blocked', by.busy.detail);
  assert.match(by.busy.detail, /429/);
  assert.equal(by.data.status, 'ok', by.data.detail);
  assert.match(by.data.detail, /^JSON from localhost, \d+ bytes \(127\.0\.0\.1: HTTP 503\)$/);
  assert.ok(hits.includes('127.0.0.1/shop/search') && hits.includes('localhost/mirror-b/works'), `the browser reached the local sites: ${hits.join(', ')}`);

  const state = L.loadLinkState();
  assert.ok(state.checkedAt);
  assert.deepEqual(Object.fromEntries(Object.entries(state.sites).map(([k, v]) => [k, v.status])), { shop: 'ok', moved: 'broken', busy: 'blocked', data: 'ok' });
  assert.deepEqual(L.recipeOff('moved'), { at: state.sites.moved.at, detail: 'it went to the home page' }, 'a broken recipe is switched off');
  assert.equal(L.recipeOff('busy'), null, 'a site that said no today keeps its recipe on');
});

test('links:check: an error on our side keeps the last verdict; a later run replaces it', { skip, timeout: 60000 }, async () => {
  L.saveLinkState({ checkedAt: '2026-11-01T05:00:00Z', sites: { nosample: { status: 'broken', at: '2026-11-01T05:00:00Z', detail: 'it went to the home page' } } });
  const [r] = await L.checkLinks(['nosample'], { recipes: recipes(), open });
  assert.deepEqual([r.status, r.detail], ['error', 'the sample didn’t build: a field is missing']);
  assert.equal(L.loadLinkState().sites.nosample.status, 'broken', 'the error left the last verdict alone');
  const t = recipes();
  t.nosample.build = t.shop.build; t.nosample.sample = t.shop.sample;
  const [again] = await L.checkLinks(['nosample'], { recipes: t, open });
  assert.equal(again.status, 'ok', again.detail);
  assert.equal(L.recipeOff('nosample'), null, 'the recipe is back on');
});

test('links:check: a JSON recipe the browser couldn’t reach from this computer is an error, not "blocked by the site"', async () => {
  // The browser can't reach its own guard proxy (seen on a loaded Windows machine, Nov 2026): every address fails with
  // net::ERR_PROXY_CONNECTION_FAILED. Pages whose goto fails that way stand in for it (the real JSON path is above).
  const proxyDown = url => Promise.reject(new Error(`page.goto: net::ERR_PROXY_CONNECTION_FAILED at ${url}\nCall log: …`));
  const offline = async fn => fn({ goto: proxyDown });
  L.saveLinkState({ checkedAt: null, sites: { data: { status: 'ok', at: '2026-11-01T05:00:00Z', detail: 'JSON from localhost' } } });
  const [r] = await L.checkLinks(['data'], { recipes: recipes(), open: offline });
  assert.equal(r.status, 'error', r.detail);
  assert.equal(r.detail, 'this computer couldn’t reach the site (127.0.0.1: no answer (net::ERR_PROXY_CONNECTION_FAILED); localhost: no answer (net::ERR_PROXY_CONNECTION_FAILED))');
  assert.equal(L.loadLinkState().sites.data.status, 'ok', 'the last verdict stays');
  // One address that answered is the site's answer again.
  const answer = { status: () => 200, body: async () => Buffer.from('{"message":{"items":[]}}') };
  const half = async fn => fn({ goto: async url => (url.includes('mirror-a') ? proxyDown(url) : answer) });
  const [r2] = await L.checkLinks(['data'], { recipes: recipes(), open: half });
  assert.equal(r2.status, 'ok', r2.detail);
});

test('links:check: which navigation errors are on this computer’s side', () => {
  assert.equal(L.failedOnOurSide('page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://api.crossref.org/works?query.bibliographic=x'), true);
  assert.equal(L.failedOnOurSide('page.goto: net::ERR_INTERNET_DISCONNECTED at https://example.com/'), true);
  assert.equal(L.failedOnOurSide('page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/'), false, 'the site refused');
  assert.equal(L.failedOnOurSide('page.goto: Timeout 20000ms exceeded.'), false, 'the site was too slow');
  assert.equal(L.failedOnOurSide(''), false);
});
