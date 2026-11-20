// Office tools (Phase 11, decision #81; Phase 22, decisions #131–#134, #161–#162): Word, Excel, PowerPoint and PDF files people can
// open anywhere, saved to the Library (with a preview) and linked in the reply. Passing an existing item's id makes a new
// version of it, except over a file the person uploaded: that is never replaced by a regenerated copy (a new item is made
// instead); uploads are changed in place with sheet_set_cells / docx_fill, which keep everything else in the file. A
// first version comes with page 1 as it prints for Jess to look at (PDFs; office files when LibreOffice is installed).
import { imageSize } from 'image-size';
import { registerTool } from './registry.js';
import { createFileItem, addFileVersion, itemForUser, itemView, readBytes, readText, originOf, isOutsideFile, pagePicture, wantsPreview, fromWords,
  outsideSource } from '../../services/library.js';
import { oneLine } from '../../lib/untrusted.js';
import { guardOutside } from '../injection.js';
import { shotRef } from '../../services/page-check.js';
import { primaryPlace } from '../../services/places.js';
import { pdfFormFields, fillPdfForm, mergePdfs, pageText, writeOnPdf } from '../../services/pdf.js';
import { sheetSetCells, docxFill } from '../../services/office-edit.js';
import { extract } from '../../services/uploads.js';
import { docxFromMarkdown, makeWorkbook, formulaReport, xlsxSheets, pptxFromSlides, pdfFromMarkdown, sheetsPreviewHtml, slidesPreviewHtml, sheetsText,
  slidesText, paperFor, libraryImageIds, SLIDE_LAYOUTS } from '../../services/office.js';
import { THEME_IDS, themeMenu } from '../../services/themes.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { publish } from '../../lib/bus.js';
import { renderFragment } from '../../views/render.js';

const KINDS = {
  doc: { type: 'doc', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', noun: 'Word document' },
  sheet: { type: 'sheet', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', noun: 'spreadsheet' },
  slides: { type: 'slides', ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', noun: 'presentation' },
  pdf: { type: 'pdf', ext: 'pdf', mime: 'application/pdf', noun: 'PDF' },
};
const bare = id => String(id || '').replace(/^\/?library\//, '').replace(/\/$/, '');
/** A file the person gave us (uploaded, downloaded by Jess's browser, saved from an email), as opposed to one Jess generated. */
export const isPersonsFile = isOutsideFile;
const givenAs = { uploaded: 'a file they uploaded', downloaded: 'a file downloaded for them', email: 'a file from an email' };

// A first look at what she made (decision #162): page 1 as it prints, shown to the model with the result, on a file's first
// version only (a revision was already looked at). PDFs always; Word, Excel and PowerPoint files when LibreOffice is there.
// Best effort and bounded: a slow conversion goes on in the background for the Library's pictures, the result doesn't wait.
const LOOK_MS = 45000;
async function firstLook(ctx, item) {
  if (item.version !== 1 || !wantsPreview(item)) return null;
  let timer;
  try {
    const pic = await Promise.race([pagePicture(item, 1), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('slow')), LOOK_MS); })]);
    return shotRef(ctx.user.id, pic.buffer).ref;
  } catch (err) {
    if (err.message !== 'slow') console.warn('[office] first look failed:', String(err.message).split('\n')[0]);
    return null;
  } finally { clearTimeout(timer); }
}
const LOOK_NOTE = {
  make: 'Page 1 as it prints is shown below: fix only a real defect you can see (once, by making it again with its id); don’t polish.',
  form: 'Page 1 of the filled copy is shown below: check each answer sits in its box or on its line; pdf_page_image shows the other pages. '
    + 'Fix a misplaced answer once, then stop.',
};

