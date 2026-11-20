// One pdf.js for the whole server (decision #161): Mozilla's pdfjs-dist, its Node "legacy" build, with its in-process
// worker. Every PDF reader here goes through it: text extraction (services/uploads.js, services/pdf.js), page pictures
// (services/pdf-render.js), and unpdf, which the web reader uses (browser/site-readers/pdf.js) and which is pointed at
// this same build below instead of its bundled copy.
//
// Why it must be one: pdf.js runs its "worker" in-process in Node and finds it through a global
// (globalThis.pdfjsWorker). unpdf's bundled pdf.js (6.1.x) and pdfjs-dist (6.2.x) each set that global, and whichever
// set it last served both, so a PDF opened by the other failed ("The API version … does not match the Worker version …",
// seen in the test suite the moment both were in one process). This module is imported before any PDF is read (it is
// in the static import graph of the Library), sets the worker global to pdfjs-dist's own and makes unpdf use pdfjs-dist,
// so unpdf's bundle is never loaded.
//
// Why pdfjs-dist and not unpdf's bundle: in Node, unpdf hands pdf.js its data folders as file:// URLs that its bundle
// can't read, so fonts a PDF doesn't embed (Helvetica, Times: most generated forms) were drawn with a wrong face and
// character maps (CJK text without a Unicode map) couldn't load. openPdf passes them as the paths pdf.js reads in Node.
import path from 'node:path';
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { definePDFJSModule } from 'unpdf';

globalThis.pdfjsWorker = { WorkerMessageHandler }; // (importing the worker sets it too; said here so the intent is visible)
await definePDFJSModule(() => pdfjs);

const require = createRequire(import.meta.url);
// pdf.js wants these as paths ending in "/" (forward slashes work on Windows too).
const DIR = path.dirname(require.resolve('pdfjs-dist/package.json')).replace(/\\/g, '/');
export const PDF_DATA = { standardFontDataUrl: `${DIR}/standard_fonts/`, cMapUrl: `${DIR}/cmaps/`, cMapPacked: true, wasmUrl: `${DIR}/wasm/` };
export const PDFJS_VERSION = pdfjs.version;

/**
 * Open a PDF → pdf.js's PDFDocumentProxy (call `await pdf.loadingTask.destroy()` when done). The standard fonts,
 * character maps and image decoders come from pdfjs-dist on disk; no system fonts, no eval.
 */
export async function openPdf(buffer, options = {}) {
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), ...PDF_DATA, useSystemFonts: false, isEvalSupported: false, verbosity: 0, ...options });
  try {
    return await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    throw err;
  }
}

/** Open a PDF, run fn(pdf) and always close it again → what fn returns. */
export async function withPdf(buffer, fn, options) {
  const pdf = await openPdf(buffer, options);
  try { return await fn(pdf); } finally { await pdf.loadingTask.destroy(); }
}
