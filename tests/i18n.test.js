// Translations (#14): t/tn with placeholders and plural rules, English as the fallback, the locale picked from ?lang, the
// cookie or Accept-Language among languages that have a catalog, right-to-left pages, the pseudo-locale, the browser's
// catalog in the page, and the extractor's list and checks. Run: npm test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-i18n-'));
const LOCALES = path.join(HOME, 'locales');
fs.mkdirSync(LOCALES);
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';
process.env.JESSBOT_LOCALES = LOCALES;
fs.writeFileSync(path.join(LOCALES, 'fr.json'), JSON.stringify({
  'Sign in': 'Se connecter',
  'Sign in to talk to {name}.': 'Connectez-vous pour parler à {name}.',
  '{count} files': { one: '{count} fichier', other: '{count} fichiers' },
}));
fs.writeFileSync(path.join(LOCALES, 'ar.json'), JSON.stringify({
  'Welcome back': 'مرحبًا بعودتك',
  '{count} files': { zero: 'لا ملفات', one: 'ملف واحد', two: 'ملفان', few: '{count} ملفات', many: '{count} ملفًا', other: '{count} ملف' },
}));

const { openDb, closeDb, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();
const I = await import('../src/lib/i18n.js');
const X = await import('../scripts/i18n.js');
const { createApp } = await import('../src/app.js');

let server, base;
before(async () => {
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  settings.set('bot', { name: 'Nova', variant: 'neutral', tone: 'calm', pronouns: 'they/them', description: '' });
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

test('t: the translation with its placeholders; English when a text has none; values are text, not markup', () => {
  assert.equal(I.translate('fr', 'Sign in'), 'Se connecter');
  assert.equal(I.translate('fr', 'Sign in to talk to {name}.', { name: 'Nova' }), 'Connectez-vous pour parler à Nova.');
  assert.equal(I.translate('fr', 'Not translated yet'), 'Not translated yet');
  assert.equal(I.translate('en', 'Sign in to talk to {name}.', { name: '<b>x</b>' }), 'Sign in to talk to <b>x</b>.', 'templates escape it');
  assert.equal(I.translate('fr-CA', 'Sign in'), 'Se connecter', 'a regional variant falls back to the language');
  assert.equal(I.translate('en', 'Keep {missing} as is.'), 'Keep {missing} as is.');
  assert.equal(I.translate('ar', 'Not translated yet.'), '⁨Not translated yet.⁩', 'English on a right-to-left page keeps its direction');
});

test('tn: each language’s plural rules (Arabic has six forms); English one/other', () => {
  assert.equal(I.translatePlural('en', 1, '{count} file', '{count} files'), '1 file');
  assert.equal(I.translatePlural('en', 3, '{count} file', '{count} files'), '3 files');
  assert.equal(I.translatePlural('fr', 1, '{count} file', '{count} files'), '1 fichier');
  assert.equal(I.translatePlural('fr', 5, '{count} file', '{count} files'), '5 fichiers');
  assert.deepEqual([0, 1, 2, 3, 11, 100].map(n => I.translatePlural('ar', n, '{count} file', '{count} files')),
    ['لا ملفات', 'ملف واحد', 'ملفان', '3 ملفات', '11 ملفًا', '100 ملف']);
});

test('the locale: only languages with a catalog; Accept-Language order and quality; right-to-left; the pseudo-locale', () => {
  assert.deepEqual(I.availableLocales().sort(), ['ar', 'en', 'en-XA', 'fr']);
  assert.equal(I.pickLocale('de-DE,de;q=0.9,fr;q=0.8,en;q=0.5'), 'fr');
  assert.equal(I.pickLocale('fr-BE'), 'fr');
  assert.equal(I.pickLocale('de'), 'en', 'no German catalog: English');
  assert.equal(I.pickLocale('fr;q=0,ar'), 'ar', 'q=0 means not that one');
  assert.equal(I.directionOf('ar'), 'rtl');
  assert.equal(I.directionOf('fr'), 'ltr');
  assert.equal(I.translate(I.PSEUDO, 'Sign in to talk to {name}.', { name: 'Nova' }), '[Sígn ín tó tálk tó Nova.]', 'placeholders untouched');
});

test('pages: ?lang picks the language and remembers it; the html says its language and direction; English by default', async () => {
  const en = await (await fetch(`${base}/login`)).text();
  assert.match(en, /<html lang="en" dir="ltr"/);
  assert.match(en, /Sign in to talk to Nova\./);
  assert.match(en, /<script type="application\/json" id="jb-i18n">\{\}<\/script>/, 'English: an empty catalog');

  const res = await fetch(`${base}/login?lang=fr`);
  const fr = await res.text();
  assert.match(fr, /<html lang="fr" dir="ltr"/);
  assert.match(fr, /Connectez-vous pour parler à Nova\./);
  assert.match(fr, />Se connecter /);
  assert.match(fr, /Welcome back/, 'untranslated texts stay English');
  assert.match(fr, /"Sign in":"Se connecter"/, 'the browser gets the catalog');
  const cookie = (res.headers.getSetCookie() || []).map(c => c.split(';')[0]).find(c => c.startsWith('jb_lang='));
  assert.equal(cookie, 'jb_lang=fr');
  assert.match(await (await fetch(`${base}/login`, { headers: { Cookie: cookie } })).text(), /<html lang="fr"/, 'remembered');

  const ar = await (await fetch(`${base}/login`, { headers: { 'Accept-Language': 'ar-TN,ar;q=0.9' } })).text();
  assert.match(ar, /<html lang="ar" dir="rtl"/);
  assert.match(ar, /مرحبًا بعودتك/);
  assert.match(await (await fetch(`${base}/login?lang=xx`)).text(), /<html lang="en"/, 'an unknown language is ignored');
  assert.match(await (await fetch(`${base}/login?lang=en-XA`)).text(), /\[Sígn ín tó tálk tó Nova\.\]/);
});

test('extractor: finds texts in templates and scripts (plurals with their singular); flags catalog problems', () => {
  const messages = X.collect();
  assert.ok(messages['Sign in'].where.some(w => w.startsWith('src/views/pages/login.hbs:')));
  assert.ok(messages["Couldn't save"].where.some(w => w.startsWith('public/js/forms.js:')));
  const fake = { 'Sign in': { where: ['x'] }, 'Hello {name}': { where: ['x'] }, '{count} files': { where: ['x'], one: '{count} file' } };
  assert.deepEqual(X.catalogProblems(fake, { 'Sign in': 'Se connecter', 'Hello {name}': 'Bonjour {name}', '{count} files': { one: '{count} fichier', other: '{count} fichiers' } }), []);
  const problems = X.catalogProblems(fake, { Gone: 'x', 'Hello {name}': 'Bonjour {nom}', '{count} files': 'fichiers' });
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /not used any more: "Gone"/);
  assert.match(problems.join('\n'), /placeholders differ/);
  assert.match(problems.join('\n'), /a plural needs \{ one, other/);
});

test('the repository’s list of texts is current (npm run i18n)', () => {
  const file = path.join(import.meta.dirname, '..', 'locales', 'messages.json');
  assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(X.collect(), null, 2)}\n`, 'run npm run i18n and commit locales/messages.json');
});