async function save(ctx, kind, { id, title, description, buffer, text, preview, why, look = null }) {
  const k = KINDS[kind];
  let item, kept = null;
  if (id) {
    const current = itemForUser(ctx.user, bare(id), { write: true });
    if (current.ext !== k.ext) throw Object.assign(new Error(`That item is a ${current.ext} file — make a new ${k.noun} instead.`), { status: 400 });
    if (isPersonsFile(current)) kept = current; // their own file: never overwritten by a regenerated copy
    else item = addFileVersion(current, { buffer, text, preview, title, description });
  }
  item ||= createFileItem({ user: ctx.user, title, type: k.type, ext: k.ext, mime: k.mime, buffer, text, preview, description,
    threadId: ctx.thread.id, runId: ctx.run.id, sourceLabel: why || null });
  const updated = !!id && !kept;
  const view = itemView(item);
  publish(ctx.user.id, updated ? 'library.updated' : 'library.created', { item: view, html: await renderFragment('library-card', view, ctx.user).catch(() => null) });
  const shot = look ? await firstLook(ctx, item) : null;
  return {
    ...(shot ? { attachments: [shot] } : {}), // shown to the model after this result (prompt.js toolImages)
    content: `${kept ? `“${kept.title}” is ${givenAs[originOf(kept)]}, so I didn’t replace it with a regenerated copy (that would lose its own formatting, `
      + `sheets and pictures). ${kind === 'sheet' ? 'To change cells in it, use sheet_set_cells.' : kind === 'doc' ? 'To fill in or reword it, use docx_fill.' : ''} Instead I `
      : ''}${updated ? 'Updated' : kept ? 'saved' : 'Saved'} “${item.title}” as a ${k.noun} (${k.ext}, version ${item.version}) in the Library. Link it as `
      + `[${item.title}](/library/${item.public_id}) — they can preview it there and download it to open in Office, Google Docs or their phone.`
      + (shot ? ` ${LOOK_NOTE[look]}` : ''),
    step: { detail: `${k.noun[0].toUpperCase()}${k.noun.slice(1)} · in your Library`, href: `/library/${item.public_id}` },
    item,
  };
}

