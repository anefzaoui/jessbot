// Which deep-link recipes still land on results (decision #164): `npm run links:check [-- site site …]`.
// Opens one sample search per site (src/lib/deeplinks.js) in Jess's own browser (CloakBrowser, same network guard) and
// records the verdicts in <data>/deeplinks-state.json. A recipe that is broken is switched off — open_search then opens
// the site's own search page and Jess uses its form; a later ok switches it back on. A bot wall is recorded as "blocked"
// (the recipe may be fine). Needs the browser (npm run browser:install) and internet; run it monthly or after a failure.
// Works with Jessbot running or stopped: the database is only read (browser settings), never migrated.
import { openDb, closeDb } from '../src/db/index.js';
import { ensureDirs } from '../src/config/index.js';

ensureDirs();
await openDb(undefined, { migrate: false }).catch(err => { console.error(`\n✗ Database: ${err.message}\n`); process.exit(1); });
const { SITE_KEYS } = await import('../src/lib/deeplinks.js');
const { checkLinks, linkStateFile } = await import('../src/browser/links.js');
const { browserStatus, closeBrowser } = await import('../src/browser/index.js');

const asked = process.argv.slice(2).filter(a => !a.startsWith('-'));
const unknown = asked.filter(s => !SITE_KEYS.includes(s));
if (unknown.length) { console.error(`Unknown site(s): ${unknown.join(', ')}. Known: ${SITE_KEYS.join(', ')}`); process.exit(2); }
if (!browserStatus().installed) { console.error('The browser isn’t installed: npm run browser:install'); process.exit(1); }

const mark = { ok: '✓', broken: '✗', blocked: '!', error: '?' };
console.log(`\nChecking ${(asked.length ? asked : SITE_KEYS).length} deep-link recipes…\n`);
const results = await checkLinks(asked.length ? asked : SITE_KEYS, {
  onResult: r => console.log(`  ${mark[r.status]} ${r.site.padEnd(24)} ${r.status.padEnd(8)} ${(r.ms / 1000).toFixed(1).padStart(5)} s  ${r.detail}`),
});
await closeBrowser();
closeDb();
const count = s => results.filter(r => r.status === s).length;
console.log(`\n${count('ok')} ok · ${count('broken')} broken (switched off) · ${count('blocked')} blocked by the site · ${count('error')} errors`);
console.log(`Saved: ${linkStateFile()}\n`);
process.exit(0);
