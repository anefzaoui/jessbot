// Office documents and PDF (Phase 11, decision #81). Jess makes real files people open anywhere — Word (docx), Excel
// (exceljs), PowerPoint (pptxgenjs), PDF (our own browser prints HTML: fonts, Arabic shaping and RTL for free) — and reads
// the ones they upload (Word via mammoth in uploads.js; Excel via exceljs; PowerPoint via officeparser). Previews are
// HTML we build ourselves from the file's content (escaped), never the file's own markup. Right-to-left text is marked
// right-to-left in every format (bidi.js decides per paragraph / sheet / slide).
import { Document, Packer, Paragraph, HeadingLevel, TextRun, ExternalHyperlink, Table, TableRow, TableCell, WidthType, AlignmentType, ShadingType, BorderStyle,
  TableLayoutType, Footer, PageNumber, TableOfContents, Bookmark, ImageRun } from 'docx';
import FormulaParser from 'fast-formula-parser';
import * as formulajs from '@formulajs/formulajs';
import MarkdownIt from 'markdown-it';
import { textDir } from '../../public/js/bidi.js';
import { renderDocument } from '../lib/markdown.js';
import { documentFontCss, mathFontCss } from './fonts.js';
import { printPdf } from './print.js';
import { themeOf, seriesColors } from './themes.js';
import { escapeMarkdown } from '../lib/text-safe.js';
import { lazy } from '../lib/lazy.js';

// Loaded when a file is made or read, not when the server starts (decision #256).
export const excelLib = lazy(() => import('exceljs').then(m => m.default));
const pptxLib = lazy(() => import('pptxgenjs').then(m => m.default));
const officeParser = lazy(() => import('officeparser'));

const md = new MarkdownIt({ html: false, linkify: true });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---- Word ---------------------------------------------------------------------------------------------------------
// Page sizes in twentieths of a point (DXA). Letter where people use it (the US, Canada and the other letter-paper
// countries of the Americas, the Philippines), A4 everywhere else; one-inch margins either way.
export const PAGES = { A4: { width: 11906, height: 16838 }, Letter: { width: 12240, height: 15840 } };
const MARGIN = 1440;
const LETTER_COUNTRIES = new Set(['US', 'CA', 'MX', 'PH', 'PR', 'CL', 'CO', 'VE', 'GT', 'CR', 'PA', 'DO', 'SV', 'NI']);
const LETTER_ZONES = /^(America\/(New_York|Detroit|Chicago|Denver|Phoenix|Boise|Los_Angeles|Anchorage|Juneau|Sitka|Nome|Adak|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+|Menominee|Toronto|Montreal|Vancouver|Edmonton|Winnipeg|Regina|Halifax|Moncton|St_Johns|Whitehorse|Yellowknife|Iqaluit|Mexico_City|Tijuana|Monterrey|Bogota|Caracas|Santiago|Puerto_Rico|Guatemala|Costa_Rica|Panama|Santo_Domingo|El_Salvador|Managua)|Pacific\/Honolulu|Asia\/Manila|US\/.+|Canada\/.+)$/;
/** The paper a person's documents use: their home's country when known, else their time zone; A4 by default. */
export const paperFor = ({ countryCode, timezone } = {}) => (countryCode ? (LETTER_COUNTRIES.has(String(countryCode).toUpperCase()) ? 'Letter' : 'A4')
  : LETTER_ZONES.test(String(timezone || '')) ? 'Letter' : 'A4');

const LIBRARY_SRC = /^\/?library\/([A-Za-z0-9_-]{6,40})\/?$/;
/** Library ids referenced as images in markdown (![alt](/library/<id>)), in order, without repeats. */
export function libraryImageIds(markdown) {
  const ids = new Set();
  const walk = list => { for (const t of list || []) { if (t.type === 'image') { const m = LIBRARY_SRC.exec(t.attrGet('src') || ''); if (m) ids.add(m[1]); } walk(t.children); } };
  walk(md.parse(String(markdown || ''), {}));
  return [...ids];
}

// Inline tokens → runs (bold, italic, code, links, Library images); a paragraph that reads right-to-left is bidirectional.
function runs(inline, rtl, { bold = false, images = new Map(), maxPx = 600, font } = {}) {
  const out = [];
  const fmt = { bold, italics: false };
  let link = null;
  // Arabic takes Arial (every Office has it) whatever the theme font; no Latin font on a heading, so its style's font shows.
  const fonts = font ? { ascii: font, hAnsi: font, cs: 'Arial' } : { cs: 'Arial' };
  for (const t of inline?.children || []) {
    if (t.type === 'strong_open') fmt.bold = true; else if (t.type === 'strong_close') fmt.bold = bold;
    else if (t.type === 'em_open') fmt.italics = true; else if (t.type === 'em_close') fmt.italics = false;
    else if (t.type === 'link_open') {
      const href = t.attrGet('href') || '';
      link = /^(https?:|mailto:)/i.test(href) ? { href, children: [] } : null; // app-relative links mean nothing inside a file
    } else if (t.type === 'link_close') { if (link) out.push(new ExternalHyperlink({ link: link.href, children: link.children })); link = null; }
    else if (t.type === 'softbreak' || t.type === 'hardbreak') (link ? link.children : out).push(new TextRun({ text: '', break: 1 }));
    else if (t.type === 'image') {
      const img = images.get(LIBRARY_SRC.exec(t.attrGet('src') || '')?.[1]);
      const alt = t.content || img?.title || 'image';
      if (!img) { out.push(new TextRun({ text: `[${alt}]`, italics: true, font: fonts })); continue; }
      const scale = Math.min(1, maxPx / img.width, 820 / img.height);
      out.push(new ImageRun({ type: img.type, data: img.data, transformation: { width: Math.round(img.width * scale), height: Math.round(img.height * scale) },
        altText: { name: alt.slice(0, 60), title: alt.slice(0, 60), description: alt } }));
    } else if (t.type === 'text' || t.type === 'code_inline') {
      const run = new TextRun({ text: t.content, bold: fmt.bold || undefined, italics: fmt.italics || undefined, rightToLeft: rtl || undefined, // unset, not false: styles decide
        ...(t.type === 'code_inline' ? { font: 'Consolas', shading: { type: ShadingType.CLEAR, fill: 'F1F2F4' } } : { font: fonts }),
        ...(link ? { style: 'Hyperlink' } : {}) });
      (link ? link.children : out).push(run);
    }
  }
  return out;
}

// Column widths in DXA that add up to the text width: each column's share follows its longest cell (clamped, so a
// one-letter column stays readable and a paragraph-long cell can't squeeze the rest out). Fixed widths go on the table,
// its grid AND every cell: percentage-only tables are drawn differently by Google Docs and LibreOffice.
export function columnWidths(rows, total) {
  const n = Math.max(1, ...rows.map(r => r.length));
  const weight = Array.from({ length: n }, (_, k) => Math.min(40, Math.max(6, ...rows.map(r => String(r[k] ?? '').length))));
  const sum = weight.reduce((a, b) => a + b, 0);
  const widths = weight.map(w => Math.floor((total * w) / sum));
  widths[widths.length - 1] += total - widths.reduce((a, b) => a + b, 0);
  return widths;
}

/**
 * Markdown → a .docx Buffer: headings, paragraphs, lists (nested), tables, quotes, code, rules, Library images.
 * page: 'A4' | 'Letter'. A centred "Page X of Y" footer; a contents list after the title when there are 3+ sections (##).
 * images: Map of Library id → { data, type: png|jpg|gif, width, height, title } for ![alt](/library/<id>).
 */