// Library pictures for documents and slides: { images: Map id → { data, type, width, height, title }, notes: [why one was skipped] }.
// Word and PowerPoint take PNG, JPEG and GIF; a WebP or a missing id is reported instead of breaking the file.
function loadImages(ctx, ids) {
  const images = new Map(), notes = [];
  for (const id of ids) {
    let item;
    try { item = itemForUser(ctx.user, bare(id)); } catch { item = null; }
    if (!item || item.owner_id !== ctx.user.id) { notes.push(`/library/${id} isn’t in their Library`); continue; } // (an admin may view others' files, never copy them)
    const type = { png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif' }[item.ext];
    if (item.type !== 'image' || !type) { notes.push(`“${item.title}” isn’t a PNG, JPEG or GIF picture`); continue; }
    try {
      const data = readBytes(item);
      const { width, height } = imageSize(data);
      if (!width || !height) throw new Error('no size');
      images.set(bare(id), { data, type, width, height, title: item.title });
    } catch { notes.push(`“${item.title}” couldn’t be read as a picture`); }
  }
  return { images, notes };
}

// Paper follows where they live: Letter in the US, Canada and the other letter-paper countries, A4 elsewhere.
const paperOf = user => paperFor({ countryCode: primaryPlace(user)?.country_code, timezone: user.timezone });

const common = {
  title: { type: 'string', description: 'Short, specific title (≤ 80 chars).' },
  description: { type: 'string', description: 'One sentence: what it is.' },
  id: { type: 'string', description: 'To revise a file you made earlier: its Library id (the earlier version is kept). An id of a file they uploaded is never overwritten; a new item is made.' },
  why: { type: 'string', description: 'Very short origin label, e.g. "from your budget question".' },
};
const theme = { type: 'string', enum: THEME_IDS, description: `Colours and fonts. Default jess. Pick one to suit the topic: ${themeMenu()}.` };

registerTool({
  name: 'make_word_document', toolset: 'office', risk: 'write', activity: 'creating', iconName: 'file-type',
  displayName: 'Makes a Word document',
  description: 'Create a Word (.docx) document from markdown — letters, CVs, reports, contracts, minutes. Headings, lists, tables, '
    + 'bold/italic and links carry over; Arabic paragraphs are right-to-left. Tables get fixed column widths sized to their content; '
    + 'every page has a centred "Page X of Y" footer; with 3 or more ## sections a contents list goes before the first one. Paper is '
    + 'Letter or A4 from where they live. Embed a Library picture (PNG, JPEG or GIF) with ![alt](/library/<id>). Use when they want a '
    + 'file to edit, send or print.',
  parameters: { type: 'object', required: ['title', 'markdown'], additionalProperties: false, properties: { ...common, theme,
    markdown: { type: 'string', description: 'The full document in markdown.' } } },
  label: args => `Made “${String(args.title || 'a document').slice(0, 60)}” (Word)`,
  run: async (args, ctx) => {
    const { images, notes } = loadImages(ctx, libraryImageIds(args.markdown));
    const buffer = await docxFromMarkdown(args.markdown, { title: args.title, theme: args.theme, page: paperOf(ctx.user), images });
    const res = await save(ctx, 'doc', { ...args, look: 'make', buffer, text: args.markdown, preview: `<article class="prose-jb">${renderMarkdown(args.markdown)}</article>` });
    return notes.length ? { ...res, content: `${res.content} Pictures left out (shown as their alt text): ${notes.join('; ')}.` } : res;
  },
});

registerTool({
  name: 'make_spreadsheet', toolset: 'office', risk: 'write', activity: 'creating', iconName: 'sheet',
  displayName: 'Makes a spreadsheet',
  description: 'Create an Excel (.xlsx) workbook — budgets, trackers, comparisons, lists. Each sheet has columns (header + format) and '
    + 'rows of values; a value starting with "=" is a formula (e.g. "=B2*C2", "=SUM(D2:D20)"). Use formulas for anything computed '
    + 'so it stays live when they edit it, and put assumptions (rates, prices) in their own cells (mark those columns input: true, shown '
    + 'blue on a light fill) and reference them. Formats: number, integer, currency, percent (0.15 = 15%), date (YYYY-MM-DD), text. '
    + 'Newer functions (XLOOKUP, IFS, TEXTJOIN, MAXIFS…) work; dynamic-array ones (FILTER, SORT, UNIQUE, SEQUENCE, LET…) are refused. '
    + 'Every formula is computed as the file is made and the result stored in it: the reply lists any formula problems (#DIV/0!, #REF!, '
    + '#NAME?…) by cell — fix them and make it again with the same id.',
  parameters: { type: 'object', required: ['title', 'sheets'], additionalProperties: false, properties: { ...common, theme,
    sheets: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', required: ['name', 'columns', 'rows'], additionalProperties: false, properties: {
      name: { type: 'string' },
      columns: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', required: ['header'], additionalProperties: false, properties: {
        header: { type: 'string' }, format: { type: 'string', enum: ['number', 'integer', 'currency', 'percent', 'date', 'text'] }, width: { type: 'number' },
        input: { type: 'boolean', description: 'A column of values they are meant to change (blue text, light fill).' },
        wrap: { type: 'boolean', description: 'Wrap long text in this column.' } } } },
      rows: { type: 'array', maxItems: 2000, items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
      totals: { type: 'array', items: { type: 'integer' }, description: 'Column indexes (0-based) to total in a bold last row.' },
      notes: { type: 'array', maxItems: 50, items: { type: 'object', required: ['cell', 'text'], additionalProperties: false, properties: {
        cell: { type: 'string', description: 'A1-style address, e.g. "C2" (row 1 is the header).' }, text: { type: 'string', description: 'The assumption or source.' } } } },
      freeze: { type: 'object', additionalProperties: false, description: 'Rows / columns kept in view while scrolling (default: the header row).',
        properties: { rows: { type: 'integer', minimum: 0, maximum: 50 }, columns: { type: 'integer', minimum: 0, maximum: 20 } } } } } } } },
  label: args => `Made “${String(args.title || 'a spreadsheet').slice(0, 60)}” (Excel)`,
  run: async (args, ctx) => {
    const book = await makeWorkbook(args.sheets, { title: args.title, theme: args.theme });
    const shown = await xlsxSheets(book.buffer, { maxRows: 300 }); // read back from the file: exactly what they'll open
    const res = await save(ctx, 'sheet', { ...args, look: 'make', buffer: book.buffer, text: sheetsText(shown), preview: sheetsPreviewHtml(shown) });
    const report = formulaReport(book);
    if (!book.problems.length) return report ? { ...res, content: `${res.content} ${report}` } : res;
    return { ...res, content: `${res.content}\n\nNot right yet: ${report} Fix these and make it again with id "${res.item.public_id}" (the file is saved as it is; `
      + 'versions are kept). Don’t tell them it’s finished until the problems are gone.' };
  },
});

