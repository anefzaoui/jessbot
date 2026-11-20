// PDF forms and merging (Phase 11, decision #82; Phase 22, decision #134) with @cantoo/pdf-lib (the maintained pdf-lib
// fork, MIT). Reading and making PDFs live in uploads.js (pdf.js text) and office.js (the browser prints HTML); this is
// the in-place work: what fields a form has and what each one is for, filling them (optionally flattened so they can't
// be changed), writing onto flat or scanned forms, and joining / picking pages.
//
// Real forms name their fields "Text12" or "Check Box 7", so each field comes with its page, rectangle, tooltip, max
// length, checkbox value and the printed label nearest to it (left, right or above, from the page's text layer via
// pdf.js, lib/pdfjs.js). Answers are drawn with bundled Unicode fonts (fonts.js), never the 14 standard PDF fonts that only know
// Western European letters. pdf-lib draws a field's look without shaping offsets, so an Arabic answer (or one mixing
// scripts no single font covers) is left in the field for the viewer to draw (NeedAppearances, not flattened); for a
// final flattened copy it is written onto the page with our own fontkit layout instead, which places every glyph.
import { PDFDocument, PDFName, PDFBool, PDFString, PDFHexString, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList,
  TextAlignment, rgb, pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix, showText, setFillingRgbColor } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import { withPdf } from '../lib/pdfjs.js';
import { pdfLibFonts } from './fonts.js';
import { lineText } from './uploads.js';
import { textDir } from '../../public/js/bidi.js';

const typeOf = f => (f instanceof PDFTextField ? 'text' : f instanceof PDFCheckBox ? 'checkbox' : f instanceof PDFDropdown ? 'dropdown'
  : f instanceof PDFRadioGroup ? 'radio' : f instanceof PDFOptionList ? 'list' : 'other');
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const RTL_CHARS = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const round = n => Math.round(n * 10) / 10;

async function load(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  if (doc.isEncrypted) throw bad('That PDF is password-protected, so it can’t be filled or written on. Ask them for an unlocked copy.');
  return doc;
}

// ---- The text layer: lines of words with positions, split where a gap leaves room for an answer ---------------------
/**
 * Per page: { page (1-based), width, height, segments: [{ text, x, y, x2, size, rtl }] }. Coordinates are PDF points from
 * the page's bottom-left, the same space pdf-lib uses for fields and drawing. y is the text baseline.
 */
export async function pageText(buffer) {
  return withPdf(buffer, async pdf => {
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const [x0, y0, x1, y1] = page.view;
      const items = (await page.getTextContent()).items.filter(it => it.str)
        .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, size: Math.hypot(it.transform[2], it.transform[3]) || it.height || 10, rtl: it.dir === 'rtl' }));
      // Lines: same baseline (within a third of the text size), left to right.
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = [];
      for (const it of items) {
        const line = lines.find(l => Math.abs(l.y - it.y) <= Math.max(2, it.size / 3));
        (line ? line.items : lines[lines.push({ y: it.y, items: [] }) - 1].items).push(it);
      }
      const segments = [];
      for (const line of lines) {
        line.items.sort((a, b) => a.x - b.x);
        let seg = null;
        for (const it of line.items) {
          if (seg && it.x - seg.x2 <= Math.max(seg.size, it.size) * 1.2) { seg.parts.push(it); seg.x2 = Math.max(seg.x2, it.x + it.w); seg.size = Math.max(seg.size, it.size); continue; }
          seg = { parts: [it], x: it.x, x2: it.x + it.w, y: line.y, size: it.size };
          segments.push(seg);
        }
      }
      for (const s of segments) {
        const words = s.parts.filter(it => it.str.trim());
        s.rtl = words.filter(it => it.rtl).length > words.length / 2;
        // Right-to-left pieces come in visual order: uploads.js lineText puts them back in reading order (and plain letters).
        s.text = (s.parts.some(it => it.rtl) ? lineText(s.parts.map(it => ({ str: it.str, dir: it.rtl ? 'rtl' : 'ltr', x: it.x })))
          : s.parts.reduce((t, it, i) => { const prev = s.parts[i - 1]; const gap = prev ? it.x - (prev.x + prev.w) : 0; return t + (prev && gap > it.size * 0.2 && !/\s$/.test(t) && !/^\s/.test(it.str) ? ' ' : '') + it.str; }, ''))
          .replace(/\s+/g, ' ').trim();
        s.x = round(s.x); s.x2 = round(s.x2); s.y = round(s.y); s.size = round(s.size);
        delete s.parts;
      }
      pages.push({ page: p, width: round(x1 - x0), height: round(y1 - y0), segments: segments.filter(x => x.text) });
    }
    return pages;
  });
}

