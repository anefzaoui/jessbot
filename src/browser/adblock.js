// Ad and tracker blocking for Jess's browser (decision #168), off by default (Admin → Browser). Ghostery's adblocker
// engine (@ghostery/adblocker, MPL-2.0, used unmodified) matches each request INSIDE the existing request guard
// (index.js guard()): the SSRF check runs first and always, then this — never the library's enableBlockingInPage, which
// installs its own request interception beside ours. Documents Jess opens herself are never blocked, only what a page
// pulls in (ad scripts, trackers, ad frames); a matched script can be replaced by the list's harmless stand-in (redirect)
// so the page doesn't break. The filter lists (EasyList, EasyPrivacy, uBlock Origin's lists — downloaded per install,
// never committed) come through the browser itself (decision #15: the browser is the only way out) and are kept compiled
// in <data>/adblock/engine.bin for a week. A site that shows an anti-adblock wall gets blocking switched off for 30 days.
import fs from 'node:fs';
import path from 'node:path';
import { FiltersEngine, Request, adsAndTrackingLists } from '@ghostery/adblocker';
import { paths } from '../config/index.js';
import { settings } from '../db/index.js';

const MAX_AGE_MS = 7 * 864e5;
const OFF_MS = 30 * 864e5;
const engineFile = () => path.join(paths.data, 'adblock', 'engine.bin');

let engine = null, lastError = null;

/** The engine when it is ready, else null (pages load unblocked rather than wait; index.js starts the build). */
export const currentEngine = () => engine;

/** Load the compiled engine from disk (fresh and the right version), else build it from the lists and save it. */
export async function loadEngine({ fetcher, now = Date.now() } = {}) {
  const file = engineFile();
  try {
    const st = fs.statSync(file);
    if (now - st.mtimeMs < MAX_AGE_MS) { engine = FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(file))); return engine; }
  } catch { /* none yet, or an older engine version: build */ }
  if (!fetcher) throw new Error('no way to download the filter lists');
  const built = await FiltersEngine.fromLists(fetcher, adsAndTrackingLists);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, built.serialize());
  fs.renameSync(tmp, file);
  engine = built;
  lastError = null;
  return engine;
}

export const adblockState = () => ({ ready: !!engine, error: lastError });
export const noteAdblockError = err => { lastError = String(err?.message || err).split('\n')[0]; };
export const resetAdblock = (e = null) => { engine = e; lastError = null; offCache = null; }; // tests

// ---- Per-site off switch (anti-adblock walls) -----------------------------------------------------------------------------
const bare = h => String(h || '').toLowerCase().replace(/^www\d*\./, '');
// Read on every request, so kept in memory for 30 s (and dropped whenever it changes).
let offCache = null;
const offList = () => {
  if (!offCache || Date.now() - offCache.at > 30000) offCache = { at: Date.now(), list: settings.get('browser.adblockOff', {}) || {} };
  return offCache.list;
};

/** Blocking is off for this host (a site that asked for it to be turned off, within 30 days). */
export function adblockOffFor(host) {
  const until = offList()[bare(host)];
  return !!until && Date.parse(until) > Date.now();
}
export function switchOffFor(host) {
  const list = Object.fromEntries(Object.entries(offList()).filter(([, until]) => Date.parse(until) > Date.now()));
  list[bare(host)] = new Date(Date.now() + OFF_MS).toISOString();
  settings.set('browser.adblockOff', list);
  offCache = null;
}
/** The sites blocking is off for now: [{ host, until (ISO) }], soonest back on first (Admin → Browser, Phase 25). */
export const sitesSwitchedOff = () => Object.entries(offList()).filter(([, until]) => Date.parse(until) > Date.now())
  .map(([host, until]) => ({ host, until })).sort((a, b) => a.until.localeCompare(b.until));
/** The admin turns blocking back on for a site before its 30 days are up. → true when it was off. */
export function switchOnFor(host) {
  const list = { ...offList() };
  if (!(bare(host) in list)) return false;
  delete list[bare(host)];
  settings.set('browser.adblockOff', list);
  offCache = null;
  return true;
}

// A page that noticed the blocker: "disable your ad blocker", "whitelist this site", in the languages Jess meets most.
// A request, not a mention: an article about ad blockers doesn't switch anything off.
const ANTI_ADBLOCK = /\b(disable|turn off|pause|switch off|deactivate|whitelist|allowlist)\b[^.]{0,40}\bad ?-?block|\bad ?-?block(er)?\b[^.]{0,30}\b(detected|enabled|is on|is active)\b|\b(using|use) an ad ?-?blocker|whitelist (us|this site)|allow ads on|bloqueur de pub\w*|désactive[rz]? (votre |ton )?(bloqueur|adblock)|werbeblocker|bloqueador de anuncios|مانع الإعلانات/i;
/** Does this page (title + the first ~1,500 characters of text) ask to turn the ad blocker off? Pure. */
export const antiAdblockWall = ({ title = '', text = '' } = {}) => ANTI_ADBLOCK.test(`${title}\n${String(text).slice(0, 1500)}`);

// ---- Matching (called from the request guard) ----------------------------------------------------------------------------
/**
 * What to do with one request → null (let it through) | { block: true } | { redirect: { body, contentType } }.
 * url, type: Playwright's resourceType; sourceUrl: the frame that asked; pageUrl: the top page (its site may be switched
 * off); mainFrame: a navigation of the top page (never blocked — Jess opened it). Pure given the engine.
 */
export function adblockDecision(e, { url, type, sourceUrl = '', pageUrl = '', mainFrame = false }) {
  if (!e || mainFrame || !/^https?:/i.test(url)) return null;
  let top = '';
  try { top = new URL(pageUrl || sourceUrl).hostname; } catch { /* about:blank */ }
  if (top && adblockOffFor(top)) return null;
  const res = e.match(Request.fromRawDetails({ url, sourceUrl, type: type === 'document' ? 'sub_frame' : type }));
  if (res.redirect && !res.exception) {
    const b64 = /^data:[^,]*;base64,(.*)$/s.exec(res.redirect.dataUrl || '');
    return { redirect: { body: b64 ? Buffer.from(b64[1], 'base64') : Buffer.from(res.redirect.body || ''), contentType: res.redirect.contentType } };
  }
  if (res.match && !res.exception) return { block: true };
  return null;
}
