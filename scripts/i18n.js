// npm run i18n          — list every translatable text into locales/messages.json, and say how far each language is
// npm run i18n:check    — the same check without writing: fails when messages.json is stale, or a catalog has an entry
//                         that no longer exists, a placeholder that isn't in the English, or a plural that isn't one.
// Texts are found where code asks for them (#14, docs/TRANSLATING.md):
//   templates   {{t "Text"}}  (t "Text")  {{tn n "one" "other"}}  (tn n "one" "other")
//   JavaScript  t('Text')  t("Text")  t(`Text`) (no ${…})  tn(n, 'one', 'other')   in src/ and public/js/
// messages.json: { "<English text>": { "where": ["file:line", …], "one"?: "<singular>" } }, sorted, for translators and
// tools. A language is locales/<lang>.json: { "<English text>": "<translation>" | { one, other, … } }.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = path.join(ROOT, 'locales');
const MESSAGES = path.join(LOCALES, 'messages.json');
const check = process.argv.includes('--check');

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory()
  ? (['node_modules', 'vendor', 'dev'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
const STR = String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|` + '`' + String.raw`((?:[^` + '`' + String.raw`\\$]|\\.)*)` + '`)';
const unescape = s => s.replace(/\\(['"`\\])/g, '$1');
const RX = {
  hbsT: /(?:\{\{|\()t\s+"([^"]*)"/g,
  hbsTn: /(?:\{\{|\()tn\s+[^\s"]+\s+"([^"]*)"\s+"([^"]*)"/g,
  jsT: new RegExp(String.raw`(?<![\w$.])t\(\s*${STR}\s*[,)]`, 'g'),
  jsTn: new RegExp(String.raw`(?<![\w$.])tn\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*${STR}\s*,\s*${STR}\s*[,)]`, 'g'),
};
const lineAt = (text, i) => text.slice(0, i).split('\n').length;

/** Every text the code asks for → { text: { where: [], one? } }. Exported for the tests. */
export function collect(root = ROOT) {
  const found = {};
  const add = (text, where, one) => {
    if (!text) return;
    found[text] ||= { where: [] };
    if (!found[text].where.includes(where)) found[text].where.push(where);
    if (one) found[text].one = one;
  };
  const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'public', 'js'))];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (!/\.(hbs|js)$/.test(f) || rel === 'src/lib/i18n.js' || rel === 'public/js/i18n.js') continue;
    const text = fs.readFileSync(f, 'utf8');
    if (f.endsWith('.hbs')) {
      for (const m of text.matchAll(RX.hbsT)) add(m[1], `${rel}:${lineAt(text, m.index)}`);
      for (const m of text.matchAll(RX.hbsTn)) add(m[2], `${rel}:${lineAt(text, m.index)}`, m[1]);
    } else {
      for (const m of text.matchAll(RX.jsT)) add(unescape(m[1] ?? m[2] ?? m[3]), `${rel}:${lineAt(text, m.index)}`);
      for (const m of text.matchAll(RX.jsTn)) add(unescape(m[4] ?? m[5] ?? m[6]), `${rel}:${lineAt(text, m.index)}`, unescape(m[1] ?? m[2] ?? m[3]));
    }
  }
  return Object.fromEntries(Object.keys(found).sort((a, b) => a.localeCompare(b, 'en')).map(k => [k, found[k]]));
}

const placeholders = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

/** Problems of one catalog against the texts → [message]. Exported for the tests. */
export function catalogProblems(messages, catalog) {
  const out = [];
  for (const [key, value] of Object.entries(catalog)) {
    const m = messages[key];
    if (!m) { out.push(`not used any more: ${JSON.stringify(key)}`); continue; }
    const want = placeholders(key) || placeholders(m.one || '');
    if (m.one) {
      if (typeof value !== 'object' || value === null || typeof value.other !== 'string') { out.push(`a plural needs { one, other, … }: ${JSON.stringify(key)}`); continue; }
      for (const [cat, v] of Object.entries(value)) {
        const extra = placeholders(v).split(',').filter(p => p && p !== 'count' && !want.split(',').includes(p));
        if (extra.length) out.push(`{${extra.join('}, {')}} isn't in the English (${cat}): ${JSON.stringify(key)}`);
      }
    } else if (typeof value !== 'string') out.push(`should be a string: ${JSON.stringify(key)}`);
    else if (value && placeholders(value) !== placeholders(key)) out.push(`placeholders differ from the English: ${JSON.stringify(key)}`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const messages = collect();
  const json = `${JSON.stringify(messages, null, 2)}\n`;
  let failed = false;
  const current = fs.existsSync(MESSAGES) ? fs.readFileSync(MESSAGES, 'utf8') : '';
  if (current !== json) {
    if (check) { console.error('locales/messages.json is out of date: run npm run i18n and commit it.'); failed = true; }
    else { fs.mkdirSync(LOCALES, { recursive: true }); fs.writeFileSync(MESSAGES, json); }
  }
  const total = Object.keys(messages).length;
  console.log(`${total} texts${check ? '' : ' → locales/messages.json'}`);
  for (const f of fs.readdirSync(LOCALES).filter(n => /^[a-z]{2,3}(-[A-Z]{2})?\.json$/.test(n))) {
    const catalog = JSON.parse(fs.readFileSync(path.join(LOCALES, f), 'utf8'));
    const done = Object.keys(messages).filter(k => catalog[k]).length;
    const problems = catalogProblems(messages, catalog);
    console.log(`${f.slice(0, -5)}: ${done} of ${total} translated (${total ? Math.round((done / total) * 100) : 100}%)${problems.length ? `, ${problems.length} problem(s)` : ''}`);
    for (const p of problems) console.log(`  ${p}`);
    if (problems.length) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
