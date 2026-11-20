// Learned site recipes (decision #165, from the skills review's report-householdA C8; "per-site recipes" were deferred in
// #56). When Jess searches a site through its own form — types, submits, and lands on a results address with parameters —
// the shape of that address is kept: host, path and parameter NAMES, each value replaced by a slot ({query} for what she
// typed, {date}, {number}, {value}). Values are never stored: what one person searched for stays theirs, while the shape
// helps the whole household next time ("Known results URL shape: …?ss={query}&checkin={date} (worked 4×)"). Session and
// tracking parameters are dropped, as are opaque state blobs (a shape with them in it can't be reproduced). A recipe is
// only kept when what she typed shows up in the address — proof it is a search address, not any page. Opening an address
// of that shape later counts as a success or a failure; two failures in a row delete the recipe.
import { get, all, run } from '../db/index.js';
import { TRACKING } from './read.js';

const SESSIONISH = /^(sid|ssid|jsessionid|phpsessid|aspsessionid\w*|session|sessionid|.*[_-]?session[_-]?.*|token|.*[_-]?token[_-]?.*|auth|auth_?code|nonce|state|csrf.*|xsrf.*|_|cb|rnd|random|timestamp|ts|ei|ved|sca_esv|sxsrf|aid|label|srpvid|sb|sig|signature|hash|key|api_?key)$/i;
const MAX_PARAMS = 20;
const TEMPLATE_MAX = 600;

const safeDecode = s => { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch { return String(s); } };
const norm = s => safeDecode(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[\s_+-]+/g, ' ').trim();
const isDate = v => /^\d{4}-\d{2}-\d{2}$|^\d{8}$|^\d{6}$|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(v);
// A value that is an encoded state (a protobuf, a signed token, a base64 blob): long, no spaces, mixed letters and digits.
const isOpaque = v => v.length > 40 || (v.length >= 24 && !/\s/.test(v) && /[a-z]/i.test(v) && /\d/.test(v));
const dropParam = name => TRACKING.test(name) || SESSIONISH.test(name) || /^utm_/i.test(name);

/** What a value is, as a slot — or null when it must not be part of a recipe (an opaque state blob). */
function slotOf(value, typed) {
  const v = safeDecode(value).trim();
  const n = norm(v);
  if (n && typed.some(t => t.length >= 2 && (n === t || n.includes(t) || (n.length >= 3 && t.includes(n))))) return '{query}';
  if (!v) return '{value}';
  if (isDate(v)) return '{date}';
  if (/^-?\d{1,6}(\.\d+)?$/.test(v)) return '{number}';
  if (isOpaque(v)) return null;
  return '{value}';
}

/**
 * The recipe an address shows, or null. url: the results address; typed: what was typed into the form (strings);
 * formUrl: the page the form was on (its path segments may stay as they are). Pure.
 * → { host, pathTemplate, params: ['q={query}', …], hasQuery }
 */
export function recipeFrom(url, typed = [], { formUrl = null } = {}) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const words = [...new Set([].concat(typed || []).map(norm).filter(t => t.length >= 2))];
  if (!words.length) return null;
  let formSegs = new Set();
  try { if (formUrl) formSegs = new Set(new URL(formUrl).pathname.split('/').filter(Boolean)); } catch { /* none */ }
  let hasQuery = false;
  const segs = u.pathname.split('/').map((seg, i) => {
    if (!seg || i === 0) return seg;
    const slot = slotOf(seg, words);
    if (slot === '{query}') { hasQuery = true; return slot; }
    // Structure stays as it is: segments the form page had, or a plain lowercase word (searchresults.html, homes, jobs).
    // Anything else — a capitalised name, digits, codes — is a value, and values are never kept.
    if (formSegs.has(seg) || /^[a-z][a-z._-]{0,24}$/.test(seg)) return seg;
    return slot || '{value}';
  });
  const params = [];
  for (const [name, value] of u.searchParams) {
    if (dropParam(name) || !/^[\w.[\]:-]{1,60}$/.test(name)) continue;
    const slot = slotOf(value, words);
    if (slot == null) continue; // an opaque state blob: not reproducible
    if (slot === '{query}') hasQuery = true;
    params.push(`${name}=${slot}`);
    if (params.length >= MAX_PARAMS) break;
  }
  // The fragment can carry the search too (single-page apps): parameters after #… are handled the same way.
  if (u.hash.includes('=')) {
    for (const [name, value] of new URLSearchParams(u.hash.slice(1))) {
      if (dropParam(name) || !/^[\w.[\]:-]{1,60}$/.test(name)) continue;
      const slot = slotOf(value, words);
      if (slot === '{query}') { hasQuery = true; params.push(`#${name}=${slot}`); }
    }
  }
  const pathTemplate = segs.join('/') || '/';
  if (!hasQuery || pathTemplate.length + params.join('&').length > TEMPLATE_MAX) return null;
  return { host: u.hostname.toLowerCase(), pathTemplate, params, hasQuery };
}

