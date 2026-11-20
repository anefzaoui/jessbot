// Asset fingerprinting (decision #51): the stylesheet, icon sprite and entry script are referenced as `?v=<hash>` and
// cached as immutable, so navigating between pages never waits on a revalidation (which made Brave paint fallback
// fonts and icon-less buttons for a moment on every page). A rebuild changes the hash; the next page load picks it up.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config/index.js';

const FILES = ['css/app.css', 'icons.svg', 'js/main.js'];
let cached = null, checkedAt = 0;

/** Short hash of the built assets' mtimes + sizes. Re-checked at most every 2 s (cheap stats), so rebuilds show up. */
export function assetVersion() {
  if (cached && Date.now() - checkedAt < 2000) return cached;
  const h = crypto.createHash('sha1');
  for (const f of FILES) {
    try { const st = fs.statSync(path.join(paths.public, f)); h.update(`${f}:${st.mtimeMs}:${st.size};`); } catch { h.update(`${f}:missing;`); }
  }
  // JS modules imported by main.js are part of the same release: include the newest of them.
  try {
    const dir = path.join(paths.public, 'js');
    h.update(String(Math.max(...fs.readdirSync(dir).map(n => fs.statSync(path.join(dir, n)).mtimeMs))));
  } catch { /* no js dir */ }
  cached = h.digest('hex').slice(0, 10);
  checkedAt = Date.now();
  return cached;
}

/** express.static setHeaders: fingerprinted → immutable for a year; fonts/images → 30 days; everything else revalidates. */
export function staticCacheHeaders(res, file) {
  if (res.req?.query?.v) return res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (/[\\/]fonts[\\/]/.test(file)) return res.setHeader('Cache-Control', 'public, max-age=2592000');
  if (/[\\/]img[\\/].*\.(webp|png|jpe?g|svg)$/.test(file)) return res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Cache-Control', 'no-cache');
}
