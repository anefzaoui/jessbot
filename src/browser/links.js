// Which deep-link recipes still work (decision #164). `npm run links:check` (scripts/links-check.js) opens one sample
// search per site (lib/deeplinks.js) through Jess's own browser and records whether it still lands on a results page.
// A recipe that stopped working is switched off here — data/deeplinks-state.json, never git — and open_search then opens
// the site's own search page so Jess uses its form. A site that shows a bot wall to this network is recorded as blocked,
// not broken: the recipe may be fine, the site just said no today.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/index.js';
import { withPage } from './index.js';
import { probeWall, dismissConsent, trackDocument } from './walls.js';
import { siteOf } from './profiles.js';
import { SITES, SITE_KEYS, buildLink, sampleOf, todayIn } from '../lib/deeplinks.js';
import { trimEndChars } from '../lib/text-safe.js';

export const linkStateFile = () => path.join(paths.data, 'deeplinks-state.json');

/** { checkedAt, sites: { key: { status: ok|broken|blocked|error, at, url, detail, ms } } } — empty when never checked. */
export function loadLinkState() {
  try {
    const j = JSON.parse(fs.readFileSync(linkStateFile(), 'utf8'));
    return j && typeof j.sites === 'object' ? j : { checkedAt: null, sites: {} };
  } catch { return { checkedAt: null, sites: {} }; }
}

