// Releases (#13): CHANGELOG.md parsed and stamped; each release newer than the install's last one becomes a What's new
// draft (Highlights as its lines), never a backlog on a new install; the release script makes the commit (and the tag
// only when asked) in a real git repository and refuses what it should. Run: npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-releases-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';

const { openDb, closeDb, settings, all } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const C = await import('../src/lib/changelog.js');
const W = await import('../src/services/whats-new.js');
after(() => { closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

const LOG = `# Changelog

## [Unreleased]

### Highlights

- Something people will notice next time.

## [0.3.0] - 2026-12-20

### Fixed

- A reminder that fired twice.

## [0.2.0] - 2026-12-01

### Highlights

- You can pick Ollama on your own computer instead of OpenRouter.
- Your assistant can have its own name and picture — set them in Admin.

### Added

- A provider picker (setup, Admin → Models).
  It lists Ollama's models.

## [0.1.0] - 2026-11-20

### Highlights

- The first release.
`;

test('changelog: versions compare as semver; sections parsed (wrapped bullets joined); releases newest first', () => {
  assert.equal(C.compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(C.compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(C.compareVersions('0.2.0', '0.2.0'), 0);
  const all = C.parseChangelog(LOG);
  assert.deepEqual(all.map(r => r.version), ['Unreleased', '0.3.0', '0.2.0', '0.1.0']);
  const r = all.find(x => x.version === '0.2.0');
  assert.equal(r.date, '2026-12-01');
  assert.deepEqual(r.sections.Added, ['A provider picker (setup, Admin → Models). It lists Ollama\'s models.']);
  assert.deepEqual(C.releases(LOG).map(x => x.version), ['0.3.0', '0.2.0', '0.1.0']);
});

test('stamp: Unreleased becomes the version (a new empty one above it); refuses an empty Unreleased or a version that exists', () => {
  const out = C.stampRelease(LOG, '0.4.0', '2027-01-05', 'https://github.com/example/jessbot');
  const parsed = C.parseChangelog(out);
  assert.deepEqual(parsed.slice(0, 2).map(r => [r.version, r.date]), [['Unreleased', null], ['0.4.0', '2027-01-05']]);
  assert.deepEqual(parsed[1].sections.Highlights, ['Something people will notice next time.']);
  assert.match(out, /\[0\.4\.0\]: https:\/\/github\.com\/example\/jessbot\/compare\/v0\.3\.0\.\.\.v0\.4\.0/);
  assert.throws(() => C.stampRelease(out, '0.5.0', '2027-02-01'), /nothing under \[Unreleased\]/);
  assert.throws(() => C.stampRelease(LOG, '0.3.0', '2027-02-01'), /already has 0\.3\.0/);
});

test('What\'s new: a new install records its version and shows nothing; an update brings each newer release as a draft', () => {
  assert.equal(W.importChangelog({ text: LOG, version: '0.1.0' }), 0, 'first start: nothing from before');
  assert.deepEqual(settings.get('whatsNew'), { version: '0.1.0' });
  assert.equal(W.importChangelog({ text: LOG, version: '0.2.0' }), 1, 'updated to 0.2.0');
  let rows = all('SELECT * FROM whats_new ORDER BY id');
  assert.equal(rows[0].commit_ref, 'v0.2.0');
  assert.equal(rows[0].status, 'draft');
  assert.deepEqual(JSON.parse(rows[0].lines), ['You can pick Ollama on your own computer instead of OpenRouter.',
    'Your assistant can have its own name and picture: set them in Admin.'], 'Highlights are the lines, cleaned (no em dash)');
  assert.ok(rows[0].drafted_at, 'written already: the model isn’t asked');
  assert.equal(W.importChangelog({ text: LOG, version: '0.2.0' }), 0, 'once');
  // Two releases at once (0.3.0 skipped by an install that went from 0.2.0 straight to a later one), and one too new.
  assert.equal(W.importChangelog({ text: LOG.replace('## [Unreleased]', '## [0.4.0] - 2027-01-05'), version: '0.3.0' }), 1, '0.4.0 is newer than the code: not yet');
  rows = all('SELECT * FROM whats_new ORDER BY id');
  assert.equal(rows[1].commit_ref, 'v0.3.0');
  assert.deepEqual(JSON.parse(rows[1].lines), [], 'no Highlights: the scheduler drafts lines from the list');
  assert.deepEqual(JSON.parse(rows[1].subjects), ['Fixed: A reminder that fired twice.']);
  assert.equal(rows[1].drafted_at, null);
  assert.deepEqual(settings.get('whatsNew'), { version: '0.3.0' });
});

test('the repository’s own CHANGELOG.md parses, and its newest release (if any) matches package.json', () => {
  const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const parsed = C.parseChangelog(text);
  assert.equal(parsed[0].version, 'Unreleased', 'Unreleased comes first');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const newest = C.releases(text)[0];
  if (newest) assert.equal(C.compareVersions(newest.version, pkg) <= 0, true);
  for (const r of C.releases(text)) assert.ok((r.sections.Highlights || []).length <= W.MAX_LINES, `${r.version}: at most ${W.MAX_LINES} highlights`);
});

// The release script in a throwaway git repository with the files it touches.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-release-repo-'));
  for (const f of ['scripts/release.js', 'scripts/release-notes.js', 'src/lib/changelog.js']) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'jessbot', version: '0.1.0', type: 'module', private: true }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'jessbot', version: '0.1.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'jessbot', version: '0.1.0' } } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Highlights\n\n- The first release.\n');
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'release@example.test');
  g('config', 'user.name', 'Release Test');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'tag.gpgsign', 'false');
  g('add', '-A');
  g('commit', '-q', '-m', 'start');
  return { dir, g, run: (...a) => spawnSync(process.execPath, ['scripts/release.js', ...a], { cwd: dir, encoding: 'utf8' }) };
}

