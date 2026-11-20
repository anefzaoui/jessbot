// Uploads (Phase 10, decision #76): a file someone attaches in chat (or drops on the Library) becomes a Library item —
// and so does a file Jess's browser downloads (decision #117, "Downloaded from <host>").
// What a file IS comes from its own bytes (file-type), never from its name or the browser's claim. Text is extracted
// once, at upload: PDFs with pdf.js (lib/pdfjs.js), Word files with mammoth (→ HTML → markdown via turndown), plain text as is.
// Images keep no text: Jess sees them (the model's vision) when they're attached to a message, through a copy at most
// 1568 px on its longer side that is made before the upload answers (decision #201; the original is what the person keeps).
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { withPdf } from '../lib/pdfjs.js';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { createFileItem, itemView, sizeLabel, DOWNLOADED_FROM, NO_TEXT_MARK, hasReadableText, modelImage } from './library.js';
import { xlsxSheets, sheetsText, sheetsPreviewHtml, officeText } from './office.js';
import { invalid } from '../lib/errors.js';
import { captionsToText, captionStats } from '../lib/captions.js';
import { renderMarkdown } from '../lib/markdown.js';

export const UPLOAD_MAX_BYTES = 25 * 1048576;
export const UPLOAD_MAX_FILES = 6;
const TEXT_MAX = 400_000; // characters of extracted text kept per file

const BY_MIME = {
  'application/pdf': { type: 'pdf', ext: 'pdf' },
  'image/png': { type: 'image', ext: 'png' },
  'image/jpeg': { type: 'image', ext: 'jpg' },
  'image/webp': { type: 'image', ext: 'webp' },
  'image/gif': { type: 'image', ext: 'gif' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { type: 'doc', ext: 'docx' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { type: 'sheet', ext: 'xlsx' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { type: 'slides', ext: 'pptx' },
  'text/vtt': { type: 'md', ext: 'vtt' }, // file-type knows WebVTT by its "WEBVTT" header
};
// Plain text has no signature: accepted when it decodes as UTF-8 and the name says what it is.
// .srt / .vtt (meeting and video transcripts, decision #142) are kept as uploaded; their text is the cleaned transcript.
const TEXT_EXT = { txt: 'md', md: 'md', markdown: 'md', csv: 'sheet', tsv: 'sheet', json: 'md', log: 'md', xml: 'md', yaml: 'md', yml: 'md', ics: 'md',
  srt: 'md', vtt: 'md' };
const TEXT_MIME = { md: 'text/markdown; charset=utf-8', sheet: 'text/csv; charset=utf-8' };
const EXT_MIME = { srt: 'application/x-subrip; charset=utf-8', vtt: 'text/vtt; charset=utf-8' };
export const CAPTION_EXTS = new Set(['srt', 'vtt']);

export const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.json,.log,.xml,.yaml,.yml,.ics,.srt,.vtt,image/*,application/pdf';

const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });

/** { type, ext, mime } for these bytes, or null when we don't take this kind of file. */
export async function sniff(buffer, name = '') {
  const ft = await fileTypeFromBuffer(buffer).catch(() => null);
  if (ft && BY_MIME[ft.mime]) return { ...BY_MIME[ft.mime], mime: EXT_MIME[BY_MIME[ft.mime].ext] || ft.mime };
  if (ft) return null; // a real binary format we don't handle (zip, exe, video…)
  const ext = path.extname(name).slice(1).toLowerCase();
  const type = TEXT_EXT[ext];
  if (!type) return null;
  const text = buffer.toString('utf8');
  if (text.includes('�') || /[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 4096))) return null; // not really text
  return { type, ext, mime: EXT_MIME[ext] || TEXT_MIME[type] };
}

// PDF text in reading order, right-to-left lines included. pdf.js hands a line back as pieces in VISUAL order (left to
// right on the page), each piece already in logical order and tagged ltr/rtl. For a line with right-to-left pieces the
// piece order is reversed — runs of left-to-right pieces (English, numbers) stay in their own order — and shaped Arabic
// glyphs (presentation forms) are normalized to plain letters (NFKC). Other lines are joined as they come.
const LTR_WORD = /[A-Za-z0-9]/;
export function lineText(items) {
  if (!items.some(it => it.dir === 'rtl')) return items.map(it => it.str).join('');
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const blocks = []; // an LTR block: consecutive pieces with Latin/digits (and the spaces between them)
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    const ltr = it.dir !== 'rtl' && LTR_WORD.test(it.str);
    const bridge = it.dir !== 'rtl' && !it.str.trim() && blocks.at(-1)?.ltr && sorted.slice(i + 1).find(n => n.str.trim())?.dir !== 'rtl'
      && LTR_WORD.test(sorted.slice(i + 1).find(n => n.str.trim())?.str || '');
    if ((ltr || bridge) && blocks.at(-1)?.ltr) blocks.at(-1).str += it.str;
    else blocks.push({ str: it.str, ltr });
  }
  return blocks.reverse().map(b => b.str).join('').normalize('NFKC');
}

export async function pdfText(buffer) {
  return withPdf(buffer, async pdf => {
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const { items } = await (await pdf.getPage(p)).getTextContent();
      const lines = [];
      let line = [], lastY = null;
      for (const it of items) {
        const y = it.transform?.[5] ?? lastY;
        if (line.length && lastY != null && Math.abs(y - lastY) > 2) { lines.push(line); line = []; }
        if (it.str) line.push({ str: it.str, dir: it.dir, x: it.transform?.[4] ?? 0 });
        lastY = y;
        if (it.hasEOL) { lines.push(line); line = []; }
      }
      if (line.length) lines.push(line);
      pages.push(lines.map(lineText).map(s => s.trim()).filter(Boolean).join('\n'));
    }
    return { pages: pdf.numPages, text: pages.map((t, i) => `--- page ${i + 1} ---\n${t}`).join('\n\n') };
  });
}