// The printed label a field belongs to: the nearest words on its line (left, or right — Arabic forms and checkboxes put
// labels there) or just above it. Fill-in lines ("_____", ".....") and text inside the field don't count.
function nearestLabel(segments, r, { box = false } = {}) {
  let best = null;
  const top = r.y + r.height, mid = r.y + r.height / 2;
  for (const s of segments) {
    const text = s.text.replace(/[_.…]{2,}/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/\p{L}/u.test(text)) continue;
    if (s.x >= r.x - 1 && s.x2 <= r.x + r.width + 1 && s.y >= r.y - 1 && s.y <= top + 1) continue; // inside the field
    const center = s.y + s.size * 0.35;
    const sameLine = center >= r.y - s.size * 0.6 && center <= top + s.size * 0.6;
    let score = null;
    if (sameLine && s.x2 <= r.x + 2) score = (r.x - s.x2) * (s.rtl ? 1.5 : 1);
    else if (sameLine && s.x >= r.x + r.width - 2) score = (s.x - (r.x + r.width)) * (s.rtl || box ? 1 : 1.6);
    else if (s.y >= top - 2 && s.y - top <= 28 && s.x < r.x + r.width + 10 && s.x2 > r.x - 10) score = (s.y - top) * 1.2 + 4;
    if (score == null || score > 220) continue;
    if (!best || score < best.score) best = { score, text };
  }
  return best ? best.text.replace(/\s*[:：]\s*$/, '').slice(0, 100) : null;
}

const decode = v => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null);

/**
 * The form's fields, by page then top to bottom: [{ name, type, value, options?, page, rect: { x, y, width, height }, label?,
 * tooltip?, maxLength?, exportValue?, required?, readOnly? }] (empty when the PDF isn't a fillable form).
 */
