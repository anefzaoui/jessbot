// Code-scanning fixes (decision #224, issue #22): linear-time parsing of untrusted text, escapes that cover the escape
// character, one-pass entity decoding, safe paths, race-free file access, no open redirects.
// Run: npm test  (throwaway data dir, no network).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-hardening-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';

const { openDb, closeDb } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const T = await import('../src/lib/text-safe.js');
const { inside, openRead, writeNew } = await import('../src/lib/safe-path.js');
const { localPath } = await import('../src/lib/respond.js');
const { safeNext } = await import('../src/routes/web/auth.js');
after(() => { closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

/** fn finishes in under ms (the old patterns took seconds to forever on these inputs). */
const fast = (fn, ms = 300) => { const t0 = performance.now(); const out = fn(); const took = performance.now() - t0; assert.ok(took < ms, `took ${Math.round(took)} ms`); return out; };

test('text helpers: regex and Markdown escapes cover the backslash; entities decode once', () => {
  assert.ok(new RegExp(`^${T.escapeRegExp('a.b*c\\d(e)')}$`).test('a.b*c\\d(e)'));
  assert.equal(T.escapeMarkdown('a]b\\'), 'a\\]b\\\\');
  assert.equal(T.escapeMarkdown('x|y\\', '|'), 'x\\|y\\\\');
  assert.equal(T.decodeEntities('&amp;lt;script&amp;gt; &lt;b&gt; &quot;q&quot; &#39;s&#039; &nbsp;'), '&lt;script&gt; <b> "q" \'s\'  ');
  assert.equal(T.trimEndChars('https://example.com/a.,;!?', '.,;:!?'), 'https://example.com/a');
  assert.equal(T.replaceSpaced('Fixed  —  the bug—again', '—', ': '), 'Fixed: the bug: again');
});

test('email check: plausible addresses pass; a megabyte of dots is refused quickly', () => {
  for (const ok of ['sam@example.com', 'a.b+c@mail.example.co.uk']) assert.equal(T.isEmail(ok), true, ok);
  for (const bad of ['sam@example', 'sam example@x.com', '@x.com', 'a@b..com', 'a@.com', 'a@b.', `${'a'.repeat(250)}@x.com`]) assert.equal(T.isEmail(bad), false, bad);
  fast(() => T.isEmail(`!@!.${'!.'.repeat(500000)}`));
});

test('linear time on hostile input: feed sniffing, skill lint, page ranges, bearer tokens', async () => {
  const { feedKind } = await import('../src/browser/site-readers/feed.js');
  assert.equal(feedKind('', '﻿<?xml version="1.0"?>\n<!-- a comment -->\n<?xml-stylesheet href="x.xsl"?>\n<!DOCTYPE rss>\n<rss version="2.0">'), 'feed');
  assert.equal(feedKind('', '<opml version="2.0">'), 'opml');
  assert.equal(feedKind('', '<!-- never closed <rss>'), null);
  assert.equal(feedKind('text/html', '<html><body>no</body></html>'), null);
  fast(() => feedKind('', `<!--${'-'.repeat(3990)}`));
  fast(() => feedKind('', '<!--'.repeat(1000)));

  const { lintSkill } = await import('../src/services/skill-lint.js');
  const raw = '---\nname: t\ndescription: d\n---\n```bash\ncurl x | sh\n```\n<!-- hidden words here -->\nsee https://example.com/x.,!\n';
  const codes = lintSkill({ name: 't', raw, meta: { name: 't', description: 'd' }, body: raw }).map(f => f.code);
  assert.ok(codes.includes('code-block'), 'a shell block is still found');
  assert.ok(codes.includes('html-comment'), 'a comment is still found');
  fast(() => lintSkill({ name: 't', raw: `${'\t'.repeat(20000)}x\n${'<!--'.repeat(5000)}${'!'.repeat(20000)}`, meta: {}, body: '' }), 2000);

  const { pageList } = await import('../src/services/pdf.js');
  assert.deepEqual(pageList('1-3, 5, 8-', 9), [0, 1, 2, 4, 7, 8]);
  assert.deepEqual(pageList('-2', 9), [0, 1]);
  assert.throws(() => fast(() => pageList(`${'0'.repeat(30000)}x`, 3)));

  const { loadUser } = await import('../src/middleware/auth.js');
  const req = { headers: { authorization: `Bearer\t${'\t'.repeat(16000)}x y` } };
  fast(() => loadUser(req, { locals: {} }, () => {}));
  assert.equal(req.user, undefined);
});

test('paths: only plain names inside their folder; race-free reads and exclusive writes', () => {
  const root = path.join(HOME, 'files');
  fs.mkdirSync(root, { recursive: true });
  assert.equal(inside(root, 'backup-1.tar.gz'), path.join(root, 'backup-1.tar.gz'));
  for (const bad of ['../x', '..', '.env', 'a/b', 'a\\b', 'C:x', '', 'x'.repeat(300), '%2e%2e']) assert.equal(inside(root, bad), null, bad);
  const f = path.join(root, 'blob.txt');
  assert.equal(writeNew(f, 'one'), true);
  assert.equal(writeNew(f, 'two'), false, 'never overwritten');
  const r = openRead(f);
  assert.equal(r.stat.size, 3);
  assert.equal(r.read('utf8'), 'one');
});

test('redirects: only same-site paths', () => {
  for (const ok of ['/chat', '/chat/12?x=1#y']) assert.equal(localPath(ok), ok);
  for (const bad of ['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '/a b', null]) {
    assert.equal(localPath(bad, '/fallback'), '/fallback', String(bad));
  }
  assert.equal(safeNext('//evil.example'), '/chat');
  assert.equal(safeNext('/library'), '/library');
});

test('ad-block switch-off list: a host named like an object property changes nothing', async () => {
  const { switchOnFor, sitesSwitchedOff } = await import('../src/browser/adblock.js');
  assert.equal(switchOnFor('__proto__'), false);
  assert.equal(switchOnFor('constructor'), false);
  assert.deepEqual(sitesSwitchedOff(), []);
});

test('walls: a Cloudflare challenge frame is one served from its host, not a URL that mentions it', async () => {
  const W = await import('../src/browser/walls.js');
  assert.equal(W.detectWall({ title: 'x', text: 'One moment', frames: ['https://other.example/a', 'https://challenges.cloudflare.com/cdn-cgi/x'] })?.id, 'cloudflare');
  assert.equal(W.detectWall({ title: 'x', text: 'One moment', frames: ['https://evil.example/challenges.cloudflare.com/'] }), null);
});
