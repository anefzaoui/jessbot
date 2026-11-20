// The default browser engine: open-source Chromium driven by playwright-core (Apache-2.0).
// Where the browser comes from, first match wins:
//   1. JESSBOT_CHROMIUM_PATH — a Chrome or Chromium already on the machine (a distro package, the Docker image's own copy);
//   2. Playwright's Chromium build ("Chrome for Testing"), downloaded per install into tools/ms-playwright
//      (PLAYWRIGHT_BROWSERS_PATH, set in src/config so it moves with the folder; never committed).
// Launched in Chromium's new headless mode (the full browser, not the stripped headless shell), so pages render as they do
// for people. The user agent drops "HeadlessChrome", which many sites refuse outright. No stealth patches beyond that:
// sites with strong bot walls may refuse it where CloakBrowser gets through (see engines/cloakbrowser.js).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { paths } from '../../config/index.js'; // first: it sets PLAYWRIGHT_BROWSERS_PATH before playwright-core loads
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);

export const id = 'chromium';
export const label = 'Chromium';
export const summary = 'Open-source Chromium, downloaded once into tools/ (about 200 MB), or a Chrome/Chromium already installed.';

const systemPath = () => (process.env.JESSBOT_CHROMIUM_PATH || '').trim() || null;

/** The Chromium build Playwright would use from tools/ms-playwright (may not be downloaded yet). */
function bundledPath() {
  try { return chromium.executablePath(); } catch { return null; }
}

let cachedVersion = null;
export function info() {
  const sys = systemPath();
  const bin = sys || bundledPath();
  const installed = !!(bin && fs.existsSync(bin));
  if (installed && !cachedVersion) cachedVersion = browsersJsonVersion();
  return {
    installed, binaryPath: bin, source: sys ? 'system' : 'bundled', cacheDir: process.env.PLAYWRIGHT_BROWSERS_PATH,
    version: sys ? null : cachedVersion, platform: `${process.platform}-${process.arch}`,
    unsupported: sys && !installed ? `JESSBOT_CHROMIUM_PATH points at ${sys}, which doesn't exist.` : null,
  };
}

/** The version Playwright pins for its Chromium (browsers.json), e.g. "153.0.8010.12". */
function browsersJsonVersion() {
  try {
    const file = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).browsers.find(b => b.name === 'chromium')?.browserVersion || null;
  } catch { return null; }
}

let progress = null;
/** Download Playwright's Chromium into tools/ms-playwright (the playwright-core CLI, so it is the exact build it expects). */
export function install() {
  if (systemPath()) return Promise.resolve(systemPath());
  progress = { pct: null, downloadedMB: 0, totalMB: null, unpacking: false };
  const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  return new Promise((resolve, reject) => {
    // --no-shell: only the full Chromium (the headless shell isn't used); --no-remove: leave anything else in the folder.
    const child = spawn(process.execPath, [cli, 'install', 'chromium', '--no-shell', '--no-remove'],
      { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = d => {
      const s = String(d);
      tail = (tail + s).slice(-2000);
      // "|■■■■■     |  40% of 170.6 MiB" (the CLI's progress lines)
      for (const m of s.matchAll(/(\d{1,3})% of ([\d.]+) ?MiB/g)) {
        const total = Number(m[2]);
        progress = { pct: Number(m[1]), totalMB: Math.round(total), downloadedMB: Math.round(total * Number(m[1]) / 100), unpacking: Number(m[1]) >= 100 };
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => { progress = null; reject(err); });
    child.on('exit', code => {
      progress = null;
      if (code !== 0) return reject(new Error(lastLine(tail) || `the Chromium download stopped (exit ${code})`));
      cachedVersion = null;
      resolve(bundledPath());
    });
  });
}
const lastLine = s => s.split('\n').map(l => l.trim()).filter(Boolean).at(-1) || '';

export const installProgress = () => progress;

/** Launch it: the full Chromium in new headless mode. */
// Launched as a browser server we hold on to: Chromium's own shutdown can hang on some systems (seen on Windows with
// Chromium, Chrome and Edge alike), and a server can always be stopped by killing its process (stop() below).
const servers = new WeakMap();
export async function launch() {
  const sys = systemPath();
  const server = await chromium.launchServer({ headless: true, ...(sys ? { executablePath: sys } : { channel: 'chromium' }) });
  const browser = await chromium.connect(server.wsEndpoint());
  servers.set(browser, server);
  return browser;
}

/** Stop a browser this engine launched for good (its process, not just our connection to it). */
export async function stop(browser) {
  const server = servers.get(browser);
  servers.delete(browser);
  await browser.close().catch(() => {}); // a connected browser: this only disconnects
  await server?.kill().catch(() => {});
}

/** A desktop user agent for this browser's version, without "HeadlessChrome". */
export function userAgent(version) {
  const major = String(version || '').split('.')[0] || '140';
  const os = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export const licence = null; // nothing to license

// Kept for status pages: where a downloaded build lives.
export const folder = () => process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(paths.tools, 'ms-playwright');