export async function pdfFormFields(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const fields = doc.getForm().getFields();
  if (!fields.length) return [];
  const pageOfRef = new Map();
  doc.getPages().forEach((p, i) => { for (const ref of p.node.Annots()?.asArray() || []) pageOfRef.set(String(ref), i); });
  let text = [];
  try { text = await pageText(buffer); } catch { /* no text layer: fields without labels */ }
  const out = fields.map(f => {
    const type = typeOf(f);
    const o = { name: f.getName(), type };
    try {
      if (type === 'text') { o.value = f.getText() || ''; const max = f.getMaxLength(); if (max) o.maxLength = max; }
      else if (type === 'checkbox') o.value = f.isChecked();
      else if (type === 'dropdown' || type === 'list') { o.value = f.getSelected(); o.options = f.getOptions(); }
      else if (type === 'radio') { o.value = f.getSelected() || null; o.options = f.getOptions(); }
    } catch { /* unreadable field */ }
    const tooltip = decode(f.acroField.dict.lookup(PDFName.of('TU')));
    if (tooltip && tooltip.trim() && tooltip.trim() !== o.name) o.tooltip = tooltip.trim().slice(0, 160);
    if (f.isRequired?.()) o.required = true;
    if (f.isReadOnly?.()) o.readOnly = true;
    const widget = f.acroField.getWidgets()[0];
    if (widget) {
      if (type === 'checkbox') { const on = widget.getOnValue(); if (on) o.exportValue = on.decodeText(); }
      const r = widget.getRectangle();
      const ref = doc.context.getObjectRef(widget.dict);
      let index = ref ? pageOfRef.get(String(ref)) : undefined;
      if (index === undefined) { const p = widget.P(); index = p ? doc.getPages().findIndex(pg => pg.ref === p) : -1; }
      if (index >= 0) {
        o.page = index + 1;
        o.rect = { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
        const label = nearestLabel(text[index]?.segments || [], o.rect, { box: type === 'checkbox' || type === 'radio' });
        if (label) o.label = label;
      }
    }
    return o;
  });
  return out.sort((a, b) => (a.page || 1e9) - (b.page || 1e9) || (b.rect ? b.rect.y + b.rect.height : 0) - (a.rect ? a.rect.y + a.rect.height : 0) || (a.rect?.x || 0) - (b.rect?.x || 0));
}

// ---- Unicode fonts for pdf-lib ------------------------------------------------------------------------------------
// One embedded font per bundled subset, made on demand for this document, plus the same file opened with fontkit for
// shaping: pdf-lib's own drawText lays text out with fontkit but ignores the glyph offsets shaping produces, which
// puts Arabic dots and marks in the wrong place, so shaped runs are drawn glyph by glyph at fontkit's positions.
const fkFonts = new Map();
const fkFont = file => { if (!fkFonts.has(file.id)) fkFonts.set(file.id, fontkit.create(Buffer.from(file.bytes))); return fkFonts.get(file.id); };
function fontSet(doc) {
  doc.registerFontkit(fontkit);
  const cache = new Map();
  const files = pdfLibFonts();
  const get = async f => { if (!cache.has(f.id)) cache.set(f.id, doc.embedFont(f.bytes, { subset: true })); return cache.get(f.id); };
  const covering = text => files.find(f => [...text].every(ch => /\s/.test(ch) || f.test(ch.codePointAt(0))));
  return {
    /** The font that can draw all of `text`, or null. */
    for: async text => { const f = covering(text); return f ? get(f) : null; },
    /** `text` in runs by the first font with each character's glyph: [{ text, font, fk, rtl }]. Unknown characters → '?'. */
    runs: async text => {
      const out = [];
      for (const ch of text) {
        const known = files.find(x => x.test(ch.codePointAt(0)));
        const last = out.at(-1);
        if (/\s/.test(ch) && last) { last.text += ch; continue; }
        const f = known || files[0], c = known ? ch : '?';
        if (last && last.file === f) last.text += c; else out.push({ text: c, file: f });
      }
      for (const r of out) { r.font = await get(r.file); r.fk = fkFont(r.file); r.rtl = RTL_CHARS.test(r.text); delete r.file; }
      return out;
    },
  };
}

// A run laid out by fontkit: its width in points and how to draw it at (x, y). The glyph ids come from the embedded
// font's encodeText (which also puts them in the subset), in the same order as fontkit's glyphs.
function shaped(page, run, size) {
  const layout = run.fk.layout(run.text);
  const scale = size / run.fk.unitsPerEm;
  const width = layout.positions.reduce((w, p) => w + p.xAdvance, 0) * scale;
  const draw = (x, y, color) => {
    const hex = run.font.encodeText(run.text).asString();
    const ids = hex.match(/.{4}/g) || [];
    if (ids.length !== layout.glyphs.length) { page.drawText(run.text, { x, y, size, font: run.font, color }); return; } // (never seen; the plain way is still legible)
    const key = page.node.newFontDictionary(run.font.name, run.font.ref);
    const ops = [pushGraphicsState(), beginText(), setFontAndSize(key, size), setFillingRgbColor(color.red, color.green, color.blue)];
    let pen = x;
    layout.positions.forEach((p, i) => {
      ops.push(setTextMatrix(1, 0, 0, 1, pen + p.xOffset * scale, y + p.yOffset * scale), showText(PDFHexString.of(ids[i])));
      pen += p.xAdvance * scale;
    });
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
  };
  return { width, draw };
}

/**
 * One line of text at (x, y) (the baseline): split into runs by font, laid out right to left when the line reads that way,
 * each run shaped and placed by fontkit. align 'right' makes x the right end (the default for a right-to-left line).
 * → the drawn line's left and right edges.
 */
async function drawLine(page, fonts, line, { x, y, size, align }) {
  const rtl = textDir(line) === 'rtl';
  const runs = await fonts.runs(line);
  // A space between runs belongs between them in reading order: a run set against the line's direction keeps its
  // trailing space on the far side (fontkit reverses right-to-left runs; left-to-right runs stay as they are).
  for (const r of runs) if (r.rtl !== rtl) { const m = /\s+$/.exec(r.text); if (m) r.text = m[0] + r.text.slice(0, m.index); }
  const visual = (rtl ? [...runs].reverse() : runs).map(r => shaped(page, r, size));
  const total = visual.reduce((a, r) => a + r.width, 0);
  const left = (align ? align === 'right' : rtl) ? x - total : x;
  let cx = left;
  for (const r of visual) { r.draw(cx, y, rgb(0, 0, 0)); cx += r.width; }
  return { left, right: left + total };
}

// A field's text size: the one its default appearance asks for, or one that fits its box (auto size 0 → fit).
const fieldSize = (field, rect) => {
  const da = field.acroField.getDefaultAppearance() || '';
  const set = Number(/([\d.]+)\s+Tf/.exec(da)?.[1]);
  return Math.max(6, Math.min(set > 0 ? set : 11, rect.height * 0.7));
};

/**
 * Fill fields by name → { buffer, filled, missing, problems, viewerDrawn, drawnOnPage, flattened }. Checkboxes take
 * true/false ("yes"/"no"), choices must match an option.
 * Each answer's look is drawn with the bundled font that has all its letters. An answer that needs shaping (Arabic) or
 * mixes scripts no single font covers stays in the field for the viewer to draw (AcroForm NeedAppearances; viewerDrawn
 * lists them): pdf-lib's field drawing ignores shaping offsets, so it would misplace Arabic dots.
 * flatten: bake the answers into the page (no longer editable) for a final copy to send; those viewer-drawn answers are
 * then written onto the page with the same shaping as pdf_write_text (drawnOnPage), so the final copy reads right in
 * every viewer.
 */
export async function fillPdfForm(buffer, values, { flatten = false } = {}) {
  const doc = await load(buffer);
  const form = doc.getForm();
  const fonts = fontSet(doc);
  const byName = new Map(form.getFields().map(f => [f.getName(), f]));
  const filled = [], missing = [], problems = [], viewerDrawn = [], later = [];
  for (const [name, raw] of Object.entries(values || {})) {
    const f = byName.get(name);
    if (!f) { missing.push(name); continue; }
    try {
      const type = typeOf(f);
      let shown = null;
      if (type === 'text') { shown = raw == null ? '' : String(raw); f.setText(shown); }
      else if (type === 'checkbox') { (raw === true || /^(true|yes|on|1|x|✓)$/i.test(String(raw)) ? f.check() : f.uncheck()); f.updateAppearances(); }
      else if (type === 'dropdown' || type === 'list' || type === 'radio') {
        const want = String(raw);
        const option = f.getOptions().find(o => o === want) || f.getOptions().find(o => o.toLowerCase() === want.toLowerCase());
        if (!option) { problems.push(`${name}: “${want}” isn’t one of ${f.getOptions().join(', ')}`); continue; }
        f.select(option);
        if (type === 'radio') f.updateAppearances(); else shown = option;
      } else { problems.push(`${name}: unsupported field type`); continue; }
      if (shown != null) {
        const font = shown === '' ? await fonts.for('a') : await fonts.for(shown);
        if (font && !RTL_CHARS.test(shown)) f.updateAppearances(font);
        else {
          viewerDrawn.push(name);
          if (RTL_CHARS.test(shown) && type === 'text') f.setAlignment(TextAlignment.Right);
          later.push({ field: f, text: shown, rtl: RTL_CHARS.test(shown) });
        }
      }
      filled.push(name);
    } catch (err) { problems.push(`${name}: ${err.message}`); }
  }
  const drawnOnPage = [];
  if (flatten) {
    // Widgets and pages first (flattening removes the fields), then flatten, then write the viewer-drawn answers.
    const pages = doc.getPages();
    const spots = later.flatMap(({ field, text, rtl }) => field.acroField.getWidgets().slice(0, 1).map(w => {
      const p = w.P(); const index = p ? pages.findIndex(pg => pg.ref === p) : pages.findIndex(pg => (pg.node.Annots()?.asArray() || []).some(ref => doc.context.lookup(ref) === w.dict));
      return { name: field.getName(), text, rtl, rect: w.getRectangle(), page: pages[index], size: fieldSize(field, w.getRectangle()) };
    }));
    form.flatten({ updateFieldAppearances: false });
    for (const s of spots) {
      if (!s.page) { problems.push(`${s.name}: couldn’t find its page to write the answer on`); continue; }
      const y = s.rect.y + (s.rect.height - s.size * 0.72) / 2;
      await drawLine(s.page, fonts, s.text.replace(/\s*\n\s*/g, ' '), { x: s.rtl ? s.rect.x + s.rect.width - 2 : s.rect.x + 2, y, size: s.size, align: s.rtl ? 'right' : 'left' });
      drawnOnPage.push(s.name);
    }
  } else if (viewerDrawn.length) form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  return { buffer: Buffer.from(await doc.save({ updateFieldAppearances: false })), filled, missing, problems,
    viewerDrawn: flatten ? [] : viewerDrawn, drawnOnPage, flattened: !!flatten };
}

// ---- Writing onto a page (flat or scanned forms) --------------------------------------------------------------------
/**
 * Draw answers onto pages of a copy → { buffer, placed, problems }. items: [{ page (1-based), x, y (points from the
 * bottom-left: the text baseline), text?, tick?, size? (default 10), align?: 'left'|'right' }]. Text is split into runs
 * by which bundled font has the letters; a right-to-left line is laid out right to left (Arabic shaped by fontkit), and
 * aligns to x as its right end unless align says otherwise. "\n" starts a new line below. tick draws a check mark in a
 * size-point box whose bottom-left is x, y.
 */
export async function writeOnPdf(buffer, items) {
  const doc = await load(buffer);
  const fonts = fontSet(doc);
  const pages = doc.getPages();
  const placed = [], problems = [];
  for (const [k, it] of (items || []).entries()) {
    const n = k + 1;
    const page = pages[Number(it.page) - 1];
    if (!page) { problems.push(`item ${n}: there is no page ${it.page} (the file has ${pages.length})`); continue; }
    const { width, height } = page.getSize();
    const x = Number(it.x), y = Number(it.y), size = Math.min(48, Math.max(5, Number(it.size) || 10));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) {
      problems.push(`item ${n}: (${it.x}, ${it.y}) is off page ${it.page}, which is ${round(width)} × ${round(height)} points`); continue;
    }
    const lines = String(it.text || '').split(/\r?\n/);
    if (!it.tick && !lines.some(l => l.trim())) { problems.push(`item ${n}: nothing to write`); continue; }
    if (it.tick) {
      const t = Math.max(1, size / 7), black = rgb(0, 0, 0);
      page.drawLine({ start: { x: x + size * 0.1, y: y + size * 0.5 }, end: { x: x + size * 0.4, y: y + size * 0.15 }, thickness: t, color: black });
      page.drawLine({ start: { x: x + size * 0.4, y: y + size * 0.15 }, end: { x: x + size * 0.95, y: y + size * 0.9 }, thickness: t, color: black });
    }
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      const edge = await drawLine(page, fonts, line, { x, y: y - i * size * 1.25, size, align: it.align });
      if (edge.right > width + 1 || edge.left < -1) problems.push(`item ${n}: “${line.slice(0, 40)}” runs off the edge of page ${it.page}`);
    }
    placed.push({ page: Number(it.page), x, y, ...(it.tick ? { tick: true } : {}), ...(lines.some(l => l.trim()) ? { text: String(it.text) } : {}) });
  }
  return { buffer: Buffer.from(await doc.save({ updateFieldAppearances: false })), placed, problems };
}

// "1-3, 5, 8-" → zero-based page indexes within count.
export function pageList(spec, count) {
  if (!spec || !String(spec).trim()) return [...Array(count).keys()];
  const out = [];
  for (const part of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!m) throw Object.assign(new Error(`“${part}” isn’t a page range (like 1-3, 5, 8-).`), { status: 400 });
    const a = m[1] ? Number(m[1]) : 1, b = m[2] ? (m[3] ? Number(m[3]) : count) : a;
    for (let p = Math.max(1, a); p <= Math.min(count, b); p++) out.push(p - 1);
  }
  if (!out.length) throw Object.assign(new Error(`Those pages aren’t in the file (it has ${count}).`), { status: 400 });
  return out;
}

/** Join PDFs (each with an optional page range) into one → { buffer, pages }. */
export async function mergePdfs(parts) {
  const out = await PDFDocument.create();
  for (const { buffer, pages } of parts) {
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const copied = await out.copyPages(src, pageList(pages, src.getPageCount()));
    for (const p of copied) out.addPage(p);
  }
  return { buffer: Buffer.from(await out.save()), pages: out.getPageCount() };
}
