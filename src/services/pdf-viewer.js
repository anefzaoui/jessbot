// What the Library viewer needs to know about a PDF beyond its row (Phase 25, decision #175): whether the file asks the
// viewer app to draw its form answers (AcroForm NeedAppearances). pdf_fill_form leaves Arabic and mixed-script answers
// that way so they are shaped right (decision #134), but a viewer that ignores the flag (some phone previews) shows those
// boxes empty, so the page says so and offers the fix. Read from the file itself, so an uploaded PDF that asks for it is
// covered too; cached per item version (a new version is a new key).
import fs from 'node:fs';
import { PDFDocument, PDFName, PDFDict } from '@cantoo/pdf-lib';
import { fileOf } from './library.js';
import { openRead } from '../lib/safe-path.js';

const MAX_BYTES = 25e6; // bigger files aren't opened just for this
const CACHE_MAX = 500;
const cache = new Map();

/** Does this PDF's form ask the viewer to draw its answers? false for anything else, unreadable or oversized. */
export async function viewerDrawsAnswers(item) {
  if (item?.type !== 'pdf') return false;
  const key = `${item.id}:${item.version}`;
  if (cache.has(key)) return cache.get(key);
  let on = false;
  try {
    const file = fileOf(item, item.version);
    const f = openRead(file);
    if (f.stat.size > MAX_BYTES) f.close();
    else {
      const doc = await PDFDocument.load(f.read(), { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
      const form = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
      on = String(form?.get(PDFName.of('NeedAppearances')) ?? '') === 'true';
    }
  } catch { on = false; }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, on);
  return on;
}
