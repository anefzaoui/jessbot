// Reading pages, searching and screenshots — all through the browser (./index.js).
// Extraction: @mozilla/readability on a linkedom DOM → Turndown markdown (links reduced to their text,
// media dropped: fewer tokens, same meaning). Text hidden from readers never gets that far (decision #118): an in-page
// pass with computed styles (visibleHtml), then the same rules on inline styles in extract(). web_read: site readers
// (YouTube, X, Reddit; PDFs and feeds by what the response is — site-readers/, decision #135) and an escalation ladder
// past bot walls (walls.js, decision #136). Search by intent (decision #137), SearXNG first when configured (#138).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { strikethrough } from 'turndown-plugin-gfm';
import { paths } from '../config/index.js';
import { withPage, note, browserSettings, isPrivateUrl, ENGINE_LABELS } from './index.js';
import * as walls from './walls.js';
import { siteReaderFor, isPdf, pdfDocument, PDF_MAX_BYTES, feedKind, renderFeed, renderOpml, normalizeFeed } from './site-readers/index.js';
import { loadProfile, profileFile, searchProfileFile, siteOf } from './profiles.js';
import { gnewsUrl, NEWS_WHEN } from './news.js';
import { searxngSearch, searxngHealthy, SEARXNG_LABEL } from './searxng.js';
import { looseDate } from '../lib/when.js';
import { pruneInPage, pruneHiddenDocument } from '../lib/hidden-text.js';
import { PATTERNS } from '../agent/injection.js';
import { pdfOptions, fontsReady } from '../services/print.js';
import { decodeEntities, trimEndChars } from '../lib/text-safe.js';

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '_' });
td.use(strikethrough);
// Tables (mostly layout: infoboxes, navboxes) as compact "a · b · c" rows — GFM pipes cost tokens and break on nesting.
td.addRule('cell', { filter: ['th', 'td'], replacement: content => `${content.replace(/\s+/g, ' ').trim()} · ` });
td.addRule('row', { filter: 'tr', replacement: content => `${content.replace(/ · $/, '')}\n` });
td.addRule('link-text', { filter: 'a', replacement: content => content });
td.addRule('no-media', { filter: ['img', 'picture', 'video', 'audio', 'iframe', 'svg', 'canvas', 'noscript', 'button', 'form'], replacement: () => '' });

const tidy = md => md.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const squash = s => String(s || '').replace(/\s+/g, ' ').trim();

export async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw new Error('That isn’t a valid web address.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('I can only open http(s) web pages.');
  if (!browserSettings().allowPrivate && await isPrivateUrl(url.href)) {
    throw new Error('That address is on a private or local network — I only browse the public web (the admin can change this in Admin → Browser).');
  }
  return url.href;
}

// A date from the page's JSON-LD (schema.org Article/NewsArticle/WebPage…).
function ldDate(document, key) {
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = v => (Array.isArray(v) ? v.map(walk).find(Boolean) : v && typeof v === 'object' ? (typeof v[key] === 'string' ? v[key] : walk(v['@graph'])) : null);
      const d = walk(JSON.parse(s.textContent));
      if (d) return d;
    } catch { /* malformed JSON-LD */ }
  }
  return null;
}

/** HTML → { title, siteName, byline, published, modified, image, excerpt, markdown, html, hidden }. Pure; used by web_read, the feed and tests.
 *  html = Readability's article HTML (unsanitized — reader mode cleans it) when the page reads as an article, else null.
 *  hidden = what the inline-style pass left out ({ removed, chars, sample, … }, lib/hidden-text.js) — both paths, article
 *  and whole-page, read the same pruned document (inline display:none included, as Readability itself does). */