test('release script: stamps, sets the version, commits; tags only with --tag; the notes script checks the tag', () => {
  const { dir, g, run } = repo();
  const dry = run('0.1.0', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run, nothing changes/);
  assert.equal(g('status', '--porcelain'), '');
  const r = run('0.1.0', '--date', '2026-11-20');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(g('log', '-1', '--format=%s'), 'Release v0.1.0');
  assert.equal(g('tag', '--list'), '', 'not tagged without --tag');
  assert.match(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), /## \[Unreleased\]\n\n## \[0\.1\.0\] - 2026-11-20\n\n### Highlights\n\n- The first release\./);
  const notes = spawnSync(process.execPath, ['scripts/release-notes.js', 'v0.1.0'], { cwd: dir, encoding: 'utf8' });
  assert.equal(notes.status, 0, notes.stderr);
  assert.match(notes.stdout, /The first release/);
  assert.notEqual(spawnSync(process.execPath, ['scripts/release-notes.js', 'v0.9.9'], { cwd: dir, encoding: 'utf8' }).status, 0, 'a tag that isn’t package.json’s version');
  g('tag', '-a', 'v0.1.0', '-m', 'Jessbot v0.1.0');

  // The next one, with --tag: version bumped in both files.
  fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), '');
  const log = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8').replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n\n- A fix.\n');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), log);
  assert.match(run('0.2.0').stderr, /working tree has changes/, 'a dirty tree');
  g('commit', '-qam', 'a fix');
  assert.match(run('0.0.9').stderr, /isn’t newer than the last release, v0\.1\.0/);
  const t = run('0.2.0', '--tag');
  assert.equal(t.status, 0, t.stderr);
  assert.equal(g('tag', '--list', 'v0.2.0'), 'v0.2.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.2.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).version, '0.2.0');
  assert.match(run('0.3.0').stderr, /nothing under \[Unreleased\]/);
  g('switch', '-q', '-c', 'other');
  assert.match(run('0.3.0').stderr, /made from main/);
  fs.rmSync(dir, { recursive: true, force: true });
});