/** Readable text of a PDF / Word file ('' when there is none, e.g. a scanned PDF). */
export async function extract(kind, buffer) {
  if (kind.type === 'pdf') {
    const { pages, text } = await pdfText(buffer);
    return { text: text.slice(0, TEXT_MAX), pages };
  }
  if (kind.type === 'doc') {
    const { value } = await mammoth.convertToHtml({ buffer });
    return { text: td.turndown(value).slice(0, TEXT_MAX) };
  }
  if (kind.ext === 'xlsx') {
    const sheets = await xlsxSheets(buffer);
    return { text: sheetsText(sheets).slice(0, TEXT_MAX), preview: sheetsPreviewHtml(sheets) };
  }
  if (kind.ext === 'pptx') return { text: (await officeText(buffer)).slice(0, TEXT_MAX) };
  if (CAPTION_EXTS.has(kind.ext)) {
    const raw = buffer.toString('utf8');
    const text = captionsToText(raw).slice(0, TEXT_MAX);
    const s = captionStats(raw);
    const description = ['Transcript', s.minutes ? `${s.minutes} min` : null, s.speakers ? `${s.speakers} speaker${s.speakers === 1 ? '' : 's'}` : null]
      .filter(Boolean).join(' · ');
    return { text, preview: renderMarkdown(text || '_No spoken lines in this file._'), description };
  }
  return { text: '' };
}

const titleFrom = name => path.basename(String(name || 'file'), path.extname(String(name || ''))).replace(/[_]+/g, ' ').trim().slice(0, 120) || 'Untitled file';

/**
 * Store one file for this person → its Library item view. Uploads, browser downloads and email attachments
 * (services/mail-files.js) all go through here, so every outside file is typed and read the same way. sourceLabel says
 * where it came from (library.js originOf reads it); title defaults to the file's name; kind: what sniff() already found
 * (the caller checked the bytes itself). Throws invalid({ file }) for what we can't take; `unreadable` words that refusal
 * for the caller's situation.
 */
export async function storeFile(user, { buffer, name, title = null }, { threadId = null, runId = null, sourceLabel = 'Uploaded', unreadable, kind: known = null } = {}) {
  if (!buffer?.length) throw invalid({ file: `“${name}” is empty.` });
  if (buffer.length > UPLOAD_MAX_BYTES) throw invalid({ file: `“${name}” is ${sizeLabel(buffer.length)} — the limit is ${sizeLabel(UPLOAD_MAX_BYTES)}.` });
  const kind = known || await sniff(buffer, name);
  if (!kind) throw invalid({ file: unreadable ? unreadable(name) : `I can’t read “${name}” yet — send a PDF, an image, a Word / Excel / PowerPoint file or plain text.` });
  let text = '', pages = null, preview = null, described = null;
  try { ({ text, pages = null, preview = null, description: described = null } = await extract(kind, buffer)); } catch (err) {
    // The file is still kept; it just has no text for Jess. The name is the uploader's: one line in the log.
    console.warn('[upload] extract %s: %s', String(name).replace(/[\r\n]+/g, ' '), String(err.message).replace(/[\r\n]+/g, ' '));
  }
  const description = kind.type === 'pdf' ? `${pages ? `${pages} page${pages === 1 ? '' : 's'}` : 'PDF'}${hasReadableText(text) ? '' : NO_TEXT_MARK}` : described;
  const item = createFileItem({ user, title: title || titleFrom(name), type: kind.type, ext: kind.ext, mime: kind.mime, buffer, text, preview, description,
    threadId, runId, sourceLabel });
  if (item.type === 'image') await modelImage(item); // ready before it can be attached (started by createFileItem; shared)
  return itemView(item);
}

/** Save one uploaded file for this person → its Library item view (+ pages for PDFs). Throws invalid() for what we can't take. */
export async function saveUpload(user, { buffer, originalname }, { threadId = null } = {}) {
  const name = Buffer.from(originalname || 'file', 'latin1').toString('utf8'); // multer hands over the raw header bytes
  return storeFile(user, { buffer, name }, { threadId });
}

// ---- Browser downloads (decision #117) ------------------------------------------------------------------------------------
export const DOWNLOAD_SESSION_FILES = 10;               // per browsing session
export const DOWNLOAD_SESSION_BYTES = 100 * 1048576;
const hostOf = u => { try { const h = new URL(u).hostname.replace(/^www\./, ''); return h || null; } catch { return null; } };

/**
 * A file Jess's browser downloaded → a Library item for this person, typed and read like an upload, labelled
 * "Downloaded from <host>". url: where it came from (the download's address, or the page's when that is a blob:/data: URL).
 */
export async function saveDownload(user, { buffer, filename, url }, { threadId = null, runId = null } = {}) {
  const name = String(filename || 'download').trim() || 'download';
  return storeFile(user, { buffer, name }, {
    threadId, runId, sourceLabel: `${DOWNLOADED_FROM}${hostOf(url) || 'a website'}`.slice(0, 80),
    unreadable: n => `“${n}” is a kind of file I can’t keep yet (I take PDFs, images, Word / Excel / PowerPoint files and plain text), so it was not saved.`,
  });
}