export function extract(html, url) {
  const { document } = parseHTML(html);
  const hidden = pruneHiddenDocument(document);
  const meta = n => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute('content') || null;
  const head = {
    title: meta('og:title') || squash(document.querySelector('title')?.textContent),
    siteName: meta('og:site_name'), image: meta('og:image'),
    published: meta('article:published_time') || meta('og:published_time') || meta('datePublished') || meta('date') || meta('dc.date') || meta('DC.date.issued') || ldDate(document, 'datePublished'),
    modified: meta('article:modified_time') || meta('og:updated_time') || meta('dateModified') || ldDate(document, 'dateModified'),
    description: meta('og:description') || meta('description'),
  };
  let article = null;
  try { article = new Readability(document, { charThreshold: 400 }).parse(); } catch { /* fall back below */ }
  let markdown;
  const readable = !!(article?.content && article.textContent.trim().length > 200);
  if (readable) markdown = tidy(td.turndown(article.content));
  else {
    const { document: raw } = parseHTML(html);
    pruneHiddenDocument(raw);
    raw.querySelectorAll('script, style, noscript, nav, footer, header, svg').forEach(n => n.remove());
    markdown = tidy((raw.body?.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n'));
  }
  let image = head.image;
  try { if (image) image = new URL(image, url).href; } catch { image = null; }
  return {
    url, title: squash(article?.title) || head.title || url, siteName: article?.siteName || head.siteName || new URL(url).hostname,
    byline: squash(article?.byline) || null, published: article?.publishedTime || head.published || document.querySelector('time[datetime]')?.getAttribute('datetime') || null,
    modified: head.modified || null,
    image, excerpt: squash(article?.excerpt || head.description).slice(0, 300) || null, markdown, html: readable ? article.content : null,
    hidden: { removed: hidden.removed, chars: hidden.chars, sample: hidden.sample, reasons: hidden.reasons, displayNone: 0, pagePass: null },
  };
}

const PATTERN_SOURCES = PATTERNS.map(p => p.re.source);
const PRUNE_TIMEOUT_MS = 4000;

/**
 * The page's HTML without the text a reader can't see (lib/hidden-text.js pruneInPage, computed styles, the live page
 * untouched). → { html, stats } — stats null when the pass failed or timed out, and then html is page.content() as before.
 */
export async function visibleHtml(page) {
  let timer;
  try {
    // The pass may lose the race and settle later (or fail when the page closes): it must never become an unhandled rejection.
    const pass = page.evaluate(pruneInPage, { patterns: PATTERN_SOURCES, maxMs: 1500, maxNodes: 40000 }).catch(() => null);
    const out = await Promise.race([pass, new Promise(resolve => { timer = setTimeout(() => resolve(null), PRUNE_TIMEOUT_MS); })]);
    if (out?.html) { const { html, ...stats } = out; return { html, stats }; }
  } catch { /* a page that won't run it (navigating, crashed frame): the plain HTML below */ } finally { clearTimeout(timer); }
  return { html: await page.content(), stats: null };
}

/** extract() of what a reader actually sees; doc.hidden adds up both passes (pagePass: 'ok' | 'partial' | 'failed'). */
export async function extractVisible(page) {
  const { html, stats } = await visibleHtml(page);
  const doc = extract(html, page.url());
  const inline = doc.hidden;
  doc.hidden = {
    removed: (stats?.removed || 0) + inline.removed, chars: (stats?.chars || 0) + inline.chars,
    sample: [stats?.sample, inline.sample].filter(Boolean).join('\n').slice(0, 2000),
    reasons: { ...inline.reasons, ...Object.fromEntries(Object.entries(stats?.reasons || {}).map(([k, n]) => [k, n + (inline.reasons[k] || 0)])) },
    displayNone: stats?.displayNone || 0, pagePass: !stats ? 'failed' : stats.partial ? 'partial' : 'ok',
  };
  return doc;
}

// ---- Addresses ---------------------------------------------------------------------------------------------
// Tracking parameters and AMP copies change the address, not the page (decision #137): one normal form keys the page cache
// and merges search results from several engines.
export const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|ref|ref_src|ref_url|amp)$/i;

/** The address in normal form: https, no www/amp. host, no tracking parameters, no #fragment, no trailing slash, no AMP path;
 *  remaining parameters sorted. Anything that isn't an http(s) URL comes back trimmed. Pure. */
export function normalizeUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return String(raw ?? '').trim(); }
  if (!['http:', 'https:'].includes(u.protocol)) return u.href;
  // Google's AMP viewer and the AMP cache wrap the publisher's address: unwrap it.
  const viewer = /^\/amp\/(s\/)?(.+)$/.exec(u.pathname);
  if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && viewer) return normalizeUrl(`https://${viewer[2]}${u.search}`);
  const cache = /^\/[a-z]\/(?:s\/)?(.+)$/.exec(u.pathname);
  if (/\.cdn\.ampproject\.org$/i.test(u.hostname) && cache) return normalizeUrl(`https://${cache[1]}${u.search}`);
  const host = u.hostname.toLowerCase().replace(/^(www\d*|amp)\./, '');
  const path = trimEndChars(u.pathname.replace(/\/amp\/?$/i, '').replace(/\.amp(\.html?)?$/i, '$1'), '/');
  const params = [...u.searchParams].filter(([k, v]) => !TRACKING.test(k) && !(k.toLowerCase() === 'outputtype' && /^amp$/i.test(v)))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params)}` : '';
  return `https://${host}${u.port && !['80', '443'].includes(u.port) ? `:${u.port}` : ''}${path}${query}`;
}

// ---- Reading a page: site readers, then the escalation ladder (decisions #135, #136) --------------------------------------
// Recently read pages, so "read more" (start=…) doesn't reload the page. Keyed by the normal form of the address.
const cache = new Map();
const CACHE_MS = 15 * 60000;
const DOWNLOAD_MSG = 'That link downloads a file instead of showing a page. Open it with browser_open: downloads there are saved to the person’s Library.';

/** Raised when a site keeps a wall up (err.message starts with "BLOCKED:"). The tool shows it as a result, not a failure. */
export class BlockedError extends Error {
  constructor(message, { host, wall, until = null } = {}) { super(message); this.name = 'Blocked'; Object.assign(this, { host, wall, until }); }
}
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u || ''); } };
const clock = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function blocked(url, label, { resting = null, cookies = true } = {}) {
  const host = hostOf(url);
  const tail = 'Don’t treat it as the page’s content. Open it with browser_open instead — there the person can take over the tab '
    + '(hand-over) to pass the check or sign in — or use another source.';
  if (resting) {
    return new BlockedError(`BLOCKED: ${host} showed ${resting.label} when I last tried to read it, so I’m leaving it alone until `
      + `${clock(resting.until)} (UTC). ${tail}`, { host, wall: resting.label, until: resting.until });
  }
  return new BlockedError(`BLOCKED: ${host} answered with ${label} instead of the page — I waited for it to clear and tried again `
    + `${cookies ? 'with the person’s own browser cookies' : 'like a normal browser'}, and it still refused. ${tail}`, { host, wall: label, until: Date.now() + walls.HOST_COOLDOWN_MS });
}

const statusError = status => new Error(`The site answered ${status}${status === 404 || status === 410 ? ' (the page isn’t there)' : ''}.`);
const typeOf = res => (res.headers()['content-type'] || '').toLowerCase();

