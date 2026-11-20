// Printing HTML to a PDF with our own browser (decision #133). make_pdf's HTML is served from a reserved .invalid address
// with a CSP that lets it load nothing but inline styles and data: fonts and images. It is the app's only printing path
// (browser/read.js's old renderHtmlPdf is gone), and it waits for the page's fonts before printing: the bundled fonts are data: URIs that decode
// asynchronously, and printing while a face is still loading silently drops that text from the PDF (seen in testing:
// whole paragraphs missing in one run out of two). Library pages printed by library_export (services/page-export.js,
// decision #146) share the same wait and the page sizes below.
import { withPage } from '../browser/index.js';

const PRINT_URL = 'https://print.jessbot.invalid/';
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

// Paper and picture sizes: `format` is Chromium's paper name; `px` the CSS-pixel frame (96 px per inch) a page is laid
// out in before it is printed or captured. square and story are social-media frames (1080×1080, 1080×1920 pixels).
export const PAGE_SIZES = {
  A4: { label: 'A4', format: 'A4', px: [794, 1123] },
  A5: { label: 'A5', format: 'A5', px: [559, 794] },
  Letter: { label: 'Letter', format: 'Letter', px: [816, 1056] },
  square: { label: 'square', width: '1080px', height: '1080px', px: [1080, 1080], frame: true },
  story: { label: 'story', width: '1080px', height: '1920px', px: [1080, 1920], frame: true },
};

/** The CSS-pixel frame of a size, turned when landscape: [width, height]. */
export function frameOf(size = 'A4', landscape = false) {
  const s = PAGE_SIZES[size] || PAGE_SIZES.A4;
  return landscape ? [s.px[1], s.px[0]] : [...s.px];
}

/** page.pdf options for a size. margin: CSS lengths (default none: the page's own padding is its margin). */
export function pdfOptions({ size = 'A4', landscape = false, footer, margin } = {}) {
  const s = PAGE_SIZES[size] || PAGE_SIZES.A4;
  const m = margin || { top: '0', bottom: '0', left: '0', right: '0' };
  return {
    ...(s.format ? { format: s.format, landscape: !!landscape } : { width: landscape ? s.height : s.width, height: landscape ? s.width : s.height }),
    printBackground: true, displayHeaderFooter: !!footer, headerTemplate: '<span></span>', footerTemplate: footer || '<span></span>', margin: m,
  };
}

/** Resolves once the page's fonts have loaded (at most 8 s). Evaluated through DevTools, so the page's CSP doesn't apply. */
export const fontsReady = page => page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 8000))]).then(() => true));

/** html → PDF bytes. page: 'A4' | 'Letter'; footer: a Chromium footer template (pageNumber / totalPages spans). */
export async function printPdf(html, { page: paper = 'A4', footer, signal } = {}) {
  return withPage(async page => {
    await page.route(PRINT_URL, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html, headers: { 'Content-Security-Policy': CSP } }));
    await page.goto(PRINT_URL, { waitUntil: 'load', timeout: 20000 });
    await fontsReady(page);
    return page.pdf(pdfOptions({ size: paper === 'Letter' ? 'Letter' : 'A4', footer, margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' } }));
  }, { signal, media: true });
}
