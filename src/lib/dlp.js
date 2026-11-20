// Outbound data-loss guard (Phase 18, decisions #126–#127, docs/SECURITY.md). Plain code, no model calls, no I/O:
//  - Registered secrets: values this install must never send anywhere (the model key, the password key, the push key,
//    and every sealed password at the moment it is unsealed). An exact match in a tool call — as typed, URL-encoded or
//    base64 — blocks the call (agent/loop.js audits `secret_blocked`, metadata only); the server log redacts them too.
//  - Secret shapes: API keys, AWS/GitHub/Slack tokens, private keys, sign-in tokens (JWT), two-step sign-in seeds, card
//    numbers (Luhn-checked, shown as ••••last4) and "password/PIN/code is X". Approval previews list and mask them;
//    memories refuse them (services/memory.js). IBANs and phone numbers are deliberately NOT secrets.
//  - Outbound URLs: a known data-catching host (webhook.site, requestbin, *.ngrok*, oast.*, …) always asks first; a URL
//    that carries data (a long or random-looking value, an email address in its query) asks when the task read outside
//    content first (services/policy.js assess).

// ---- Registered secrets ------------------------------------------------------------------------------------------------
const MIN_SECRET = 8;          // shorter values would match ordinary text (a 4-digit PIN is everywhere)
const MAX_REGISTERED = 500;
const registered = new Map();  // value → label
// Read live on every check: setup and Admin can change the model key while the server runs.
const ENV_SECRETS = [['OPENROUTER_KEY', 'the model key'], ['LLM_API_KEY', 'the model key'], ['JESSBOT_SECRET', 'the password key'],
  ['JESSBOT_VAPID_PRIVATE', 'the push key']];

/** Remember a value that must never leave in a tool call. Returns false for values too short to match safely. */
// The forms a value can take on its way out: as is, URL-encoded, base64 (padding dropped).
const formsOf = v => [...new Set([v, encodeURIComponent(v), Buffer.from(v).toString('base64').replace(/=+$/, '')])];

export function registerSecret(value, label = 'a saved password') {
  const v = String(value ?? '');
  if (v.trim().length < MIN_SECRET) return false;
  registered.delete(v);
  registered.set(v, { label: String(label), forms: formsOf(v) });
  if (registered.size > MAX_REGISTERED) registered.delete(registered.keys().next().value);
  return true;
}

const envForms = new Map(); // value → forms (the env values rarely change; computed once per value)
function* knownSecrets() {
  for (const [k, label] of ENV_SECRETS) {
    const v = process.env[k];
    if (!v || v.trim().length < MIN_SECRET) continue;
    if (!envForms.has(v)) envForms.set(v, formsOf(v));
    yield { label, forms: envForms.get(v) };
  }
  yield* registered.values();
}

/** Labels of registered secrets found in the text (deduplicated): ['the model key']. */
export function secretsIn(text) {
  const t = String(text ?? '');
  if (!t) return [];
  const found = new Set();
  for (const s of knownSecrets()) if (s.forms.some(f => t.includes(f))) found.add(s.label);
  return [...found];
}

/** The text with every registered secret (all its forms) replaced — for the server log. */
export function redactSecrets(text) {
  let t = String(text ?? '');
  for (const s of knownSecrets()) for (const f of s.forms) if (t.includes(f)) t = t.split(f).join('…redacted');
  return t;
}

/** Every string inside a tool's arguments (nested objects and arrays included). */
export function stringsOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsOf(v, out);
  return out;
}
export const argText = args => stringsOf(args).join('\n');

// ---- Secret shapes ---------------------------------------------------------------------------------------------------
/** Luhn checksum over the digits of s. */
export function luhn(s) {
  const d = String(s).replace(/\D/g, '');
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return d.length > 0 && sum % 10 === 0;
}