/** The PDF the page shows, as bytes: fetched from inside the page (same origin, same network guard), capped at 25 MB. */
async function pdfBytes(page, res) {
  const declared = Number(res.headers()['content-length']) || 0;
  const tooBig = n => new Error(`That PDF is ${(n / 1048576).toFixed(1)} MB — I read PDFs up to ${PDF_MAX_BYTES / 1048576} MB. It can be opened `
    + 'with browser_open and downloaded to the Library instead.');
  if (declared > PDF_MAX_BYTES) throw tooBig(declared);
  const out = await page.evaluate(async ({ u, max }) => {
    const r = await fetch(u, { credentials: 'include' });
    if (!r.ok || !r.body) return { status: r.status };
    const reader = r.body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) { reader.cancel().catch(() => {}); return { tooBig: n }; }
      chunks.push(value);
    }
    const all = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    let s = '';
    for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
    return { status: r.status, b64: btoa(s) };
  }, { u: page.url(), max: PDF_MAX_BYTES });
  if (out.tooBig) throw tooBig(out.tooBig);
  if (!out.b64) throw statusError(out.status || 0);
  return Buffer.from(out.b64, 'base64');
}

/** A PDF document for web_read, the bytes kept (not enumerable, not cached) for web_read's save option. */
async function pdfDoc(buffer, url) {
  const doc = await pdfDocument(buffer, { url });
  Object.defineProperty(doc, 'bytes', { value: buffer, enumerable: false });
  return doc;
}

/** What a response that isn't an HTML page reads as: a PDF, a feed, an OPML list, JSON or plain text. null for HTML. */
async function readResponse(page, res) {
  const type = typeOf(res);
  const status = res.status();
  if (isPdf(type)) {
    if (status >= 400) throw statusError(status);
    return pdfDoc(await pdfBytes(page, res), page.url());
  }
  if (/html/.test(type)) return null;
  if (status >= 400) throw statusError(status);
  const buf = await res.body();
  const url = page.url();
  if (isPdf('', buf)) return pdfDoc(buf, url);
  const body = decodeBody(buf, type);
  const kind = feedKind(type, body);
  try {
    if (kind === 'feed') return renderFeed(body, url);
    if (kind === 'opml') return renderOpml(body, url);
  } catch { /* looked like a feed but doesn't parse: shown as text below */ }
  return { url, title: new URL(url).pathname.split('/').pop() || url, siteName: new URL(url).hostname,
    markdown: /json/.test(type) ? '```json\n' + body.slice(0, 200000) + '\n```' : body.slice(0, 200000), contentType: type };
}

/**
 * One attempt at a page in a fresh tab → { doc } or { wall }. A check that solves itself gets up to 12 s; a full-page consent
 * screen is declined. Non-HTML answers (PDF, feeds, JSON, text) are read as what they are, also when a passed check leads
 * to one. Pages answering 4xx/5xx without a wall are errors.
 */