const bulletsSchema = max => ({ type: 'array', maxItems: max, items: { type: 'string' } });
registerTool({
  name: 'make_presentation', toolset: 'office', risk: 'write', activity: 'creating', iconName: 'presentation',
  displayName: 'Makes a presentation',
  description: 'Create a PowerPoint (.pptx) deck (16:9): a dark title slide from title + subtitle, then your slides. Pick a layout per '
    + 'slide and vary them: bullets (3–6 short bullets), two_column (columns: 2 × { heading, bullets }, or bullets + image), stats '
    + '(stats: 2–4 × { value, label }, e.g. "40%"), comparison (columns: 2–3 cards), quote (quote + attribution), timeline (steps: 3–6 × '
    + '{ label, text }), chart (chart: { type: bar|line|pie, labels, series: [{ name, values }] }, numbers inline, a pie has one series), '
    + 'image (a Library picture id, full width, with caption), section (a divider), closing (dark, e.g. "Questions?"). Text is measured '
    + 'before the file is made: if a slide still overflows at 14 pt the tool says which one, so split it. Put the talking points in notes. '
    + 'Arabic slides are right-to-left.',
  parameters: { type: 'object', required: ['title', 'slides'], additionalProperties: false, properties: { ...common, theme,
    subtitle: { type: 'string' },
    slides: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', required: ['title'], additionalProperties: false, properties: {
      layout: { type: 'string', enum: SLIDE_LAYOUTS, description: 'Default bullets.' },
      title: { type: 'string' }, bullets: bulletsSchema(8), notes: { type: 'string', description: 'Speaker notes.' },
      columns: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, properties: { heading: { type: 'string' }, bullets: bulletsSchema(6) } } },
      stats: { type: 'array', maxItems: 4, items: { type: 'object', required: ['value'], additionalProperties: false, properties: { value: { type: 'string' }, label: { type: 'string' } } } },
      quote: { type: 'string' }, attribution: { type: 'string' },
      steps: { type: 'array', maxItems: 6, items: { type: 'object', required: ['label'], additionalProperties: false, properties: { label: { type: 'string' }, text: { type: 'string' } } } },
      chart: { type: 'object', required: ['type', 'labels', 'series'], additionalProperties: false, properties: {
        type: { type: 'string', enum: ['bar', 'line', 'pie'] }, labels: { type: 'array', maxItems: 24, items: { type: 'string' } },
        series: { type: 'array', maxItems: 6, items: { type: 'object', required: ['values'], additionalProperties: false, properties: {
          name: { type: 'string' }, values: { type: 'array', maxItems: 24, items: { type: 'number' } } } } } } },
      image: { type: 'string', description: 'Library id of a PNG, JPEG or GIF picture (image and two_column layouts).' },
      caption: { type: 'string' } } } } } },
  label: args => `Made “${String(args.title || 'a presentation').slice(0, 60)}” (PowerPoint)`,
  run: async (args, ctx) => {
    const { images, notes } = loadImages(ctx, [...new Set(args.slides.map(s => s.image).filter(Boolean).map(bare))]);
    let buffer;
    try { buffer = await pptxFromSlides(args.slides, { title: args.title, subtitle: args.subtitle, theme: args.theme, images }); } catch (err) {
      if (err.status === 400 && notes.length) err.message += ` (${notes.join('; ')})`;
      throw err;
    }
    const all = [{ layout: 'title', title: args.title, bullets: args.subtitle ? [args.subtitle] : [] }, ...args.slides];
    return save(ctx, 'slides', { ...args, look: 'make', buffer, text: slidesText(all), preview: slidesPreviewHtml(all) });
  },
});

registerTool({
  name: 'make_pdf', toolset: 'office', risk: 'write', activity: 'creating', iconName: 'file-text',
  displayName: 'Makes a PDF',
  description: 'Create a print-ready PDF from markdown — invoices, itineraries, worksheets, one-pagers, anything to print or send as-is. '
    + 'Tables, headings and Arabic (right-to-left) text are laid out properly with bundled fonts; "Page X of Y" in the footer; Letter or '
    + 'A4 from where they live. A line holding only \\newpage starts a new page (e.g. a worksheet, then its answer key). Maths in LaTeX: '
    + '$x^2+1$ inline, $$\\frac{a}{b}$$ on its own line (write a plain dollar as \\$). Embed a Library picture with ![alt](/library/<id>). '
    + 'The first version comes with page 1 as it prints, for you to check.',
  parameters: { type: 'object', required: ['title', 'markdown'], additionalProperties: false, properties: { ...common, theme,
    markdown: { type: 'string', description: 'The full content in markdown (start with a # title).' } } },
  label: args => `Made “${String(args.title || 'a PDF').slice(0, 60)}” (PDF)`,
  run: async (args, ctx) => {
    const { images, notes } = loadImages(ctx, libraryImageIds(args.markdown));
    const out = await pdfFromMarkdown(args.markdown, { title: args.title, theme: args.theme, page: paperOf(ctx.user), images, signal: ctx.signal });
    const res = await save(ctx, 'pdf', { ...args, look: 'make', buffer: out.buffer, text: args.markdown });
    const extra = [
      out.mathErrors.length ? `${out.mathErrors.length} formula${out.mathErrors.length === 1 ? '' : 's'} couldn’t be read and show as source: ${out.mathErrors.slice(0, 5).map(e => `$${e.tex}$ (${e.error})`).join('; ')}. Fix and make it again with id "${res.item.public_id}".` : '',
      notes.length ? `Pictures left out: ${notes.join('; ')}.` : '',
    ].filter(Boolean).join(' ');
    return extra ? { ...res, content: `${res.content} ${extra}` } : res;
  },
});

