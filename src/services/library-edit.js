// Small changes to a Library document or page without resending it whole (decision #144). Pure text functions; the
// tools (agent/tools/library.js) save the result as a new version through updateItem, so every earlier version stays.
//   applyEdits: find/replace patches. Each find must match exactly once in the text as it stands after the edits before
//     it; zero or several matches throw with the candidates (line + a little context) and nothing is changed.
//   appendToMarkdown: one line or table row (or a few lines) added to a markdown log, under a heading when given (made at
//     the end if missing); with a key (a date, a name) the line already carrying that key is replaced instead.
import { diffLines } from 'diff';

const bad = message => Object.assign(new Error(message), { status: 400 });
const MAX_EDITS = 50;
const MAX_LISTED = 5;

const lineAt = (text, i) => text.slice(0, i).split('\n').length;
const oneLine = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function occurrences(text, find) {
  const out = [];
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) out.push(at);
  return out;
}

// "line 12: …the words «match» around it…" for a match at [at, at + len).
function context(text, at, len) {
  const from = Math.max(0, at - 40), to = Math.min(text.length, at + len + 40);
  const shown = `${text.slice(from, at)}«${oneLine(text.slice(at, at + len), 80)}»${text.slice(at + len, to)}`;
  return `line ${lineAt(text, at)}: ${from > 0 ? '…' : ''}${oneLine(shown, 180)}${to < text.length ? '…' : ''}`;
}

/**
 * content + [{ find, replace }] → { text, changes: [{ line, find, replace }] }. Edits apply in order. A file with Windows
 * line ends matches finds written with plain \n (and keeps its own line ends).
 */
export function applyEdits(content, edits) {
  if (!Array.isArray(edits) || !edits.length) throw bad('Give at least one edit: { find, replace }.');
  if (edits.length > MAX_EDITS) throw bad(`That’s more than ${MAX_EDITS} edits in one go; send the whole new version with library_update instead.`);
  const crlf = String(content).includes('\r\n');
  let text = String(content);
  const changes = [];
  edits.forEach((e, n) => {
    const label = edits.length > 1 ? `Edit ${n + 1}: ` : '';
    let find = String(e?.find ?? ''), replace = String(e?.replace ?? '');
    if (!find) throw bad(`${label}find is empty. Quote the exact text to change (library_read shows it).`);
    if (crlf && !find.includes('\r')) { find = find.replace(/\n/g, '\r\n'); replace = replace.replace(/\r?\n/g, '\r\n'); }
    const hits = occurrences(text, find);
    if (hits.length > 1) {
      throw bad(`${label}“${oneLine(find, 80)}” appears ${hits.length} times, so I can’t tell which one you mean. Nothing was changed. `
        + `Add a few neighbouring words to find so it matches only one:\n${hits.slice(0, MAX_LISTED).map(h => `  ${context(text, h, find.length)}`).join('\n')}`
        + `${hits.length > MAX_LISTED ? `\n  … and ${hits.length - MAX_LISTED} more` : ''}`);
    }
    if (!hits.length) {
      // Near misses: the same words with other spacing, line breaks or capitals.
      const re = new RegExp(escapeRe(find.trim()).replace(/\s+/g, '\\s+'), 'gi');
      const near = find.trim() ? [...text.matchAll(re)].slice(0, MAX_LISTED) : [];
      throw bad(`${label}“${oneLine(find, 80)}” isn’t in the current version${n ? ' (after the edits before it)' : ''}. Nothing was changed. `
        + (near.length ? `Close matches (spacing or capitals differ):\n${near.map(m => `  ${context(text, m.index, m[0].length)}`).join('\n')}\nUse the exact text.`
          : 'Read it again with library_read and copy the exact text.'));
    }
    const at = hits[0];
    changes.push({ line: lineAt(text, at), find, replace });
    text = text.slice(0, at) + replace + text.slice(at + find.length);
  });
  if (text === content) throw bad('Those edits leave the text exactly as it was.');
  return { text, changes };
}

/** "+3 −1 lines" between two versions (line-level). */
export function lineDiff(before, after) {
  let added = 0, removed = 0;
  for (const part of diffLines(String(before), String(after))) {
    if (part.added) added += part.count;
    else if (part.removed) removed += part.count;
  }
  return { added, removed, label: `+${added} −${removed} line${added + removed === 1 ? '' : 's'}` };
}

/** One line per change for the tool result: "line 12: “old” → “new”". */
export const changesSummary = (changes, limit = 8) => changes.slice(0, limit)
  .map(c => `line ${c.line}: “${oneLine(c.find, 60)}” → ${c.replace ? `“${oneLine(c.replace, 60)}”` : '(removed)'}`).join('\n')
  + (changes.length > limit ? `\n… and ${changes.length - limit} more` : '');

