// Optional browser engine: CloakBrowser, a Chromium build with stealth patches that gets through bot walls where stock
// Chromium is refused (some airline and shop sites). Its npm wrapper (`cloakbrowser`, MIT) is an optional dependency; the
// browser binary itself is PROPRIETARY: each install downloads it into tools/cloakbrowser when the admin asks for it, it is
// never committed or redistributed, and its terms cover internal use (you, your family, your company) — offering Jessbot as
// a service to others needs CloakHQ's commercial licence (decision #15). Nothing here runs unless the admin picks it.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../../config/index.js';

export const id = 'cloakbrowser';
export const label = 'CloakBrowser';
export const summary = 'A stealth Chromium build (proprietary, about 500 MB, downloaded into tools/cloakbrowser): gets past more bot walls. For internal use only.';

process.env.CLOAKBROWSER_CACHE_DIR ||= paths.cloakbrowser;
process.env.CLOAKBROWSER_AUTO_UPDATE = 'false'; // pinned: the binary changes only when the admin presses Install/Update

// The wrapper only describes, downloads and launches the binary; importing it does none of that.
let mod = null;
try { mod = await import('cloakbrowser'); } catch { /* optional dependency not installed */ }
const MISSING = 'The CloakBrowser wrapper isn’t installed (npm install cloakbrowser).';
const cb = () => { if (!mod) throw new Error(MISSING); return mod; };
/** Whether the wrapper package is present (it is an optional dependency). */
export const available = () => !!mod;

export function info() {
  let i;
  try { i = cb().binaryInfo(); } catch (err) { i = { installed: false, error: err.message }; }
  const override = process.env.CLOAKBROWSER_BINARY_PATH;
  return {
    installed: !!(i.installed || (override && fs.existsSync(override))), source: 'bundled',
    version: i.version || null, tier: i.tier || 'free', platform: i.platform || `${process.platform}-${process.arch}`,
    binaryPath: override || i.binaryPath || null, cacheDir: process.env.CLOAKBROWSER_CACHE_DIR, unsupported: i.error || null,
  };
}

let total = null;
export async function install() {
  total = null;
  const m = cb();
  expectedSize(m).then(t => { total = t; });
  try { return await m.ensureBinary(); } finally { total = null; }
}
async function expectedSize(m) {
  try {
    const res = await fetch(m.binaryInfo().downloadUrl, { method: 'HEAD', redirect: 'follow' });
    return Number(res.headers.get('content-length')) || null;
  } catch { return null; }
}

// The wrapper downloads to "_download_<ts>.zip|tar.gz" next to the binary folders; its size is our progress.
export function installProgress() {
  let downloaded = 0, unpacking = false;
  try {
    const dir = process.env.CLOAKBROWSER_CACHE_DIR;
    const f = fs.readdirSync(dir).find(n => n.startsWith('_download_'));
    if (f) downloaded = fs.statSync(path.join(dir, f)).size;
    unpacking = !!(f && total && downloaded >= total);
  } catch { /* not created yet */ }
  const pct = total ? Math.min(100, Math.floor((downloaded / total) * 100)) : null;
  return { downloadedMB: Math.round(downloaded / 1048576), totalMB: total ? Math.round(total / 1048576) : null, pct, unpacking };
}

export async function launch() { return cb().launch({ headless: true, locale: 'en-US' }); }
export const userAgent = () => undefined; // CloakBrowser sets its own

// ---- Licence key (optional; the free keyless binary works) ----------------------------------------------------------
const keyFile = () => path.join(process.env.CLOAKBROWSER_CACHE_DIR, 'license.key');
const readKey = () => { try { return fs.readFileSync(keyFile(), 'utf8').trim() || null; } catch { return null; } };
export const licence = {
  info() {
    const env = (process.env.CLOAKBROWSER_LICENSE_KEY || '').trim();
    const key = env || readKey();
    return key ? { present: true, masked: `${key.slice(0, 5)}…${key.slice(-4)}`, source: env ? 'env' : 'file' } : { present: false };
  },
  set(key) {
    const k = String(key || '').trim();
    if (!/^cb_[A-Za-z0-9_-]{8,200}$/.test(k)) throw Object.assign(new Error('That doesn’t look like a CloakBrowser key (they start with cb_).'), { status: 422 });
    fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
    fs.writeFileSync(keyFile(), k, { mode: 0o600 });
  },
  remove() { fs.rmSync(keyFile(), { force: true }); },
};
