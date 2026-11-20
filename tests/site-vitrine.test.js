// The website's lightbox (website/vitrine/) is Vitrine (https://github.com/anefzaoui/vitrine), vendored unmodified at
// the commit website/vitrine/vitrine.lock.json pins (decision #251). A change is made upstream and fetched again
// (with Vitrine's tools/vendor.mjs fetch website/vitrine --lightbox=<sha>), never edited here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the website\'s Vitrine is an unchanged copy of the commit its lock pins', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/vitrine-check.mjs'), path.join(root, 'website/vitrine')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
