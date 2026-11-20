// Free text → a safe SQLite FTS5 query: every word as a quoted prefix term ("lond"* matches London), all required.
export const ftsQuery = text => String(text ?? '').replace(/["'*^:()]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 12)
  .map(w => `"${w}"*`).join(' ');

// Free text → "any of these words" with prefix terms, for ranked recall (decision #151). Words shorter than `min` letters
// are dropped (they match everything as prefixes); a word of 4+ letters loses its last letter first, a cheap stand-in for
// stemming that the unicode61 tokenizer lacks: "kids" → "kid"* finds "kid" and "kids", "birthdays" → "birthday"*. The
// commonest English function words are left out too: as prefixes they match most rows ("the"* → their, them, there).
const STOP = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'you', 'your', 'what', 'how', 'with', 'that', 'this', 'from', 'have',
  'has', 'had', 'can', 'will', 'about', 'they', 'them', 'their', 'there', 'when', 'where', 'which', 'who', 'why', 'not', 'but', 'all',
  'any', 'our', 'out', 'get', 'got', 'did', 'does', 'just', 'some', 'into', 'should', 'would', 'could']);
const meaningful = (text, min) => [...new Set(String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
  .filter(w => [...w].length >= min && !STOP.has(w)))];
export const ftsAny = (text, { min = 3, max = 12 } = {}) => meaningful(text, min).slice(0, max)
  .map(w => `"${[...w].length >= 4 ? [...w].slice(0, -1).join('') : w}"*`).join(' OR ');
// Free text → every meaningful word required (whole-word prefixes, the same small words left out as ftsAny); when nothing
// meaningful is left ("to do"), every word as ftsQuery has it.
export const ftsAll = (text, { min = 3, max = 12 } = {}) => {
  const words = meaningful(text, min).slice(0, max);
  return words.length ? words.map(w => `"${w}"*`).join(' ') : ftsQuery(text);
};
