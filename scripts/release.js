// npm run release -- <version> [--tag] [--dry-run] [--date YYYY-MM-DD]   (docs/RELEASING.md, #13)
// Makes a release commit from main: CHANGELOG.md's [Unreleased] section becomes [<version>] - <date> (a new empty
// Unreleased opens above it), package.json and package-lock.json get the version, and the commit is "Release v<version>".
// With --tag it also makes the annotated tag v<version> (pushing it publishes the Docker image and the GitHub release;
// see .github/workflows). Without --tag nothing is published: push the commit, and tag when ready.
// Refuses: a dirty tree, a branch other than main (unless --any-branch), a version that isn't newer than the last tag,
// an empty [Unreleased], a tag that exists. --dry-run prints what it would do and changes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stampRelease, parseChangelog, compareVersions, SEMVER } from '../src/lib/changelog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const opt = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const version = args.find(a => SEMVER.test(a.replace(/^v/, '')))?.replace(/^v/, '');
const dry = flag('dry-run');
const die = msg => { console.error(`\n[release] ${msg}\n`); process.exit(1); };
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

if (!version) die('Usage: npm run release -- <version> [--tag] [--dry-run] [--date YYYY-MM-DD]   e.g. npm run release -- 0.2.0');
const date = opt('date') || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die(`--date must be YYYY-MM-DD, not ${date}.`);

if (git('status', '--porcelain')) die('The working tree has changes: commit or stash them first.');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main' && !flag('any-branch')) die(`Releases are made from main (this is ${branch}); --any-branch to override.`);
const tags = git('tag', '--list', 'v*').split('\n').map(t => t.replace(/^v/, '')).filter(t => SEMVER.test(t)).sort(compareVersions);
if (tags.includes(version)) die(`The tag v${version} exists already.`);
const last = tags.at(-1);
if (last && compareVersions(version, last) <= 0) die(`${version} isn’t newer than the last release, v${last}.`);

const changelogFile = path.join(ROOT, 'CHANGELOG.md');
const before = fs.readFileSync(changelogFile, 'utf8');
let repoUrl = null;
try { repoUrl = git('remote', 'get-url', 'origin').replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/'); } catch { /* no remote */ }
let after;
try { after = stampRelease(before, version, date, /^https:\/\/github\.com\//.test(repoUrl || '') ? repoUrl : null); } catch (err) { die(err.message); }
const notes = parseChangelog(after).find(r => r.version === version).body;

console.log(`[release] v${version} (${date})${last ? `, after v${last}` : ', the first release'}${dry ? ' — dry run, nothing changes' : ''}\n`);
console.log(notes, '\n');
if (dry) process.exit(0);

fs.writeFileSync(changelogFile, after);
// The version in package.json and package-lock.json (its own and its root package's), keeping each file's layout.
const setVersion = (file, edit) => {
  const f = path.join(ROOT, file);
  const json = JSON.parse(fs.readFileSync(f, 'utf8'));
  edit(json);
  fs.writeFileSync(f, `${JSON.stringify(json, null, 2)}
`);
  return json;
};
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
setVersion('package.json', j => { j.version = version; });
setVersion('package-lock.json', j => { j.version = version; if (j.packages?.['']) j.packages[''].version = version; });
git('add', 'CHANGELOG.md', 'package.json', 'package-lock.json');
git('commit', '-m', `Release v${version}`, '-m', notes);
console.log(`[release] Committed "Release v${version}" (package ${pkg.version} → ${version}).`);
if (flag('tag')) {
  git('tag', '-a', `v${version}`, '-m', `Jessbot v${version}\n\n${notes}`);
  console.log(`[release] Tagged v${version}. Publish: git push origin main && git push origin v${version}`);
} else {
  console.log(`[release] Not tagged. Push the commit (git push origin main), then when ready: git tag -a v${version} -m "Jessbot v${version}" && git push origin v${version}`);
}
