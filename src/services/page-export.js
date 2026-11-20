// A Library page as a print-ready PDF or a PNG (decision #146): invitations, posters, menus, cards, charts. The page is
// rendered exactly as the viewer shows it (services/page-check.js openArtifact: the artifact sandbox CSP, the same three
// CDNs, no network APIs, the local network blocked by the browser's guard), laid out in the chosen frame, and then
//   PDF: printed at that paper size once its fonts have loaded (services/print.js), backgrounds on, no extra margin
//        (the page's own padding is its margin; a page may set its own with @page);
//   PNG: A4 / A5 / Letter as the whole page at the paper's width (as tall as the content), drawn at 2 pixels per CSS pixel
//        so it prints sharp (A4: 1588 px wide, about 190 dpi); square (1080×1080) and story (1080×1920) exactly that frame at
//        1× (social sites want those exact pixel sizes), with a note when content runs past the frame.
// The bundled OFL fonts (services/fonts.js: Noto Sans, Noto Serif, Noto Naskh Arabic) are added to the page as data:
// @font-face rules, allowed by the CSP's font-src data:, so a page that names them prints the same on any host.
import { withPage } from '../browser/index.js';
import { documentFontCss } from './fonts.js';
import { PAGE_SIZES, frameOf, pdfOptions, fontsReady } from './print.js';
import { openArtifact, readIssues } from './page-check.js';

export const EXPORT_FORMATS = ['pdf', 'png'];
export const EXPORT_SIZES = Object.keys(PAGE_SIZES);

/** The page with the bundled fonts and colour-exact printing added at the top of its <head> (its own styles still win). */
export function exportHtml(html) {
  // One line, so the page's own line numbers (in error reports) stay as they are in the file.
  const inject = `<style data-jessbot-export>${documentFontCss().replace(/\n/g, '')}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>`;
  const s = String(html);
  const head = /<head(\s[^>]*)?>/i.exec(s);
  if (head) return s.slice(0, head.index + head[0].length) + inject + s.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(s);
  if (root) return `${s.slice(0, root.index + root[0].length)}<head>${inject}</head>${s.slice(root.index + root[0].length)}`;
  return `<!doctype html><html><head>${inject}</head><body>${s}</body></html>`;
}

/** Pixels per CSS pixel of a PNG export: 2 for paper sizes (print quality), 1 for the fixed social frames (exact size). */
export const pngScale = size => (PAGE_SIZES[size]?.frame ? 1 : 2);

/** Checked export options → { format, size, landscape } (throws 400 with the choices). */
export function exportOptions({ format, size, landscape } = {}) {
  const f = String(format || '').toLowerCase();
  if (!EXPORT_FORMATS.includes(f)) throw Object.assign(new Error(`format must be pdf or png, not “${format}”.`), { status: 400 });
  const s = size == null || size === '' ? (f === 'png' ? 'square' : 'A4') : String(size);
  const key = EXPORT_SIZES.find(k => k.toLowerCase() === s.toLowerCase());
  if (!key) throw Object.assign(new Error(`size must be one of ${EXPORT_SIZES.join(', ')}, not “${size}”.`), { status: 400 });
  return { format: f, size: key, landscape: !!landscape };
}

/**
 * Render a Library page to PDF or PNG bytes.
 * → { buffer, mime, ext, frame: [w, h], issues (what went wrong while it ran: page-check.js problemsOf reads them), overflow:
 *   px past a fixed frame (PNG), scale: pixels per CSS pixel (PNG) }.
 */
export async function exportPage(html, { format, size, landscape, csp, signal } = {}) {
  const o = exportOptions({ format, size, landscape });
  const [width, height] = frameOf(o.size, o.landscape);
  return withPage(async page => {
    const issues = await openArtifact(page, exportHtml(html), { csp, timeout: 20000 });
    await fontsReady(page);
    await new Promise(r => setTimeout(r, 400)); // entrance animations settle before the capture
    await readIssues(page, issues);
    if (o.format === 'pdf') {
      const buffer = await page.pdf(pdfOptions({ size: o.size, landscape: o.landscape }));
      return { buffer, mime: 'application/pdf', ext: 'pdf', frame: [width, height], issues, overflow: 0 };
    }
    const fixed = !!PAGE_SIZES[o.size].frame;
    const tall = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
    const buffer = await page.screenshot({ type: 'png', fullPage: !fixed });
    return { buffer, mime: 'image/png', ext: 'png', frame: [width, height], issues, overflow: fixed ? Math.max(0, tall - height) : 0, scale: pngScale(o.size) };
  }, { signal, media: true, render: true, viewport: { width, height }, deviceScaleFactor: o.format === 'png' ? pngScale(o.size) : undefined });
}