/** The shape as an address to show: https://host/path?a={x}&b={y}#c={query}. */
export function shapeOf(r) {
  const params = JSON.parse(r.param_names || '[]');
  const q = params.filter(p => !p.startsWith('#')), h = params.filter(p => p.startsWith('#')).map(p => p.slice(1));
  return `https://${r.host}${r.path_template}${q.length ? `?${q.join('&')}` : ''}${h.length ? `#${h.join('&')}` : ''}`;
}

/** Store (or count again) the recipe a search landed on. → the row, or null when the address isn't a search recipe. */
export function learnRecipe(url, typed, { formUrl = null } = {}) {
  const r = recipeFrom(url, typed, { formUrl });
  if (!r) return null;
  const names = JSON.stringify(r.params);
  run(`INSERT INTO site_recipes (host, path_template, param_names) VALUES (?, ?, ?)
       ON CONFLICT(host, path_template, param_names) DO UPDATE SET ok_count = ok_count + 1, fail_count = 0, last_ok_at = datetime('now')`,
  r.host, r.pathTemplate, names);
  return get('SELECT * FROM site_recipes WHERE host = ? AND path_template = ? AND param_names = ?', r.host, r.pathTemplate, names);
}

const bareHost = h => String(h || '').toLowerCase().replace(/^www\d*\./, '');
const hostOfUrl = url => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
export const recipesFor = host => all('SELECT * FROM site_recipes WHERE host IN (?, ?) ORDER BY ok_count DESC, last_ok_at DESC', bareHost(host), `www.${bareHost(host)}`)
  .filter(r => r.fail_count < 2);

/** The line browser_open / open_search add for a host with a known recipe, or null. */
export function recipeHint(url) {
  const best = recipesFor(hostOfUrl(url))[0];
  if (!best) return null;
  return `Known results URL shape on ${bareHost(best.host)} (learned from an earlier search there; worked ${best.ok_count}×): ${shapeOf(best)} — `
    + 'fill the slots and open it to get results in one step; if it doesn’t give results, use the site’s form.';
}

/** Does this address have a recipe's shape (same host and path pattern, all its parameter names)? → the recipe or null. */
export function matchRecipe(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const names = new Set([...u.searchParams.keys()]);
  const segs = u.pathname.split('/');
  for (const r of recipesFor(u.hostname)) {
    const t = r.path_template.split('/');
    if (t.length !== segs.length || t.some((s, i) => !/^\{\w+\}$/.test(s) && s !== segs[i])) continue;
    const need = JSON.parse(r.param_names).filter(p => !p.startsWith('#')).map(p => p.split('=')[0]);
    if (need.every(n => names.has(n))) return r;
  }
  return null;
}

/**
 * Jess opened an address; if it has a recipe's shape, count how it went. ok: no wall, not an error status, and the results
 * address kept the recipe's parameters (a redirect to the home page is a failure). Two failures in a row delete it.
 * → 'ok' | 'fail' | 'dropped' | null (no recipe).
 */
export function noteRecipeUse({ requestedUrl, finalUrl, status = null, wall = null }) {
  const r = matchRecipe(requestedUrl);
  if (!r) return null;
  const kept = !!finalUrl && hostOfUrl(finalUrl) && bareHost(hostOfUrl(finalUrl)) === bareHost(r.host) && !!matchRecipe(finalUrl);
  const ok = !wall && !(status >= 400) && kept;
  if (ok) {
    run(`UPDATE site_recipes SET ok_count = ok_count + 1, fail_count = 0, last_ok_at = datetime('now') WHERE id = ?`, r.id);
    return 'ok';
  }
  if (wall) return null; // a bot wall says nothing about the recipe
  if (r.fail_count + 1 >= 2) { run('DELETE FROM site_recipes WHERE id = ?', r.id); return 'dropped'; }
  run('UPDATE site_recipes SET fail_count = fail_count + 1 WHERE id = ?', r.id);
  return 'fail';
}