// ---- Changing their own files in place (decision #134): always a new version, the rest of the file untouched --------
const officeItem = (ctx, id, ext) => {
  const item = itemForUser(ctx.user, bare(id), { write: true });
  if (item.ext !== ext) throw Object.assign(new Error(`“${item.title}” is a ${item.ext} file, not ${ext === 'xlsx' ? 'an Excel workbook (.xlsx)' : 'a Word document (.docx)'}.`), { status: 400 });
  return item;
};
async function saveVersion(ctx, item, buffer, kind) {
  const { text = '', preview = null } = await extract(kind, buffer).catch(() => ({}));
  const fresh = addFileVersion(item, { buffer, text, preview });
  const view = itemView(fresh);
  publish(ctx.user.id, 'library.updated', { item: view, html: await renderFragment('library-card', view, ctx.user).catch(() => null) });
  return fresh;
}
const cellValue = { type: ['string', 'number', 'boolean', 'null'] };

registerTool({
  name: 'sheet_set_cells', toolset: 'office', risk: 'write', activity: 'editing', iconName: 'sheet',
  displayName: 'Changes cells in a spreadsheet',
  description: 'Change cells in an Excel workbook in the Library, including one they uploaded, keeping everything else in the file '
    + '(formatting, other sheets, formulas). Each change names a cell ("B4" or "Budget!B4"), a range ("B2:D2", with values as a row, '
    + 'a column or rows) or a name defined in the workbook, and gives a value or a formula ("=B2*12"). Formulas are recomputed and any '
    + 'problems are listed by cell. Saves a new version (the old one stays downloadable). A workbook with charts, pivot tables, macros or '
    + 'pictures is refused (they would be lost): make a new spreadsheet instead.',
  parameters: { type: 'object', required: ['id', 'changes'], additionalProperties: false, properties: {
    id: { type: 'string', description: 'Library id of the .xlsx file.' },
    sheet: { type: 'string', description: 'Sheet for targets that don’t name one. Default: the first sheet.' },
    changes: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['target'], additionalProperties: false, properties: {
      target: { type: 'string' }, value: cellValue, formula: { type: 'string' },
      values: { type: 'array', maxItems: 500, items: { anyOf: [cellValue, { type: 'array', maxItems: 50, items: cellValue }] } } } } } } },
  label: args => `Changed ${args.changes?.length || 0} cell${args.changes?.length === 1 ? '' : 's'} in a spreadsheet`,
  run: async (args, ctx) => {
    const item = officeItem(ctx, args.id, 'xlsx');
    const out = await sheetSetCells(readBytes(item), args.changes, { sheet: args.sheet });
    const fresh = await saveVersion(ctx, item, out.buffer, { type: 'sheet', ext: 'xlsx' });
    const list = out.changed.slice(0, 20).map(c => `${c.ref}: ${c.before || '(empty)'} → ${c.after || '(empty)'}`).join('; ');
    const report = formulaReport(out);
    return {
      content: `Changed ${out.changed.length} cell${out.changed.length === 1 ? '' : 's'} in “${fresh.title}” (now version ${fresh.version}; the earlier one stays downloadable): `
        + `${list}${out.changed.length > 20 ? `; and ${out.changed.length - 20} more` : ''}.${report ? ` ${out.problems.length ? 'Not right yet: ' : ''}${report}` : ''} `
        + `Link it as [${fresh.title}](/library/${fresh.public_id}).`,
      step: { detail: `Spreadsheet · version ${fresh.version}`, href: `/library/${fresh.public_id}` },
    };
  },
});

