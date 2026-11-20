// Translations (#14, docs/TRANSLATING.md). The English text is the key (gettext style): code and templates say
// t('Sign in'), and locales/<lang>.json maps it to that language. English has no catalog; a missing entry falls back to
// English, so an unfinished translation never shows a blank. `npm run i18n` lists every text (locales/messages.json) and
// checks the catalogs.
//   t(text, vars?)                      'Sign in to talk to {name}.' with { name } → placeholders filled in
//   tn(count, one, other, vars?)        plural: the catalog entry is { one, other, few, … } by Intl.PluralRules;
//                                       {count} is available in both
// Placeholders are {word}; values are inserted as text (templates escape the result as usual).
// The locale: the person's choice (later), else the browser's Accept-Language among the languages that have a catalog,
// else English. "en-XA" (development only) is a pseudo-locale that marks every translated text, to see what isn't.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/index.js';

export const DEFAULT_LOCALE = 'en';
export const PSEUDO = 'en-XA';
const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'yi']);
const dir = () => process.env.JESSBOT_LOCALES || path.join(paths.root, 'locales'); // JESSBOT_LOCALES: tests

let cache = null; // { lang: { catalog, mtime } }
function catalogs() {
  if (cache && process.env.NODE_ENV === 'production') return cache;
  const out = {};
  let files = [];
  try { files = fs.readdirSync(dir()).filter(f => /^[a-z]{2,3}(-[A-Z]{2})?\.json$/.test(f)); } catch { /* none yet */ }
  for (const f of files) {
    const lang = f.slice(0, -5);
    try {
      // One open file for both the age check and the read: nothing can swap it in between.
      const fd = fs.openSync(path.join(dir(), f), 'r');
      try {
        const mtime = fs.fstatSync(fd).mtimeMs;
        out[lang] = cache?.[lang]?.mtime === mtime ? cache[lang] : { catalog: JSON.parse(fs.readFileSync(fd, 'utf8')), mtime };
      } finally { fs.closeSync(fd); }
    } catch (err) { console.warn(`[i18n] ${f} can’t be read: ${err.message}`); }
  }
  cache = out;
  return out;
}

/** The languages people can get: English, every catalog, and the pseudo-locale in development. */
export function availableLocales() {
  return [DEFAULT_LOCALE, ...Object.keys(catalogs()).filter(l => l !== DEFAULT_LOCALE), ...(process.env.NODE_ENV === 'production' ? [] : [PSEUDO])];
}

/** The best of `wanted` (a list, or an Accept-Language header) that is available, else English. */
export function pickLocale(wanted) {
  const have = availableLocales();
  const list = Array.isArray(wanted) ? wanted : String(wanted || '').split(',')
    .map(p => { const [tag, q] = p.trim().split(';q='); return { tag: tag.trim(), q: q ? Number(q) : 1 }; })
    .filter(x => x.tag && x.q > 0).sort((a, b) => b.q - a.q).map(x => x.tag);
  for (const tag of list) {
    if (!tag) continue;
    if (have.includes(tag)) return tag;
    const base = tag.split('-')[0].toLowerCase();
    if (have.includes(base)) return base;
  }
  return DEFAULT_LOCALE;
}

export const directionOf = locale => (RTL.has(String(locale).split('-')[0]) ? 'rtl' : 'ltr');

const fill = (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars && vars[k] != null ? String(vars[k]) : m));
const pseudo = s => `[${s.replace(/[aeiouAEIOU]/g, c => ({ a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' })[c])}]`;
const pseudoKeep = s => s.split(/(\{\w+\})/).map((part, i) => (i % 2 ? part : pseudo(part).slice(1, -1))).join('');

/** The catalog entry for `text` in `locale`, or undefined. */
const entry = (locale, text) => catalogs()[locale]?.catalog?.[text] ?? catalogs()[String(locale).split('-')[0]]?.catalog?.[text];

// English shown on a right-to-left page (no translation yet) keeps its own direction: wrapped in Unicode isolates
// (FSI … PDI, invisible), so its full stop doesn't jump to the other end of the line.
const isolate = (locale, s) => (directionOf(locale) === 'rtl' ? `⁨${s}⁩` : s);

/** Translate one text (see the top). */
export function translate(locale, text, vars) {
  if (locale === PSEUDO) return fill(`[${pseudoKeep(text)}]`, vars);
  const found = locale && locale !== DEFAULT_LOCALE ? entry(locale, text) : undefined;
  return typeof found === 'string' && found ? fill(found, vars) : isolate(locale, fill(text, vars));
}

/** Plural: `other` is the key; the catalog's value is { one, other, … } by the language's plural categories. */
export function translatePlural(locale, count, one, other, vars = {}) {
  const v = { count, ...vars };
  if (locale === PSEUDO) return fill(`[${pseudoKeep(count === 1 ? one : other)}]`, v);
  const found = locale && locale !== DEFAULT_LOCALE ? entry(locale, other) : undefined;
  if (found && typeof found === 'object') {
    const cat = new Intl.PluralRules(locale).select(count);
    return fill(found[cat] ?? found.other ?? other, v);
  }
  return isolate(locale, fill(count === 1 ? one : other, v));
}

/** Bound helpers for one locale: { t, tn }. */
export const translator = locale => ({
  locale, dir: directionOf(locale),
  t: (text, vars) => translate(locale, text, vars),
  tn: (count, one, other, vars) => translatePlural(locale, count, one, other, vars),
});

/** The client's share of a catalog: every entry (the browser's t() looks texts up in it). Empty for English. */
export function clientCatalog(locale) {
  if (locale === PSEUDO) return { pseudo: true };
  return locale === DEFAULT_LOCALE ? {} : { ...(catalogs()[String(locale).split('-')[0]]?.catalog || {}), ...(catalogs()[locale]?.catalog || {}) };
}