async function loadPage(page, url) {
  const doc = walls.trackDocument(page); // the newest main document (a passed check navigates to the real page)
  try {
    let res;
    try { res = await page.goto(url, { waitUntil: 'commit', timeout: 30000 }); } catch (err) {
      if (/Download is starting/i.test(err.message)) throw new Error(DOWNLOAD_MSG);
      throw err;
    }
    if (!res) throw new Error('The page didn’t respond.');
    doc.set(res);
    const first = await readResponse(page, res);
    if (first) return { doc: first };
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    // Google News article links forward to the publisher by script.
    if (/(^|\.)news\.google\.com$/.test(new URL(page.url()).hostname) && /\/(rss\/)?articles\//.test(new URL(page.url()).pathname)) {
      await page.waitForURL(u => !/(^|\.)news\.google\.com$/.test(u.hostname), { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    }
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    let wall = await walls.probeWall(page, doc.status());
    if (wall?.kind === 'consent') {
      await walls.dismissConsent(page);
      wall = await walls.waitOutWall(page, { maxMs: 8000, statusOf: doc.status });
    } else if (wall?.selfSolving) {
      wall = await walls.waitOutWall(page, { maxMs: 12000, statusOf: doc.status });
    }
    if (wall) return { wall };
    const now = doc.response();
    if (now && now !== res) { // the check passed and a new document stands: it may be a PDF or a feed
      const next = await readResponse(page, now);
      if (next) return { doc: next };
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    }
    if (doc.status() >= 400) throw statusError(doc.status());
    return { doc: await extractVisible(page) };
  } finally { doc.stop(); }
}

/**
 * The escalation ladder (decision #136): an incognito tab; when a wall stays up, one retry with the person's own cookies
 * (read-only — nothing is written back) and images/media on, like a normal browser; still walled → BLOCKED, and the host
 * rests for 30 minutes. skipFirst: a site reader already met the wall in an incognito tab.
 */
async function readGeneric(url, { signal, userId = null, skipFirst = false, wall = null } = {}) {
  const resting = walls.hostResting(url);
  if (resting) throw blocked(url, resting.label, { resting });
  if (!skipFirst) {
    const first = await withPage(page => loadPage(page, url), { signal });
    if (first.doc) return first.doc;
    wall = first.wall;
  }
  const storageState = userId ? loadProfile(profileFile(userId)) : undefined;
  const second = await withPage(page => loadPage(page, url), { signal, media: true, storageState });
  if (second.doc) return second.doc;
  const label = second.wall?.label || wall?.label || 'a bot check';
  walls.restHost(url, label);
  throw blocked(url, label, { cookies: !!storageState?.cookies?.length });
}

/**
 * Read a page for web_read. Site readers first (YouTube, X, Reddit — site-readers/), falling back to the generic reader on
 * any failure; the generic reader handles PDFs and feeds by what the response is. userId: whose cookies the ladder's retry
 * may use; lang: the person's language (video captions); fresh: skip the cache (web_read's save needs the PDF's bytes).
 */
export async function readPage(rawUrl, { signal, userId = null, lang = 'en', fresh = false } = {}) {
  const url = await assertPublicUrl(rawUrl);
  const reader = siteReaderFor(url);
  const key = normalizeUrl(url) + (reader?.name === 'youtube' ? `#lang=${String(lang || 'en').slice(0, 2).toLowerCase()}` : '');
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.doc;
  const t = Date.now();
  try {
    let doc = null, wall = null;
    // A resting host is left alone — except X posts, which are read from FxTwitter's API, not from x.com.
    if (reader && (reader.name === 'x' || !walls.hostResting(url))) {
      try {
        doc = await reader.read(url, { withPage, fetchJson, walls, dismissConsent: walls.dismissConsent, signal, lang });
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'BrowserUnavailable') throw err;
        wall = err.wall || null;
        note({ kind: 'read', url, title: `${reader.label} reader: ${err.message.split('\n')[0]} — reading the page instead`, ms: Date.now() - t, ok: false });
      }
    }
    doc ||= await readGeneric(url, { signal, userId, skipFirst: !!wall, wall });
    cache.set(key, { doc, at: Date.now() });
    if (cache.size > 30) cache.delete(cache.keys().next().value);
    note({ kind: 'read', url, title: doc.title, ms: Date.now() - t, ok: true });
    return doc;
  } catch (err) {
    if (err.name !== 'AbortError') note({ kind: 'read', url, ms: Date.now() - t, ok: false, error: err.message.split('\n')[0] });
    throw friendly(err);
  }
}

function friendly(err) {
  const m = err.message || '';
  if (err.name === 'AbortError' || err.name === 'BrowserUnavailable' || err.name === 'Blocked') return err;
  if (/ERR_NAME_NOT_RESOLVED/.test(m)) return new Error('That site doesn’t exist (the address didn’t resolve).');
  if (/ERR_BLOCKED_BY_CLIENT/.test(m)) return new Error('That address is on a private or local network — I only browse the public web.');
  if (/Timeout|ERR_TIMED_OUT/.test(m)) return new Error('The page took too long to load.');
  if (/ERR_CONNECTION|ERR_ADDRESS|ERR_SSL|ERR_CERT/.test(m)) return new Error(`I couldn’t connect to that site (${(m.match(/net::(\w+)/) || [])[1] || 'connection error'}).`);
  return new Error(m.split('\n')[0]);
}

// ---- Search ----------------------------------------------------------------------------------------------
// Web: SearXNG when configured and healthy (decision #138), then DuckDuckGo HTML → Brave → Bing (decision #16), moving on
// after a challenge page or nothing. By intent (decision #137): `freshness` (day/week/month/year) is passed to each engine
// its own way; `kind: 'news'` asks Google News in the person's edition; `kind: 'reference'` asks Wikipedia, which is also
// the last resort when every engine failed; `check` asks two engines and merges them by normal address.
const CHALLENGE = /captcha|unusual traffic|are you a robot|not a robot|verify you are (a )?human|just a moment|anomaly|automated (queries|requests)/i;

function ddgUrl(href) {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    if (u.pathname === '/y.js') return null; // ad
    return u.searchParams.get('uddg') || u.href;
  } catch { return null; }
}