registerTool({
  name: 'docx_fill', toolset: 'office', risk: 'write', activity: 'editing', iconName: 'file-pen-line',
  displayName: 'Fills in a Word document',
  description: 'Fill in or reword a Word document in the Library, including one they uploaded, keeping its formatting: placeholders '
    + 'fills {{name}} tags (placeholders: { "name": "Theo" }), and replace swaps exact phrases anywhere in the text, headers and footers '
    + '(case-sensitive; the new words keep the formatting of the text they replace). Reports tags left unfilled and phrases not found. '
    + 'Saves a new version (the old one stays downloadable). Only use what you know about them; never invent ID numbers, dates or signatures.',
  parameters: { type: 'object', required: ['id'], additionalProperties: false, properties: {
    id: { type: 'string', description: 'Library id of the .docx file.' },
    placeholders: { type: 'object', additionalProperties: { type: ['string', 'number'] }, description: 'Values for {{name}} tags.' },
    replace: { type: 'array', maxItems: 50, items: { type: 'object', required: ['find', 'replace'], additionalProperties: false, properties: {
      find: { type: 'string' }, replace: { type: 'string' } } } } } },
  label: () => 'Filled in a Word document',
  run: async (args, ctx) => {
    const item = officeItem(ctx, args.id, 'docx');
    const out = await docxFill(readBytes(item), { placeholders: args.placeholders, replace: args.replace });
    const changes = out.filled.length + out.replaced.reduce((n, r) => n + r.count, 0);
    if (!changes) throw Object.assign(new Error(`Nothing changed in “${item.title}”: ${out.notFound.length ? `not found: ${out.notFound.map(x => `“${x}”`).join(', ')}` : 'no matches'}. `
      + 'Read the document again (library_read) and use its exact words or {{tags}}.'), { status: 400 });
    const fresh = await saveVersion(ctx, item, out.buffer, { type: 'doc', ext: 'docx' });
    const notes = [
      out.filled.length ? `Filled ${out.filled.join(', ')}.` : '',
      out.replaced.filter(r => r.count).map(r => `Replaced “${r.find}” ${r.count}×.`).join(' '),
      out.notFound.length ? `Not found: ${out.notFound.map(x => `“${x}”`).join(', ')}.` : '',
      out.unfilled.length ? `Still unfilled in the document: ${out.unfilled.map(x => `{{${x}}}`).join(', ')}.` : '',
    ].filter(Boolean).join(' ');
    return {
      content: `Updated “${fresh.title}” (now version ${fresh.version}; the earlier one stays downloadable). ${notes} Link it as [${fresh.title}](/library/${fresh.public_id}).`,
      step: { detail: `Word document · version ${fresh.version}`, href: `/library/${fresh.public_id}` },
    };
  },
});

// ---- PDF forms and merging (decisions #82, #134) ------------------------------------------------------------------
const pdfItem = (ctx, id) => {
  const item = itemForUser(ctx.user, bare(id));
  if (item.ext !== 'pdf') throw Object.assign(new Error(`“${item.title}” isn’t a PDF.`), { status: 400 });
  return item;
};
const q = s => `“${String(s).replace(/\s+/g, ' ').slice(0, 80)}”`;