const last4 = s => `••••${String(s).replace(/[\s-]/g, '').slice(-4)}`;
const KEY_SHAPES = [
  { kind: 'api_key', label: 'an API key', re: /\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws_key', label: 'an AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github_token', label: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: 'slack_token', label: 'a Slack token', re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'private_key', label: 'a private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g },
  { kind: 'jwt', label: 'a sign-in token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'totp_seed', label: 'a two-step sign-in secret', re: /otpauth:\/\/[^\s"'<>]+/gi },
];
// Card numbers: 13–19 digits (single spaces or dashes between groups allowed), first digit 2–6 (the card networks), Luhn
// valid. Never the tail of a longer number: not after a letter or digit (an IBAN's "DE89 3704…"), not after "+" or a digit
// group (a phone number's "+1 415 555…"), not followed by more digits.
const CARD = /(?<![\p{L}\p{N}+])(?<!\d[ -])[2-6]\d(?:[ -]?\d){11,17}(?![ -]?\d)(?![\p{L}\p{N}])/gu;
// "password is X" and its kin, in English, French, Spanish, German and Arabic. The value must look like one: it has a digit
// or a symbol, is quoted, or is a single word that isn't ordinary prose ("my password is wrong" is not a secret).
const SECRET_WORDS = 'pass\\s?words?|passcodes?|passphrases?|pins?(?:\\s+(?:code|number))?|otp|one[- ]time\\s+(?:pass)?codes?'
  + '|(?:2fa|mfa|two[- ]factor|verification|security|access|login|sign[- ]in|door|gate|alarm|entry|backup|recovery|sms)\\s+codes?'
  + '|(?:secret|setup|recovery|backup)\\s+keys?|wi-?fi\\s+(?:password|key)|mots?\\s+de\\s+passe|code\\s+(?:secret|pin|d[\'’]accès)'
  + '|contraseñas?|clave|passwort|kennwort|geheimzahl|كلمة\\s+(?:المرور|السر)|الرقم\\s+السري|رمز\\s+(?:التحقق|الدخول)';
const PHRASE = new RegExp(`(?<![\\p{L}\\p{N}])(${SECRET_WORDS})(\\s*(?:is|was|=|:|est|es|ist|lautet|هي|هو)\\s*)(["'“‘«]?)([^\\s"'”’»,;]{3,64})`, 'giu');
// A bare "code is 4821": digits only, and not a postcode, booking reference, promo or error code.
const CODE_IS = /(?<![\p{L}\p{N}])(?<!(?:zip|post|postal|area|country|dial(?:ling)?|promo|discount|coupon|voucher|gift|referral|dress|source|iso|qr|bar|colou?r|tracking|booking|confirmation|order|reference|product|error|status|flight|course|class|tax|sort|swift|bank|branch)[\s-]?)(code)(\s*(?:is|was|:|est|es|ist)\s*)()(\d{4,8})(?!\d)/giu;
const PROSE = new Set(['wrong', 'incorrect', 'invalid', 'expired', 'expiring', 'required', 'needed', 'missing', 'correct', 'changed',
  'reset', 'same', 'weak', 'strong', 'saved', 'stored', 'written', 'below', 'above', 'attached', 'here', 'there', 'the', 'not', 'too',
  'very', 'still', 'also', 'now', 'set', 'case', 'sensitive', 'long', 'short', 'secure', 'safe', 'private', 'personal', 'different',
  'empty', 'blank', 'unknown', 'forgotten', 'lost', 'old', 'new', 'temporary', 'enabled', 'disabled', 'on', 'in', 'at', 'for', 'your',
  'my', 'our', 'their', 'his', 'her', 'a', 'an', 'and', 'or', 'but', 'being', 'going', 'faux', 'incorrect', 'correcte', 'nouveau',
  'nouvelle', 'erróneo', 'incorrecta', 'falsch', 'richtig', 'neu', 'this', 'that', 'what', 'which', 'needs', 'must', 'should']);
const looksSecret = (value, quoted) => quoted || /[\d\p{P}\p{S}]/u.test(value) || !PROSE.has(value.toLowerCase());

/**
 * Secret-looking things in a text → [{ kind, label, masked, start, end }] (sorted, no overlaps). `start`/`end` cover what
 * gets masked: the whole token for keys and cards, only the value for "password is X".
 */
export function findShapes(text) {
  const t = String(text ?? '');
  const hits = [];
  for (const s of KEY_SHAPES) for (const m of t.matchAll(s.re)) hits.push({ kind: s.kind, label: s.label, masked: last4(m[0].trim()), start: m.index, end: m.index + m[0].length });
  for (const m of t.matchAll(CARD)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) hits.push({ kind: 'card', label: 'a card number', masked: last4(digits), start: m.index, end: m.index + m[0].length });
  }
  for (const re of [PHRASE, CODE_IS]) {
    for (const m of t.matchAll(re)) {
      const [whole, word, , quote, raw] = m;
      const value = raw.replace(/[.)\]]+$/, ''); // the sentence's full stop is not part of it
      if (value.length < 3 || !looksSecret(value, !!quote)) continue;
      const start = m.index + whole.length - raw.length;
      hits.push({ kind: 'password', label: `what looks like a ${/pin|code|otp|رمز|الرقم/i.test(word) ? 'code' : 'password'}`, masked: '••••', start, end: start + value.length });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const h of hits) if (!out.length || h.start >= out.at(-1).end) out.push({ kind: h.kind, label: h.label, masked: h.masked, start: h.start, end: h.end });
  return out;
}

