// CloakBrowser — Jessbot's only way onto the internet (decisions #15, #43).
// One headless browser shared by every tool, launched on first use and closed when idle. Each task gets its own
// incognito context; a request guard blocks the local network (SSRF) and, when reading, heavy media.
// The binary lives in ./tools/cloakbrowser: downloaded per install, pinned to this wrapper's version, never committed.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { paths } from '../config/index.js';
import { settings } from '../db/index.js';
import { loadProfile, saveProfile } from './profiles.js';
import { cleanSearxngUrl, testSearxng, resetSearxngHealth, searxngState } from './searxng.js';
import { currentEngine, loadEngine, adblockDecision, adblockState, noteAdblockError } from './adblock.js';
import { adsAndTrackingLists } from '@ghostery/adblocker';

process.env.CLOAKBROWSER_CACHE_DIR ||= paths.cloakbrowser;
process.env.CLOAKBROWSER_AUTO_UPDATE = 'false'; // pinned: the binary changes only when the admin presses Install/Update
const cb = await import('cloakbrowser');

export const DEFAULTS = { maxPages: 2, idleMinutes: 5, blockMedia: true, allowPrivate: false, engines: ['duckduckgo', 'brave', 'bing'], searxngUrl: '', blockAds: false };
export const ENGINE_LABELS = { duckduckgo: 'DuckDuckGo', brave: 'Brave Search', bing: 'Bing', google: 'Google', startpage: 'Google (via Startpage)' };
export const browserSettings = () => ({ ...DEFAULTS, ...settings.get('browser', {}) });

/**
 * Save Admin → Browser. searxngUrl (decision #138): '' turns SearXNG off; a new address is tested with a real query before
 * it is saved (a failure throws with err.field = 'searxngUrl'); left out, the saved one stays.
 */
export async function saveBrowserSettings(input, { test = testSearxng, start = () => startAdblock({ force: true }) } = {}) {
  const s = browserSettings();
  let searxngUrl = s.searxngUrl || '';
  if (input.searxngUrl !== undefined) {
    try {
      searxngUrl = cleanSearxngUrl(input.searxngUrl);
      if (searxngUrl && searxngUrl !== s.searxngUrl) await test(searxngUrl);
    } catch (err) {
      throw Object.assign(new Error(`SearXNG: ${err.message}`), { field: 'searxngUrl' });
    }
  }
  const next = {
    maxPages: Math.max(1, Math.min(4, Number(input.maxPages) || s.maxPages)),
    idleMinutes: Math.max(1, Math.min(60, Number(input.idleMinutes) || s.idleMinutes)),
    blockMedia: !!input.blockMedia,
    allowPrivate: !!input.allowPrivate,
    engines: Object.keys(ENGINE_LABELS).filter(k => [].concat(input.engines || []).includes(k)),
    searxngUrl,
    // Ad and tracker blocking (decision #168): off unless the admin turns it on; a form that leaves it out keeps it.
    blockAds: input.blockAds === undefined ? !!s.blockAds : !!input.blockAds,
  };
  if (!next.engines.length) next.engines = ['duckduckgo'];
  settings.set('browser', next);
  resetSearxngHealth();
  if (next.blockAds) start(); // fetch the lists now, not during someone's first page
  return next;
}

export class BrowserUnavailable extends Error {
  constructor(message) { super(message); this.name = 'BrowserUnavailable'; }
}

// ---- Licence key (optional; free keyless binary works) -------------------------------------------------
const keyFile = () => path.join(process.env.CLOAKBROWSER_CACHE_DIR, 'license.key');
const readKey = () => { try { return fs.readFileSync(keyFile(), 'utf8').trim() || null; } catch { return null; } };

export function licenseInfo() {
  const env = (process.env.CLOAKBROWSER_LICENSE_KEY || '').trim();
  const key = env || readKey();
  return key ? { present: true, masked: `${key.slice(0, 5)}…${key.slice(-4)}`, source: env ? 'env' : 'file' } : { present: false };
}

export async function setLicenseKey(key) {
  const k = String(key || '').trim();
  if (!/^cb_[A-Za-z0-9_-]{8,200}$/.test(k)) throw Object.assign(new Error('That doesn’t look like a CloakBrowser key (they start with cb_).'), { status: 422 });
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), k, { mode: 0o600 });
  await closeBrowser();
}