export async function docxFromMarkdown(markdown, { title = 'Document', theme, page = 'A4', images = new Map() } = {}) {
  const t = themeOf(theme);
  const size = PAGES[page] || PAGES.A4;
  const textWidth = size.width - 2 * MARGIN;
  const font = t.officeFonts.body;
  const opts = { images, maxPx: Math.floor(textWidth / 15), font };
  const tokens = md.parse(String(markdown || ''), {});
  const docRtl = textDir(tokens.filter(x => x.type === 'inline').map(x => x.content).join(' ')) === 'rtl';
  const sectionHeads = tokens.map((x, i) => [x, tokens[i + 1]]).filter(([x]) => x.type === 'heading_open' && (x.tag === 'h2' || x.tag === 'h3'));
  const withToc = sectionHeads.filter(([x]) => x.tag === 'h2').length >= 3;
  const children = [];
  const lists = []; // stack of { ordered }
  let quote = 0, tocPlaced = !withToc, anchor = 0;
  const toc = () => {
    const label = docRtl ? 'المحتويات' : 'Contents';
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, bidirectional: docRtl, children: [new TextRun({ text: label, rightToLeft: docRtl })] }));
    children.push(new TableOfContents(label, { hyperlink: true, headingStyleRange: '2-3', beginDirty: false,
      cachedEntries: sectionHeads.map(([x, inline], k) => ({ title: inline.content, level: x.tag === 'h2' ? 2 : 3, href: `jb-sec-${k + 1}` })) }));
    tocPlaced = true;
  };
  for (let i = 0; i < tokens.length; i++) {
    const x = tokens[i];
    if (x.type === 'bullet_list_open' || x.type === 'ordered_list_open') lists.push({ ordered: x.type === 'ordered_list_open' });
    else if (x.type === 'bullet_list_close' || x.type === 'ordered_list_close') lists.pop();
    else if (x.type === 'blockquote_open') quote++; else if (x.type === 'blockquote_close') quote--;
    else if (x.type === 'heading_open') {
      const inline = tokens[i + 1];
      const rtl = textDir(inline.content) === 'rtl';
      if (!tocPlaced && x.tag !== 'h1') toc(); // the contents go before the first section, after the title and intro
      const level = { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3 }[x.tag] || HeadingLevel.HEADING_4;
      const kids = runs(inline, rtl, { ...opts, font: null });
      const marked = withToc && (x.tag === 'h2' || x.tag === 'h3') ? [new Bookmark({ id: `jb-sec-${++anchor}`, children: kids })] : kids;
      children.push(new Paragraph({ heading: level, children: marked, bidirectional: rtl }));
    } else if (x.type === 'paragraph_open') {
      const inline = tokens[i + 1];
      const rtl = textDir(inline.content) === 'rtl';
      const inList = lists.length > 0;
      children.push(new Paragraph({
        children: runs(inline, rtl, opts), bidirectional: rtl, spacing: { after: inList ? 60 : 160 },
        ...(inList ? (lists.at(-1).ordered ? { numbering: { reference: 'jb-numbers', level: Math.min(lists.length - 1, 2) } } : { bullet: { level: Math.min(lists.length - 1, 2) } }) : {}),
        ...(quote ? { indent: { left: 480 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: t.accent2, space: 12 } } } : {}),
      }));
    } else if (x.type === 'fence' || x.type === 'code_block') {
      for (const line of x.content.replace(/\n$/, '').split('\n')) {
        children.push(new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 19 })], shading: { type: ShadingType.CLEAR, fill: 'F4F5F7' }, spacing: { after: 0 } }));
      }
      children.push(new Paragraph({ children: [] }));
    } else if (x.type === 'hr') children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: t.line, space: 1 } }, children: [] }));
    else if (x.type === 'table_open') {
      const rows = [];
      let row = null, header = false;
      for (i++; i < tokens.length && tokens[i].type !== 'table_close'; i++) {
        const y = tokens[i];
        if (y.type === 'thead_open') header = true; else if (y.type === 'thead_close') header = false;
        else if (y.type === 'tr_open') row = [];
        else if (y.type === 'tr_close') { rows.push({ cells: row, header }); row = null; }
        else if (y.type === 'inline' && row) row.push(y);
      }
      const widths = columnWidths(rows.map(r => r.cells.map(c => c.content)), textWidth);
      const rtlTable = textDir(rows.flatMap(r => r.cells.map(c => c.content)).join(' ')) === 'rtl';
      const border = { style: BorderStyle.SINGLE, size: 4, color: t.line };
      children.push(new Table({ width: { size: textWidth, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, visuallyRightToLeft: rtlTable,
        borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
        rows: rows.map(r => new TableRow({ tableHeader: r.header || undefined, // (an explicit false still reads as a header row to some readers)
          children: widths.map((w, k) => {
            const cell = r.cells[k];
            const rtl = cell ? textDir(cell.content) === 'rtl' : false;
            return new TableCell({ width: { size: w, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 100, right: 100 },
              shading: r.header ? { type: ShadingType.CLEAR, fill: t.tint, color: 'auto' } : undefined,
              children: [new Paragraph({ bidirectional: rtl, children: cell ? runs(cell, rtl, { ...opts, bold: r.header, maxPx: Math.max(40, Math.floor(w / 15) - 14) }) : [] })] });
          }) })) }));
      children.push(new Paragraph({ children: [] }));
    }
  }
  if (!tocPlaced) toc();
  const heading = (sz, color, before) => ({ run: { font: t.officeFonts.head, size: sz, bold: true, color }, paragraph: { spacing: { before, after: 120 }, keepNext: true } });
  const words = docRtl ? ['صفحة ', ' من '] : ['Page ', ' of '];
  const doc = new Document({
    title, creator: 'Jessbot',
    styles: { default: {
      document: { run: { font, size: 22, color: t.ink } },
      heading1: heading(36, t.ink, 0), heading2: heading(28, t.accent, 280), heading3: heading(24, t.ink, 200),
      hyperlink: { run: { color: t.accent, underline: { type: 'single', color: t.accent } } },
    } },
    numbering: { config: [{ reference: 'jb-numbers', levels: [0, 1, 2].map(level => ({ level, format: 'decimal', text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } } })) }] },
    sections: [{
      properties: { page: { size: { width: size.width, height: size.height }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 708, footer: 708 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, bidirectional: docRtl,
        children: [new TextRun({ children: [words[0], PageNumber.CURRENT, words[1], PageNumber.TOTAL_PAGES], size: 18, color: t.muted, rightToLeft: docRtl })] })] }) },
      children: children.length ? children : [new Paragraph({ children: [] })],
    }],
  });
  return Packer.toBuffer(doc);
}

// ---- Excel --------------------------------------------------------------------------------------------------------
const FORMATS = { number: '#,##0.##', integer: '#,##0', currency: '#,##0.00', percent: '0.0%', date: 'yyyy-mm-dd', text: '@' };
const argb = hex => `FF${hex}`;
// Input cells (the numbers a person is meant to change): the spreadsheet convention of blue text on a light fill.
const INPUT_STYLE = { font: { color: { argb: 'FF0000FF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8DC' } } };

// Functions added to Excel after 2007 are stored in the file with an "_xlfn." prefix; written bare, Excel opens them as
// #NAME?. The list follows Microsoft's documented set of "_xlfn" functions (support article "An _xlfn. prefix is
// displayed in front of a formula", plus the later 365 additions that return a single value).
const XLFN = new Set(`ACOT ACOTH AGGREGATE ARABIC ARRAYTOTEXT BASE BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE BINOM.INV BITAND
  BITLSHIFT BITOR BITRSHIFT BITXOR CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST COMBINA
  CONCAT CONFIDENCE.NORM CONFIDENCE.T COT COTH COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL ENCODEURL ERF.PRECISE ERFC.PRECISE
  EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST FILTERXML FLOOR.MATH FLOOR.PRECISE FORECAST.ETS FORECAST.ETS.CONFINT
  FORECAST.ETS.SEASONALITY FORECAST.ETS.STAT FORECAST.LINEAR FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV GAMMALN.PRECISE GAUSS
  HYPGEOM.DIST IFNA IFS IMCOSH IMCOT IMCSC IMCSCH IMSEC IMSECH IMSINH IMTAN ISFORMULA ISO.CEILING ISOMITTED ISOWEEKNUM
  LOGNORM.DIST LOGNORM.INV MAXIFS MINIFS MODE.MULT MODE.SNGL MUNIT NEGBINOM.DIST NETWORKDAYS.INTL NORM.DIST NORM.INV NORM.S.DIST
  NORM.S.INV NUMBERVALUE PDURATION PERCENTILE.EXC PERCENTILE.INC PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI POISSON.DIST
  QUARTILE.EXC QUARTILE.INC RANK.AVG RANK.EQ RRI SEC SECH SHEET SHEETS SKEW.P STDEV.P STDEV.S SWITCH T.DIST T.DIST.2T T.DIST.RT
  T.INV T.INV.2T T.TEST TEXTAFTER TEXTBEFORE TEXTJOIN UNICHAR UNICODE VALUETOTEXT VAR.P VAR.S WEBSERVICE WEIBULL.DIST
  WORKDAY.INTL XLOOKUP XMATCH XOR Z.TEST`.split(/\s+/).filter(Boolean));
