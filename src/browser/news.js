// Google News editions (decision #137). A Google News search is a feed (news.google.com/rss/search) whose results depend on
// the edition: hl (interface language), gl (country) and ceid (country:language). They used to be hard-wired to en-US, so
// Arabic topics and local news came from the American edition. Now the edition follows the person: their language (what
// they write in) and their country (their primary place). Google has editions for some pairs only; an unknown pair falls
// back to the language's main edition (Google itself sends Arabic readers in a country without its own edition to EG:ar), then to US English. Pure.

// Edition languages per country, as Google News offers them.
const EDITIONS = {
  en: 'US GB AU BW CA ET GH IN IE IL KE MY NA NZ NG PK PH SG ZA TZ UG ZW', fr: 'FR BE CA MA SN CH', de: 'DE AT CH', it: 'IT',
  es: 'ES', 'es-419': 'AR CL CO CU MX PE US VE', 'pt-419': 'BR', 'pt-150': 'PT', nl: 'NL BE', ar: 'EG AE LB SA', he: 'IL', tr: 'TR',
  ru: 'RU UA', uk: 'UA', pl: 'PL', cs: 'CZ', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG', el: 'GR', sr: 'RS', sl: 'SI', lv: 'LV', lt: 'LT',
  sv: 'SE', no: 'NO', ja: 'JP', ko: 'KR', 'zh-Hans': 'CN', 'zh-Hant': 'TW HK', th: 'TH', vi: 'VN', id: 'ID', ms: 'MY', bn: 'BD IN',
  hi: 'IN', ta: 'IN', te: 'IN', mr: 'IN', ml: 'IN',
};
const HAS = new Set(Object.entries(EDITIONS).flatMap(([l, cs]) => cs.split(' ').map(c => `${c}:${l}`)));
// A language's main edition when the person's country has none in that language.
const HOME = { en: 'US', fr: 'FR', de: 'DE', it: 'IT', es: 'ES', 'es-419': 'MX', 'pt-419': 'BR', 'pt-150': 'PT', nl: 'NL', ar: 'EG', he: 'IL',
  tr: 'TR', ru: 'RU', uk: 'UA', pl: 'PL', cs: 'CZ', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG', el: 'GR', sr: 'RS', sl: 'SI', lv: 'LV', lt: 'LT',
  sv: 'SE', no: 'NO', ja: 'JP', ko: 'KR', 'zh-Hans': 'CN', 'zh-Hant': 'TW', th: 'TH', vi: 'VN', id: 'ID', ms: 'MY', bn: 'BD', hi: 'IN',
  ta: 'IN', te: 'IN', mr: 'IN', ml: 'IN' };
const LATAM = new Set('AR BO CL CO CR CU DO EC GT HN MX NI PA PE PR PY SV US UY VE'.split(' '));
// The hl Google uses for the edition languages that aren't plain codes.
const HL = { 'pt-419': 'pt-BR', 'pt-150': 'pt-PT', 'zh-Hans': 'zh-CN' };

/** The edition-language variant for a base language in a country ('es' in Mexico → 'es-419'). */
function variant(lang, country) {
  if (lang === 'es') return country === 'ES' ? 'es' : LATAM.has(country) ? 'es-419' : 'es';
  if (lang === 'pt') return country === 'PT' ? 'pt-150' : 'pt-419';
  if (lang === 'zh') return country === 'TW' || country === 'HK' ? 'zh-Hant' : 'zh-Hans';
  if (lang === 'iw') return 'he';
  if (lang === 'nb' || lang === 'nn') return 'no';
  return lang;
}

/** { hl, gl, ceid } for a language (ISO code, 'fr' / 'fr-CA') and a country (ISO 3166 alpha-2, may be null). */
export function newsEdition(lang, country) {
  const l = String(lang || 'en').trim().toLowerCase().split(/[-_]/)[0] || 'en';
  const c = String(country || '').trim().toUpperCase();
  let v = variant(l, c);
  let gl = HAS.has(`${c}:${v}`) ? c : HOME[v] || null;
  if (!gl) { v = 'en'; gl = HAS.has(`${c}:en`) ? c : 'US'; }
  const hl = v === 'en' ? `en-${gl}` : v === 'zh-Hant' ? `zh-${gl}` : HL[v] || v;
  return { hl, gl, ceid: `${gl}:${v}` };
}

// Freshness → Google News' "when:" operator.
export const NEWS_WHEN = { day: '1d', week: '7d', month: '30d', year: '1y' };

/**
 * A Google News search as a feed URL. when: a Google "when:" value ('3d', '1y') or null for none; lang/country pick the
 * edition (newsEdition).
 */
export function gnewsUrl(query, { lang = 'en', country = null, when = '3d' } = {}) {
  const { hl, gl, ceid } = newsEdition(lang, country);
  return 'https://news.google.com/rss/search?' + new URLSearchParams({ q: when ? `${query} when:${when}` : String(query), hl, gl, ceid });
}

/** The language a text is written in, when its script says so (Arabic, Hebrew, Cyrillic, Greek, CJK, Thai…); else null. */
export function scriptLang(text) {
  const t = String(text || '');
  const letters = t.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (!letters) return null;
  const share = re => (letters.match(re) || []).length / letters.length;
  for (const [lang, re] of [['ar', /\p{Script=Arabic}/gu], ['he', /\p{Script=Hebrew}/gu], ['ru', /\p{Script=Cyrillic}/gu], ['el', /\p{Script=Greek}/gu],
    ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu], ['ko', /\p{Script=Hangul}/gu], ['zh', /\p{Script=Han}/gu], ['th', /\p{Script=Thai}/gu],
    ['hi', /\p{Script=Devanagari}/gu], ['bn', /\p{Script=Bengali}/gu]]) {
    if (share(re) >= 0.3) return lang;
  }
  return null;
}