function bingUrl(href) {
  try {
    const u = new URL(href);
    const enc = (u.hostname === 'bing.com' || u.hostname.endsWith('.bing.com')) && u.searchParams.get('u');
    if (enc?.startsWith('a1')) return Buffer.from(enc.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return u.href;
  } catch { return null; }
}

const text = el => squash(el?.textContent);
export const FRESHNESS = ['day', 'week', 'month', 'year'];
const LETTER = { day: 'd', week: 'w', month: 'm', year: 'y' };
// Bing's "past year" is a custom range in days since 1970 (ez5_<from>_<to>); day/week/month have their own codes.
const bingRange = (f, now = Date.now()) => {
  if (f === 'year') { const today = Math.floor(now / 864e5); return `ex1:"ez5_${today - 365}_${today}"`; }
  return `ex1:"${{ day: 'ez1', week: 'ez2', month: 'ez3' }[f]}"`;
};

export const ENGINES = {
  duckduckgo: {
    url: (q, { freshness } = {}) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}${LETTER[freshness] ? `&df=${LETTER[freshness]}` : ''}`,
    ready: '.result, .no-results, .anomaly-modal',
    parse: doc => [...doc.querySelectorAll('.result')].filter(r => !/result--ad/.test(r.className)).map(r => {
      const a = r.querySelector('.result__a');
      return { title: text(a), url: ddgUrl(a?.getAttribute('href')), snippet: text(r.querySelector('.result__snippet')), age: text(r.querySelector('.result__timestamp')) };
    }),
  },
  brave: {
    url: (q, { freshness } = {}) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web${LETTER[freshness] ? `&tf=p${LETTER[freshness]}` : ''}`,
    ready: '.snippet[data-type="web"], #results',
    parse: doc => [...doc.querySelectorAll('.snippet[data-type="web"]')].map(s => {
      const a = s.querySelector('a[href^="http"]');
      return { title: text(s.querySelector('.title, .search-snippet-title')) || text(a), url: a?.getAttribute('href') || null,
        snippet: text(s.querySelector('.snippet-description, .generic-snippet .content, .description')), age: text(s.querySelector('.snippet-age, .age, time')) };
    }),
  },
  // Google itself answers automated browsers with its "unusual traffic" page on many networks (detected as a challenge,
  // then Startpage — Google's own results through a privacy proxy — is next in line).
  google: {
    url: (q, { freshness } = {}) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en${LETTER[freshness] ? `&tbs=qdr:${LETTER[freshness]}` : ''}`,
    ready: '#search, #rso, #captcha-form',
    parse: doc => [...doc.querySelectorAll('#rso a[href^="http"]:has(h3), #search a[href^="http"]:has(h3)')].map(a => {
      const box = a.closest('.g, [data-hveid], [data-sokoban-container]') || a.parentElement;
      return { title: text(a.querySelector('h3')), url: a.getAttribute('href'), snippet: text(box?.querySelector('.VwiC3b, [data-sncf], [style*="-webkit-line-clamp"]')),
        age: text(box?.querySelector('.LEwnzc span, .YrbPuc span')) };
    }),
  },
  // Startpage shows a proof-of-work check (20–60 s; its pass lasts ~5 min, kept in the search cookie jar). Too slow for
  // everyday use, so it only stands in for Google when the person asks for Google.
  startpage: {
    url: (q, { freshness } = {}) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}&cat=web&language=english${LETTER[freshness] ? `&with_date=${LETTER[freshness]}` : ''}`,
    ready: '.result, .no-results, a.result-title',
    wait: 60000,
    parse: doc => [...doc.querySelectorAll('.result')].map(r => ({
      title: text(r.querySelector('.wgl-title')) || text(r.querySelector('a.result-title')), url: r.querySelector('a.result-title')?.getAttribute('href') || null,
      snippet: text(r.querySelector('.description')), age: null, // dates lead the snippet ("Mar 27, 2017 ..."): looseDate finds them
    })),
  },
  bing: {
    url: (q, { freshness } = {}) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en${FRESHNESS.includes(freshness) ? `&filters=${encodeURIComponent(bingRange(freshness))}` : ''}`,
    ready: 'li.b_algo, li.b_no',
    parse: doc => [...doc.querySelectorAll('li.b_algo')].map(li => {
      const a = li.querySelector('h2 a');
      return { title: text(a), url: bingUrl(a?.getAttribute('href')), snippet: text(li.querySelector('.b_caption p, p')), age: text(li.querySelector('.news_dt')) };
    }),
  },
};

// How old a result is, when the engine or the snippet says (decision #60).
const dated = r => ({ ...r, date: r.date || (looseDate(r.age) || looseDate(r.snippet))?.toISOString() || null });

/** Clean result list: http(s) links with a title, one per normal address, dated. */
function tidyResults(list) {
  const seen = new Set();
  return list.filter(r => {
    if (!r.url || !r.title || !/^https?:\/\//.test(r.url)) return false;
    const key = normalizeUrl(r.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(dated);
}

/** Parse one engine's result page. Exported for tests (saved HTML fixtures). */
export function parseResults(engine, html) {
  const { document } = parseHTML(html);
  const results = tidyResults(ENGINES[engine].parse(document));
  // Challenge pages are often bare fragments (linkedom then has no real <body>): scan the markup's text instead.
  const pageText = results.length ? '' : document.toString().replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const challenged = !results.length && CHALLENGE.test(pageText.slice(0, 20000));
  return { results, challenged };
}

const searxngOn = () => !!browserSettings().searxngUrl;

// Which engines to try, in order: the one asked for (Google falls back to Startpage's Google results), then SearXNG when
// configured and healthy, then the admin's list.
export function engineOrder(prefer, configured = browserSettings().engines, { searxng = searxngOn() && searxngHealthy() } = {}) {
  const first = prefer === 'google' ? ['google', 'startpage'] : prefer && ENGINES[prefer] ? [prefer] : [];
  return [...new Set([...first, ...(searxng ? ['searxng'] : []), ...configured])].filter(k => ENGINES[k] || k === 'searxng');
}

const blockedUntil = new Map(); // engine → time it may be tried again
const BLOCK_COOLDOWN_MS = 3 * 3600000;
const labelOf = key => (key === 'searxng' ? SEARXNG_LABEL : ENGINE_LABELS[key]);

/** One engine, one query → { results, challenged }; throws on a failure (the caller notes it and moves on). */
async function runEngine(key, q, { signal, freshness, lang }) {
  if (key === 'searxng') {
    const { results } = await searxngSearch(browserSettings().searxngUrl, q, { freshness, lang, signal });
    return { results: tidyResults(results), challenged: false };
  }
  const profile = searchProfileFile(); // shared by searches only; no personal logins in it
  const html = await withPage(async page => {
    await page.goto(ENGINES[key].url(q, { freshness }), { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForSelector(ENGINES[key].ready, { timeout: ENGINES[key].wait || 8000 }).catch(() => {});
    return page.content();
  }, { signal, profile });
  return parseResults(key, html);
}

/**
 * The engine chain: engines in order until `want` of them returned results. → { hits: [{ key, engine, results }], tried }.
 * An engine that shows a captcha wall rests for 3 hours; SearXNG rests for a few minutes after a failure (searxng.js).
 */
async function engineChain(q, { engine, freshness, lang, signal, want = 1 }) {
  const tried = [], hits = [];
  for (const key of engineOrder(engine)) {
    if (hits.length >= want) break;
    const label = labelOf(key);
    if (blockedUntil.get(key) > Date.now()) { tried.push(`${label}: skipped (it blocked us with a challenge page recently)`); continue; }
    const t = Date.now();
    try {
      const { results, challenged } = await runEngine(key, q, { signal, freshness, lang });
      note({ kind: 'search', engine: label, query: q, ms: Date.now() - t, ok: results.length > 0, count: results.length, ...(challenged ? { error: 'challenge page' } : {}) });
      if (results.length) { hits.push({ key, engine: label, results }); continue; }
      tried.push(`${label}: ${challenged ? 'blocked with a challenge page' : 'no results'}`);
      // A captcha wall (not a check that solves itself, like Startpage's) usually means this network is flagged for hours.
      if (challenged && !ENGINES[key]?.wait) blockedUntil.set(key, Date.now() + BLOCK_COOLDOWN_MS);
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'BrowserUnavailable') throw err;
      note({ kind: 'search', engine: label, query: q, ms: Date.now() - t, ok: false, error: err.message.split('\n')[0] });
      tried.push(`${label}: ${key === 'searxng' ? `couldn’t search (${err.message.split('\n')[0]})` : friendly(err).message}`);
    }
  }
  return { hits, tried };
}

/**
 * Results of several engines merged by normal address (decision #137): one entry per page, `engines` naming who found it,
 * pages found by more engines first, then by their best position. → { results, sites } (sites: distinct registrable domains).
 */
export function mergeResults(hits) {
  const by = new Map();
  hits.forEach(({ engine, results }, h) => results.forEach((r, i) => {
    const key = normalizeUrl(r.url);
    const cur = by.get(key);
    if (!cur) { by.set(key, { ...r, engines: [engine], rank: i, order: h }); return; }
    if (!cur.engines.includes(engine)) cur.engines.push(engine);
    cur.rank = Math.min(cur.rank, i);
    cur.snippet ||= r.snippet;
    cur.date ||= r.date;
  }));
  const results = [...by.values()].sort((a, b) => b.engines.length - a.engines.length || a.rank - b.rank || a.order - b.order)
    .map(({ rank, order, ...r }) => r);
  return { results, sites: distinctSites(results) };
}

/** How many different sites (registrable domains) a result list comes from. */
export const distinctSites = results => new Set(results.map(r => { try { return siteOf(new URL(r.url).hostname); } catch { return r.url; } })).size;

/** Google News for a query, in the person's edition → dated results with the outlet as the snippet. */
export function newsResults(feedText) {
  return normalizeFeed(feedText).items.filter(i => i.url && i.title)
    .map(i => ({ title: i.title, url: i.url, snippet: [i.sourceName && `From ${i.sourceName}`, i.summary && i.summary !== i.title && !i.summary.startsWith(i.title) ? i.summary : null].filter(Boolean).join(' — ').slice(0, 400),
      date: i.published, source: i.sourceName || null }));
}

async function searchNews(q, { freshness, lang, country, signal }) {
  const url = gnewsUrl(q, { lang, country, when: NEWS_WHEN[freshness] || null });
  const t = Date.now();
  const r = await fetchRaw(url, { signal });
  if (r.status >= 400) throw new Error(`Google News answered ${r.status}`);
  const results = newsResults(decodeBody(r.body, r.contentType));
  note({ kind: 'search', engine: 'Google News', query: q, ms: Date.now() - t, ok: results.length > 0, count: results.length });
  return results;
}

const wikiLang = l => (/^[a-z]{2,3}$/.test(String(l || '').toLowerCase()) ? String(l).toLowerCase() : 'en');
const unhtml = s => decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(); // plain text; entities decoded once

/** Wikipedia's search API answer → results (the date is the article's last edit). Pure. */
export function wikipediaResults(json, lang = 'en') {
  return (json?.query?.search || []).map(s => ({ title: s.title, url: `https://${wikiLang(lang)}.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`,
    snippet: unhtml(s.snippet), date: s.timestamp || null, dateKind: 'edited' }));
}
export const wikipediaSearchUrl = (q, lang = 'en', count = 6) => `https://${wikiLang(lang)}.wikipedia.org/w/api.php?` + new URLSearchParams({
  action: 'query', list: 'search', srsearch: q, format: 'json', srlimit: String(Math.max(1, Math.min(10, count))), srprop: 'snippet|timestamp', utf8: '1' });

