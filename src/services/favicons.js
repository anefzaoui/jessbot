// Site icons for run steps (owner: "the browser widget should show favicons"). Fetched once through the browser (src/browser/, the only
// way out), cached in data/favicons, served from our own origin (the CSP allows only our images). Sites without an icon
// get a lettered badge. Page-declared icons (<link rel="icon">) seen while browsing are preferred.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/index.js';
import { fetchRaw } from '../browser/read.js';
import { browserStatus } from '../browser/index.js';

const DIR = path.join(paths.data, 'favicons');
const RETRY_MS = 7 * 864e5;
const hints = new Map(); // host → icon URL declared by the page
const inflight = new Map();

export const validHost = h => /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(h || ''));
// ?v= busts browser caches of the lettered badges served while every fetch was failing (2026-09).
export const iconUrl = host => { const h = String(host || '').toLowerCase().replace(/^www\./, ''); return validHost(h) ? `/favicons/${h}?v=2` : null; };
export const faviconPath = url => { try { return iconUrl(new URL(url).hostname); } catch { return null; } };
export function noteIcon(pageUrl, declared) {
  try { const h = new URL(pageUrl).hostname.replace(/^www\./, ''); if (declared && /^https?:/.test(declared)) hints.set(h, declared); } catch { /* ignore */ }
}

const TYPES = { 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/png': 'png', 'image/svg+xml': 'svg', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
// "<host>.miss" = no icon found (retried weekly). Older "<host>.none" markers came from a fetch that could never
// succeed (see candidates), so they're dropped.
const cached = host => {
  const files = fs.readdirSync(DIR).filter(f => f.startsWith(`${host}.`) && /^[a-z]+$/.test(f.slice(host.length + 1)));
  for (const f of files.filter(f => f.endsWith('.none'))) fs.rmSync(path.join(DIR, f), { force: true });
  return files.find(f => !f.endsWith('.none')) || null;
};

// Where to look, best first. Chromium aborts a top-level navigation to exactly "/favicon.ico" (net::ERR_ABORTED), so the
// conventional path gets a query string; Google's favicon service covers sites that only declare icons in their HTML.
const candidates = host => [hints.get(host), `https://${host}/favicon.ico?v=1`,
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`].filter(Boolean);

async function fetchIcon(host) {
  fs.mkdirSync(DIR, { recursive: true });
  for (const url of candidates(host)) {
    try {
      const r = await fetchRaw(url, { media: true, timeout: 8000 });
      const ext = TYPES[r.contentType.split(';')[0]] || (/\.ico(\?|$)/i.test(url) && r.body.length ? 'ico' : null);
      if (r.status === 200 && ext && r.body.length > 50 && r.body.length < 300000) { fs.writeFileSync(path.join(DIR, `${host}.${ext}`), r.body); return; }
    } catch { /* try the next */ }
  }
  fs.writeFileSync(path.join(DIR, `${host}.miss`), String(Date.now()));
}

/** { file } of a cached icon, or { badge: svg } — fetching on first use (once at a time per host). */
export async function iconFor(host) {
  fs.mkdirSync(DIR, { recursive: true });
  let file = cached(host);
  if (file?.endsWith('.miss') && Date.now() - Number(fs.readFileSync(path.join(DIR, file), 'utf8')) > RETRY_MS) { fs.rmSync(path.join(DIR, file)); file = null; }
  if (!file && browserStatus().installed) {
    if (!inflight.has(host)) inflight.set(host, fetchIcon(host).finally(() => inflight.delete(host)));
    await Promise.race([inflight.get(host), new Promise(r => setTimeout(r, 9000))]);
    file = cached(host);
  }
  if (file && !file.endsWith('.miss')) return { file: path.join(DIR, file) };
  let hue = 0;
  for (const c of host) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  const letter = host.replace(/^www\./, '')[0].toUpperCase();
  return { badge: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="hsl(${hue} 55% 45%)"/><text x="16" y="22" font-family="Inter,Arial,sans-serif" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>` };
}
