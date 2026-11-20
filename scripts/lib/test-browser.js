// The browser the test scripts drive (e2e, ui:check, ui:flows), on any system:
//   1. CHROME_PATH, when set (any Chrome, Edge or Chromium);
//   2. the Chromium Jessbot itself downloaded (npm run browser:install → tools/ms-playwright);
//   3. a Chrome, Edge or Chromium installed in the usual place for this system.
// Nothing found: a clear message instead of a Playwright stack trace. Import playwright-core through this module only:
// it reads PLAYWRIGHT_BROWSERS_PATH once, when it loads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve(ROOT, process.env.JESSBOT_TOOLS || 'tools', 'ms-playwright');
const pw = await import('playwright-core');
export const { chromium, request } = pw;

const SYSTEM = {
  win32: ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']
    .flatMap(p => [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(d => path.join(d, p))),
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium'],
};

function find() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try { const ours = chromium.executablePath(); if (fs.existsSync(ours)) return ours; } catch { /* not downloaded */ }
  return (SYSTEM[process.platform] || SYSTEM.linux).find(p => fs.existsSync(p)) || null;
}

export const executablePath = find();
if (!executablePath) {
  console.error('No browser for the tests. Run `npm run browser:install` (or set CHROME_PATH to a Chrome, Edge or Chromium).');
  process.exit(2);
}

/** chromium.launch with the browser found above. */
export const launchTestBrowser = (opts = {}) => chromium.launch({ executablePath, headless: true, ...opts });
