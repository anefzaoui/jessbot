// Translations in the browser (#14; the server side is src/lib/i18n.js, same rules). The page carries this language's
// catalog as JSON (<script type="application/json" id="jb-i18n">: empty for English), so t() needs no request.
//   t('Couldn’t save')  ·  t('Saved {name}', { name })  ·  tn(n, 'one file', '{count} files')
let catalog = null;
function load() {
  if (catalog) return catalog;
  try { catalog = JSON.parse(document.getElementById('jb-i18n')?.textContent || '{}'); } catch { catalog = {}; }
  return catalog;
}
const fill = (text, vars = {}) => String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars && vars[k] != null ? String(vars[k]) : m));
const accent = s => s.replace(/[aeiouAEIOU]/g, c => ({ a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' })[c]);
const pseudo = s => `[${s.split(/(\{\w+\})/).map((p, i) => (i % 2 ? p : accent(p))).join('')}]`;
export const locale = () => document.documentElement.lang || 'en';
// English on a right-to-left page keeps its own direction (Unicode isolates), as on the server.
const isolate = s => (document.documentElement.dir === 'rtl' ? `⁨${s}⁩` : s);

/** One text in the page's language (English when there is no translation). */
export function t(text, vars) {
  const c = load();
  if (c.pseudo) return fill(pseudo(text), vars);
  const found = c[text];
  return typeof found === 'string' && found ? fill(found, vars) : isolate(fill(text, vars));
}

/** Plural: `other` is the key; the catalog's value is { one, other, few, … } by the language's plural rules. */
export function tn(count, one, other, vars = {}) {
  const c = load();
  const v = { count, ...vars };
  if (c.pseudo) return fill(pseudo(count === 1 ? one : other), v);
  const found = c[other];
  if (found && typeof found === 'object') return fill(found[new Intl.PluralRules(locale()).select(count)] ?? found.other ?? other, v);
  return isolate(fill(count === 1 ? one : other, v));
}
