// The Library (decision #47): everything Jess makes for a person. Metadata in SQLite, files on disk at
// data/artifacts/<owner_id>/<public_id>/v<N>.<ext> (every version kept), search via FTS5 over the current version.
// HTML artifacts are untrusted content: they are only ever served with a sandbox CSP (routes/web/library.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { get, all, run } from '../db/index.js';
import { paths } from '../config/index.js';
import { renderMarkdown } from '../lib/markdown.js';
import { invalid, notFound, forbidden } from '../lib/errors.js';
import { toIso } from './chatview.js';
import { ftsAll, ftsAny } from '../lib/fts.js';
import { linkThreadItem } from './projects.js';
import { onProjectFile } from './project-files.js';
import { renderPdfPages, renderPdfPage, fitImage, MODEL_EDGE } from './pdf-render.js';
import { officeToPdf, findSoffice, OFFICE_EXTS } from './office-render.js';
import { publish } from '../lib/bus.js';
import { adminMayView } from './oversight.js';
import { stripInvisible } from '../lib/untrusted.js';

export const FORMATS = {
  html: { ext: 'html', mime: 'text/html; charset=utf-8', label: 'Interactive page' },
  md: { ext: 'md', mime: 'text/markdown; charset=utf-8', label: 'Document' },
};
export const MAX_BYTES = 1_000_000;
const TITLE_MAX = 120;

// Every HTML artifact is served with this policy — in the app AND when rendered for a thumbnail: opaque origin
// (no cookies, storage or same-origin API access), no network APIs, scripts/styles/fonts inline or from three CDNs.
const CDNS = 'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com';
export const ARTIFACT_CSP = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads',
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS}`,
  `style-src 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
  `font-src data: ${CDNS} https://fonts.gstatic.com`,
  'img-src data: blob: https:',
  'media-src data: blob: https:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

const dirOf = item => path.join(paths.artifacts, String(item.owner_id), item.public_id);
export const fileOf = (item, v = item.version) => path.join(dirOf(item), `v${v}.${item.ext}`);
export const thumbFile = item => path.join(dirOf(item), 'thumb.jpg');

export const sizeLabel = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// A fragment becomes a complete, mobile-friendly document; a full document is kept as written.
export function normalizeHtml(content, title) {
  const s = String(content).trim();
  if (/<html[\s>]/i.test(s)) return s;
  const esc = String(title).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n`
    + `<title>${esc}</title>\n<style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}</style>\n</head>\n<body>\n${s}\n</body>\n</html>\n`;
}

// Plain text of a version, for search and for the model.
export function textOf(type, content) {
  if (type !== 'html') return String(content);
  return String(content).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

const titleError = t => (!t ? 'Give it a title.' : t.length > TITLE_MAX ? `Keep the title under ${TITLE_MAX} characters.` : null);

function validate({ title, type, content }) {
  const errors = {};
  const t = String(title || '').trim();
  if (titleError(t)) errors.title = titleError(t);
  if (!FORMATS[type]) errors.type = `Type must be one of: ${Object.keys(FORMATS).join(', ')}.`;
  const body = String(content ?? '');
  if (!body.trim()) errors.content = 'The content is empty.';
  else if (Buffer.byteLength(body) > MAX_BYTES) errors.content = `That is too large (limit ${sizeLabel(MAX_BYTES)}).`;
  if (Object.keys(errors).length) throw invalid(errors);
  return t;
}

function writeVersion(item, v, content) {
  fs.mkdirSync(dirOf(item), { recursive: true });
  const body = item.type === 'html' ? normalizeHtml(content, item.title) : String(content);
  fs.writeFileSync(fileOf(item, v), body);
  return Buffer.byteLength(body);
}

function reindex(item, content) {
  onProjectFile(item.id, { force: true }); // its content changed: a project file is re-indexed for project_search (decision #94)
  run('DELETE FROM library_fts WHERE rowid = ?', item.id);
  run('INSERT INTO library_fts (rowid, title, description, body) VALUES (?, ?, ?, ?)',
    item.id, item.title, item.description || '', (isBinary(item) ? String(content || '') : textOf(item.type, content)).slice(0, 50000));
}

export const getItem = id => get('SELECT * FROM library_items WHERE id = ?', id) || null;

export function createItem({ user, title, type, content, description = null, proactive = false, sourceLabel = null, threadId = null, runId = null }) {
  const t = validate({ title, type, content });
  const publicId = crypto.randomBytes(9).toString('base64url');
  const { lastInsertRowid } = run(
    `INSERT INTO library_items (public_id, owner_id, title, type, description, ext, mime, proactive, source_label, thread_id, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    publicId, user.id, t, type, description ? String(description).slice(0, 300) : null, FORMATS[type].ext, FORMATS[type].mime,
    proactive ? 1 : 0, sourceLabel ? String(sourceLabel).slice(0, 80) : null, threadId, runId);
  const item = getItem(Number(lastInsertRowid));
  if (threadId) linkThreadItem(threadId, item.id); // made in a project chat → a project file
  const size = writeVersion(item, 1, content);
  run('UPDATE library_items SET size_bytes = ? WHERE id = ?', size, item.id);
  reindex(item, content);
  return getItem(item.id);
}

