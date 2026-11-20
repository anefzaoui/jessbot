// PDF links in web_read (decision #135): the bytes come from the browser (read.js pdfBytes: an in-page fetch of the PDF
// the viewer shows, same origin, same guard), then the same extraction uploads use (services/uploads.js pdfText: reading
// order, right-to-left lines). Title, author and dates from the PDF's own info. A PDF with no text layer is said to be
// scanned, never guessed at. Pure (no browser) from pdfDocument() on, so tests run it on fixture files.
import path from 'node:path';
import { getDocumentProxy, getMeta } from 'unpdf';
import { pdfText } from '../../services/uploads.js';

export const PDF_MAX_BYTES = 25 * 1048576;

/** True for a PDF by its Content-Type or its first bytes (servers often say application/octet-stream). */
export const isPdf = (contentType = '', head = null) => /application\/(x-)?pdf/i.test(contentType)
  || (head != null && Buffer.from(head.subarray ? head.subarray(0, 5) : head).toString('latin1') === '%PDF-');

/** A PDF date ("D:20230115093000+01'00'") → ISO string, or null. */
export function pdfDate(v) {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(String(v || '').trim());
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz] = m;
  const zone = !tz || tz === 'Z' ? 'Z' : `${tz.slice(0, 3)}:${tz.replace(/'/g, '').slice(3, 5) || '00'}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`);
  return Number.isNaN(date.getTime()) || +y < 1980 ? null : date.toISOString();
}

// Titles that say nothing: tools write their own name or the source file's.
const JUNK_TITLE = /^(untitled|about:blank|document\d*|microsoft word|slide \d+|\s*)$/i;
const cleanTitle = t => String(t || '').replace(/^Microsoft (Word|PowerPoint|Excel) - /i, '').replace(/\.(docx?|pptx?|xlsx?|pdf)$/i, '').replace(/\s+/g, ' ').trim();

/** The file name a URL points at, without ".pdf" ("form-w9"), or null. */
export function fileNameOf(url) {
  try {
    const base = decodeURIComponent(path.posix.basename(new URL(url).pathname));
    return base ? base.replace(/\.pdf$/i, '') || null : null;
  } catch { return null; }
}

/**
 * PDF bytes → the document web_read shows: { url, title, siteName, byline, published, modified, markdown, pages,
 * contentType, pdf: { pages, emptyPages, scanned, bytes } }. markdown keeps "--- page N ---" markers so answers can
 * cite pages. Throws a plain-language error for a file that isn't a readable PDF (encrypted, broken).
 */
export async function pdfDocument(buffer, { url }) {
  let info = {};
  try {
    const proxy = await getDocumentProxy(new Uint8Array(buffer));
    info = (await getMeta(proxy)).info || {};
    await Promise.resolve(proxy.destroy?.()).catch(() => {}); // free pdf.js's worker memory when the build offers it
  } catch (err) {
    if (/password/i.test(err.message || '')) throw new Error('That PDF is password-protected, so I can’t read it.');
    throw new Error(`That PDF couldn’t be opened (${String(err.message || 'broken file').split('\n')[0]}).`);
  }
  const { pages, text } = await pdfText(buffer);
  const perPage = text.split(/^--- page \d+ ---$/m).slice(1).map(t => t.trim());
  const emptyPages = perPage.map((t, i) => (t ? null : i + 1)).filter(Boolean);
  const scanned = perPage.length > 0 && emptyPages.length === perPage.length;
  const title = [cleanTitle(info.Title)].find(t => t && !JUNK_TITLE.test(t)) || fileNameOf(url) || 'PDF document';
  let markdown;
  if (scanned) {
    markdown = `(This is a scanned PDF with no text layer: ${pages} page${pages === 1 ? '' : 's'} of images. I can’t read its words from `
      + 'the page. Saving it to the Library (web_read with save: true) keeps the file for the person.)';
  } else {
    markdown = text;
    if (emptyPages.length) markdown += `\n\n(Pages ${emptyPages.join(', ')} have no text layer — probably scanned images.)`;
  }
  return {
    url, title, siteName: (() => { try { return new URL(url).hostname; } catch { return null; } })(), byline: cleanTitle(info.Author) || null,
    published: pdfDate(info.CreationDate), modified: pdfDate(info.ModDate), markdown, contentType: 'application/pdf',
    pdf: { pages, emptyPages, scanned, bytes: buffer.length, form: !!info.IsAcroFormPresent },
  };
}
