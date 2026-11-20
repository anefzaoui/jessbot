// node scripts/release-notes.js v0.2.0 — one release's notes from CHANGELOG.md, for the GitHub release (#13).
// Fails when the tag doesn't match package.json's version or the release isn't in CHANGELOG.md, so a mistyped tag
// can't publish.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChangelog } from '../src/lib/changelog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = String(process.argv[2] || '');
const version = tag.replace(/^v/, '');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (version !== pkg) { console.error(`The tag ${tag} doesn't match package.json's version ${pkg}.`); process.exit(1); }
const r = parseChangelog(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')).find(x => x.version === version);
if (!r || !r.date) { console.error(`CHANGELOG.md has no dated [${version}] section (npm run release -- ${version}).`); process.exit(1); }
process.stdout.write(`${r.body}\n`);