export function updateItem(item, { content, title, description }) {
  if (isBinary(item)) throw invalid({ content: 'Uploaded files aren’t edited in place — make a new document from it instead.' });
  const t = validate({ title: title ?? item.title, type: item.type, content: content ?? readContent(item) });
  const v = item.version + 1;
  const next = { ...item, title: t };
  const size = writeVersion(next, v, content ?? readContent(item));
  run(`UPDATE library_items SET version = ?, title = ?, description = COALESCE(?, description), size_bytes = ?, has_thumb = 0,
       updated_at = datetime('now') WHERE id = ?`, v, t, description ? String(description).slice(0, 300) : null, size, item.id);
  const fresh = getItem(item.id);
  reindex(fresh, readContent(fresh));
  return fresh;
}

export function restoreVersion(item, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n >= item.version || !fs.existsSync(fileOf(item, n))) throw notFound('That version doesn’t exist.');
  return updateItem(item, { content: fs.readFileSync(fileOf(item, n), 'utf8') });
}

/**
 * A new title and/or description for any item, uploads and scans included (library_describe, PATCH /library/:id): no new
 * version, the file is untouched; search (title + description + text) is re-indexed. An empty description clears it.
 */
export function describeItem(item, { title, description } = {}) {
  if (title === undefined && description === undefined) throw invalid({ title: 'Give a new title or description.' });
  const t = title === undefined ? item.title : String(title).trim();
  if (titleError(t)) throw invalid({ title: titleError(t) });
  const d = description === undefined ? item.description : String(description).replace(/\s+/g, ' ').trim().slice(0, 300) || null;
  run(`UPDATE library_items SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?`, t, d, item.id);
  const fresh = getItem(item.id);
  reindex(fresh, readText(fresh));
  return fresh;
}

export const deleteItem = item => { run(`UPDATE library_items SET deleted_at = datetime('now') WHERE id = ?`, item.id); onProjectFile(item.id); };
export const restoreItem = item => { run('UPDATE library_items SET deleted_at = NULL WHERE id = ?', item.id); onProjectFile(item.id); };

export function readContent(item, v = item.version) {
  try { return fs.readFileSync(fileOf(item, v), 'utf8'); } catch { throw notFound('That file is missing.'); }
}

// ---- Files people upload (Phase 10, decision #76): kept byte-for-byte; their text sits next to them (v<N>.txt) --------
// Binary types are never edited in place (a new document is made instead); their text is what search and Jess read.
// Binary by the file itself (a "sheet" may be a CSV text file or an .xlsx workbook).
// Caption files (.srt/.vtt) belong here too: kept byte-for-byte, and what Jess reads is the cleaned transcript beside them (#142).
// Audio (long read-aloud, #142) is a WAV; its text is the script that was read.
export const BINARY_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'docx', 'xlsx', 'pptx', 'srt', 'vtt', 'wav']);
export const isBinary = item => BINARY_EXTS.has(item.ext);
// Where a file came from (source_label): the person's upload, Jess's browser (decision #117), an email's attachment
// (decision #157: "From email: “Invoice 12”"), or Jess herself. The first three are outside files: fenced when read,
// never regenerated over by the office tools. (Email files saved before the email label read "Downloaded from an email: …"
// and count as downloads, which behave the same.)
export const DOWNLOADED_FROM = 'Downloaded from ';
export const FROM_EMAIL = 'From email: ';
export const originOf = item => {
  const label = String(item.source_label || '');
  return label === 'Uploaded' ? 'uploaded' : label.startsWith(DOWNLOADED_FROM) ? 'downloaded' : label.startsWith(FROM_EMAIL) ? 'email' : 'made';
};
/** A file someone else made (uploaded, downloaded, from an email), as opposed to one Jess generated. */
export const isOutsideFile = item => originOf(item) !== 'made';
/** Where it came from, in words for Jess: "uploaded by them", "downloaded from x.com", "from email: “Invoice 12”", "made by you". */
export function fromWords(item) {
  const o = originOf(item);
  if (o === 'uploaded') return 'uploaded by them';
  if (o === 'made') return 'made by you';
  return `${item.source_label[0].toLowerCase()}${item.source_label.slice(1)}`;
}
/** The outside source of a file's text for the injection screen: the website's host, "an email: “…”", or the Library item. */
export function outsideSource(item) {
  const o = originOf(item);
  return o === 'downloaded' ? item.source_label.slice(DOWNLOADED_FROM.length) : o === 'email' ? `an email: ${item.source_label.slice(FROM_EMAIL.length)}` : `library ${item.public_id}`;
}
const textFileOf = (item, v = item.version) => path.join(dirOf(item), `v${v}.txt`);
const previewFileOf = (item, v = item.version) => path.join(dirOf(item), `v${v}.preview.html`);