async function searchWikipedia(q, { lang, count, signal }) {
  const l = wikiLang(lang);
  let results = wikipediaResults(await fetchJson(wikipediaSearchUrl(q, l, count), { signal }), l);
  if (!results.length && l !== 'en') results = wikipediaResults(await fetchJson(wikipediaSearchUrl(q, 'en', count), { signal }), 'en');
  return results;
}

// Recent searches (10 minutes), so the same question asked again in a task doesn't search again.
const searchCache = new Map();
const SEARCH_CACHE_MS = 10 * 60000;
export const clearSearchCache = () => searchCache.clear();

/**
 * Search. opts: count, engine (the one the person named), freshness (day|week|month|year), kind ('web' | 'news' |
 * 'reference'), check (two engines, merged), lang / country (the person's: news edition, Wikipedia language).
 * → { engine, results: [{ title, url, snippet, date, dateKind?, engines? }], tried, kind, sites? }. results is empty only
 * when everything failed, Wikipedia included.
 */
export async function search(query, { count = 6, signal, engine, freshness = null, kind = 'web', check = false, lang = 'en', country = null } = {}) {
  const q = squash(query).slice(0, 300);
  if (!q) throw new Error('Search for what? The query was empty.');
  const f = FRESHNESS.includes(freshness) ? freshness : null;
  const n = Math.max(1, Math.min(10, count));
  const key = JSON.stringify([q.toLowerCase(), engine || '', f, kind, !!check, lang, country, searxngOn()]);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_MS) {
    const results = hit.out.results.slice(0, n);
    return { ...hit.out, results, ...(hit.out.checked ? { sites: distinctSites(results) } : {}), cached: true };
  }
  const done = out => {
    if (out.results.length) {
      searchCache.set(key, { out, at: Date.now() });
      if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
    }
    const results = out.results.slice(0, n);
    return { ...out, results, ...(out.checked ? { sites: distinctSites(results) } : {}) }; // sites among what is shown
  };
  const tried = [];
  if (kind === 'news') {
    try {
      const results = await searchNews(q, { freshness: f, lang, country, signal });
      if (results.length) return done({ engine: 'Google News', results, tried, kind });
      tried.push('Google News: no results');
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'BrowserUnavailable') throw err;
      tried.push(`Google News: ${friendly(err).message}`);
    }
  }
  if (kind === 'reference') {
    try {
      const results = await searchWikipedia(q, { lang, count: 10, signal });
      if (results.length) return done({ engine: 'Wikipedia', results, tried, kind });
      tried.push('Wikipedia: no results');
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'BrowserUnavailable') throw err;
      tried.push(`Wikipedia: ${friendly(err).message}`);
    }
  }
  const chain = await engineChain(q, { engine, freshness: f, lang, signal, want: check ? 2 : 1 });
  tried.push(...chain.tried);
  if (chain.hits.length) {
    if (check) {
      const merged = mergeResults(chain.hits);
      return done({ engine: chain.hits.map(h => h.engine).join(' + '), results: merged.results, sites: merged.sites, tried, kind, checked: chain.hits.length });
    }
    return done({ engine: chain.hits[0].engine, results: chain.hits[0].results, tried, kind });
  }
  // Every engine failed: Wikipedia as the last resort (reference questions still get an answer), said as such.
  if (kind !== 'reference') {
    try {
      const results = await searchWikipedia(q, { lang, count: 10, signal });
      if (results.length) return done({ engine: 'Wikipedia (every search engine failed)', results, tried, kind, fallback: true });
      tried.push('Wikipedia: no results');
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'BrowserUnavailable') throw err;
      tried.push(`Wikipedia: ${friendly(err).message}`);
    }
  }
  return { engine: null, results: [], tried, kind };
}