export function saveLinkState(state) {
  const file = linkStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The check that switched a site's recipe off ({ at, detail }), or null while it is on (never checked counts as on). */
export function recipeOff(site, state = loadLinkState()) {
  const s = state.sites?.[site];
  return s?.status === 'broken' ? { at: s.at, detail: s.detail } : null;
}

const pathAndQuery = u => { try { const x = new URL(u); return `${trimEndChars(x.pathname, '/')}${x.search}`; } catch { return ''; } };

/**
 * Did a sample link land on results? Pure. → { status: ok|broken|blocked, detail }.
 * link: buildLink's answer; finalUrl/status/wall/title/text/textLength: what the browser saw.
 */
export function linkVerdict({ link, finalUrl, status = null, wall = null, title = '', text = '', textLength = null, expect = null }) {
  if (wall) return { status: 'blocked', detail: `${wall} (the recipe may still be fine)` };
  if (status >= 400) return { status: 'broken', detail: `the site answered ${status}` };
  let asked, landed;
  try { asked = new URL(link.url); landed = new URL(finalUrl); } catch { return { status: 'broken', detail: 'no page loaded' }; }
  if (siteOf(landed.hostname) !== siteOf(asked.hostname)) return { status: 'broken', detail: `it went to ${landed.hostname}` };
  const hadSearch = pathAndQuery(link.url).length > 1;
  if (hadSearch && pathAndQuery(finalUrl) === '' && !landed.hash) return { status: 'broken', detail: 'it went to the home page' };
  const len = textLength ?? String(text).length;
  if (len < 300) return { status: 'broken', detail: `the page is nearly empty (${len} characters)` };
  if (expect && !expect.test(`${title}\n${text}`)) return { status: 'broken', detail: 'no results on the page' };
  return { status: 'ok', detail: `${String(title).slice(0, 80) || landed.hostname}` };
}

// A navigation that failed on this machine's side — the browser couldn't reach its own guard proxy, or the computer is
// offline — says nothing about the site: it is an error (the last verdict stays), not "blocked by the site" (decision #257).
const OUR_SIDE = /net::ERR_(PROXY_CONNECTION_FAILED|INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED)\b/;
export const failedOnOurSide = message => OUR_SIDE.test(String(message || ''));
const navError = message => (/net::ERR_[A-Z_]+/.exec(message)?.[0] || String(message).slice(0, 120));

/**
 * Open one site's sample search and judge it. → { site, url, status, detail, ms } (never throws).
 * recipes: the recipe table (lib/deeplinks.js SITES); open: how a page is opened (withPage: Jess's browser, its guard
 * proxy and request guard). Tests bring local stand-ins for both.
 */
export async function checkLink(site, { today = todayIn(), signal, recipes = SITES, open = withPage } = {}) {
  const t = Date.now();
  let link;
  try { link = buildLink(site, sampleOf(site, today, recipes), { today, homeCountry: null, recipes }); } catch (err) {
    return { site, url: null, status: 'error', detail: `the sample didn’t build: ${err.message}`, ms: 0 };
  }
  try {
    const out = await open(async page => {
      if (link.kind === 'json') {
        // Data recipes may have mirrors (Overpass): the recipe works when any of them answers JSON.
        const tried = [], ours = [];
        for (const url of [link.url, ...link.alternates]) {
          const res = await page.goto(url, { waitUntil: 'commit', timeout: 20000 }).catch(err => ({ error: err.message.split('\n')[0] }));
          const host = new URL(url).hostname;
          if (res.error) { tried.push(`${host}: no answer (${navError(res.error)})`); ours.push(failedOnOurSide(res.error)); continue; }
          ours.push(false);
          const body = (await res.body().catch(() => Buffer.alloc(0))).toString('utf8');
          let ok = false;
          try { ok = typeof JSON.parse(body) === 'object'; } catch { /* not JSON */ }
          if (ok && res.status() < 400) return { status: 'ok', detail: `JSON from ${host}, ${body.length} bytes${tried.length ? ` (${tried.join('; ')})` : ''}` };
          tried.push(`${host}: HTTP ${res.status()}${ok ? '' : ', not JSON'}`);
          if ([403, 429].includes(res.status()) && !link.alternates.length) return { status: 'blocked', detail: `HTTP ${res.status()} (rate limit or block; the recipe may still be fine)` };
        }
        if (ours.every(Boolean)) return { status: 'error', detail: `this computer couldn’t reach the site (${tried.join('; ')})` };
        return { status: tried.every(t => /no answer|HTTP (403|406|429|5\d\d)/.test(t)) ? 'blocked' : 'broken', detail: tried.join('; ') };
      }
      const res = await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const doc = trackDocument(page, res);
      try {
        await page.waitForLoadState('load', { timeout: 12000 }).catch(() => {});
        if (await dismissConsent(page)) await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(2500); // results pages fill in after load
        const wall = await probeWall(page, doc.status());
        const seen = await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText || '').slice(0, 20000), len: (document.body?.innerText || '').trim().length })).catch(() => ({ title: '', text: '', len: 0 }));
        const verdict = linkVerdict({ link, finalUrl: page.url(), status: doc.status(), wall: wall?.label || null, title: seen.title, text: seen.text, textLength: seen.len, expect: recipes[site].expect || null });
        if (verdict.status !== 'broken' || !/answered|nearly empty/.test(verdict.detail)) return verdict;
        // An error or an empty page: is it the recipe, or does the whole site refuse this browser? Its home page decides.
        const home = await page.goto(link.home, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        await page.waitForTimeout(2500);
        const homeWall = await probeWall(page, home?.status() ?? null);
        const homeLen = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0);
        if (homeWall || !home || home.status() >= 400 || homeLen < 300) {
          return { status: 'blocked', detail: `the whole site refuses this browser (${verdict.detail}; its home page too: ${homeWall?.label || (home ? `HTTP ${home.status()}, ${homeLen} characters` : 'no answer')})` };
        }
        return verdict;
      } finally { doc.stop(); }
    }, { signal, media: false, viewport: { width: 1280, height: 900 } });
    return { site, url: link.url, ...out, ms: Date.now() - t };
  } catch (err) {
    return { site, url: link.url, status: 'error', detail: String(err.message || err).split('\n')[0].slice(0, 200), ms: Date.now() - t };
  }
}

/** Check sites (default: all) one after another and record the results. Only a broken result switches a recipe off. */
export async function checkLinks(sites = SITE_KEYS, { today = todayIn(), onResult = () => {}, recipes = SITES, open = withPage } = {}) {
  const state = loadLinkState();
  const results = [];
  for (const site of sites) {
    const r = await checkLink(site, { today, recipes, open });
    results.push(r);
    // An error (our side: the browser, the network) keeps the last verdict; everything else replaces it.
    if (r.status !== 'error' || !state.sites[site]) state.sites[site] = { status: r.status, at: new Date().toISOString(), url: r.url, detail: r.detail, ms: r.ms };
    onResult(r);
  }
  state.checkedAt = new Date().toISOString();
  saveLinkState(state);
  return results;
}