export async function removeLicenseKey() {
  fs.rmSync(keyFile(), { force: true });
  await closeBrowser();
}

// ---- Install / update ------------------------------------------------------------------------------------
let install = { state: 'idle' };
let installing = null;

export function installBrowser() {
  if (installing) return installing;
  install = { state: 'installing', startedAt: Date.now(), total: null };
  expectedSize().then(total => { if (install.state === 'installing') install.total = total; });
  installing = (async () => {
    try {
      await closeBrowser();
      const binary = await cb.ensureBinary();
      install = { state: 'done', finishedAt: Date.now(), binary };
      console.log(`[browser] ready: ${binary}`);
      return binary;
    } catch (err) {
      install = { state: 'error', error: err.message.split('\n')[0] };
      console.error('[browser] install failed:', err.message);
      throw err;
    } finally { installing = null; }
  })();
  installing.catch(() => {});
  return installing;
}

async function expectedSize() {
  try {
    const res = await fetch(cb.binaryInfo().downloadUrl, { method: 'HEAD', redirect: 'follow' });
    return Number(res.headers.get('content-length')) || null;
  } catch { return null; }
}

// The wrapper downloads to "_download_<ts>.zip|tar.gz" next to the binary folders; its size is our progress.
function installProgress() {
  if (install.state !== 'installing') return null;
  let downloaded = 0, unpacking = false;
  try {
    const dir = process.env.CLOAKBROWSER_CACHE_DIR;
    const f = fs.readdirSync(dir).find(n => n.startsWith('_download_'));
    if (f) downloaded = fs.statSync(path.join(dir, f)).size;
    unpacking = !!(f && install.total && downloaded >= install.total);
  } catch { /* not created yet */ }
  const pct = install.total ? Math.min(100, Math.floor((downloaded / install.total) * 100)) : null;
  return { downloadedMB: Math.round(downloaded / 1048576), totalMB: install.total ? Math.round(install.total / 1048576) : null, pct, unpacking };
}

// ---- Status ------------------------------------------------------------------------------------------------
let browser = null, launching = null, idleTimer = null, active = 0, lastUsedAt = null, blockedCount = 0;
const waiters = [];
const recent = [];

export function browserStatus() {
  let info;
  try { info = cb.binaryInfo(); } catch (err) { info = { installed: false, error: err.message }; }
  const override = process.env.CLOAKBROWSER_BINARY_PATH;
  return {
    installed: !!(info.installed || (override && fs.existsSync(override))),
    version: info.version || null, major: info.version ? String(info.version).split('.')[0] : null, tier: info.tier || 'free', platform: info.platform || `${process.platform}-${process.arch}`,
    binaryPath: override || info.binaryPath || null, cacheDir: process.env.CLOAKBROWSER_CACHE_DIR,
    installing: install.state === 'installing', installError: install.state === 'error' ? install.error : null,
    progress: installProgress(), unsupported: info.error || null,
    running: !!browser, openPages: active, queued: waiters.length, lastUsedAt, blockedCount,
    license: licenseInfo(),
    searxng: browserSettings().searxngUrl ? { url: browserSettings().searxngUrl, ...searxngState() } : null, // Phase 25: Admin → Browser shows it
    adblock: browserSettings().blockAds ? { ...adblockState(), building: !!adblockBuilding, blocked: adsBlocked } : null, // Phase 25: shown there too
  };
}

export const recentBrowsing = () => recent.slice();
export function note(entry) {
  recent.unshift({ at: new Date().toISOString(), ...entry });
  if (recent.length > 50) recent.length = 50;
}

// ---- Browser lifecycle -----------------------------------------------------------------------------------
async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (install.state === 'installing') {
    const p = installProgress();
    throw new BrowserUnavailable(`The browser is still being installed${p?.pct != null ? ` (${p.pct}%)` : ''} — try again in a minute.`);
  }
  if (!browserStatus().installed) throw new BrowserUnavailable('The browser isn’t installed yet. The admin can install it in Admin → Browser.');
  launching ||= (async () => {
    const b = await cb.launch({ headless: true, locale: 'en-US' });
    b.on('disconnected', () => { if (browser === b) browser = null; });
    browser = b;
    console.log(`[browser] launched Chromium ${b.version()}`);
    return b;
  })().finally(() => { launching = null; });
  return launching;
}

