// Install (or verify) the CloakBrowser binary into ./tools/cloakbrowser from the command line — for servers
// without a desktop, Docker builds, or re-installs.   npm run browser:install
import { ensureDirs } from '../src/config/index.js';
import { openDb, closeDb } from '../src/db/index.js';

ensureDirs();
await openDb();
const { installBrowser, browserStatus } = await import('../src/browser/index.js');

const before = browserStatus();
if (before.installed && !process.argv.includes('--force')) {
  console.log(`CloakBrowser ${before.version} (${before.tier}) is already installed at ${before.binaryPath}`);
} else {
  console.log(`Installing CloakBrowser into ${before.cacheDir} …`);
  try {
    await installBrowser();
    const s = browserStatus();
    console.log(`Ready: Chromium ${s.version} (${s.tier}) → ${s.binaryPath}`);
  } catch (err) {
    console.error(`Install failed: ${err.message}`);
    process.exitCode = 1;
  }
}
closeDb();