// Dynamic-array functions spill into neighbouring cells; a file needs spill metadata exceljs can't write, so they would
// open as a single cell or an error. LET/LAMBDA and friends need a second prefix scheme for their names. Refused, clearly.
const DYNAMIC = new Set(`FILTER SORT SORTBY UNIQUE SEQUENCE RANDARRAY TEXTSPLIT VSTACK HSTACK TOCOL TOROW WRAPROWS WRAPCOLS TAKE DROP
  CHOOSEROWS CHOOSECOLS EXPAND GROUPBY PIVOTBY LET LAMBDA MAP REDUCE SCAN BYROW BYCOL MAKEARRAY`.split(/\s+/).filter(Boolean));

/**
 * A formula as Excel stores it: post-2007 functions get their "_xlfn." prefix (strings and quoted sheet names are left
 * alone; an existing prefix is kept). Throws (status 400) on a dynamic-array function, naming it and saying what to use.
 */
export function excelFormula(formula, where = 'a formula') {
  const f = String(formula).replace(/^=/, '');
  let out = '';
  for (let i = 0; i < f.length;) {
    const ch = f[i];
    if (ch === '"' || ch === "'") { // string literal / quoted sheet name: copy through ("" and '' escape the quote)
      let j = i + 1;
      while (j < f.length && !(f[j] === ch && f[j + 1] !== ch)) j += f[j] === ch ? 2 : 1;
      out += f.slice(i, j + 1); i = j + 1; continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(f.slice(i));
    if (m && !/[A-Za-z0-9_.]/.test(f[i - 1] || '')) {
      const name = m[0], upper = name.toUpperCase();
      const call = /^\s*\(/.test(f.slice(i + name.length));
      if (call && DYNAMIC.has(upper.replace(/^_XLFN\.(_XLWS\.)?/, ''))) {
        throw Object.assign(new Error(`${where} uses ${upper.replace(/^_XLFN\.(_XLWS\.)?/, '')}, a dynamic-array function that doesn't work in files made this way. `
          + 'Use one value per cell instead: SUMIFS / COUNTIFS / AVERAGEIFS, INDEX with MATCH or XLOOKUP, or write the values out.'), { status: 400 });
      }
      out += call && XLFN.has(upper) ? `_xlfn.${upper}` : name;
      i += name.length; continue;
    }
    out += ch; i++;
  }
  return out;
}

const a1 = (row, col) => { let s = '', n = col; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return `${s}${row}`; };
const sheetRef = name => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

/**
 * sheets: [{ name, columns: [{ header, width?, format?: number|integer|currency|percent|date|text, input?, wrap? }],
 *   rows: [[value]], totals?: [col index], notes?: [{ cell: 'B2', text }], freeze?: { rows?, columns? } }]
 * Values starting with "=" are formulas (e.g. "=SUM(B2:B9)"). A header row that reads right-to-left makes the sheet RTL.
 * → { buffer, problems: [{ ref, error, formula }], unchecked: [function names we couldn't compute] }.
 * Every formula cell carries its computed result (previewers that don't calculate show numbers, not blanks) and the
 * workbook asks Excel to recalculate everything on open.
 */
export async function makeWorkbook(sheets, { title = 'Workbook', theme } = {}) {
  const t = themeOf(theme);
  const ExcelJS = await excelLib();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Jessbot';
  wb.title = title;
  for (const sheet of sheets) {
    const cols = sheet.columns || [];
    const rtl = textDir(cols.map(c => c.header).join(' ')) === 'rtl';
    const name = String(sheet.name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet';
    const freezeRows = Math.max(0, Math.min(50, Number.isInteger(sheet.freeze?.rows) ? sheet.freeze.rows : 1));
    const freezeCols = Math.max(0, Math.min(20, Number.isInteger(sheet.freeze?.columns) ? sheet.freeze.columns : 0));
    const ws = wb.addWorksheet(name, { views: [{ state: freezeRows || freezeCols ? 'frozen' : 'normal', ySplit: freezeRows, xSplit: freezeCols, rightToLeft: rtl }] });
    ws.columns = cols.map((c, k) => ({ header: String(c.header ?? ''), key: `c${k}`, width: c.width || Math.min(48, Math.max(10, String(c.header ?? '').length + 4)) }));
    (sheet.rows || []).forEach((r, n) => {
      ws.addRow(cols.map((c, k) => {
        const v = r[k];
        if (typeof v === 'string' && v.startsWith('=')) return { formula: excelFormula(v, `${name}!${a1(n + 2, k + 1)}`) };
        if (c.format === 'date' && v && !(v instanceof Date)) { const d = new Date(v); return Number.isNaN(d.getTime()) ? v : d; }
        if (['number', 'integer', 'currency', 'percent'].includes(c.format) && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
        return v ?? null;
      }));
    });
    const dataRows = (sheet.rows || []).length;
    if (Array.isArray(sheet.totals) && sheet.totals.length && dataRows) {
      const last = ws.rowCount;
      const total = ws.addRow(cols.map((c, k) => (k === 0 ? 'Total' : sheet.totals.includes(k) ? { formula: `SUM(${ws.getColumn(k + 1).letter}2:${ws.getColumn(k + 1).letter}${last})` } : null)));
      cols.forEach((c, k) => { // style the table's own cells, not the whole row out to column XFD
        const cell = total.getCell(k + 1);
        cell.font = { bold: true, name: t.officeFonts.body };
        cell.border = { top: { style: 'thin', color: { argb: argb(t.muted) } } };
      });
    }
    cols.forEach((c, k) => {
      const col = ws.getColumn(k + 1);
      if (FORMATS[c.format]) col.numFmt = FORMATS[c.format];
      for (let r = 2; r <= dataRows + 1; r++) {
        const cell = ws.getCell(r, k + 1);
        if (c.input) { cell.font = { ...INPUT_STYLE.font, name: t.officeFonts.body }; cell.fill = INPUT_STYLE.fill; }
        if (c.wrap) cell.alignment = { wrapText: true, vertical: 'top' };
      }
    });
    for (const note of sheet.notes || []) {
      if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/i.test(String(note?.cell || '')) || !String(note?.text || '').trim()) continue;
      ws.getCell(String(note.cell).toUpperCase()).note = String(note.text).slice(0, 1000);
    }
    cols.forEach((c, k) => {
      const cell = ws.getCell(1, k + 1);
      cell.font = { bold: true, color: { argb: argb(t.ink) }, name: t.officeFonts.head };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(t.tint) } };
      cell.alignment = { vertical: 'middle', wrapText: !!c.wrap };
      cell.border = { bottom: { style: 'thin', color: { argb: argb(t.accent) } } };
    });
    if (cols.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  }
  const check = cacheResults(wb);
  wb.calcProperties.fullCalcOnLoad = true;
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), ...check };
}

/** The workbook as a Buffer (see makeWorkbook for the problems it also finds). */
export const xlsxFromSheets = async (sheets, opts) => (await makeWorkbook(sheets, opts)).buffer;

