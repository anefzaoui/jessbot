// Import memories and contacts (decision #156; volt-life CODE-21). A memory export pasted from another assistant (plain
// lines, markdown, or JSON of ChatGPT-style "memories") and `.vcf` contacts (names, birthdays, anniversaries, relations)
// become CANDIDATE facts, shown for confirmation and never saved directly. Confirming saves the chosen ones in the person's
// private scope through the normal write path (cleanFact: invisible characters, instruction-looking text and secrets are
// refused; near-duplicates return the existing fact). The screen is Phase 25; this is the server side.
import ICAL from 'ical.js';
import { invalid } from '../lib/errors.js';
import { publish } from '../lib/bus.js';
import { cleanFact, normaliseDate, dateText, addFactChecked, userScope, sameInScope, queryVectors } from './memory.js';

export const MAX_IMPORT_CHARS = 500_000;
export const MAX_CANDIDATES = 300;
const MAX_FACT = 300;
const KINDS = new Set(['fact', 'preference', 'profile', 'event', 'schedule', 'place']);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthName = m => MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1);

// ---- Kind and date from a line of text -----------------------------------------------------------------------------
function guessKind(text) {
  if (/\b(birthday|born|anniversary)\b/i.test(text)) return 'event';
  if (/\b(prefers?|likes?|loves?|enjoys?|hates?|dislikes?|favou?rite|allergic|vegetarian|vegan)\b/i.test(text)) return 'preference';
  if (/\b(lives (?:in|at|near)|moved to|based in|grew up in|home is)\b/i.test(text)) return 'place';
  if (/\b(name is|is called|years old|works (?:as|at|for)|job is|occupation)\b/i.test(text)) return 'profile';
  return 'fact';
}
const pad = n => String(n).padStart(2, '0');
// "Maya's birthday is March 3rd" / "born 14 February 2016" / "birthday: 2016-02-14" → a yearly date (only for birthdays,
// anniversaries and "born": other dates in a memory line are too ambiguous to guess).
function yearlyDateIn(text) {
  if (!/\b(birthday|born|anniversary)\b/i.test(text)) return null;
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, recurs: 'yearly' };
  const mon = `(${MONTHS.join('|')}|${MONTHS.map(x => x.slice(0, 3)).join('|')})\\.?`;
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${mon}(?:,?\\s+(\\d{4}))?`, 'i').exec(text)
    || new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i').exec(text);
  if (!m) return null;
  const [day, name, year] = /^\d/.test(m[1]) ? [m[1], m[2], m[3]] : [m[2], m[1], m[3]];
  const month = MONTHS.findIndex(x => x.startsWith(name.toLowerCase().slice(0, 3))) + 1;
  return { date: year ? `${year}-${pad(month)}-${pad(day)}` : `${pad(month)}-${pad(day)}`, recurs: 'yearly' };
}

// Other assistants write "User has a daughter…" / "User's daughter…"; Jessbot's facts are about the person ("Has a daughter…").
function tidyLine(line) {
  let t = String(line).replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').replace(/\*\*|__|`/g, '').replace(/^\s*\[[ x]\]\s*/i, '').trim();
  t = t.replace(/^(?:the )?user['’]s\s+/i, 'Their ').replace(/^(?:the )?user\s+/i, '');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}
// Too long for one memory: split at sentence ends into parts of at most 300 characters.
function splitLong(text) {
  if (text.length <= MAX_FACT) return [text];
  const parts = [];
  let cur = '';
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (cur && `${cur} ${s}`.length > MAX_FACT) { parts.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) parts.push(cur);
  return parts;
}

// ---- Formats ---------------------------------------------------------------------------------------------------------
function fromJson(data) {
  const out = [];
  const walk = (v, depth = 0) => {
    if (depth > 4 || out.length > MAX_CANDIDATES * 2) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (v && typeof v === 'object') {
      const text = ['memory', 'content', 'text', 'value', 'fact', 'note'].map(k => v[k]).find(x => typeof x === 'string');
      if (text) { out.push(text); return; }
      for (const k of ['memories', 'items', 'data', 'facts', 'results']) if (v[k]) walk(v[k], depth + 1);
    }
  };
  walk(data);
  return out;
}

function fromText(text) {
  return text.split(/\r?\n/).map(l => l.trim()).filter(l => l
    && !/^#{1,6}\s/.test(l)             // markdown headings
    && !/^[-=*_]{3,}$/.test(l)          // rules
    && !/:\s*$/.test(l)                 // "Here's what I remember about you:" / "Family:"
    && l.replace(/[^\p{L}\p{N}]/gu, '').length >= 3);
}

// vCard (3.0/4.0 via ical.js; 2.1 quoted-printable decoded here). Relations: RELATED;TYPE=child and Apple's
// itemN.X-ABRELATEDNAMES + itemN.X-ABLabel pairs. Apple writes a birthday without a year as 1604-MM-DD.
const qp = s => { try { return Buffer.from(String(s).replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'); } catch { return String(s); } };
const label = s => String(s || '').replace(/^_\$!<|>!\$_$/g, '').trim().toLowerCase();
function vcardDate(raw, omitYear) {
  const s = String(raw || '').trim();
  let m;
  if ((m = /^--(\d{2})-?(\d{2})/.exec(s))) return `${m[1]}-${m[2]}`;
  if ((m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s))) return m[1] === '1604' || m[1] === omitYear ? `${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
const spoken = d => (d.length === 5 ? `${Number(d.slice(3))} ${monthName(Number(d.slice(0, 2)))}` : `${Number(d.slice(8))} ${monthName(Number(d.slice(5, 7)))} ${d.slice(0, 4)}`);

function fromVcard(text) {
  let parsed;
  try { parsed = ICAL.parse(text); } catch (err) { throw invalid({ text: `That .vcf file couldn’t be read (${String(err.message).slice(0, 80)}).` }); }
  const cards = (Array.isArray(parsed[0]) ? parsed : [parsed]).filter(c => c[0] === 'vcard');
  const out = [];
  for (const [, props] of cards) {
    const val = p => (p[1]?.encoding && /quoted-printable/i.test(p[1].encoding) ? qp(p[3]) : p[3]);
    const first = name => props.find(p => p[0] === name);
    let name = first('fn') ? String(val(first('fn'))).trim() : '';
    if (!name && first('n')) {
      const n = val(first('n'));
      const [family, given] = Array.isArray(n) ? n : String(n).split(/[;,]/);
      name = [given, family].filter(Boolean).join(' ').trim();
    }
    if (!name) continue;
    for (const [prop, what] of [['bday', 'birthday'], ['anniversary', 'anniversary']]) {
      const p = first(prop);
      const d = p && vcardDate(val(p), p[1]?.['x-apple-omit-year']);
      if (d && normaliseOk(d)) out.push({ text: `${name}’s ${what} is ${spoken(d)}`, kind: 'event', date: d, recurs: 'yearly', source: 'vcard' });
    }
    const related = props.filter(p => p[0] === 'related' && p[3] && !/^(urn|https?|mailto|tel):/i.test(String(p[3])))
      .map(p => ({ who: String(val(p)).trim(), rel: label(Array.isArray(p[1]?.type) ? p[1].type[0] : p[1]?.type) }));
    for (const p of props.filter(x => x[0] === 'x-abrelatednames')) {
      const lab = props.find(x => x[0] === 'x-ablabel' && x[1]?.group && x[1].group === p[1]?.group);
      related.push({ who: String(val(p)).trim(), rel: label(lab ? val(lab) : '') });
    }
    for (const r of related.filter(x => x.who)) {
      out.push({ text: r.rel ? `${r.who} is ${name}’s ${r.rel}` : `${r.who} is related to ${name}`, kind: 'fact', source: 'vcard' });
    }
  }
  return out;
}
const normaliseOk = d => { try { normaliseDate(d, 'yearly'); return true; } catch { return false; } };

/** What kind of paste this is: 'vcard' | 'json' | 'text'. */
export function importFormat(text, filename = '') {
  const t = String(text).trimStart();
  if (/\.vcf$/i.test(filename) || /^BEGIN:VCARD/i.test(t)) return 'vcard';
  if (/^[[{]/.test(t)) { try { JSON.parse(t); return 'json'; } catch { /* plain text that starts with a bracket */ } }
  return 'text';
}

/**
 * A paste or a file's text → candidate facts for the person to confirm: [{ key, text, kind, date, recurs, dateLabel, source,
 * problem, duplicateOf }]. `problem` says why one can't be saved (too long, a secret, instruction-looking); `duplicateOf` is
 * the id of a memory that already says it; `dateLabel` is the date in words ("14 March, every year"). Nothing is written.
 */
export function previewImport(user, { text, filename = '' } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) throw invalid({ text: 'Paste the memories (or choose a .vcf file) first.' });
  if (raw.length > MAX_IMPORT_CHARS) throw invalid({ text: 'That’s too much to import at once. Split it into smaller parts.' });
  const format = importFormat(raw, filename);
  let items;
  if (format === 'vcard') items = fromVcard(raw);
  else {
    const lines = format === 'json' ? fromJson(JSON.parse(raw.trim())) : fromText(raw);
    items = lines.map(tidyLine).filter(Boolean).flatMap(splitLong).map(t => ({ text: t, kind: guessKind(t), ...(yearlyDateIn(t) || {}), source: format }));
  }
  const seen = new Set();
  const scopeId = userScope(user).id;
  const candidates = [];
  for (const it of items) {
    const k = it.text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    let problem = null, when = null;
    try { cleanFact(it.text); if (it.date) when = normaliseDate(it.date, it.recurs); } catch (err) { problem = err.errors ? Object.values(err.errors).join(' ') : err.message; }
    candidates.push({ key: `c${candidates.length + 1}`, text: it.text, kind: it.kind, date: it.date || null, recurs: it.recurs || null,
      dateLabel: when ? dateText({ event_at: when.eventAt, recurs: when.recurs }) : null,
      source: it.source, problem, duplicateOf: problem ? null : sameInScope(scopeId, it.text, when?.eventAt ?? null)?.id ?? null });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return { format, candidates, truncated: items.length > candidates.length && candidates.length >= MAX_CANDIDATES };
}

/**
 * Save the candidates the person chose: [{ text, kind?, date?, recurs? }] → { saved: [{ id, text }], skipped: [{ text, reason }] }.
 * Private scope, marked as theirs (created_by user: extraction never overwrites them), each through cleanFact and the
 * near-duplicate check. Their texts are embedded in one call first (so 200 lines aren't 200 embedding calls).
 */
export async function confirmImport(user, items) {
  if (!Array.isArray(items) || !items.length) throw invalid({ items: 'Choose at least one memory to import.' });
  if (items.length > MAX_CANDIDATES) throw invalid({ items: `Import at most ${MAX_CANDIDATES} at a time.` });
  const list = items.map(it => ({ text: String(it?.text ?? ''), kind: KINDS.has(it?.kind) ? it.kind : 'fact', date: it?.date || null, recurs: it?.recurs || null }));
  const cleaned = list.map(it => { try { return cleanFact(it.text); } catch { return it.text.slice(0, MAX_FACT); } });
  const vecs = await queryVectors(cleaned, user.id, 15_000);
  const saved = [], skipped = [];
  for (const [i, it] of list.entries()) {
    try {
      const r = await addFactChecked({ user, text: it.text, kind: it.kind, date: it.date, recurs: it.date ? it.recurs : null, scopeHint: 'private',
        createdBy: 'user' }, { vec: vecs?.[i] || null });
      if (r.duplicate) skipped.push({ text: it.text, reason: 'Already remembered.', memoryId: r.fact.id });
      else saved.push({ id: r.fact.id, text: r.fact.text });
    } catch (err) {
      skipped.push({ text: it.text, reason: err.errors ? Object.values(err.errors).join(' ') : err.message });
    }
  }
  if (saved.length) publish(user.id, 'memory.updated', { count: saved.length });
  return { saved, skipped };
}
