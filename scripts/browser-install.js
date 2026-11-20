// Install (or verify) the browser Jessbot uses for the web, from the command line — for servers without a desktop,
// Docker builds, or re-installs.
//   npm run browser:install                         the current engine (Chromium unless the admin picked another)
//   npm run browser:install -- --engine cloakbrowser   a specific engine (it is not switched to; pick it in Admin → Browser)
//   npm run browser:install -- --force              download again even when it is there
import { ensureDirs } from '../src/config/index.js';
import { openDb, closeDb } from '../src/db/index.js';

ensureDirs();
await openDb();
const { installBrowser } = await import('../src/browser/index.js');
const { ENGINES, engineId } = await import('../src/browser/engines/index.js');

const i = process.argv.indexOf('--engine');
const id = i > 0 ? process.argv[i + 1] : engineId();
const engine = ENGINES[id];
if (!engine) {
  console.error(`Unknown engine "${id}". Engines: ${Object.keys(ENGINES).join(', ')}`);
  process.exitCode = 2;
} else {
  const before = engine.info();
  if (before.installed && !process.argv.includes('--force')) {
    console.log(`${engine.label}${before.version ? ` ${before.version}` : ''} is already installed at ${before.binaryPath}`);
  } else {
    console.log(`Installing ${engine.label}${before.cacheDir ? ` into ${before.cacheDir}` : ''} …`);
    try {
      const bin = await installBrowser(id);
      const after = engine.info();
      console.log(`Ready: ${engine.label}${after.version ? ` ${after.version}` : ''} → ${bin || after.binaryPath}`);
    } catch (err) {
      console.error(`Install failed: ${err.message}`);
      process.exitCode = 1;
    }
  }
}
closeDb();
