// Browser engines (decision #218): open-source Chromium by default, CloakBrowser optional, the choice kept with the other
// browser settings. Run: npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-engines-'));
const TOOLS = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-engines-tools-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_TOOLS = TOOLS; // an empty tools folder: nothing downloaded, no CloakBrowser left from before
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
delete process.env.JESSBOT_BROWSER_ENGINE;
delete process.env.JESSBOT_CHROMIUM_PATH;
delete process.env.CLOAKBROWSER_CACHE_DIR;

const { openDb, closeDb, settings } = await import('../src/db/index.js');
const { ensureDirs, paths } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const E = await import('../src/browser/engines/index.js');
const B = await import('../src/browser/index.js');
const chromium = await import('../src/browser/engines/chromium.js');
after(() => { closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(TOOLS, { recursive: true, force: true }); });

test('Chromium is the default engine; its download lives in tools/ms-playwright', () => {
  assert.equal(E.engineId(), 'chromium');
  assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, paths.playwright);
  assert.equal(paths.playwright, path.join(TOOLS, 'ms-playwright'));
  const s = B.browserStatus();
  assert.equal(s.engine.id, 'chromium');
  assert.equal(s.installed, false, 'nothing downloaded in an empty tools folder');
  assert.deepEqual(s.engines.map(e => e.id), ['chromium', 'cloakbrowser']);
  assert.ok(s.binaryPath.startsWith(path.join(TOOLS, 'ms-playwright')), s.binaryPath);
});

test('JESSBOT_CHROMIUM_PATH uses a browser already on the machine (and says so when it is missing)', () => {
  const fake = path.join(TOOLS, 'my-chrome.exe');
  fs.writeFileSync(fake, '');
  process.env.JESSBOT_CHROMIUM_PATH = fake;
  try {
    assert.deepEqual([chromium.info().installed, chromium.info().source, chromium.info().binaryPath], [true, 'system', fake]);
    process.env.JESSBOT_CHROMIUM_PATH = path.join(TOOLS, 'nope.exe');
    assert.equal(chromium.info().installed, false);
    assert.match(chromium.info().unsupported, /doesn't exist/);
  } finally { delete process.env.JESSBOT_CHROMIUM_PATH; }
});

test('its contexts get a desktop user agent without "HeadlessChrome"', () => {
  const ua = chromium.userAgent('153.0.8010.12');
  assert.match(ua, /Chrome\/153\.0\.0\.0 Safari\/537\.36$/);
  assert.doesNotMatch(ua, /Headless/);
});

test('switching engines is saved with the browser settings; a form that leaves it out keeps it', async () => {
  await B.saveBrowserSettings({ ...B.browserSettings(), blockMedia: false, engine: 'cloakbrowser' });
  assert.equal(E.engineId(), 'cloakbrowser');
  assert.equal(B.browserStatus().engine.label, 'CloakBrowser');
  await B.saveBrowserSettings({ maxPages: 3, blockMedia: true, engines: ['duckduckgo'] }); // the settings form: no engine field
  assert.equal(E.engineId(), 'cloakbrowser', 'kept');
  assert.equal(B.browserSettings().maxPages, 3);
  await B.saveBrowserSettings({ ...B.browserSettings(), engine: 'not-an-engine' });
  assert.equal(E.engineId(), 'cloakbrowser', 'an unknown engine is ignored');
  await B.saveBrowserSettings({ ...B.browserSettings(), engine: 'chromium' });
  assert.equal(settings.get('browser').engine, 'chromium');
});

test('the CloakBrowser licence is its own: a malformed key is refused', async () => {
  await assert.rejects(() => B.setLicenseKey('not-a-key'), /start with cb_/);
  assert.equal(B.licenseInfo().present, false);
});
