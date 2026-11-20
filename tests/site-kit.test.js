// The website's lightbox (website/kit/) is SiteKit, synced from Mister Download Manager's website (website/kit/
// there is its master copy). This copy must be exactly the version its header and kit.json name: a change is made
// in the master and synced here, never edited in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the website kit is an unchanged copy of its SiteKit version', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/check-kit.mjs'), path.join(root, 'website/kit')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