export async function closeBrowser() {
  clearTimeout(idleTimer);
  const b = browser;
  browser = null;
  if (b) await b.close().catch(() => {});
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  if (active || sessionCount || !browser) return;
  idleTimer = setTimeout(() => { if (!active && !sessionCount) closeBrowser(); }, browserSettings().idleMinutes * 60000);
  idleTimer.unref();
}

// At most `maxPages` pages at once; the rest wait their turn (visible as "queued" in Admin → Browser).
const acquire = () => new Promise(resolve => {
  const go = () => { active++; resolve(); };
  active < browserSettings().maxPages ? go() : waiters.push(go);
});
function release() { active--; waiters.shift()?.(); scheduleIdle(); }

const abortError = () => Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });

/**
 * Run fn(page) in a fresh incognito context. Closes everything afterwards, or as soon as `signal` aborts.
 * media: load images/fonts/video (screenshots) — otherwise blocked when settings.blockMedia is on.
 */
// profile: a cookie jar file kept between calls (search engines remember a solved check instead of asking every time),
// sealed on disk (profiles.js). storageState: cookies to start from that are NOT written back (web_read's retry with the
// person's own cookies, decision #136: read-only). deviceScaleFactor: pixels per CSS pixel (2 for sharp PNG exports; default 1).
// mobile: a phone (touch, the page's mobile viewport rules; web_screenshot's mobile view, decision #166). Pages opened only to
// be read ask for reduced motion (#168): no animations to wait for; captures (media) keep the page's normal look.
export async function withPage(fn, { signal, media = false, viewport = { width: 1280, height: 900 }, profile, storageState, deviceScaleFactor, mobile = false } = {}) {
  await acquire();
  let ctx;
  try {
    if (signal?.aborted) throw abortError();
    const b = await getBrowser();
    ctx = await b.newContext({ viewport, locale: 'en-US', serviceWorkers: 'block', acceptDownloads: false,
      storageState: profile ? loadProfile(profile) : storageState, ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
      ...(mobile ? { isMobile: true, hasTouch: true, userAgent: mobileUserAgent(b.version()) } : {}), ...(media ? {} : { reducedMotion: 'reduce' }) });
    await guard(ctx, { blockMedia: !media && browserSettings().blockMedia });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    const onAbort = () => ctx.close().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const out = await fn(page);
      if (profile) { const state = await ctx.storageState().catch(() => null); if (state) saveProfile(profile, state); } // else: the next search solves the check again
      return out;
    } catch (err) {
      if (signal?.aborted) throw abortError();
      throw err;
    } finally { signal?.removeEventListener('abort', onAbort); }
  } finally {
    await ctx?.close().catch(() => {});
    lastUsedAt = new Date().toISOString();
    release();
  }
}

/** A phone's user agent for the same Chrome version (sites that pick their mobile layout by the user agent — Wikipedia
 *  sends phones to en.m. — only show it to a phone). Used for web_screenshot's mobile view, never for Jess's sessions. */
export const mobileUserAgent = version => `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${String(version || '146').split('.')[0]}.0.0.0 Mobile Safari/537.36`;

/**
 * A long-lived incognito context for an interactive browsing session (session.js): same request guard, images on,
 * downloads accepted. Sessions don't take page slots; they keep the browser alive until closed.
 */
let sessionCount = 0;
export async function openSessionContext({ viewport = { width: 1280, height: 900 }, storageState } = {}) {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport, locale: 'en-US', serviceWorkers: 'block', acceptDownloads: true, storageState, reducedMotion: 'reduce' });
  await guard(ctx, { blockMedia: false });
  ctx.setDefaultTimeout(15000);
  sessionCount++;
  clearTimeout(idleTimer);
  ctx.on('close', () => { sessionCount--; lastUsedAt = new Date().toISOString(); scheduleIdle(); });
  return ctx;
}

// ---- Request guard: public internet only ------------------------------------------------------------------
const HEAVY = new Set(['image', 'media', 'font']);

async function guard(ctx, { blockMedia }) {
  const { allowPrivate, blockAds } = browserSettings();
  if (blockAds && !currentEngine()) startAdblock();
  await ctx.route('**/*', routeGuard({ blockMedia, allowPrivate, blockAds }));
}

/**
 * The request guard itself, one route handler per context: heavy media (when reading), then the network check (public
 * internet only), then — only for what passed that — ad and tracker blocking (decision #168). engine: the ad blocker
 * (default: the loaded one; tests pass their own).
 */
