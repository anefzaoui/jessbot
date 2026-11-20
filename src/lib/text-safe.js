// Small text helpers that are easy to get subtly wrong, in one place (decision #224, code scanning #22): every pattern
// here runs in linear time on any input, and every escape covers the escape character itself.

/** A literal string inside a RegExp. */
export const escapeRegExp = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text inside Markdown link brackets or a table cell: the backslash first, then the given characters. */
export const escapeMarkdown = (s, chars = '[]') => {
  const set = new Set(['\\', ...chars]);
  let out = '';
  for (const c of String(s ?? '')) out += set.has(c) ? `\\${c}` : c;
  return out;
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#039': "'" };
/** Decode the common HTML entities in ONE pass ("&amp;lt;" stays "&lt;"; decoding &amp; first would turn it into "<"). */
export const decodeEntities = s => String(s ?? '').replace(/&(amp|lt|gt|quot|apos|nbsp|#0?39);/g, (m, name) => ENTITIES[name] ?? m);

/** Remove any run of the given characters from the end (no regex: a run can't make it slow). */
export function trimEndChars(s, chars) {
  const str = String(s ?? '');
  let end = str.length;
  while (end > 0 && chars.includes(str[end - 1])) end--;
  return str.slice(0, end);
}

/** Replace a separator with optional whitespace around it ("a — b" → "a: b") without a backtracking regex. */
export function replaceSpaced(s, sep, by) {
  const parts = String(s ?? '').split(sep);
  return parts.map((p, i) => (i > 0 ? p.trimStart() : p)).map((p, i, all) => (i < all.length - 1 ? p.trimEnd() : p)).join(by);
}

/** An email address, plausibly: one @, no spaces, a dot in the domain, at most 254 characters. Linear time. */
export function isEmail(s) {
  const v = String(s ?? '');
  if (v.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(v);
}
