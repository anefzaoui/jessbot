// Browser engines (decision #218). Everything Jessbot does on the web — searching, reading, the agent's browsing sessions,
// feeds, weather, places, favicons, page export and print — goes through one Playwright Browser that an engine launches.
// An engine is a module with this shape:
//   id, label, summary                 who it is (Admin → Browser and the setup step list them)
//   info() → { installed, version, binaryPath, source, cacheDir, platform, tier?, unsupported? }
//   install() → Promise<binaryPath>    download it (or nothing to do); installProgress() → { pct, downloadedMB, totalMB, unpacking } | null
//   launch() → Promise<Browser>        a playwright-core Browser, headless
//   userAgent(version) → string|undefined   the desktop user agent its contexts should use (undefined: leave it)
//   licence: { info, set, remove } | null
// Built in: "chromium" (open source, the default) and "cloakbrowser" (optional, proprietary binary, user-installed).
// Another engine (a different stealth build, a remote browser) plugs in by adding a module here.
import fs from 'node:fs';
import { settings } from '../../db/index.js';
import * as chromium from './chromium.js';
import * as cloakbrowser from './cloakbrowser.js';

export const ENGINES = { chromium, cloakbrowser };
export const DEFAULT_ENGINE = 'chromium';

/**
 * The engine in use: the admin's choice (settings.browser.engine), else JESSBOT_BROWSER_ENGINE, else Chromium. An install
 * from before engines existed that already has CloakBrowser downloaded keeps using it until the admin changes it.
 */
export function engineId() {
  const chosen = settings.get('browser', {})?.engine || process.env.JESSBOT_BROWSER_ENGINE;
  if (ENGINES[chosen]) return chosen;
  return legacyCloak() ? 'cloakbrowser' : DEFAULT_ENGINE;
}
export const browserEngine = () => ENGINES[engineId()];

let legacy = null; // checked once per start
function legacyCloak() {
  if (legacy !== null) return legacy;
  try {
    // CloakBrowser's binaries live in versioned folders under tools/cloakbrowser (chromium-<version>…).
    const dir = process.env.CLOAKBROWSER_CACHE_DIR;
    legacy = !!dir && fs.existsSync(dir) && fs.readdirSync(dir).some(n => n.startsWith('chromium-'));
  } catch { legacy = false; }
  return legacy;
}
export const engineList = () => Object.values(ENGINES).map(e => ({ id: e.id, label: e.label, summary: e.summary }));