/** The text with every secret shape masked (cards and keys → ••••last4, passwords → ••••). */
export function maskShapes(text) {
  const t = String(text ?? '');
  let out = '', at = 0;
  for (const h of findShapes(t)) { out += t.slice(at, h.start) + h.masked; at = h.end; }
  return out + t.slice(at);
}

/** Flags for an approval card: one per distinct thing found ({ kind, label, masked }), at most 8. */
export function shapeFlags(text) {
  const seen = new Set(), out = [];
  for (const h of findShapes(text)) {
    const key = `${h.kind}:${h.masked}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: h.kind, label: h.label, masked: h.masked });
  }
  return out.slice(0, 8);
}

// ---- Outbound URLs ---------------------------------------------------------------------------------------------------
// Services built to catch whatever is sent to them (request inspectors, tunnels, out-of-band test hosts, paste sites).
const EXFIL = [/(^|\.)webhook\.site$/, /requestbin/, /(^|\.)pipedream\.net$/, /(^|\.)[^.]*ngrok[^.]*\.[a-z]+$/, /(^|\.)interact\.sh$/,
  /(^|\.)oast\.[a-z]+$/, /(^|\.)oastify\.com$/, /(^|\.)burpcollaborator\.net$/, /(^|\.)pastebin\.com$/, /(^|\.)transfer\.sh$/,
  /(^|\.)beeceptor\.com$/, /(^|\.)requestcatcher\.com$/, /(^|\.)hookbin\.com$/];
export const isExfilHost = host => { const h = String(host || '').toLowerCase().replace(/\.$/, ''); return !!h && EXFIL.some(re => re.test(h)); };

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>`]+/gi;
/** URLs a tool call would open: `url`-like arguments (a bare "example.com/x" too) and any http(s) address in its text. */
export function urlsIn(args) {
  const out = new Set();
  const walk = (v, key = '') => {
    if (typeof v === 'string') {
      if (/^(url|href|link|address)$/i.test(key) && v.trim() && !/^https?:\/\//i.test(v.trim()) && /^[\w.-]+\.[a-z]{2,}(?:[/?#:]|$)/i.test(v.trim())) out.add(`https://${v.trim()}`);
      for (const m of v.matchAll(URL_IN_TEXT)) out.add(m[0].replace(/[).,;!?]+$/, ''));
    } else if (Array.isArray(v)) v.forEach(x => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(args);
  return [...out];
}

/** Shannon entropy in bits per character. */
export function entropy(s) {
  const t = String(s || '');
  if (!t) return 0;
  const counts = new Map();
  for (const ch of t) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / t.length; h -= p * Math.log2(p); }
  return h;
}

const LONG_VALUE = 64;
const EMAIL = /[^\s@/?&=#]+@[^\s@/?&=#]+\.[a-z]{2,}/i;
const safeDecode = s => { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch { return String(s); } };

/**
 * Does opening this URL look like sending data out? → { kind: 'exfil'|'data', host, why } or null.
 * exfil: a data-catching host (always). data: a query/fragment value longer than 64 characters, random-looking (≥ 24
 * characters at ≥ 4.2 bits each), or holding an email address — returned whatever the taint; the caller decides.
 * theirWords: the person's own message; a value they typed themselves ("look up ann@x.com") doesn't count as data.
 */
export function urlRisk(url, { theirWords = '' } = {}) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\./, '');
  if (isExfilHost(u.hostname)) return { kind: 'exfil', host, why: `${host} is a service that collects whatever is sent to it` };
  const said = String(theirWords || '').toLowerCase();
  const values = [...u.searchParams.values()];
  if (u.hash.length > 1) values.push(...(u.hash.slice(1).includes('=') ? [...new URLSearchParams(u.hash.slice(1)).values()] : [u.hash.slice(1)]));
  for (const raw of values) {
    const v = safeDecode(raw).trim();
    if (!v || (said && said.includes(v.toLowerCase()))) continue;
    if (EMAIL.test(v)) return { kind: 'data', host, why: `the address sends an email address to ${host}` };
    if (v.length > LONG_VALUE) return { kind: 'data', host, why: `the address carries a long piece of text to ${host}` };
    if (v.length >= 24 && entropy(v) >= 4.2) return { kind: 'data', host, why: `the address carries a coded value to ${host}` };
  }
  return null;
}