registerTool({
  name: 'pdf_form_fields', toolset: 'office', risk: 'read', activity: 'reading', iconName: 'text-cursor-input',
  displayName: 'Reads a PDF form',
  description: 'List the fillable fields of a PDF form in the Library, by page and top to bottom: name, type, current value, options, '
    + 'the printed label next to it, tooltip, max length, checkbox value and position (points from the bottom-left of the page). Use the '
    + 'labels to know which field is which (real forms name them "Text12"). A flat or scanned form has no fields: then you get the page '
    + 'text with positions, to place answers with pdf_write_text. Use before pdf_fill_form.',
  parameters: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' } } },
  label: () => 'Read the form’s fields',
  // Field names, labels, tooltips, values, options and a flat form's text are written by whoever made the PDF (often a website
  // or an email's sender), and a tooltip is never on the printed page: fenced and screened like any outside file, the run marked
  // with where it came from (agent/injection.js guardOutside). Jess's own instructions around them stay outside the fence.
  run: async (args, ctx) => {
    const item = pdfItem(ctx, args.id);
    const title = oneLine(item.title, 120);
    const from = fromWords(item);
    const guarded = async body => (await guardOutside(ctx, { tool: 'pdf_form_fields', kind: 'pdf_form', attrs: { id: item.public_id, from },
      body, label: `form “${title}” (${from})`, origin: outsideSource(item) })).content;
    const bytes = readBytes(item);
    const fields = await pdfFormFields(bytes);
    if (!fields.length) {
      const pages = await pageText(bytes).catch(() => []);
      const lines = pages.flatMap(p => p.segments.map(s => `- p${p.page} x=${s.x}–${s.x2} y=${s.y} (${s.size}pt): ${q(s.text)}`));
      if (!lines.length) return `“${title}” has no fillable fields and no text layer (a scan). Look at it with pdf_page_image (its result converts a spot in `
        + 'the picture to points), then place answers with pdf_write_text at positions in points from the bottom-left; or ask them what the form asks for.';
      return `“${title}” has no fillable fields: it’s a flat form. Its text, with positions in points from the bottom-left `
        + `(${pages.map(p => `page ${p.page} is ${p.width} × ${p.height}`).join(', ')}; y is the text baseline):\n`
        + `${await guarded(`${lines.slice(0, 160).join('\n')}${lines.length > 160 ? `\n(${lines.length - 160} more lines)` : ''}`)}\n`
        + 'To fill it, write each answer just right of its label (x a little past the label’s end, same y) or on the line under it, with pdf_write_text.';
    }
    const describe = f => [
      `- "${f.name}" (${f.type}${f.page ? `, page ${f.page}` : ''}${f.label ? `, label ${q(f.label)}` : ''}${f.tooltip ? `, tooltip ${q(f.tooltip)}` : ''}`
        + `${f.maxLength ? `, max ${f.maxLength} characters` : ''}${f.exportValue ? `, checked value "${f.exportValue}"` : ''}${f.required ? ', required' : ''}${f.readOnly ? ', read-only' : ''})`,
      f.value !== undefined && f.value !== '' && !(Array.isArray(f.value) && !f.value.length) && f.value !== false ? ` = ${JSON.stringify(f.value)}` : '',
      f.options ? ` · options: ${f.options.join(' | ')}` : '',
      f.rect ? ` · at x=${f.rect.x} y=${f.rect.y} w=${f.rect.width} h=${f.rect.height}` : '',
    ].join('');
    return `Fields in “${title}”, by page, top to bottom:\n${await guarded(fields.map(describe).join('\n'))}`;
  },
});

registerTool({
  name: 'pdf_fill_form', toolset: 'office', risk: 'write', activity: 'filling', iconName: 'pen-line',
  displayName: 'Fills in a PDF form',
  description: 'Fill a PDF form from the Library with values by field name (from pdf_form_fields) and save the filled copy as a new '
    + 'Library item (the blank stays). Any language works: answers are drawn with Unicode fonts; Arabic answers are left for the viewer '
    + 'to draw while the form stays editable, and are written onto the page in a flattened copy. flatten=true bakes the answers in for a '
    + 'final copy to send. The result shows you page 1 of the filled copy (pdf_page_image shows any other page): check the answers sit in '
    + 'their boxes. Only use what you know about them — ask for anything missing; never invent ID numbers, dates or signatures, '
    + 'and never sign for them.',
  parameters: { type: 'object', required: ['id', 'values'], additionalProperties: false, properties: {
    id: { type: 'string' }, values: { type: 'object', additionalProperties: { type: ['string', 'boolean', 'number'] } },
    flatten: { type: 'boolean', description: 'Bake the answers in for a final copy (default false: the form stays editable).' }, title: { type: 'string' } } },
  label: () => 'Filled in a PDF form',
  run: async (args, ctx) => {
    const item = pdfItem(ctx, args.id);
    const out = await fillPdfForm(readBytes(item), args.values, { flatten: !!args.flatten });
    if (!out.filled.length) throw Object.assign(new Error(`Nothing was filled — ${[...out.missing.map(m => `no field "${m}"`), ...out.problems].join('; ')}. Check pdf_form_fields.`), { status: 400 });
    const res = await save(ctx, 'pdf', { title: args.title || `${item.title} (filled)`, description: `Filled from “${item.title}”`, buffer: out.buffer, look: 'form',
      text: `Filled form “${item.title}”:\n${Object.entries(args.values).map(([k, v]) => `${k}: ${v}`).join('\n')}`, why: 'filled form' });
    const notes = [
      out.missing.length ? `No such fields: ${out.missing.join(', ')}.` : '',
      out.problems.length ? `Not filled: ${out.problems.join('; ')}.` : '',
      out.viewerDrawn.length ? `${out.viewerDrawn.join(', ')} ${out.viewerDrawn.length === 1 ? 'is' : 'are'} in Arabic or mixed scripts, so the viewer draws `
        + '(the form is marked for that and left editable); if one shows blank on their phone, make a flattened copy (flatten=true), which writes them onto the page.' : '',
      out.drawnOnPage.length ? `${out.drawnOnPage.join(', ')} ${out.drawnOnPage.length === 1 ? 'was' : 'were'} written onto the page (shaped for Arabic).` : '',
    ].filter(Boolean).join(' ');
    return { ...res, content: `${res.content} Filled ${out.filled.length} field${out.filled.length === 1 ? '' : 's'}${out.flattened ? ' (flattened)' : ''}.${notes ? ` ${notes}` : ''}` };
  },
});

