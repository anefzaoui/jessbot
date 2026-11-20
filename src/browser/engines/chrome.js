// The preferred browser engine where Google Chrome is installed (decision #221): Patchright (`patchright-core`,
// Apache-2.0, the Playwright API with its automation traces removed) driving the person's own Google Chrome. Nothing is
// downloaded and Chrome is never redistributed: Jessbot only uses the copy that is already there. In the research
// behind this choice it looked no more automated than CloakBrowser to the common bot checks.
// Its differences from plain Playwright, and what Jessbot does about them:
//  - page.evaluate runs in an isolated world: code that reads the page's own JavaScript globals goes through
//    evaluateInPage() (src/browser/index.js), which asks for the main world;
//  - no console events and no bindings from init scripts: Jessbot's own pages (page checks, print, export) render in a
//    plain Playwright browser instead (withPage({ render: true })), and the autoconsent cookie-banner helper is off
//    (Jessbot's own consent-page handling, walls.js, still runs).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import '../../config/index.js';
import { chromium } from 'patchright-core';
import { launchViaServer, stopServer } from './server.js';
import { userAgent as desktopUserAgent } from './chromium.js';

export const id = 'chrome';
export const label = 'Google Chrome';
export const summary = 'Your installed Google Chrome, driven by Patchright so sites don’t see an automated browser. Nothing to download.';

const CANDIDATES = {
  win32: [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
    .map(d => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
};

/** Where Google Chrome is installed, or null. */
export function chromePath() {
  return (CANDIDATES[process.platform] || CANDIDATES.linux).find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

let versionCache = null; // { path, mtime, version }
/** Chrome's version without starting it: the versioned folder next to chrome.exe, Info.plist, or --version on Linux. */
export function chromeVersion(bin = chromePath()) {
  if (!bin) return null;
  let mtime = 0;
  try { mtime = fs.statSync(bin).mtimeMs; } catch { return null; }
  if (versionCache?.path === bin && versionCache.mtime === mtime) return versionCache.version;
  let version = null;
  try {
    if (process.platform === 'win32') {
      version = fs.readdirSync(path.dirname(bin)).filter(n => /^\d+\.\d+\.\d+\.\d+$/.test(n))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] || null;
    } else if (process.platform === 'darwin') {
      const plist = fs.readFileSync(path.join(path.dirname(bin), '..', 'Info.plist'), 'utf8');
      version = /<key>CFBundleShortVersionString<\/key>\s*<string>([\d.]+)<\/string>/.exec(plist)?.[1] || null;
    } else {
      version = /(\d+\.\d+\.\d+\.\d+)/.exec(execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 }))?.[1] || null;
    }
  } catch { version = null; }
  versionCache = { path: bin, mtime, version };
  return version;
}

export function info() {
  const bin = chromePath();
  return {
    installed: !!bin, binaryPath: bin, source: 'system', version: chromeVersion(bin), cacheDir: null,
    platform: `${process.platform}-${process.arch}`,
    unsupported: bin ? null : 'Google Chrome isn’t installed on this computer. Install it from google.com/chrome, or pick Chromium.',
  };
}

/** Nothing to download: Jessbot never installs or ships Chrome. */
export async function install() {
  const bin = chromePath();
  if (!bin) throw new Error('Google Chrome isn’t installed. Install it from google.com/chrome (Jessbot never downloads Chrome itself), or pick Chromium.');
  return bin;
}
export const installProgress = () => null;

export async function launch() {
  const version = chromeVersion();
  // The user agent as a launch switch (workers included), without "HeadlessChrome".
  return launchViaServer(chromium, { channel: 'chrome', args: version ? [`--user-agent=${desktopUserAgent(version)}`] : [] });
}
export const stop = stopServer;
export const userAgent = desktopUserAgent;

// What Patchright changes (see the top of this file).
export const caps = { consoleEvents: false, bindings: false };

export const licence = null;
