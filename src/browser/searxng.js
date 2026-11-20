// SearXNG, an optional search engine (decision #138, owner-approved exception to #15/#23). A SearXNG instance searches many
// engines itself and answers JSON (format=json) — so Jessbot reaches it DIRECTLY (Node fetch), like mail and calendar
// servers (#77), not through the browser: the instance is the admin's own (usually `npm run searxng:install`, bound to
// 127.0.0.1) and makes the requests to the search engines itself. Used first when configured and healthy; when it fails
// the usual browser engines take over, and it rests for a few minutes. The address lives in Admin → Browser.
// Result pages are still read through the browser (web_read), as always.
// The request goes through lib/outbound.js (decision #221): the admin's address may be local, a redirect away from it may not.
import { outboundFetch } from '../lib/outbound.js';

export const SEARXNG_LABEL = 'SearXNG';
const TIMEOUT_MS = 12000;
const DOWN_REST_MS = 5 * 60000;
export const TIME_RANGE = { day: 'day', week: 'week', month: 'month', year: 'year' };

/** '' or a clean base URL (http/https, no query, no trailing slash). Throws a plain-language error otherwise. */
export function cleanSearxngUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) throw new Error('Use an http:// or https:// address.');
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`); } catch { throw new Error('That isn’t a valid address (like http://127.0.0.1:8888).'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Use an http:// or https:// address.');
  if (u.username || u.password) throw new Error('Leave the user name and password out of the address.');
  u.search = ''; u.hash = '';
  return u.href.replace(/\/+$/, '');
}

/** The JSON search URL. opts: { freshness: day|week|month|year, lang: 'fr', engines: 'google' , page }. */
export function searxngSearchUrl(base, query, { freshness = null, lang = null, engines = null, categories = 'general', page = 1 } = {}) {
  const p = new URLSearchParams({ q: query, format: 'json', categories, pageno: String(page) });
  if (freshness && TIME_RANGE[freshness]) p.set('time_range', TIME_RANGE[freshness]);
  if (lang) p.set('language', lang);
  if (engines) p.set('engines', engines);
  return `${base}/search?${p}`;
}

/**
 * SearXNG's JSON → { results: [{ title, url, snippet, age, engines }], unresponsive: [engine names] }. Pure; results
 * that aren't http(s) links are dropped. age is the engine's publishedDate (search's date logic reads it).
 */
export function parseSearxng(json) {
  const list = Array.isArray(json?.results) ? json.results : [];
  const results = list.filter(r => r && /^https?:\/\//.test(r.url || '') && (r.title || r.content)).map(r => ({
    title: String(r.title || r.url).replace(/\s+/g, ' ').trim(), url: r.url, snippet: String(r.content || '').replace(/\s+/g, ' ').trim(),
    age: r.publishedDate || r.pubdate || null, engines: Array.isArray(r.engines) ? r.engines : r.engine ? [r.engine] : [],
  }));
  const unresponsive = (json?.unresponsive_engines || []).map(e => (Array.isArray(e) ? `${e[0]} (${e[1]})` : String(e)));
  return { results, unresponsive };
}

let downUntil = 0;
let lastError = null;
export const searxngHealthy = () => Date.now() >= downUntil;
export const searxngState = () => ({ healthy: searxngHealthy(), lastError, downUntil: downUntil > Date.now() ? new Date(downUntil).toISOString() : null });
export const resetSearxngHealth = () => { downUntil = 0; lastError = null; }; // tests, and a fresh address in Admin

async function getJson(url, { signal, timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeout);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await outboundFetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'Jessbot' } }, { trustedOrigin: url });
    const text = await res.text();
    if (res.status === 403) throw new Error('it refused JSON (HTTP 403) — add “json” to search.formats in its settings.yml');
    if (res.status === 429) throw new Error('it is rate-limiting us (HTTP 429) — turn its limiter off for this address');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    try { return JSON.parse(text); } catch { throw new Error('it answered, but not with JSON — is this a SearXNG address?'); }
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
    if (ctrl.signal.aborted) throw new Error(`it didn’t answer within ${Math.round(timeout / 1000)} s`);
    if (err.cause?.code === 'ECONNREFUSED') throw new Error('nothing is listening there (connection refused) — is it running?');
    if (err.cause?.code === 'ENOTFOUND') throw new Error('that host name doesn’t resolve');
    throw err;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

/** One search. → { results, unresponsive }. A failure marks the instance down for DOWN_REST_MS and throws. */
export async function searxngSearch(base, query, opts = {}) {
  try {
    const out = parseSearxng(await getJson(searxngSearchUrl(base, query, opts), { signal: opts.signal }));
    lastError = null;
    return out;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    downUntil = Date.now() + DOWN_REST_MS;
    lastError = err.message;
    throw err;
  }
}

/** Admin's connection test: a real query. → { ok: true, count, ms } or throws with the reason. */
export async function testSearxng(base, { signal } = {}) {
  const url = cleanSearxngUrl(base);
  if (!url) throw new Error('Enter the SearXNG address first.');
  const t = Date.now();
  const json = await getJson(searxngSearchUrl(url, 'weather'), { signal, timeout: 15000 });
  if (!Array.isArray(json?.results)) throw new Error('it answered JSON, but not search results — is this a SearXNG address?');
  resetSearxngHealth();
  return { ok: true, count: json.results.length, ms: Date.now() - t };
}