const metaFileOf = (item, v = item.version) => path.join(dirOf(item), `v${v}.meta.json`);
// Pictures of a version's pages (decision #161): v<N>.page<k>.jpg; an office file as LibreOffice prints it: v<N>.render.pdf.
export const pageFileOf = (item, n, v = item.version) => path.join(dirOf(item), `v${v}.page${n}.jpg`);
export const renderFileOf = (item, v = item.version) => path.join(dirOf(item), `v${v}.render.pdf`);

function writeSidecars(item, v, { text, preview, meta = null }) {
  if (isBinary(item) && text) fs.writeFileSync(textFileOf(item, v), text);
  if (preview) fs.writeFileSync(previewFileOf(item, v), preview);
  if (meta) fs.writeFileSync(metaFileOf(item, v), JSON.stringify(meta));
}

/** Small facts about a version the viewer needs without opening the file (audio: duration, waveform, voice), or null. */
export const metaOf = (item, v = item.version) => { try { return JSON.parse(fs.readFileSync(metaFileOf(item, v), 'utf8')); } catch { return null; } };

// A file's title usually comes from a name someone else chose (an upload, a download, an email attachment's MIME name, which
// can carry newlines and invisible characters): stored as one clean line, so no prompt line that quotes it can be split.
const fileTitle = title => stripInvisible(title).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);

/**
 * Store a file: uploads ({ type, ext, mime } from the file's own bytes, services/uploads.js) and office files Jess makes
 * (services/office.js). text = what search and Jess read; preview = our own escaped HTML for the viewer (office files).
 */