// Formulas → values. A workbook we just made has no cached results, so previews and the text Jess reads would show
// "=B2*12". fast-formula-parser (MIT) parses formulas and resolves cell and range references through the workbook
// (results memoised, circular references caught); functions it lacks or only stubs (PMT, COUNTA, COUNTIFS, TEXTJOIN,
// SWITCH, MAXIFS…) come from formulajs (MIT), so household sheets compute.
const { FormulaError } = FormulaParser;
const formulajsFn = name => name.split('.').reduce((o, k) => (o == null ? undefined : o[k]), formulajs);
const STUB = /^\([^)]*\)\s*=>\s*\{\s*\}$|^\w*\s*\([^)]*\)\s*\{\s*\}$/; // an empty body: the parser's placeholder
const EXTRA_FUNCTIONS = (() => {
  const own = new FormulaParser({}).functions;
  const names = new Set();
  const walk = (o, prefix) => { for (const [k, v] of Object.entries(o)) { const n = prefix ? `${prefix}.${k}` : k; if (typeof v === 'function') names.add(n); else if (v && typeof v === 'object' && /^[A-Z]/.test(k)) walk(v, n); } };
  walk(formulajs, '');
  const out = {};
  for (const n of names) {
    if (!/^[A-Z][A-Z0-9.]*$/.test(n) || (own[n] && !STUB.test(String(own[n]).trim()))) continue;
    const fn = formulajsFn(n);
    out[n] = (...args) => {
      let r;
      try { r = fn(...args.map(a => (a?.omitted ? undefined : a?.value))); } catch { throw FormulaError.VALUE; }
      if (r instanceof Error) throw new FormulaError(/^#/.test(r.message) ? r.message : '#VALUE!');
      if (Array.isArray(r)) return Array.isArray(r[0]) ? r[0][0] : r[0];
      return r;
    };
  }
  return out;
})();
const KNOWN_FUNCTIONS = new Set([...Object.keys(new FormulaParser({}).functions), ...Object.keys(EXTRA_FUNCTIONS), ...XLFN, ...DYNAMIC]);
const EXCEL_ERRORS = new Set(['#DIV/0!', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#VALUE!']);
export const ERROR_RE = /^#(DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!|ERROR|CIRCULAR)/;

/** A formula's value, or a marker: FormulaError (a real Excel error), { circular }, { unknown: NAME }, { unchecked: NAME }, { broken }. */
function evaluator(wb) {
  const memo = new Map(), busy = new Set();
  const plain = v => (v == null ? null : v instanceof Date ? v : typeof v === 'object' ? (v.richText ? v.richText.map(r => r.text).join('') : v.error ? new FormulaError(v.error) : v.text ?? v.hyperlink ?? null) : v);
  const compute = (sheetName, row, col) => {
    const key = `${sheetName}!${row}:${col}`;
    if (memo.has(key)) return memo.get(key);
    if (busy.has(key)) return { circular: true };
    const ws = wb.getWorksheet(sheetName);
    busy.add(key);
    let out;
    const formula = ws.getCell(row, col).formula;
    // Structured references (Spend[Cost], [@Cost]: Excel tables) aren't understood by the parser: left for Excel, not an error.
    if (String(formula).replace(/"(?:[^"]|"")*"/g, '""').includes('[')) out = { unchecked: 'table references' };
    else try { out = parser.parse(formula, { sheet: sheetName, row, col }); } catch (err) {
      const fn = /Function (\S+) is not implemented/.exec(err?.message || '')?.[1];
      out = fn ? (KNOWN_FUNCTIONS.has(fn.toUpperCase()) ? { unchecked: fn.toUpperCase() } : { unknown: fn.toUpperCase() }) : err instanceof FormulaError ? err : { broken: true };
    }
    busy.delete(key);
    if (Array.isArray(out)) out = Array.isArray(out[0]) ? out[0][0] : out[0]; // a bare range: its first value
    memo.set(key, out);
    return out;
  };
  // What a reference sees: markers read as the error Excel would show.
  const valueOf = (sheetName, row, col, { fresh = false } = {}) => {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) return null;
    const v = ws.getCell(row, col).value;
    if (!v || typeof v !== 'object' || !('formula' in v || 'sharedFormula' in v)) return plain(v);
    if (!fresh && v.result != null && typeof v.result !== 'object') return v.result;
    if (!fresh && v.result?.error) return new FormulaError(v.result.error);
    return compute(sheetName, row, col);
  };
  const asRef = x => (x instanceof FormulaError || x instanceof Date || x == null || typeof x !== 'object' ? x
    : x.circular ? new FormulaError('#CIRCULAR') : x.broken ? FormulaError.VALUE : x.unknown ? FormulaError.NAME : null);
  const parser = new FormulaParser({
    functions: EXTRA_FUNCTIONS,
    onCell: ({ sheet, row, col }) => asRef(valueOf(sheet, row, col, { fresh: freshAll })),
    onRange: ({ sheet, from, to }) => {
      const ws = wb.getWorksheet(sheet);
      if (!ws) return [[]];
      // rowCount / columnCount are the last used row and column (actualRowCount counts non-empty rows: a blank row in the
      // sheet made every range stop short of its last rows).
      const lastRow = Math.min(to.row, ws.rowCount), lastCol = Math.min(to.col, ws.columnCount);
      const out = [];
      for (let r = from.row; r <= lastRow; r++) { const line = []; for (let c = from.col; c <= lastCol; c++) line.push(asRef(valueOf(sheet, r, c, { fresh: freshAll }))); out.push(line); }
      return out;
    },
  });
  let freshAll = false;
  valueOf.recomputeAll = () => { freshAll = true; memo.clear(); };
  return valueOf;
}

/** A computed value as the text a person sees. */
function display(v) {
  if (v == null) return '';
  if (v instanceof FormulaError) return v.error;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return v.circular ? '#CIRCULAR' : v.unknown ? '#NAME?' : v.unchecked ? '(computed in Excel)' : '#ERROR';
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/**
 * Compute every formula cell (ignoring stale cached results), store each result in the cell (a real Excel error stays
 * an error; values we can't compute are left for Excel) and report what's broken:
 * → { problems: [{ ref: 'Budget!D7', error: '#DIV/0!', formula: '=C7/B7' }], unchecked: ['XLOOKUP'] }.
 */
export function cacheResults(wb) {
  const valueOf = evaluator(wb);
  valueOf.recomputeAll();
  const problems = [], unchecked = new Set(), results = [];
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row, r) => row.eachCell({ includeEmpty: false }, (cell, c) => {
      const v = cell.value;
      if (!v || typeof v !== 'object' || !('formula' in v || 'sharedFormula' in v)) return;
      const out = valueOf(ws.name, r, c, { fresh: true });
      results.push([cell, out]);
      const shown = display(out);
      if (out && typeof out === 'object' && out.unchecked) unchecked.add(out.unchecked);
      else if (ERROR_RE.test(shown)) {
        problems.push({ ref: `${sheetRef(ws.name)}!${a1(r, c)}`, error: shown, formula: `=${cell.formula}`,
          ...(out?.unknown ? { hint: `${out.unknown} isn’t an Excel function` } : {}) });
      }
    }));
  }
  // Write after computing everything (a written result must not feed a later formula's "fresh" computation).
  for (const [cell, out] of results) {
    const result = out instanceof FormulaError ? (EXCEL_ERRORS.has(out.error) ? { error: out.error } : undefined)
      : out instanceof Date || ['number', 'string', 'boolean'].includes(typeof out) ? out : undefined;
    const f = cell.value;
    if ('sharedFormula' in f) cell.value = { sharedFormula: f.sharedFormula, ...(result === undefined ? {} : { result }) };
    else cell.value = { formula: f.formula, ...(result === undefined ? {} : { result }) };
  }
  return { problems, unchecked: [...unchecked] };
}

/** "3 formula problems: Budget!D7 = #DIV/0! (=C7/B7), …" (empty when all is well). */
export function formulaReport({ problems = [], unchecked = [] }, { limit = 12 } = {}) {
  const lines = [];
  if (problems.length) {
    lines.push(`${problems.length} formula problem${problems.length === 1 ? '' : 's'}: ${problems.slice(0, limit).map(p => `${p.ref} = ${p.error} (${p.formula})${p.hint ? `: ${p.hint}` : ''}`).join('; ')}`
      + `${problems.length > limit ? `; and ${problems.length - limit} more` : ''}.`);
  }
  if (unchecked.length) lines.push(`I couldn’t compute ${unchecked.join(', ')} here, so those cells are left for Excel to calculate when the file opens.`);
  return lines.join(' ');
}