// ---- Appending to a markdown log ------------------------------------------------------------------------------------
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const norm = s => String(s).replace(/^#+\s*/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const kindOf = line => (/^\s*\|/.test(line) ? 'table' : /^\s*(?:[-*+]|\d+[.)])\s/.test(line) ? 'list' : 'text');

/**
 * Does this line carry `key`? A table row: its first cell is the key. Any other line: after a list marker, a checkbox and
 * bold/italic marks, it starts with the key followed by a non-word character or the end ("2026-09-26: 7h" has
 * 2026-09-26; "2026-09-261" doesn't). Case-insensitive. A table's --- row never matches.
 */
export function lineHasKey(line, key) {
  const k = String(key).trim().toLowerCase();
  if (!k) return false;
  if (/^\s*\|/.test(line)) {
    if (/^[\s|:-]+$/.test(line) && line.includes('-')) return false; // the header's --- row
    const first = line.trim().replace(/^\|/, '').split('|')[0];
    return first.replace(/[*_`]/g, '').trim().toLowerCase() === k;
  }
  const t = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '').replace(/^[*_`]+/, '').toLowerCase();
  return t.startsWith(k) && !/[\p{L}\p{N}]/u.test(t.charAt(k.length));
}

/** Where each heading is (outside code fences): [{ at, level, text }]. */
function headings(lines) {
  const out = [];
  let fenced = false;
  lines.forEach((l, at) => {
    if (FENCE.test(l)) { fenced = !fenced; return; }
    const m = !fenced && HEADING.exec(l);
    if (m) out.push({ at, level: m[1].length, text: m[2] });
  });
  return out;
}

/**
 * content + { text, underHeading?, key? } → { text, action: 'added' | 'replaced', line, heading: 'found' | 'made' | null,
 * duplicates }. Rows join a table or list directly under its last line; anything else gets a blank line first.
 */
export function appendToMarkdown(content, { text, underHeading, key } = {}) {
  const add = String(text ?? '').replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '').split('\n');
  if (!add.join('').trim()) throw bad('text is empty: give the line or table row to add.');
  if (key != null && String(key).trim() && !lineHasKey(add[0], key)) {
    throw bad(`With key “${oneLine(key, 40)}”, the text must start with it (a table row whose first cell is “${oneLine(key, 40)}”, or a line like `
      + `“- ${oneLine(key, 40)}: …”), so the same entry can be found and replaced next time.`);
  }
  const eol = String(content).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(content).split(/\r?\n/);
  let start = 0, end = lines.length, heading = null;
  if (underHeading != null && String(underHeading).trim()) {
    const all = headings(lines);
    const want = norm(underHeading);
    const h = all.find(x => norm(x.text) === want);
    if (h) {
      heading = 'found';
      start = h.at + 1;
      end = all.find(x => x.at > h.at && x.level <= h.level)?.at ?? lines.length;
    } else {
      heading = 'made';
      while (lines.length && !lines.at(-1).trim()) lines.pop();
      const level = Math.min(6, (all.length ? Math.min(...all.map(x => x.level)) : 1) + 1);
      if (lines.length) lines.push('');
      lines.push(`${'#'.repeat(level)} ${String(underHeading).replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim()}`, '');
      start = end = lines.length;
    }
  }
  if (key != null && String(key).trim()) {
    const hits = [];
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
      if (FENCE.test(lines[i])) { fenced = !fenced; continue; }
      if (!fenced && i >= start && i < end && lineHasKey(lines[i], key)) hits.push(i);
    }
    if (hits.length) {
      lines.splice(hits[0], 1, ...add);
      return { text: lines.join(eol), action: 'replaced', line: hits[0] + 1, heading, duplicates: hits.length - 1 };
    }
  }
  let last = end - 1;
  while (last >= start && !lines[last].trim()) last--;
  const prev = last >= start ? lines[last] : null;
  const joins = prev != null && kindOf(prev) !== 'text' && kindOf(prev) === kindOf(add[0]);
  const at = last >= start ? last + 1 : start;
  // A blank line before, unless the text continues a table or list (or opens the document); one after when a heading follows.
  const lead = (prev != null && !joins) || (prev == null && at > 0 && lines[at - 1].trim()) ? 1 : 0;
  const block = [...Array(lead).fill(''), ...add, ...(at < lines.length && lines[at].trim() ? [''] : [])];
  lines.splice(at, 0, ...block);
  if (lines.at(-1) !== '') lines.push(''); // end with a newline
  return { text: lines.join(eol), action: 'added', line: at + lead + 1, heading, duplicates: 0 };
}
