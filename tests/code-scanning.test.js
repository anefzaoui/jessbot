// The last code-scanning alerts (issue #22, decision #248): a trailing-slash trim that couldn't go quadratic, the
// skill linter's line index stepping by lines, the lettered favicon badge built from a fixed alphabet and served with a
// CSP, and the sign-in page's redirect kept on this site. Run: npm test (throwaway data dir, no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-codescan-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
delete process.env.TRUST_PROXY;

const { openDb, closeDb } = await import('../src/db/index.js');
const { ensureDirs, paths } = await import('../src/config/index.js');
const { completeSetup } = await import('../src/services/setup.js');
const { createUser } = await import('../src/services/users.js');
const { createSession } = await import('../src/services/sessions.js');
const { createApp } = await import('../src/app.js');
ensureDirs();
await openDb();

let server, base, cookie;
before(async () => {
  const owner = await createUser({ name: 'Sam Rivera', email: 'sam@codescan.test', password: 'correct horse battery' });
  completeSetup();
  cookie = `jb_session=${createSession(owner.id)}`;
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

/** fn finishes in under ms; the old trailing-slash pattern took seconds on these inputs. */
const fast = (fn, ms = 300) => { const t0 = performance.now(); const out = fn(); const took = performance.now() - t0; assert.ok(took < ms, `took ${Math.round(took)} ms`); return out; };

test('trailing slashes: trimmed in linear time wherever an address is cleaned (alert 107)', async () => {
  const L = await import('../src/services/llm.js');
  const slashes = '/'.repeat(200000);
  assert.equal(L.providerInput({ provider: 'compatible', baseUrl: 'https://llm.example/v1///', model: 'm' }).baseUrl, 'https://llm.example/v1');
  // Many slashes that don't end the string: the case a backtracking /\/+$/ retries from every slash.
  const { baseUrl } = fast(() => L.providerInput({ provider: 'compatible', baseUrl: `https://llm.example/${slashes}x`, model: 'm' }));
  assert.ok(baseUrl.endsWith('/x'));

  const { normalizeUrl } = await import('../src/browser/read.js');
  assert.equal(normalizeUrl('https://news.example/story/amp/'), normalizeUrl('https://news.example/story'));
  fast(() => normalizeUrl(`https://news.example/${slashes}x`));

  const { cleanSearxngUrl } = await import('../src/browser/searxng.js');
  assert.equal(cleanSearxngUrl('http://127.0.0.1:8888///'), 'http://127.0.0.1:8888');

  const { createResetLink } = await import('../src/services/password-reset.js');
  const { url } = createResetLink(1, { base: 'https://jess.example/' });
  assert.match(url, /^https:\/\/jess\.example\/reset\/[\w-]+$/);
});

test('skill lint: line numbers step by lines, and a body that isn\'t text is linted as text (alert 40)', async () => {
  const { lintSkill } = await import('../src/services/skill-lint.js');
  const raw = `---\nname: t\ndescription: d\n---\n${'plain line\n'.repeat(50000)}see https://webhook.site/abc\n`;
  const found = fast(() => lintSkill({ name: 't', raw, meta: { name: 't', description: 'd' }, body: raw }), 3000);
  const link = found.find(f => /webhook\.site/.test(f.excerpt || ''));
  assert.ok(link, 'the data-catcher link is found');
  assert.equal(link.line, 50005, 'on its own line number');
  // A forged length doesn't drive any loop: the object becomes the text "[object Object]".
  fast(() => lintSkill({ name: 't', raw: { length: 1e12 }, meta: {}, body: '' }));
});

test('favicon badge: one letter from a fixed alphabet, served as an SVG that can\'t run anything (alert 34)', async () => {
  const { letterBadge } = await import('../src/services/favicons.js');
  const letterOf = h => /<text[^>]*>([^<]*)<\/text>/.exec(letterBadge(h))[1];
  assert.equal(letterOf('www.example.com'), 'E');
  assert.equal(letterOf('9gag.example'), '9');
  assert.equal(letterOf('---'), '?');
  for (const h of ['<script>.example', '"onload=alert(1)".example', 'é.example', '&amp;.example']) {
    const svg = letterBadge(h);
    assert.match(letterOf(h), /^[A-Z0-9?]$/, h);
    assert.equal(svg.match(/</g).length, 5, `${h}: only the badge's own tags`);
  }
  // Through the route: a host with a fresh "no icon" marker gets the badge without any fetch.
  fs.mkdirSync(path.join(paths.data, 'favicons'), { recursive: true });
  fs.writeFileSync(path.join(paths.data, 'favicons', 'nothing-here.example.miss'), String(Date.now()));
  const res = await fetch(`${base}/favicons/nothing-here.example`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\/svg\+xml/);
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await res.text(), />N<\/text><\/svg>$/);
  assert.equal((await fetch(`${base}/favicons/%3Cscript%3E`, { headers: { Cookie: cookie } })).status, 404, 'not a host name');
});

test('sign-in page: a signed-in visitor is only ever sent to a page of this site (alert 42)', async () => {
  const to = async next => {
    const res = await fetch(`${base}/login?next=${encodeURIComponent(next)}`, { redirect: 'manual', headers: { Cookie: cookie } });
    assert.equal(res.status, 302, next);
    return res.headers.get('location');
  };
  assert.equal(await to('/library?tab=files#top'), '/library?tab=files#top');
  for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil.example', ' /evil', 'https://evil.example/', 'http:evil.example',
    'javascript:alert(1)', '\\\\evil.example', '/%0a/evil.example'.replace('%0a', '\n')]) {
    assert.equal(await to(bad), '/chat', JSON.stringify(bad));
  }
  const twice = await fetch(`${base}/login?next=/library&next=//evil.example`, { redirect: 'manual', headers: { Cookie: cookie } });
  assert.equal(twice.headers.get('location'), '/chat', 'a repeated parameter is refused');
});
