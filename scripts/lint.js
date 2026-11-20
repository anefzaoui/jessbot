// A syntax check of every JavaScript file in the repository (server, scripts, tests and the browser's own modules):
// `node --check` on each, so a stray brace or a bad import line fails CI before any test runs.   npm run lint
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'scripts', 'tests', 'public/js'];
const files = ['server.js'];
const walk = dir => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fixtures') walk(rel); }
    else if (/\.(m?js)$/.test(e.name)) files.push(rel);
  }
};
DIRS.forEach(walk);

let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error(`✗ ${f}\n${(r.stderr || '').trim()}\n`); }
}
console.log(`${files.length - bad} of ${files.length} files parse${bad ? `; ${bad} don't` : ''}.`);
process.exitCode = bad ? 1 : 0;