// ---- Screenshots -----------------------------------------------------------------------------------------
// Saved as data/shots/u<userId>-<random>.jpg; served only to that person (or an admin) by /shots/:file.
export function saveShot(userId, buf) {
  const file = `u${userId}-${crypto.randomBytes(8).toString('hex')}.jpg`;
  fs.mkdirSync(paths.shots, { recursive: true });
  fs.writeFileSync(path.join(paths.shots, file), buf);
  return { file, href: `/shots/${file}` };
}

// web_screenshot's options (decision #166). A desktop screen is 1280×800; mobile is a phone (390×844 CSS pixels at 2×, touch,
// the page's mobile layout); full_page captures the whole length, up to FULL_PAGE_MAX CSS pixels (a page longer than that is
// cut, and said so). → the withPage options and the capture's.
export const FULL_PAGE_MAX = 15000;
export function shotOptions({ fullPage = false, mobile = false } = {}) {
  return {
    page: mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, mobile: true } : { viewport: { width: 1280, height: 800 } },
    fullPage: !!fullPage,
  };
}

// The page as a PDF (web_screenshot save_pdf): print media, A4 with the app's printing options (services/print.js — the one
// place page sizes and the font wait live), a small margin and page numbers.
const PAGE_FOOTER = '<div style="font:8px sans-serif;color:#777;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>';
async function printPage(page) {
  await fontsReady(page).catch(() => {});
  return page.pdf(pdfOptions({ size: 'A4', footer: PAGE_FOOTER, margin: { top: '12mm', bottom: '14mm', left: '10mm', right: '10mm' } }));
}

/** Scroll down the page in screen steps (to FULL_PAGE_MAX) so lazy images load before a full-page capture; back to the top. */
async function loadWholePage(page) {
  await page.evaluate(async max => {
    const step = Math.max(300, innerHeight * 0.9);
    for (let y = 0; y < Math.min(document.documentElement.scrollHeight, max); y += step) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
    scrollTo(0, 0);
  }, FULL_PAGE_MAX).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
}

/**
 * A picture of a page for the person (web_screenshot). fullPage: the whole length (cut at FULL_PAGE_MAX); mobile: as a
 * phone shows it; pdf: also print the page (services/print.js page sizes, A4) → pdf bytes for the Library.
 * → { file, href, title, url, cut, pdf: Buffer|null }.
 */