registerTool({
  name: 'pdf_write_text', toolset: 'office', risk: 'write', activity: 'filling', iconName: 'pen-line',
  displayName: 'Writes on a PDF',
  description: 'Write answers onto a flat or scanned PDF form (one without fillable fields) and save the result as a new Library item '
    + '(the original stays). Each item places text or a tick on a page at x, y in points from the bottom-left (y is the text baseline), '
    + 'taken from the label positions pdf_form_fields gives: usually just right of the label, same y. size defaults to 10. Arabic is '
    + 'shaped and right-aligned to x (its right end) unless align says otherwise; "\\n" starts a line below. tick draws a check mark in a '
    + 'size-point box. The result shows you page 1 of the new copy; look at other pages with pdf_page_image and move a misplaced answer '
    + 'once. Never sign for them and never invent ID numbers or dates.',
  parameters: { type: 'object', required: ['id', 'items'], additionalProperties: false, properties: {
    id: { type: 'string' }, title: { type: 'string' },
    items: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['page', 'x', 'y'], additionalProperties: false, properties: {
      page: { type: 'integer', minimum: 1 }, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, tick: { type: 'boolean' },
      size: { type: 'number', minimum: 5, maximum: 48 }, align: { type: 'string', enum: ['left', 'right'] } } } } } },
  label: args => `Wrote ${args.items?.length || 0} answer${args.items?.length === 1 ? '' : 's'} on a PDF`,
  run: async (args, ctx) => {
    const item = pdfItem(ctx, args.id);
    const out = await writeOnPdf(readBytes(item), args.items);
    if (!out.placed.length) throw Object.assign(new Error(`Nothing was written: ${out.problems.join('; ')}.`), { status: 400 });
    const res = await save(ctx, 'pdf', { title: args.title || `${item.title} (filled)`, description: `Answers written on “${item.title}”`, buffer: out.buffer, look: 'form',
      text: `Answers written on “${item.title}”:\n${out.placed.map(p => `page ${p.page} (${p.x}, ${p.y}): ${p.tick ? '✓ ' : ''}${p.text || ''}`).join('\n')}`, why: 'filled form' });
    return { ...res, content: `${res.content} Wrote ${out.placed.length} item${out.placed.length === 1 ? '' : 's'}.${out.problems.length ? ` Problems: ${out.problems.join('; ')}.` : ''} `
        + `${res.attachments ? '' : 'Look at the page with pdf_page_image to check the placement before you tell them it’s done. '}They should also check it in the preview before they print or send it.` };
  },
});

registerTool({
  name: 'pdf_merge', toolset: 'office', risk: 'write', activity: 'creating', iconName: 'files',
  displayName: 'Combines PDFs',
  description: 'Join PDFs from the Library into one new PDF, in order, optionally picking pages from each ("1-3, 5", "8-"). Also '
    + 'extracts pages from a single PDF.',
  parameters: { type: 'object', required: ['title', 'parts'], additionalProperties: false, properties: {
    title: { type: 'string' },
    parts: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['id'], additionalProperties: false, properties: {
      id: { type: 'string' }, pages: { type: 'string', description: 'Page range, e.g. "1-3, 5". Default: all pages.' } } } } } },
  label: args => `Combined PDFs into “${String(args.title || 'a PDF').slice(0, 60)}”`,
  run: async (args, ctx) => {
    const items = args.parts.map(p => ({ item: pdfItem(ctx, p.id), pages: p.pages }));
    const out = await mergePdfs(items.map(({ item, pages }) => ({ buffer: readBytes(item), pages })));
    return save(ctx, 'pdf', { title: args.title, description: `${out.pages} pages from ${items.map(x => `“${x.item.title}”`).join(', ')}`, buffer: out.buffer,
      text: items.map(({ item, pages }) => `From “${item.title}”${pages ? ` (pages ${pages})` : ''}:\n${readText(item).slice(0, 20000)}`).join('\n\n'), why: 'combined PDFs' });
  },
});