export function createFileItem({ user, title, type, ext, mime, buffer, text = '', preview = null, meta = null, description = null, threadId = null,
  runId = null, sourceLabel = 'Uploaded', proactive = false, sourceItemId = null }) {
  const t = fileTitle(title) || 'Untitled file';
  const publicId = crypto.randomBytes(9).toString('base64url');
  const { lastInsertRowid } = run(
    `INSERT INTO library_items (public_id, owner_id, title, type, description, ext, mime, source_label, thread_id, run_id, size_bytes, has_thumb, proactive, source_item_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    publicId, user.id, t, type, description ? String(description).slice(0, 300) : null, ext, mime, sourceLabel, threadId, runId, buffer.length, proactive ? 1 : 0, sourceItemId);
  const item = getItem(Number(lastInsertRowid));
  if (threadId) linkThreadItem(threadId, item.id);
  fs.mkdirSync(dirOf(item), { recursive: true });
  fs.writeFileSync(fileOf(item, 1), buffer);
  writeSidecars(item, 1, { text, preview, meta });
  reindex(item, text || (isBinary(item) ? '' : buffer.toString('utf8')));
  const fresh = getItem(item.id);
  previewLater(fresh); // a PDF's thumbnail, an office file's pages (when LibreOffice is there): in the background
  modelImageLater(fresh); // a picture's copy for the model (#201)
  return fresh;
}

/** A new version of a file item (office files Jess revises); earlier versions stay restorable by download. */
export function addFileVersion(item, { buffer, text = '', preview = null, title = null, description = null }) {
  const v = item.version + 1;
  const t = title ? fileTitle(title) || item.title : item.title;
  fs.mkdirSync(dirOf(item), { recursive: true });
  fs.writeFileSync(fileOf(item, v), buffer);
  writeSidecars(item, v, { text, preview });
  // The old version's thumbnail no longer shows this one: it is redrawn for the new version (previewLater).
  run(`UPDATE library_items SET version = ?, title = ?, description = COALESCE(?, description), size_bytes = ?, has_thumb = 0,
       updated_at = datetime('now') WHERE id = ?`, v, t, description ? String(description).slice(0, 300) : null, buffer.length, item.id);
  const fresh = getItem(item.id);
  reindex(fresh, text);
  previewLater(fresh);
  modelImageLater(fresh);
  return fresh;
}

/** An earlier export of `source` with this extension and title (library_export makes it a new version), or null. */
export const exportOf = (source, { ext, title }) => get(`SELECT * FROM library_items WHERE source_item_id = ? AND owner_id = ? AND ext = ? AND title = ?
  AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, source.id, source.owner_id, ext, title) || null;

/** The viewer's HTML preview of an office file, when one was made. */
export const previewOf = (item, v = item.version) => { try { return fs.readFileSync(previewFileOf(item, v), 'utf8'); } catch { return null; } };

/** What a person (or Jess) reads of an item: the text of a document; the extracted text of a PDF or Word file. */
export function readText(item, v = item.version) {
  if (!isBinary(item)) return readContent(item, v);
  try { return fs.readFileSync(textFileOf(item, v), 'utf8'); } catch { return ''; }
}

/** The file's bytes (images for the model, downloads). */
export const readBytes = (item, v = item.version) => { try { return fs.readFileSync(fileOf(item, v)); } catch { throw notFound('That file is missing.'); } };

export function saveThumb(item, buf) {
  fs.mkdirSync(dirOf(item), { recursive: true });
  fs.writeFileSync(thumbFile(item), buf);
  run('UPDATE library_items SET has_thumb = 1 WHERE id = ?', item.id);
}

// ---- Pictures of pages (decisions #161, #162) ----------------------------------------------------------------------------
// A PDF gets a first-page thumbnail; a Word, Excel or PowerPoint file, when LibreOffice is installed, is printed to a PDF
// (kept as v<N>.render.pdf) whose first pages become its thumbnail and its preview pictures. Made once per version in the
// background (concurrent callers share the work), recorded in preview_version / preview_pages so a failure isn't retried
// for that version, and announced to the owner's open pages. Items from before this existed are drawn lazily, a few per
// Library view (backfillPreviews).
export const PREVIEW_PAGES = 3;
const PAGE_PICTURE = { width: 1000, quality: 78 };    // preview pictures in the viewer
const THUMB_PICTURE = { width: 640, quality: 72 };    // the card's thumbnail (16:10, top of the page)
export const MODEL_PICTURE = { width: 1100, maxEdge: MODEL_EDGE, quality: 80 }; // what Jess looks at (pdf_page_image)
const BACKFILL_PER_VIEW = 4;
const previewing = new Map(); // `${id}:${version}` → promise of the fresh item

/** Does this item get pictures of its pages? PDFs always; office files when LibreOffice is there. */
export const wantsPreview = item => item.ext === 'pdf' || (OFFICE_EXTS.has(item.ext) && !!findSoffice());
const previewDone = item => item.preview_version === item.version;

async function announcePicture(item) {
  const view = itemView(item);
  let html = null;
  try {
    const [{ renderFragment }, { getUser }] = await Promise.all([import('../views/render.js'), import('./users.js')]);
    html = await renderFragment('library-card', view, getUser(item.owner_id));
  } catch { /* no renderer (scripts, tests): the item view alone */ }
  publish(item.owner_id, 'library.updated', { item: view, html });
}

async function drawPages(item) {
  let pdf;
  if (item.ext === 'pdf') pdf = readBytes(item);
  else {
    pdf = await officeToPdf(readBytes(item), item.ext);
    fs.writeFileSync(renderFileOf(item), pdf);
  }
  const office = item.ext !== 'pdf';
  const { pages } = await renderPdfPages(pdf, office ? Array.from({ length: PREVIEW_PAGES }, (_, i) => i + 1) : [1], office ? PAGE_PICTURE : THUMB_PICTURE);
  if (!pages.length) throw new Error('no pages');
  const thumb = office ? (await fitImage(pages[0].buffer, { maxEdge: 900, quality: THUMB_PICTURE.quality, maxBytes: 0 })).buffer : pages[0].buffer;
  return { thumb, pages: office ? pages : [] };
}

/** Make this version's pictures (once; callers share the work) → the fresh item. Never throws: a failure is recorded. */
export function makePreviews(item) {
  const key = `${item.id}:${item.version}`;
  if (previewing.has(key)) return previewing.get(key);
  const job = (async () => {
    await new Promise(r => setImmediate(r)); // the caller may still be writing sidecars in this tick
    const current = getItem(item.id);
    if (!current || current.version !== item.version || current.deleted_at) return current;
    try {
      const { thumb, pages } = await drawPages(current);
      if (getItem(item.id)?.version !== current.version) return getItem(item.id); // a newer version arrived meanwhile
      for (const p of pages) fs.writeFileSync(pageFileOf(current, p.page), p.buffer);
      fs.writeFileSync(thumbFile(current), thumb);
      run('UPDATE library_items SET has_thumb = 1, preview_version = ?, preview_pages = ? WHERE id = ? AND version = ?', current.version, pages.length, current.id, current.version);
      const fresh = getItem(current.id);
      await announcePicture(fresh);
      return fresh;
    } catch (err) {
      // LibreOffice missing (or removed since): not a failure of this file; it is drawn once it is installed.
      if (err.status !== 503) {
        run('UPDATE library_items SET preview_version = ?, preview_pages = 0 WHERE id = ? AND version = ?', current.version, current.id, current.version);
        console.warn('[library] page pictures failed', current.public_id, String(err.message).split('\n')[0]);
      }
      return getItem(current.id);
    }
  })().catch(() => null).finally(() => previewing.delete(key)); // (the database may be gone: shutdown)
  previewing.set(key, job);
  return job;
}

/** Start making pictures for this item if it takes them and has none for this version yet. */
export function previewLater(item) {
  if (item && !item.deleted_at && !previewDone(item) && wantsPreview(item)) makePreviews(item);
}

/** Items from before page pictures (or before LibreOffice was installed): a few are drawn each time the Library is viewed. */
export function backfillPreviews(items) {
  let started = 0;
  for (const item of items) {
    if (started >= BACKFILL_PER_VIEW) break;
    if (item.deleted_at || previewDone(item) || previewing.has(`${item.id}:${item.version}`) || !wantsPreview(item)) continue;
    makePreviews(item);
    started++;
  }
  return started;
}

/** Resolves when every picture being made has been made (tests, shutdown). */
export const previewsSettled = () => Promise.allSettled([...previewing.values()]);

/** The PDF behind an item's pages: the file itself, or an office file as LibreOffice prints it (made now if needed), or null. */
async function pdfBehind(item) {
  if (item.ext === 'pdf') return readBytes(item);
  if (!OFFICE_EXTS.has(item.ext)) return null;
  if (!fs.existsSync(renderFileOf(item)) && findSoffice()) await makePreviews(item);
  try { return fs.readFileSync(renderFileOf(item)); } catch { return null; }
}

/**
 * One page of a PDF (or of an office file LibreOffice printed) as a JPEG for the model → { buffer, page, count, width,
 * height }. Throws a 400 that says why when the item has no pages to show.
 */
export async function pagePicture(item, page = 1, { signal } = {}) {
  const pdf = await pdfBehind(item);
  if (!pdf) {
    const why = OFFICE_EXTS.has(item.ext) ? 'its pages can only be drawn when LibreOffice is installed on the server (library_read gives its text)'
      : item.type === 'image' ? 'it is a picture: use view_image' : 'it has no pages';
    throw Object.assign(new Error(`“${item.title}” can’t be shown as a page: ${why}.`), { status: 400 });
  }
  return renderPdfPage(pdf, page, { ...MODEL_PICTURE, signal });
}

// ---- What the model sees of a picture (decision #201) ---------------------------------------------------------------
// A phone photo is 2–12 MB, and it went to the model as base64 in every call of a turn (a ten-step run sent it ten times)
// although providers scale it to about 1.5k px before reading it. Each version of an image gets a model copy, v<N>.model:
// at most MODEL_EDGE px on its longer side, a JPEG on white; a JPEG or PNG already that small and under MODEL_KEEP.maxBytes
// is copied as it is. It is made when the image is stored (uploads wait for it) and, for images from before, on first use
// (attached to a message, view_image, a project caption, or by the prompt for the next step). The original stays what the
// person sees and downloads.
const MODEL_KEEP = { maxEdge: MODEL_EDGE, quality: 80, maxBytes: 1048576 };
const modelFileOf = (item, v = item.version) => path.join(dirOf(item), `v${v}.model`);
const modelMaking = new Map();  // `${id}:${version}` → promise of { buffer, mime } | null
const modelUnreadable = new Set(); // versions whose picture couldn't be read: not tried again until a restart
const pictureMime = buf => (buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg');

/** An image version's model copy when it has been made → { buffer, mime }, else null. Synchronous (the prompt is). */
export function modelImageOf(item, v = item?.version) {
  if (item?.type !== 'image') return null;
  try {
    const buffer = fs.readFileSync(modelFileOf(item, v));
    return buffer.length ? { buffer, mime: pictureMime(buffer) } : null;
  } catch { return null; }
}

/** An image's model copy, made now if needed (once; callers share the work) → { buffer, mime }, or null (not an image, or
 *  a picture that can't be read). Never throws. */
export function modelImage(item) {
  const ready = modelImageOf(item);
  if (!item || item.type !== 'image' || ready) return Promise.resolve(ready);
  const key = `${item.id}:${item.version}`;
  if (modelUnreadable.has(key)) return Promise.resolve(null);
  if (modelMaking.has(key)) return modelMaking.get(key);
  const job = (async () => {
    try {
      const pic = await fitImage(readBytes(item), { ...MODEL_KEEP, mime: item.mime });
      const file = modelFileOf(item);
      fs.writeFileSync(`${file}.tmp`, pic.buffer); // whole or not at all: the prompt may read it at any moment
      fs.renameSync(`${file}.tmp`, file);
      return { buffer: pic.buffer, mime: pic.mime };
    } catch (err) {
      if (err.status === 400) modelUnreadable.add(key); // bytes that don't decode; anything else (a full disk…) is tried again
      console.warn('[library] model picture failed', item.public_id, String(err.message).split('\n')[0]);
      return null;
    }
  })().finally(() => modelMaking.delete(key));
  modelMaking.set(key, job);
  return job;
}

/** Start making an image's model copy in the background (no-op for other items and for copies already made). */
export function modelImageLater(item) {
  if (item?.type === 'image' && !item.deleted_at && !modelImageOf(item)) modelImage(item);
}

/** Resolves when every model copy being made has been made (tests, shutdown). */
export const modelImagesSettled = () => Promise.allSettled([...modelMaking.values()]);

// ---- Text read by OCR (decision #163) ---------------------------------------------------------------------------------
export const NO_TEXT_MARK = ' · no text (scanned?)';
const OCR_MARK = ' · text from OCR';

/**
 * The text OCR read from this version (services/ocr.js) becomes what search, Jess and project search read, marked as
 * OCR (it may contain errors). meta ({ pages, model, cost, at }) is kept with the version's other facts.
 */
export function setOcrText(item, text, meta = null) {
  if (!isBinary(item)) throw invalid({ id: 'Only files (PDFs and pictures) are read by OCR.' });
  fs.mkdirSync(dirOf(item), { recursive: true });
  fs.writeFileSync(textFileOf(item), String(text));
  if (meta) fs.writeFileSync(metaFileOf(item), JSON.stringify({ ...(metaOf(item) || {}), ocr: meta }));
  const d = item.description || '';
  const description = d.endsWith(NO_TEXT_MARK) ? `${d.slice(0, -NO_TEXT_MARK.length)}${OCR_MARK}` : d || null;
  run(`UPDATE library_items SET ocr_version = version, description = ?, updated_at = datetime('now') WHERE id = ?`, description, item.id);
  const fresh = getItem(item.id);
  reindex(fresh, text);
  return fresh;
}

/** Text with something to read in it: a scanned PDF's text is only its page markers ("--- page 1 ---"), which don't count. */
export const hasReadableText = text => /\S/.test(String(text || '').replace(/^--- page \d+ ---$/gm, ''));

/** The current version's text came from OCR. */
export const isOcrText = item => item.ocr_version != null && item.ocr_version === item.version;

export function versionsOf(item) {
  const out = [];
  for (let v = item.version; v >= 1; v--) {
    const f = fileOf(item, v);
    if (!fs.existsSync(f)) continue;
    const st = fs.statSync(f);
    out.push({ v, current: v === item.version, at: st.mtime.toISOString(), sizeLabel: sizeLabel(st.size) });
  }
  return out;
}

/**
 * The item a person may see. Owners can do anything; admins may VIEW anyone's items when oversight is on (like chats,
 * decisions #36, #219), never change them. `publicId` is the id used in URLs.
 */
export function itemForUser(user, publicId, { write = false, includeDeleted = false } = {}) {
  const item = get('SELECT * FROM library_items WHERE public_id = ?', String(publicId || ''));
  if (!item || (item.deleted_at && !includeDeleted)) throw notFound('That item isn’t in the library.');
  if (item.owner_id === user.id) return item;
  if (adminMayView(user) && !write) return item;
  if (adminMayView(user)) throw forbidden('You can view this item, but only its owner can change it.');
  throw notFound('That item isn’t in the library.');
}

export const ITEM_TYPES = ['html', 'md', 'doc', 'pdf', 'image', 'sheet', 'slides', 'audio'];
// Words that name a kind of file (the agent evaluation: "PDF" and "the spreadsheet" found nothing, since the type isn't text).
const TYPE_WORDS = new Map(Object.entries({ pdf: 'pdf', pdfs: 'pdf', spreadsheet: 'sheet', spreadsheets: 'sheet', sheet: 'sheet', sheets: 'sheet',
  excel: 'sheet', xlsx: 'sheet', csv: 'sheet', image: 'image', images: 'image', picture: 'image', pictures: 'image',
  photo: 'image', photos: 'image', png: 'image', jpg: 'image', jpeg: 'image', docx: 'doc', slides: 'slides', presentation: 'slides', presentations: 'slides',
  pptx: 'slides', powerpoint: 'slides', audio: 'audio', recording: 'audio', recordings: 'audio' }));

/**
 * The person's items, newest first; with `query`, best matches first (decision #207): items holding every word, then items
 * holding any of them (bm25, small words ignored: "the letter from school" finds "School trip letter"), and a word naming a
 * kind of file ("PDF", "spreadsheet") also matches every item of that kind. `type` ('pdf', ['sheet', 'doc']…) only filters.
 */
export function listItems(user, { query = '', type = null, limit = 200 } = {}) {
  const types = (Array.isArray(type) ? type : type ? [type] : []).filter(t => ITEM_TYPES.includes(t));
  const only = types.length ? ` AND i.type IN (${types.map(() => '?').join(', ')})` : '';
  const words = String(query ?? '').split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const named = [...new Set(words.map(w => TYPE_WORDS.get(w.toLowerCase())).filter(t => t && (!types.length || types.includes(t))))];
  const rest = words.filter(w => !TYPE_WORDS.has(w.toLowerCase())).join(' ');
  // A query that only names a kind ("the PDFs") has no words to require; otherwise every meaningful word (ftsAll).
  const every = named.length && !ftsAny(rest) ? '' : ftsAll(rest), any = ftsAny(query);
  if (!every && !any && !named.length) {
    return all(`SELECT i.* FROM library_items i WHERE i.owner_id = ? AND i.deleted_at IS NULL${only} ORDER BY i.updated_at DESC, i.id DESC LIMIT ?`,
      user.id, ...types, limit);
  }
  const match = q => (q ? all(`SELECT i.* FROM library_fts JOIN library_items i ON i.id = library_fts.rowid
    WHERE library_fts MATCH ? AND i.owner_id = ? AND i.deleted_at IS NULL${only} ORDER BY bm25(library_fts) LIMIT ?`, q, user.id, ...types, limit) : []);
  const ofType = named.length ? all(`SELECT i.* FROM library_items i WHERE i.owner_id = ? AND i.deleted_at IS NULL
    AND i.type IN (${named.map(() => '?').join(', ')}) ORDER BY i.updated_at DESC, i.id DESC LIMIT ?`, user.id, ...named, limit) : [];
  // Points: every word 4, any word 2, the named kind 1 (or 8 when the query only names a kind: "PDF" lists the PDFs first).
  // Equal points keep the order of the list that found the item first (bm25, or newest first).
  const ranked = new Map();
  const add = (rows, points) => rows.forEach((row, pos) => {
    const r = ranked.get(row.id);
    if (r) r.points += points; else ranked.set(row.id, { row, points, pos });
  });
  add(match(every), 4); add(match(any), 2); add(ofType, every ? 1 : 8);
  return [...ranked.values()].sort((a, b) => b.points - a.points || a.pos - b.pos).slice(0, limit).map(r => r.row);
}

// ---- Views (contracts: partials/library-card.hbs, pages/library-item.hbs) --------------------------------
export function itemView(item) {
  const base = `/library/${item.public_id}`;
  return {
    id: item.public_id, title: item.title, type: item.type, description: item.description,
    sizeLabel: sizeLabel(item.size_bytes), createdAt: toIso(item.created_at), updatedAt: toIso(item.updated_at),
    thumbUrl: item.has_thumb ? `${base}/thumb.jpg?v=${item.version}` : item.type === 'image' ? `${base}/raw` : null,
    uploaded: item.source_label === 'Uploaded', origin: originOf(item), ext: item.ext, kindLabel: KIND_LABELS[item.type] || item.type,
    proactive: !!item.proactive, sourceLabel: item.source_label, version: item.version,
    href: base, rawUrl: `${base}/raw`, downloadUrl: `${base}/download`,
    sourceHref: item.thread_id ? `/chat/${item.thread_id}` : null, ownerId: item.owner_id,
    madeFrom: item.source_item_id ? madeFrom(item.source_item_id) : null, // the page a PDF/PNG was exported from (#146)
    // Its text came from OCR (#163: a scan read by the vision model; it may contain errors), or from the file itself (null).
    textSource: isOcrText(item) ? 'ocr' : null,
    // Pictures of its first pages as printed (office files with LibreOffice installed, #162), for the viewer.
    pagePictures: pagePicturesOf(item),
  };
}

function pagePicturesOf(item) {
  if (item.preview_version !== item.version || !item.preview_pages) return [];
  return Array.from({ length: item.preview_pages }, (_, i) => `/library/${item.public_id}/pages/${i + 1}.jpg?v=${item.version}`);
}

function madeFrom(id) {
  const src = get('SELECT public_id, title FROM library_items WHERE id = ? AND deleted_at IS NULL', id);
  return src ? { id: src.public_id, title: src.title, href: `/library/${src.public_id}` } : null;
}

// The Library page's kind filters (Phase 25 #212): one chip per kind people think in; `?type=` takes a chip key or any item type
// (md opens Documents, slides opens Office), so a link can open the page filtered and a refresh keeps the filter.
export const LIBRARY_FILTERS = [
  { key: 'all', types: [], label: 'All', iconName: null }, { key: 'html', types: ['html'], label: 'Interactive', iconName: 'app-window' },
  { key: 'doc', types: ['doc', 'md'], label: 'Documents', iconName: 'file-text' }, { key: 'pdf', types: ['pdf'], label: 'PDFs', iconName: 'file' },
  { key: 'image', types: ['image'], label: 'Images', iconName: 'image' }, { key: 'sheet', types: ['sheet', 'slides'], label: 'Office', iconName: 'sheet' },
  { key: 'audio', types: ['audio'], label: 'Audio', iconName: 'headphones' },
];
export const filterOf = type => LIBRARY_FILTERS.find(f => f.key === type || f.types.includes(type)) || LIBRARY_FILTERS[0];

/** The chips for these items: [{ key, types: 'doc md', label, iconName, count, chosen, empty }] (empty: none of that kind yet,
 *  and not the one chosen). Plain: the styleguide uses it too. */
export function filtersFor(items, type = null) {
  const counts = {};
  for (const i of items) counts[i.type] = (counts[i.type] || 0) + 1;
  const active = filterOf(type);
  return LIBRARY_FILTERS.map(f => {
    const count = f.key === 'all' ? items.length : f.types.reduce((n, t) => n + (counts[t] || 0), 0);
    return { key: f.key, types: f.types.join(' ') || 'all', label: f.label, iconName: f.iconName, count, chosen: f === active,
      empty: f.key !== 'all' && !count && f !== active };
  });
}

/** → { items, counts, filters (filtersFor), filter: the chosen chip's key }. */
export function libraryData(user, { type = null } = {}) {
  const rows = listItems(user);
  backfillPreviews(rows); // older PDFs (and office files, once LibreOffice is installed) get their thumbnails a few at a time
  const items = rows.map(itemView);
  const counts = { all: items.length };
  for (const i of items) counts[i.type] = (counts[i.type] || 0) + 1;
  return { items, counts, filters: filtersFor(items, type), filter: filterOf(type).key };
}

/** Files attached to a message, in order (partials/chat/attachments.hbs). Deleted ones say so instead of vanishing. */
export function attachmentViews(json) {
  let ids = [];
  try { ids = Array.isArray(json) ? json : JSON.parse(json || '[]'); } catch { /* none */ }
  return ids.map(id => {
    const item = get('SELECT * FROM library_items WHERE public_id = ?', String(id));
    if (!item || item.deleted_at) return { id, missing: true, title: 'Removed file' };
    const v = itemView(item);
    return { id: v.id, title: v.title, type: v.type, kindLabel: v.kindLabel, sizeLabel: v.sizeLabel, href: v.href, rawUrl: v.rawUrl, ext: item.ext,
      isImage: item.type === 'image', meta: item.description };
  });
}

/** Contract for partials/chat/voice-player.hbs, for an audio item (long read-aloud, #142): { id, src, direction: 'out',
 *  durationMs, duration, peaks, transcript: '', voice, rate }. rate: the speed her voice plays at (Admin → Voice). */
export function audioView(item, { rate = 1 } = {}) {
  if (item.type !== 'audio') return null;
  const m = metaOf(item) || {};
  const ms = m.durationMs ?? Math.max(0, Math.round(((item.size_bytes - 44) / 48_000) * 1000)); // pcm16 mono 24 kHz
  const secs = Math.round(ms / 1000);
  return {
    id: `lib-${item.public_id}`, src: `/library/${item.public_id}/raw?v=${item.version}`, direction: 'out', durationMs: ms,
    duration: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, peaks: (m.peaks || []).map(p => Math.max(8, Math.round(p * 100))),
    transcript: '', voice: m.voice || null, rate,
  };
}

const KIND_LABELS = { html: 'Page', md: 'Document', pdf: 'PDF', image: 'Image', doc: 'Word document', sheet: 'Table', slides: 'Slides', audio: 'Audio' };
const fenced = (lang, body) => `${'```'}${lang}\n${body}\n${'```'}`;

export function renderedDoc(item) {
  const pictures = pagePicturesOf(item);
  const printed = pictures.length // office files LibreOffice printed (#162): the first pages as they look, above the content
    ? `<div class="lib-pages">${pictures.map((src, i) => `<figure class="lib-page"><img src="${src}" alt="Page ${i + 1}" loading="lazy"><figcaption>Page ${i + 1} of ${pictures.length}, as printed</figcaption></figure>`).join('')}</div>`
    : '';
  const doc = contentDoc(item);
  return printed ? `${printed}${doc ? `<div class="lib-pages-text"><p class="lib-pages-text-h">The text in it</p>${doc}</div>` : ''}` : doc;
}

function contentDoc(item) {
  const preview = previewOf(item);
  if (preview) return preview; // office files: tables / slide outlines built from their content (services/office.js)
  if (item.type === 'md') return renderMarkdown(['md', 'txt'].includes(item.ext) ? readContent(item) : fenced(item.ext, readContent(item)));
  if (item.type === 'doc' || item.type === 'slides') return renderMarkdown(readText(item) || '_This file has no readable text._');
  if (item.type === 'sheet') return item.ext === 'xlsx' ? renderMarkdown(readText(item)) : renderMarkdown(fenced('csv', readContent(item).slice(0, 200000)));
  return null;
}
