// PDF pages as pictures (Phase 22, decision #161): the Library's PDF thumbnails, the page Jess looks at to check a form
// she filled (pdf_page_image), the pages OCR reads (services/ocr.js) and the real previews of office files LibreOffice
// turned into a PDF (services/office-render.js). Mozilla's pdf.js (pdfjs-dist, Apache-2.0) draws each page on an
// @napi-rs/canvas canvas (MIT; prebuilt binaries for Windows, macOS and Linux, x64 and arm64), so no browser is needed.
//
// The pdf.js is the server's one copy (lib/pdfjs.js): it reads the standard fonts (the Liberation and Foxit faces it
// ships, so a form that doesn't embed Helvetica still draws in the right face), character maps and its image decoders
// (JPEG 2000, JBIG2: common in scans) from disk.
//
// pdf.js renders on this thread in short slices chained by microtasks, so a page holds the event loop while it draws
// (≈50–300 ms at these sizes); callers render a few pages at a time and we yield between pages. Encoding (JPEG/PNG) runs
// off the thread in the canvas library.
import { openPdf as openDocument } from '../lib/pdfjs.js';

let canvas = null;
const loadCanvas = async () => (canvas ||= await import('@napi-rs/canvas'));
const tick = () => new Promise(r => setImmediate(r));
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

async function openPdf(buffer) {
  await loadCanvas(); // (pdf.js draws on its canvases)
  try {
    return await openDocument(buffer);
  } catch (err) {
    if (err?.name === 'PasswordException') throw bad('That PDF is password-protected, so its pages can’t be shown. Ask them for an unlocked copy.');
    throw bad(`That PDF couldn’t be opened (${String(err?.message || err).split('\n')[0].slice(0, 120)}).`);
  }
}

/** How many pages a PDF has (throws a 400 for one that can't be opened). */
export async function pdfPageCount(buffer) {
  const pdf = await openPdf(buffer);
  try { return pdf.numPages; } finally { await pdf.loadingTask.destroy(); }
}

/**
 * Render pages of a PDF → { pages: [{ page, buffer, width, height, points: [w, h] (the page's size in PDF points) }], count }.
 * pages: 1-based numbers (out-of-range ones are skipped); width: target pixel width of each picture; maxEdge caps the
 * longer side (a very tall or wide page is scaled down to fit); format 'jpeg' (quality 0–100) or 'png'. White background.
 */
export async function renderPdfPages(buffer, pages = [1], { width = 1000, maxEdge = 1600, format = 'jpeg', quality = 78, signal } = {}) {
  const pdf = await openPdf(buffer);
  const { createCanvas } = await loadCanvas();
  const out = [];
  try {
    for (const n of pages) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      if (!Number.isInteger(n) || n < 1 || n > pdf.numPages) continue;
      const page = await pdf.getPage(n);
      try {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(width / base.width, maxEdge / Math.max(base.width, base.height)) });
        const c = createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff'; // pages without a background of their own are white on paper, not transparent
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvas: c, canvasContext: ctx, viewport }).promise;
        const bytes = format === 'png' ? await c.encode('png') : await c.encode('jpeg', quality);
        out.push({ page: n, buffer: Buffer.from(bytes), width: c.width, height: c.height, points: [base.width, base.height] });
      } finally {
        page.cleanup();
      }
      await tick(); // let requests through between pages
    }
    return { pages: out, count: pdf.numPages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** One page as a picture → { page, buffer, width, height, count } (a 400 naming the page count when it doesn't exist). */
export async function renderPdfPage(buffer, page = 1, opts = {}) {
  const { pages, count } = await renderPdfPages(buffer, [page], opts);
  if (!pages.length) throw bad(`There is no page ${page}: it has ${count} page${count === 1 ? '' : 's'}.`);
  return { ...pages[0], count };
}

// The longest side of any picture sent to the model (decision #201): Anthropic scales anything larger down to this before
// reading it, OpenAI and Gemini tile or scale at about the same size, so extra pixels are only bytes on every call.
export const MODEL_EDGE = 1568;

/**
 * A picture (PNG, JPEG, WebP, GIF) with its longer side at most maxEdge → { buffer, width, height, mime }. One that is
 * already small enough, PNG or JPEG, and under maxBytes is returned as it is; anything else becomes a JPEG on white.
 */
export async function fitImage(buffer, { maxEdge = 1600, quality = 80, maxBytes = 4 * 1048576, mime = '' } = {}) {
  const { loadImage, createCanvas } = await loadCanvas();
  const img = await loadImage(buffer).catch(() => { throw bad('That picture couldn’t be read.'); });
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  if (scale === 1 && buffer.length <= maxBytes && /^image\/(png|jpeg)$/.test(mime)) return { buffer, width: img.width, height: img.height, mime };
  const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { buffer: Buffer.from(await c.encode('jpeg', quality)), width: w, height: h, mime: 'image/jpeg' };
}

/** The spread (standard deviation, 0–255) of a picture's brightness on a small grid: near 0 is a blank page. */
export async function brightnessSpread(buffer) {
  const { loadImage, createCanvas } = await loadCanvas();
  const img = await loadImage(buffer);
  const w = 64, h = Math.max(1, Math.round((img.height / img.width) * 64));
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  let sum = 0, sq = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += y; sq += y * y;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}