export async function screenshot(rawUrl, { userId, signal, fullPage = false, mobile = false, pdf = false } = {}) {
  const url = await assertPublicUrl(rawUrl);
  const t = Date.now();
  const opts = shotOptions({ fullPage, mobile });
  try {
    const shot = await withPage(async page => {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await walls.dismissConsent(page).catch(() => null); // a cookie panel over the picture helps nobody
      let cut = false, capture = { type: 'jpeg', quality: 72 };
      if (opts.fullPage) {
        await loadWholePage(page);
        const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
        const vp = page.viewportSize();
        if (height > FULL_PAGE_MAX) { cut = true; capture = { ...capture, fullPage: true, clip: { x: 0, y: 0, width: vp.width, height: FULL_PAGE_MAX } }; }
        else capture = { ...capture, fullPage: true };
      }
      const buf = await page.screenshot(capture);
      const printed = pdf ? await printPage(page) : null;
      return { buf, title: await page.title(), url: page.url(), cut, pdf: printed };
    }, { signal, media: true, ...opts.page });
    const { file } = saveShot(userId, shot.buf);
    note({ kind: 'screenshot', url, title: shot.title, ms: Date.now() - t, ok: true });
    return { file, href: `/shots/${file}`, title: squash(shot.title) || url, url: shot.url, cut: shot.cut, pdf: shot.pdf };
  } catch (err) {
    if (err.name !== 'AbortError') note({ kind: 'screenshot', url, ms: Date.now() - t, ok: false, error: err.message.split('\n')[0] });
    throw friendly(err);
  }
}

// ---- Public JSON APIs (weather, geocoding) ------------------------------------------------------------------
// Same browser, same network guard; a plain navigation to the API URL and the raw body parsed as JSON.
export async function fetchJson(rawUrl, { signal, timeout = 20000 } = {}) {
  const url = await assertPublicUrl(rawUrl);
  const t = Date.now();
  try {
    const out = await withPage(async page => {
      const res = await page.goto(url, { waitUntil: 'commit', timeout });
      if (!res) throw new Error('No response.');
      const body = (await res.body()).toString('utf8');
      if (res.status() >= 400) throw new Error(`HTTP ${res.status()}: ${body.slice(0, 160)}`);
      return JSON.parse(body);
    }, { signal });
    note({ kind: 'api', url, title: new URL(url).hostname, ms: Date.now() - t, ok: true });
    return out;
  } catch (err) {
    if (err.name !== 'AbortError') note({ kind: 'api', url, ms: Date.now() - t, ok: false, error: err.message.split('\n')[0] });
    throw friendly(err);
  }
}

// ---- Raw fetches (feeds, images) ------------------------------------------------------------------------
/** Raw bytes of a URL through the browser. `headers` go along (e.g. If-None-Match for polite feed polling). */
export async function fetchRaw(rawUrl, { headers = {}, media = false, signal, timeout = 25000 } = {}) {
  const url = await assertPublicUrl(rawUrl);
  try {
    return await withPage(async page => {
      if (Object.keys(headers).length) await page.setExtraHTTPHeaders(headers);
      // A conditional request (If-None-Match / If-Modified-Since) answered "304 Not Modified" has nothing to show, so
      // Chromium cancels the navigation (ERR_ABORTED) and Playwright never sees a response. The status is only visible
      // on the DevTools network events — and that 304 is exactly what polite feed polling asked for, not a failure.
      const conditional = Object.keys(headers).some(k => /^if-(none-match|modified-since)$/i.test(k));
      const cdp = conditional ? await page.context().newCDPSession(page) : null;
      let docId = null;
      const statuses = new Map();
      if (cdp) {
        await cdp.send('Network.enable');
        cdp.on('Network.requestWillBeSent', e => { if (e.type === 'Document') docId = e.requestId; });
        cdp.on('Network.responseReceivedExtraInfo', e => statuses.set(e.requestId, e.statusCode));
      }
      let res;
      try { res = await page.goto(url, { waitUntil: 'commit', timeout }); }
      catch (err) {
        if (docId && statuses.get(docId) === 304) return { status: 304, headers: {}, url, contentType: '', body: Buffer.alloc(0) };
        throw err;
      } finally { cdp?.detach().catch(() => {}); }
      if (!res) throw new Error('No response.');
      const status = res.status();
      const h = res.headers();
      return { status, headers: h, url: page.url(), contentType: (h['content-type'] || '').toLowerCase(), body: status === 304 ? Buffer.alloc(0) : await res.body() };
    }, { signal, media });
  } catch (err) { throw friendly(err); }
}

/** Bytes → text honouring BOM, then the XML prolog, then Content-Type (decision #23: never assume UTF-8). */
export function decodeBody(buf, contentType = '') {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  const head = buf.subarray(0, 200).toString('latin1');
  const enc = /encoding=["']([\w-]+)["']/i.exec(head)?.[1] || /charset=([\w-]+)/i.exec(contentType)?.[1] || 'utf-8';
  try { return new TextDecoder(enc.toLowerCase()).decode(buf); } catch { return buf.toString('utf8'); }
}

/** An article, following news aggregators' redirects (Google News links resolve in the browser via script). */
export async function readArticle(rawUrl, { signal } = {}) {
  const url = await assertPublicUrl(rawUrl);
  try {
    return await withPage(async page => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (/(^|\.)news\.google\.com$/.test(new URL(page.url()).hostname)) {
        await page.waitForURL(u => !/(^|\.)news\.google\.com$/.test(u.hostname), { timeout: 15000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      }
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      return extractVisible(page);
    }, { signal });
  } catch (err) { throw friendly(err); }
}

/** An image for a feed cover: bytes + extension, or null (not an image, too big, blocked). */
export async function downloadImage(rawUrl, { signal, maxBytes = 5_000_000 } = {}) {
  try {
    const r = await fetchRaw(rawUrl, { media: true, signal, timeout: 15000 });
    const ext = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }[r.contentType.split(';')[0]];
    if (r.status !== 200 || !ext || !r.body.length || r.body.length > maxBytes) return null;
    return { buf: r.body, ext };
  } catch { return null; }
}

export const __test = { readResponse }; // unit tests: non-HTML answers (PDF, feeds, OPML, JSON) from fake responses