export function routeGuard({ blockMedia = false, allowPrivate = false, blockAds = false, engine = currentEngine } = {}) {
  return async route => {
    const req = route.request();
    if (blockMedia && HEAVY.has(req.resourceType())) return route.abort('blockedbyclient');
    if (!allowPrivate && await isPrivateUrl(req.url())) {
      blockedCount++;
      return route.abort('blockedbyclient');
    }
    const hit = blockAds ? adblockDecision(engine(), requestDetails(req)) : null;
    if (hit?.redirect) { adsBlocked++; return route.fulfill({ status: 200, contentType: hit.redirect.contentType, body: hit.redirect.body }); }
    if (hit?.block) { adsBlocked++; return route.abort('blockedbyclient'); }
    return route.continue();
  };
}

/** What the ad blocker needs to know about a request: its type, the frame that asked, the top page, and whether it is the
 *  top page's own navigation (never blocked). Frames can be gone by now (a service-worker request): then only the address. */
function requestDetails(req) {
  let frame = null, page = null;
  try { frame = req.frame(); page = frame.page(); } catch { /* no frame */ }
  const mainFrame = !!frame && !!page && frame === page.mainFrame() && req.isNavigationRequest();
  return { url: req.url(), type: req.resourceType(), sourceUrl: frame?.url() || req.headers().referer || '', pageUrl: page?.url() || '', mainFrame };
}

// ---- The filter lists (decision #168): fetched through our own browser, compiled once a week --------------------------------
let adblockBuilding = null, adsBlocked = 0, adblockFailedAt = 0;
const ADBLOCK_RETRY_MS = 3600000; // after a failed download, pages go unblocked for an hour instead of retrying on each one
/** Load (or download and compile) the ad-blocking engine in the background; pages don't wait for it. */
export function startAdblock({ force = false } = {}) {
  if (currentEngine() || adblockBuilding) return adblockBuilding;
  if (!force && Date.now() - adblockFailedAt < ADBLOCK_RETRY_MS) return null;
  adblockBuilding = loadEngine().catch(() => withPage(async page => {
    // Each list is opened as a page in turn (the library asks for all at once; one page takes them one by one) and its
    // bytes read from the response — the same request guard as everything else. (Fetching from inside the first list's
    // page doesn't work: raw.githubusercontent.com sends a sandboxing CSP that forbids it.)
    let queue = Promise.resolve();
    const fetchOne = async url => {
      const res = await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
      if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status() ?? 'no answer'} for ${url}`);
      return (await res.body()).toString('utf8');
    };
    const fetcher = url => {
      const got = queue.then(() => fetchOne(url));
      queue = got.catch(() => {});
      return got.then(t => ({ text: async () => t, json: async () => JSON.parse(t), arrayBuffer: async () => new TextEncoder().encode(t).buffer }));
    };
    return loadEngine({ fetcher });
  }, { media: false, viewport: { width: 800, height: 600 } }))
    .then(e => { console.log('[browser] ad and tracker blocking ready'); return e; })
    .catch(err => { adblockFailedAt = Date.now(); noteAdblockError(err); console.warn('[browser] ad blocking lists not ready:', String(err.message).split('\n')[0]); return null; })
    .finally(() => { adblockBuilding = null; });
  return adblockBuilding;
}

const PRIVATE = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(a, p, 'ipv6');

export function isPrivateIp(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return PRIVATE.check(mapped[1], 'ipv4');
  const v = net.isIP(ip);
  return v ? PRIVATE.check(ip, v === 6 ? 'ipv6' : 'ipv4') : true;
}

const dnsCache = new Map();
/** True for anything that isn't a public http(s) address (localhost, LAN, link-local/cloud metadata, file:, …). */
export async function isPrivateUrl(u) {
  let url;
  try { url = new URL(u); } catch { return true; }
  if (['data:', 'blob:', 'about:'].includes(url.protocol)) return false;
  if (!['http:', 'https:'].includes(url.protocol)) return true;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < 60000) return hit.private;
  let priv = false;
  try { priv = (await dns.lookup(host, { all: true })).some(a => isPrivateIp(a.address)); } catch { /* unresolvable: the browser fails on its own */ }
  if (dnsCache.size > 2000) dnsCache.clear();
  dnsCache.set(host, { private: priv, at: Date.now() });
  return priv;
}