// A number format's decimals (decision #207): '#,##0.00' → exactly 2, '#,##0.##' → up to 2, '0.0%' → a percent with 1;
// General (or none) → null, the column decides. Only the positive section counts; quoted text, escapes and [colors] are skipped.
export function formatDecimals(fmt) {
  const f = String(fmt || '').split(';')[0].replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
  if (!f || /general/i.test(f) || f === '@' || !/[0#?]/.test(f) || /[dmyhs]/i.test(f)) return null;
  const d = f.match(/\.([0#?]+)/)?.[1] || '';
  return { min: (d.match(/0/g) || []).length, max: d.length, percent: f.includes('%') };
}
const decimalsOf = n => { const m = String(Math.abs(n)).match(/\.(\d+)$/); return m ? m[1].length : 0; };

/**
 * An .xlsx as sheets of display values (formulas computed). Numbers read as the cell's format shows them, and a column's
 * numbers without a fixed format share one number of decimals (at most 2): the evaluation's budget read 1,550.2 next to
 * 1,542.85 and the model compared them wrongly; now 1,550.20.
 */
export async function xlsxSheets(buffer, { maxRows = 500 } = {}) {
  const ExcelJS = await excelLib();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const valueOf = evaluator(wb);
  return wb.worksheets.map(ws => {
    const cells = [];
    const width = ws.columnCount; // the last used column (actualColumnCount counts non-empty columns and cut off the last ones)
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n <= maxRows) cells.push(Array.from({ length: width }, (_, k) => ({ v: valueOf(ws.name, n, k + 1), fmt: formatDecimals(ws.getCell(n, k + 1).numFmt) })));
    });
    // Per column: the decimals its loosely formatted numbers need (up to their format's max, 2 for General).
    const loose = Array.from({ length: width }, (_, k) => Math.max(0, ...cells.map(r => r[k]).filter(c => typeof c.v === 'number' && !c.fmt?.percent
      && (!c.fmt || c.fmt.min < c.fmt.max)).map(c => Math.min(decimalsOf(Math.round(c.v * 100) / 100), c.fmt ? c.fmt.max : 2))));
    const rows = cells.map(r => r.map((c, k) => {
      if (typeof c.v !== 'number') return display(c.v);
      if (c.fmt?.percent) return `${(c.v * 100).toLocaleString('en-US', { minimumFractionDigits: c.fmt.min, maximumFractionDigits: c.fmt.max })}%`;
      const digits = c.fmt && c.fmt.min === c.fmt.max ? c.fmt.min : Math.max(c.fmt?.min || 0, loose[k]);
      return c.v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }));
    return { name: ws.name, rows, total: ws.actualRowCount, rtl: !!ws.views?.[0]?.rightToLeft };
  });
}

/** Sheets as markdown tables (for Jess and search). */
export const sheetsText = sheets => sheets.map(s => {
  if (!s.rows.length) return `## ${s.name}\n(empty)`;
  const width = Math.max(...s.rows.map(r => r.length));
  const line = r => `| ${Array.from({ length: width }, (_, k) => escapeMarkdown(String(r[k] ?? ''), '|').replace(/\n/g, ' ')).join(' | ')} |`;
  return `## ${s.name}\n${line(s.rows[0])}\n| ${Array(width).fill('---').join(' | ')} |\n${s.rows.slice(1).map(line).join('\n')}${s.total > s.rows.length ? `\n(${s.total - s.rows.length} more rows)` : ''}`;
}).join('\n\n');

// ---- PowerPoint ---------------------------------------------------------------------------------------------------
// A 16:9 deck (13.33 × 7.5 in) with a fixed, tested geometry per layout: dark title and closing slides, light content
// slides, no decorative bars or stripes (the tell of machine-made slides). Every text box is measured before writing:
// the font steps down to a floor, and a slide that still doesn't fit is refused by name so Jess splits it.
export const SLIDE_LAYOUTS = ['bullets', 'two_column', 'stats', 'comparison', 'quote', 'timeline', 'chart', 'image', 'section', 'closing'];
const SW = 13.333, SH = 7.5, M = 0.6, CW = SW - 2 * M;
const BODY = { y: 1.75, h: 5.0 }; // content area under the title
const MIN_PT = 14;

// Average advance widths in em for a Calibri-like face (Calibri, Arial and Georgia are within ~10% of these): enough to
// estimate wrapping. Narrow and wide glyphs are told apart; Arabic letters count a little wider than Latin ones.
function emWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    if (ch === ' ') w += 0.23;
    else if (/[fijlrtI.,;:!|'"()[\]`]/.test(ch)) w += 0.28;
    else if (/[mwMW@%]/.test(ch)) w += 0.83;
    else if (/[A-Z]/.test(ch)) w += 0.62;
    else if (/[0-9]/.test(ch)) w += 0.51;
    else if (/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(ch)) w += 0.55;
    else if (/[\u2E80-\u9FFF\uAC00-\uD7AF]/.test(ch)) w += 1.0;
    else w += 0.5;
  }
  return w;
}
// Lines a paragraph takes in a box `width` inches wide at `pt` points (greedy word wrap; a word longer than the line breaks).
function lineCount(text, width, pt) {
  const max = width / (pt / 72);
  let lines = 1, cur = 0;
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const ww = emWidth(word), gap = cur ? emWidth(' ') : 0;
    if (cur + gap + ww <= max) { cur += gap + ww; continue; }
    if (cur) lines++;
    cur = ww;
    while (cur > max) { lines++; cur -= max; }
  }
  return lines;
}
/**
 * The largest size from `start` down to `min` (2 pt steps) at which the paragraphs fit a w × h inch box, or null.
 * indent: space a bullet takes; gap: points after each paragraph; line height 1.2 em; 0.1 in insets each side.
 */
export function fitSize(paragraphs, { w, h, start, min = MIN_PT, indent = 0, gap = 0, maxLines = Infinity }) {
  const paras = paragraphs.map(p => String(p ?? '')).filter(p => p.trim());
  if (!paras.length) return start;
  for (let pt = start; pt >= min; pt -= 2) {
    const lines = paras.reduce((n, p) => n + lineCount(p, w - 0.2 - indent, pt), 0);
    const height = (lines * pt * 1.2 + (paras.length - 1) * gap) / 72 + 0.1;
    if (height <= h && lines <= maxLines) return pt;
  }
  return null;
}

const imageData = img => `${img.type === 'jpg' ? 'image/jpeg' : `image/${img.type}`};base64,${img.data.toString('base64')}`;
// An image placed in a box: pptxgenjs crops (cover) or pads (contain) from the size we give it, so that size must have
// the picture's own proportions; the frame on the slide is the box.
const placeImage = (img, box, type) => ({ data: imageData(img), x: box.x, y: box.y, w: box.w, h: box.w * (img.height / img.width),
  sizing: { type, w: box.w, h: box.h } });

/**
 * slides: [{ layout?: one of SLIDE_LAYOUTS (default bullets), title, bullets?, notes?,
 *   columns?: [{ heading?, bullets }] (two_column: 2, comparison: 2–3), stats?: [{ value, label }] (2–4),
 *   quote?, attribution?, steps?: [{ label, text? }] (3–6), chart?: { type: bar|line|pie, labels, series: [{ name, values }] },
 *   image?: Library id (image; or two_column with bullets), caption? }] → a 16:9 .pptx Buffer.
 * images: Map of Library id → { data, type: png|jpg|gif, width, height }. The first slide is the title slide.
 * Throws (status 400) naming the slide when its content doesn't fit or is malformed.
 */
export async function pptxFromSlides(slides, { title = 'Presentation', subtitle = '', theme, images = new Map() } = {}) {
  const t = themeOf(theme);
  const head = t.officeFonts.head, body = t.officeFonts.body;
  const PptxGenJS = await pptxLib();
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  pptx.author = 'Jessbot';
  const all = [{ layout: 'title', title, bullets: subtitle ? [subtitle] : [] }, ...slides];
  const refuse = (n, s, why) => { throw Object.assign(new Error(`Slide ${n + 1} (“${String(s.title || '').slice(0, 60)}”) ${why}`), { status: 400 }); };
  const fit = (n, s, paras, box, what = 'has more text than its layout holds, even at 14 pt: split it into two slides or shorten it.') => {
    const pt = fitSize(paras, box);
    if (pt == null) refuse(n, s, what);
    return pt;
  };
  let section = 0;
  all.forEach((s, n) => {
    const layout = s.layout || (s.kind === 'section' ? 'section' : s.kind === 'title' ? 'title' : 'bullets');
    const slide = pptx.addSlide();
    const rtl = textDir(slideWords(s).join(' ')) === 'rtl';
    const align = rtl ? 'right' : 'left';
    const bullets = (s.bullets || []).map(String).filter(b => b.trim());
    const dark = layout === 'title' || layout === 'closing';
    slide.background = { color: dark ? t.dark : layout === 'section' ? t.tint : t.paper };

    // Title and closing: big type on the dark background, nothing else.
    if (dark || layout === 'section') {
      const big = fit(n, s, [s.title], { w: CW - 0.4, h: 2.4, start: layout === 'section' ? 40 : 44, min: 28, maxLines: 3 }, 'has a title too long for a title slide: shorten it.');
      if (layout === 'section') {
        section++;
        slide.addText(String(section).padStart(2, '0'), { x: M + 0.2, y: 0.9, w: 3, h: 1.2, fontSize: 60, bold: true, color: t.accent2, fontFace: head, align, rtlMode: rtl, ...(rtl ? { x: SW - M - 3.2 } : {}) });
      }
      slide.addText(String(s.title || ''), { x: M + 0.2, y: 2.15, w: CW - 0.4, h: 2.4, fontSize: big, bold: true, color: dark ? t.onDark : t.ink, fontFace: head, align, valign: 'bottom', rtlMode: rtl, fit: 'none' });
      if (bullets[0]) {
        const sub = fit(n, s, [bullets[0]], { w: CW - 0.4, h: 1.0, start: 22, min: 14 }, 'has a subtitle too long for a title slide: shorten it.');
        slide.addText(bullets[0], { x: M + 0.2, y: 4.65, w: CW - 0.4, h: 1.0, fontSize: sub, color: dark ? t.onDarkMuted : t.muted, fontFace: body, align, valign: 'top', rtlMode: rtl, fit: 'none' });
      }
      if (s.notes) slide.addNotes(String(s.notes));
      return;
    }

    // Content slides: a title (up to two lines), the layout's body, a quiet slide number.
    if (layout !== 'image') {
      const tp = fit(n, s, [s.title], { w: CW, h: 1.1, start: 30, min: 22, maxLines: 2 }, 'has a title too long for one or two lines: shorten it.');
      slide.addText(String(s.title || ''), { x: M, y: 0.45, w: CW, h: 1.1, fontSize: tp, bold: true, color: t.ink, fontFace: head, align, valign: 'bottom', rtlMode: rtl, fit: 'none' });
    }
    const textBox = (paras, box, { size, color = t.ink, bulleted = true, bold = false, face = body, valign = 'top' } = {}) => {
      slide.addText(paras.map(p => ({ text: String(p), options: { breakLine: true, rtlMode: rtl, ...(bulleted ? { bullet: { indent: 18 } } : {}) } })),
        { x: box.x, y: box.y, w: box.w, h: box.h, fontSize: size, color, bold, fontFace: face, valign, paraSpaceAfter: 8, align, rtlMode: rtl, fit: 'none' });
    };
    const order = arr => (rtl ? [...arr].reverse() : arr); // columns and steps read right-to-left on an Arabic slide

    if (layout === 'bullets') {
      const size = fit(n, s, bullets, { w: CW, h: BODY.h, start: 24, indent: 0.3, gap: 8 });
      if (bullets.length) textBox(bullets, { x: M, y: BODY.y, w: CW, h: BODY.h }, { size }); // a title alone is a statement slide
    } else if (layout === 'two_column' || layout === 'comparison') {
      const img = s.image ? images.get(String(s.image)) : null;
      if (layout === 'two_column' && s.image && !img) refuse(n, s, 'uses an image that isn’t in the Library (or isn’t PNG, JPEG or GIF).');
      const cols = layout === 'two_column' && img ? [{ bullets }] : (s.columns || []);
      const want = layout === 'two_column' ? (img ? [1, 1] : [2, 2]) : [2, 3];
      if (cols.length < want[0] || cols.length > want[1]) refuse(n, s, layout === 'two_column' ? 'needs two columns (or bullets and an image).' : 'needs 2 or 3 columns.');
      const slots = img ? 2 : cols.length, gutter = 0.4, cw = (CW - gutter * (slots - 1)) / slots;
      const card = layout === 'comparison';
      const pad = card ? 0.25 : 0;
      // One font size for every column so they read as a set.
      const sizes = cols.map(c => fit(n, s, (c.bullets || []).map(String), { w: cw - 2 * pad, h: BODY.h - (c.heading ? 0.7 : 0) - 2 * pad, start: 20, indent: 0.3, gap: 8 }));
      const size = Math.min(...sizes);
      const xs = order(Array.from({ length: slots }, (_, k) => M + k * (cw + gutter)));
      cols.forEach((c, k) => {
        const x = xs[k];
        if (card) slide.addShape(pptx.ShapeType.roundRect, { x, y: BODY.y, w: cw, h: BODY.h, fill: { color: t.tint }, line: { color: t.tint }, rectRadius: 0.12 });
        let y = BODY.y + pad;
        if (c.heading) {
          const hp = fit(n, s, [c.heading], { w: cw - 2 * pad, h: 0.6, start: 20, min: 14, maxLines: 1 }, 'has a column heading too long for one line: shorten it.');
          slide.addText(String(c.heading), { x: x + pad, y, w: cw - 2 * pad, h: 0.6, fontSize: hp, bold: true, color: card ? t.ink : t.accent, fontFace: head, align, valign: 'top', rtlMode: rtl, fit: 'none' });
          y += 0.7;
        }
        textBox((c.bullets || []).map(String), { x: x + pad, y, w: cw - 2 * pad, h: BODY.y + BODY.h - pad - y }, { size });
      });
      if (img) {
        const x = order([M, M + cw + gutter])[1];
        slide.addImage({ ...placeImage(img, { x, y: BODY.y, w: cw, h: BODY.h }, 'contain'), altText: s.caption || s.title });
      }
    } else if (layout === 'stats') {
      const stats = (s.stats || []).filter(x => String(x?.value ?? '').trim());
      if (stats.length < 2 || stats.length > 4) refuse(n, s, 'needs 2 to 4 numbers.');
      const gutter = 0.4, cw = (CW - gutter * (stats.length - 1)) / stats.length;
      const vsize = Math.min(...stats.map(x => fit(n, s, [x.value], { w: cw, h: 1.6, start: 60, min: 28, maxLines: 1 }, 'has a number too long to show big: shorten it (e.g. “4.2M”).')));
      const lsize = Math.min(...stats.map(x => fit(n, s, [x.label || ''], { w: cw, h: 1.5, start: 18, min: MIN_PT })));
      const xs = order(stats.map((_, k) => M + k * (cw + gutter)));
      stats.forEach((x, k) => {
        slide.addText(String(x.value), { x: xs[k], y: 2.5, w: cw, h: 1.6, fontSize: vsize, bold: true, color: t.accent2, fontFace: head, align, valign: 'bottom', rtlMode: rtl, fit: 'none' });
        if (x.label) slide.addText(String(x.label), { x: xs[k], y: 4.2, w: cw, h: 1.5, fontSize: lsize, color: t.muted, fontFace: body, align, valign: 'top', rtlMode: rtl, fit: 'none' });
      });
      if (bullets[0]) {
        const cs = fit(n, s, [bullets[0]], { w: CW, h: 0.8, start: 16, min: MIN_PT });
        slide.addText(bullets[0], { x: M, y: 6.0, w: CW, h: 0.8, fontSize: cs, color: t.ink, fontFace: body, align, valign: 'top', rtlMode: rtl, fit: 'none' });
      }
    } else if (layout === 'quote') {
      const quote = String(s.quote || bullets[0] || '').trim();
      if (!quote) refuse(n, s, 'needs the quote.');
      const qs = fit(n, s, [quote], { w: CW - 1.2, h: 3.2, start: 32, min: 18 }, 'has a quote too long for one slide: shorten it.');
      slide.addText(rtl ? '”' : '“', { x: rtl ? SW - M - 1.2 : M, y: 1.75, w: 1.2, h: 1.2, fontSize: 96, bold: true, color: t.accent2, fontFace: head, align, rtlMode: rtl });
      slide.addText(quote, { x: M + 0.6, y: 2.6, w: CW - 1.2, h: 3.2, fontSize: qs, italic: true, color: t.ink, fontFace: head, align, valign: 'top', rtlMode: rtl, fit: 'none' });
      if (s.attribution) slide.addText(String(s.attribution), { x: M + 0.6, y: 5.95, w: CW - 1.2, h: 0.6, fontSize: 18, color: t.muted, fontFace: body, align, valign: 'top', rtlMode: rtl, fit: 'none' });
    } else if (layout === 'timeline') {
      const steps = (s.steps || []).filter(x => String(x?.label ?? '').trim());
      if (steps.length < 3 || steps.length > 6) refuse(n, s, 'needs 3 to 6 steps.');
      const cw = CW / steps.length, lineY = 3.2;
      slide.addShape(pptx.ShapeType.line, { x: M + cw / 2, y: lineY, w: CW - cw, h: 0, line: { color: t.line, width: 2 } });
      const lsize = Math.min(...steps.map(x => fit(n, s, [x.label], { w: cw - 0.2, h: 0.9, start: 20, min: MIN_PT, maxLines: 2 }, 'has a step label too long: shorten it.')));
      const tsize = Math.min(...steps.map(x => fit(n, s, [x.text || ''], { w: cw - 0.2, h: 2.9, start: 16, min: MIN_PT })));
      const xs = order(steps.map((_, k) => M + k * cw));
      steps.forEach((x, k) => {
        slide.addShape(pptx.ShapeType.ellipse, { x: xs[k] + cw / 2 - 0.13, y: lineY - 0.13, w: 0.26, h: 0.26, fill: { color: t.accent }, line: { color: t.paper, width: 2 } });
        slide.addText(String(x.label), { x: xs[k] + 0.1, y: lineY - 1.15, w: cw - 0.2, h: 0.9, fontSize: lsize, bold: true, color: t.accent, fontFace: head, align: 'center', valign: 'bottom', rtlMode: rtl, fit: 'none' });
        if (x.text) slide.addText(String(x.text), { x: xs[k] + 0.1, y: lineY + 0.35, w: cw - 0.2, h: 2.9, fontSize: tsize, color: t.ink, fontFace: body, align: 'center', valign: 'top', rtlMode: rtl, fit: 'none' });
      });
    } else if (layout === 'chart') {
      const c = s.chart || {};
      const type = { bar: pptx.ChartType.bar, line: pptx.ChartType.line, pie: pptx.ChartType.pie }[c.type];
      const labels = (c.labels || []).map(String);
      const series = (c.series || []).filter(x => Array.isArray(x?.values));
      if (!type) refuse(n, s, 'needs a chart type: bar, line or pie.');
      if (labels.length < 1 || labels.length > 24 || series.length < 1 || series.length > 6) refuse(n, s, 'needs 1–24 labels and 1–6 series.');
      if (c.type === 'pie' && series.length !== 1) refuse(n, s, 'is a pie chart, which shows exactly one series.');
      for (const x of series) if (x.values.length !== labels.length || !x.values.every(v => Number.isFinite(Number(v)))) refuse(n, s, `has a series (“${x.name || '?'}”) whose values don’t match its ${labels.length} labels.`);
      const caption = String(s.caption || bullets[0] || '').trim();
      const ch = caption ? BODY.h - 0.8 : BODY.h;
      const colors = c.type === 'pie' ? labels.map((_, k) => seriesColors(t)[k % 6]) : series.map((_, k) => seriesColors(t)[k % 6]);
      slide.addChart(type, series.map(x => ({ name: String(x.name || ''), labels: [...labels], values: x.values.map(Number) })), {
        x: M, y: BODY.y, w: CW, h: ch, chartColors: colors, showLegend: c.type === 'pie' || series.length > 1, legendPos: 'b', legendFontFace: body, legendFontSize: 14, legendColor: t.ink,
        showValue: c.type !== 'pie', showPercent: c.type === 'pie', dataLabelColor: t.ink, dataLabelFontSize: 12, dataLabelFontFace: body,
        ...(c.type === 'pie' ? { dataLabelPosition: 'bestFit' } : { catAxisLabelColor: t.muted, valAxisLabelColor: t.muted, catAxisLabelFontFace: body, valAxisLabelFontFace: body,
          catAxisLabelFontSize: 14, valAxisLabelFontSize: 12, valGridLine: { color: t.line, size: 0.75 }, catAxisLineShow: false, valAxisLineShow: false }),
        ...(c.type === 'bar' ? { barDir: 'col', barGapWidthPct: 60 } : {}),
        ...(c.type === 'line' ? { lineSize: 3, lineDataSymbol: 'circle', lineDataSymbolSize: 8 } : {}),
      });
      if (caption) {
        const cs = fit(n, s, [caption], { w: CW, h: 0.7, start: 16, min: MIN_PT });
        slide.addText(caption, { x: M, y: BODY.y + ch + 0.1, w: CW, h: 0.7, fontSize: cs, color: t.muted, fontFace: body, align, valign: 'top', rtlMode: rtl, fit: 'none' });
      }
    } else if (layout === 'image') {
      const img = images.get(String(s.image || ''));
      if (!img) refuse(n, s, 'needs an image from the Library (PNG, JPEG or GIF).');
      const ih = 5.7;
      slide.addImage({ ...placeImage(img, { x: 0, y: 0, w: SW, h: ih }, 'cover'), altText: s.caption || s.title });
      const tp = fit(n, s, [s.title], { w: CW, h: 0.7, start: 26, min: 18, maxLines: 1 }, 'has a title too long for under a picture: shorten it.');
      slide.addText(String(s.title || ''), { x: M, y: ih + 0.25, w: CW, h: 0.7, fontSize: tp, bold: true, color: t.ink, fontFace: head, align, valign: 'top', rtlMode: rtl, fit: 'none' });
      const caption = String(s.caption || bullets[0] || '').trim();
      if (caption) {
        const cs = fit(n, s, [caption], { w: CW, h: 0.6, start: 16, min: MIN_PT });
        slide.addText(caption, { x: M, y: ih + 0.95, w: CW, h: 0.6, fontSize: cs, color: t.muted, fontFace: body, align, valign: 'top', rtlMode: rtl, fit: 'none' });
      }
    } else refuse(n, s, `has an unknown layout “${layout}”.`);
    if (layout !== 'image') slide.addText(String(n + 1), { x: rtl ? M : SW - M - 0.7, y: 6.95, w: 0.7, h: 0.35, fontSize: 11, color: t.muted, fontFace: body, align: rtl ? 'left' : 'right' });
    if (s.notes) slide.addNotes(String(s.notes));
  });
  return pptx.write({ outputType: 'nodebuffer' });
}

// Every piece of text on a slide, in reading order (direction detection, the text sidecar, previews).
function slideWords(s) {
  return [s.title, ...(s.bullets || []), ...(s.columns || []).flatMap(c => [c.heading, ...(c.bullets || [])]), ...(s.stats || []).flatMap(x => [x.value, x.label]),
    s.quote, s.attribution, ...(s.steps || []).flatMap(x => [x.label, x.text]), s.caption, ...(s.chart?.labels || [])].filter(x => x != null && String(x).trim()).map(String);
}

/** A deck as text for Jess and search (every layout's content, and the speaker notes). */
export function slidesText(all) {
  return all.map((s, n) => {
    const lines = [`Slide ${n + 1}: ${s.title || ''}${s.layout && !['bullets', 'title'].includes(s.layout) ? ` (${s.layout})` : ''}`];
    for (const b of s.bullets || []) lines.push(`- ${b}`);
    for (const c of s.columns || []) { if (c.heading) lines.push(`${c.heading}:`); for (const b of c.bullets || []) lines.push(`- ${b}`); }
    for (const x of s.stats || []) lines.push(`${x.value}: ${x.label || ''}`);
    if (s.quote) lines.push(`“${s.quote}”${s.attribution ? ` (${s.attribution})` : ''}`);
    for (const x of s.steps || []) lines.push(`${x.label}${x.text ? `: ${x.text}` : ''}`);
    if (s.chart) lines.push(`Chart (${s.chart.type}): ${(s.chart.series || []).map(x => `${x.name || 'series'}: ${(s.chart.labels || []).map((l, k) => `${l} ${x.values?.[k]}`).join(', ')}`).join('; ')}`);
    if (s.image) lines.push(`Image: /library/${s.image}${s.caption ? ` (${s.caption})` : ''}`);
    else if (s.caption) lines.push(s.caption);
    if (s.notes) lines.push(`Notes: ${s.notes}`);
    return lines.join('\n');
  }).join('\n\n');
}

/** Text of a .pptx (or other office file) for Jess and search. */
export async function officeText(buffer) {
  const { parseOffice } = await officeParser();
  const ast = await parseOffice(buffer, { newlineDelimiter: '\n', ignoreNotes: false });
  const { value } = await ast.to('text'); // officeparser v8: parse → AST → text
  return String(value || '').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- PDF ----------------------------------------------------------------------------------------------------------
/**
 * The print page for make_pdf → { html, math, mathErrors, footer }: themed CSS, bundled fonts as data: URIs (the same
 * PDF on any host, Arabic always shaped), MathML formulas, \newpage breaks, Library images inlined.
 * images: Map of Library id → { data, type, width, height } for ![alt](/library/<id>).
 */
export function pdfHtml(markdown, { title = 'Document', theme, images = new Map() } = {}) {
  const t = themeOf(theme);
  const imageSrc = src => {
    const img = images.get(LIBRARY_SRC.exec(src || '')?.[1]);
    if (img) return `data:${img.type === 'jpg' ? 'image/jpeg' : `image/${img.type}`};base64,${img.data.toString('base64')}`;
    return /^data:image\//.test(src || '') ? src : null; // anything else can't load in the print page anyway
  };
  const { html: body, math, mathErrors } = renderDocument(markdown, { imageSrc });
  const rtl = textDir(String(markdown || '')) === 'rtl';
  const families = ['Noto Sans', 'Noto Naskh Arabic', ...(t.headFont === 'Noto Serif' || t.bodyFont === 'Noto Serif' ? ['Noto Serif'] : [])];
  const stack = f => `"${f}", "Noto Naskh Arabic", ${f === 'Noto Serif' ? 'Georgia, serif' : 'Arial, sans-serif'}`;
  const hex = h => `#${h}`;
  const html = `<!doctype html><html lang="${rtl ? 'ar' : 'en'}"${rtl ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    ${documentFontCss(families)}
    ${math ? mathFontCss() : ''}
    body { font: 11pt/1.55 ${stack(t.bodyFont)}; color: ${hex(t.ink)}; background: ${hex(t.paper)}; margin: 0; }
    h1, h2, h3, h4 { font-family: ${stack(t.headFont)}; line-height: 1.25; break-after: avoid; }
    h1 { font-size: 22pt; margin: 0 0 10pt; } h2 { font-size: 15pt; margin: 18pt 0 6pt; color: ${hex(t.accent)}; } h3 { font-size: 12.5pt; margin: 14pt 0 4pt; }
    p, li { margin: 0 0 6pt; unicode-bidi: plaintext; } ul, ol { padding-inline-start: 18pt; }
    table { border-collapse: collapse; width: 100%; margin: 8pt 0 12pt; font-size: 10pt; break-inside: auto; } tr { break-inside: avoid; }
    th { background: ${hex(t.tint)}; text-align: start; } th, td { border: 1px solid ${hex(t.line)}; padding: 4pt 6pt; vertical-align: top; }
    blockquote { margin: 8pt 0; padding: 2pt 10pt; border-inline-start: 3pt solid ${hex(t.accent2)}; color: ${hex(t.muted)}; }
    code { font: 9.5pt Consolas, "Courier New", monospace; background: #F1F2F4; padding: 1pt 3pt; border-radius: 3pt; }
    pre { background: #F4F5F7; padding: 8pt; border-radius: 4pt; white-space: pre-wrap; direction: ltr; } pre code { background: none; padding: 0; }
    .code-head { display: none; } a { color: ${hex(t.accent)}; } hr { border: 0; border-top: 1px solid ${hex(t.line)}; margin: 14pt 0; }
    img { max-width: 100%; height: auto; }
    math { font-family: "STIX Two Math", math; } math[display="block"] { margin: 8pt 0; } .math-error { color: #9B1C1C; }
    .page-break { break-after: page; height: 0; }
    </style></head><body>${body}</body></html>`;
  const words = rtl ? ['صفحة', 'من'] : ['Page', 'of'];
  const footer = `<div dir="${rtl ? 'rtl' : 'ltr'}" style="font:8pt Arial,sans-serif;color:${hex(t.muted)};width:100%;text-align:center">`
    + `${words[0]} <span class="pageNumber"></span> ${words[1]} <span class="totalPages"></span></div>`;
  return { html, math, mathErrors, footer };
}

/** Markdown → a print-quality PDF (page: 'A4' | 'Letter'), printed by our own browser → { buffer, math, mathErrors }. */
export async function pdfFromMarkdown(markdown, { page = 'A4', signal, ...opts } = {}) {
  const { html, footer, math, mathErrors } = pdfHtml(markdown, opts);
  return { buffer: await printPdf(html, { page, footer, signal }), math, mathErrors };
}

// ---- Previews (our own HTML from the content) ---------------------------------------------------------------------
export function sheetsPreviewHtml(sheets) {
  return sheets.map(s => `<section class="sheet-preview"><h2 dir="auto">${esc(s.name)}</h2><div class="sheet-scroll"><table${s.rtl ? ' dir="rtl"' : ''}>`
    + s.rows.map((r, n) => `<tr>${r.map(c => (n === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')
    + `</table></div>${s.total > s.rows.length ? `<p class="sheet-more">${s.total - s.rows.length} more rows — download to see them all.</p>` : ''}</section>`).join('');
}

export function slidesPreviewHtml(slides) {
  // Each layout's content as short lines inside the card (data-layout lets the viewer style layouts later).
  const lines = s => {
    const out = (s.bullets || []).map(b => esc(b));
    for (const c of s.columns || []) out.push(`${c.heading ? `<strong>${esc(c.heading)}</strong>: ` : ''}${(c.bullets || []).map(esc).join('; ')}`);
    for (const x of s.stats || []) out.push(`<strong>${esc(x.value)}</strong> ${esc(x.label || '')}`);
    if (s.quote) out.push(`“${esc(s.quote)}”${s.attribution ? ` <em>${esc(s.attribution)}</em>` : ''}`);
    for (const x of s.steps || []) out.push(`<strong>${esc(x.label)}</strong>${x.text ? ` ${esc(x.text)}` : ''}`);
    if (s.chart) out.push(`${esc({ bar: 'Bar chart', line: 'Line chart', pie: 'Pie chart' }[s.chart.type] || 'Chart')}: ${(s.chart.labels || []).map(esc).join(', ')}`);
    if (s.image || s.caption) out.push(`${s.image ? 'Picture' : ''}${s.image && s.caption ? ': ' : ''}${esc(s.caption || '')}`);
    return out;
  };
  return `<ol class="slides-preview">${slides.map((s, n) => {
    const layout = s.layout || (s.kind === 'section' ? 'section' : s.kind === 'title' ? 'title' : 'bullets');
    const rtl = textDir(slideWords(s).join(' ')) === 'rtl';
    const items = lines(s);
    return `<li class="slide-card${['title', 'section', 'closing'].includes(layout) ? ' is-title' : ''}" data-layout="${layout}"${rtl ? ' dir="rtl"' : ''}><span class="slide-no">${n + 1}</span><h3>${esc(s.title)}</h3>`
      + (items.length ? `<ul>${items.map(x => `<li>${x}</li>`).join('')}</ul>` : '') + '</li>';
  }).join('')}</ol>`;
}
