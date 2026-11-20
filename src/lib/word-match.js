// Whole-word matching in any script (decisions #190, #193): muted words in the Feed and the reminder reply reader.
// "Trump" mutes "Trump's" and "TRUMP", not "trumpet"; "رياضة" mutes "الرياضة", "والرياضة" and "للرياضة" (Arabic writes
// "and", "the", "for", "with" onto the word), not "رياضيات". Scripts written without spaces (Chinese, Japanese, Thai…)
// have no word boundary to find, so a phrase in them matches as written.

/** Normalised for matching: NFKC, lower case, accents and Arabic diacritics/tatweel dropped, Arabic letter variants unified. */
export function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[‘’ʼ`´]/g, '\'')
    .normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ').trim();
}

const B = '(?<![\\p{L}\\p{N}])', E = '(?![\\p{L}\\p{N}])';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const ARABIC = /^\p{Script=Arabic}/u;
// Arabic proclitics: و / ف (and), ب / ل / ك (with, for, like), ال (the), and لل (for the).
const CLITICS = '(?:[وف]?(?:لل|[بلك]?(?:ال)?))';

/** One pattern source for a phrase (already normalised), or null when it can only match as written. */
function phraseSource(p) {
  if (!p || NO_SPACES.test(p)) return null;
  const words = p.split(' ').map(esc).join('\\s+');
  return ARABIC.test(p) ? `${B}${CLITICS}${esc(p.replace(/^ال(?=\p{L}{2,})/u, '')).split(' ').join('\\s+')}${E}` : `${B}${words}${E}`;
}

/** → (text) => the first phrase it contains (as the person wrote it), or null. Phrases: words or short phrases. */
export function wordMatcher(phrases) {
  const list = [...new Set((phrases || []).map(p => String(p || '').trim()).filter(Boolean))];
  const plain = [], res = [];
  for (const original of list) {
    const p = normalize(original);
    const src = phraseSource(p);
    if (src) res.push([original, new RegExp(src, 'u')]);
    else if (p) plain.push([original, p]);
  }
  if (!list.length) return () => null;
  return text => {
    const t = normalize(text);
    if (!t) return null;
    for (const [original, re] of res) if (re.test(t)) return original;
    for (const [original, p] of plain) if (t.includes(p)) return original;
    return null;
  };
}
