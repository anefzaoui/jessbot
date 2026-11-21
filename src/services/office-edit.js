// Changing a person's own Word and Excel files in place (decision #134). Jess never regenerates an uploaded file (that
// loses its formatting, other sheets and pictures); she edits the file itself, and the result is always a new version.
//   sheetSetCells: exceljs loads the workbook, sets cells / ranges / defined names (values or formulas), recomputes every
//     formula (stale cached results would be wrong in previewers) and saves. A workbook with parts exceljs can't write
//     back (charts, pivot tables, macros, pictures, slicers…) is refused before anything is touched.
//   docxFill: {{placeholders}} filled by docxtemplater (MIT), which copes with a tag Word split across runs; any other
//     phrase is found and replaced across runs by our own pass over the XML (linkedom): adjacent runs with the same
//     formatting are merged first (Word splits text at every edit and spell-check mark), then a phrase inside one run keeps
//     that run's formatting, and one spanning runs takes the formatting of the run it starts in.
import JSZip from 'jszip';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { DOMParser } from 'linkedom';
import { excelFormula, cacheResults, excelLib } from './office.js';

const bad = message => Object.assign(new Error(message), { status: 400 });

// ---- Excel ----------------------------------------------------------------------------------------------------------
// Package parts exceljs drops or damages on save, with the words a person knows them by.
const UNSUPPORTED = [
  [/^xl\/charts\//, 'charts'], [/^xl\/drawings\/drawing\d+\.xml$/, 'pictures or shapes'], [/^xl\/media\//, 'pictures or shapes'], // (VML drawings hold cell notes: kept)
  [/^xl\/pivot(Tables|Cache)\//, 'pivot tables'], [/^xl\/vbaProject\.bin$/, 'macros'], [/^xl\/slicer/, 'slicers'],
  [/^xl\/timeline/, 'timelines'], [/^xl\/externalLinks\//, 'links to other workbooks'], [/^xl\/(activeX|ctrlProps)\//, 'form controls'],
  [/^xl\/threadedComments\//, 'threaded comments'], [/^xl\/(model|customData)\//, 'a data model'], [/^xl\/queryTables\//, 'data queries'],
  [/^xl\/connections\.xml$/, 'data connections'], [/^xl\/(richData\/|metadata\.xml$)/, 'dynamic-array or rich data'],
];

/** What in this workbook exceljs couldn't keep (empty = safe to edit in place). */
export async function unsupportedParts(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const found = new Set();
  for (const name of Object.keys(zip.files)) for (const [re, what] of UNSUPPORTED) if (re.test(name)) found.add(what);
  return [...found];
}

const A1 = /^(?:(?:'((?:[^']|'')+)'|([^!'\s]+))!)?\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/i;
const colNum = s => [...s.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const colName = n => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const shown = v => (v == null ? '' : typeof v === 'object' ? (v.formula ? `=${v.formula}` : v.richText ? v.richText.map(r => r.text).join('') : v.text ?? v.error ?? (v instanceof Date ? v.toISOString().slice(0, 10) : JSON.stringify(v))) : String(v));

/**
 * changes: [{ target: 'B4' | 'Budget!B4' | 'B2:D2' | a defined name, value?, values?: [[…]] | […], formula? }], sheet?:
 * the sheet for targets without one (default: the first). A value starting with "=" is a formula.
 * → { buffer, changed: [{ ref, before, after }], problems, unchecked }. Throws (400) when the workbook can't be kept whole
 * or a target doesn't exist; nothing is written then.
 */
export async function sheetSetCells(buffer, changes, { sheet } = {}) {
  const lost = await unsupportedParts(buffer);
  if (lost.length) throw bad(`This workbook has ${lost.join(', ')}, which I can’t keep when I save it, so I haven’t changed it. `
    + 'I can make a new spreadsheet with the changes instead (make_spreadsheet), or they can edit it in Excel.');
  const ExcelJS = await excelLib();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const defaultSheet = sheet ? wb.getWorksheet(String(sheet)) : wb.worksheets[0];
  if (!defaultSheet) throw bad(`There’s no sheet called “${sheet}”. Sheets: ${wb.worksheets.map(w => w.name).join(', ')}.`);
  const changed = [];
  let cells = 0;
  for (const ch of changes || []) {
    let target = String(ch.target || '').trim();
    // A defined name ("TaxRate") → the range it names.
    const named = !A1.test(target) && wb.definedNames.getRanges(target)?.ranges?.[0];
    if (named) target = named.replace(/\$/g, '');
    const m = A1.exec(target);
    if (!m) throw bad(`“${ch.target}” isn’t a cell (like B4 or Budget!B4), a range (B2:D2) or a name defined in the workbook.`);
    const ws = m[1] || m[2] ? wb.getWorksheet((m[1] || m[2]).replace(/''/g, "'")) : defaultSheet;
    if (!ws) throw bad(`There’s no sheet called “${m[1] || m[2]}”. Sheets: ${wb.worksheets.map(w => w.name).join(', ')}.`);
    const r1 = Number(m[4]), c1 = colNum(m[3]), r2 = Number(m[6] || m[4]), c2 = colNum(m[5] || m[3]);
    const rows = r2 - r1 + 1, cols = c2 - c1 + 1;
    let grid;
    if (ch.values !== undefined) {
      const v = Array.isArray(ch.values) ? ch.values : [ch.values];
      grid = Array.isArray(v[0]) ? v : rows === 1 ? [v] : v.map(x => [x]);
      if (grid.length !== rows || grid.some(row => row.length !== cols)) throw bad(`${ch.target} is ${rows} × ${cols} cells, but the values given are ${grid.length} × ${grid[0]?.length ?? 0}.`);
    } else {
      if (rows * cols !== 1) throw bad(`${ch.target} is a range: give values (a row, a column or rows of values) for it.`);
      grid = [[ch.formula !== undefined ? `=${String(ch.formula).replace(/^=/, '')}` : ch.value]];
    }
    cells += rows * cols;
    if (cells > 2000) throw bad('That’s more than 2,000 cells in one go; split the changes.');
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cell = ws.getCell(r1 + r, c1 + c);
      const raw = grid[r][c];
      const ref = `${ws.name}!${colName(c1 + c)}${r1 + r}`;
      const before = shown(cell.value);
      if (typeof raw === 'string' && raw.startsWith('=')) cell.value = { formula: excelFormula(raw, ref) };
      else if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && (cell.numFmt || '').match(/[dmy]/i)) cell.value = new Date(`${raw}T00:00:00Z`);
      else cell.value = raw ?? null;
      changed.push({ ref, before, after: shown(cell.value) });
    }
  }
  if (!changed.length) throw bad('No changes were given.');
  const check = cacheResults(wb);
  wb.calcProperties.fullCalcOnLoad = true;
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), changed, ...check };
}

// ---- Appending rows (decision #144) ---------------------------------------------------------------------------------
// A log grows at the bottom of its table. The rule, in the order it is applied:
//   1. The data block: the rows above any trailing totals rows and blank rows. A totals row holds a formula that adds up
//      (any function) a range of this sheet ending above it, and isn't one of a column of the same formula filled down
//      (a running total is data, not a total); an Excel table's own totals row is one too. At most 5 trailing rows.
//   2. New rows go right under the last data row. When anything sits below it (the totals), whole rows are inserted
//      there the way Excel inserts rows: every reference in the workbook to a row at or below the insertion point moves
//      down (formulas on every sheet, defined names, conditional formats, data validation, merged cells, tables, the
//      filter and print area), and a range that spans the insertion point grows.
//   3. Ranges that ended exactly on the last data row (the SUM in a totals row, a summary elsewhere, a named range, a
//      conditional format, a table) are widened to take in the new rows: Excel wouldn't, which is how totals go stale.
//      Formulas inside the data rows themselves (a running total, B*C) are never widened.
//   4. A column whose last data row holds a formula carries it down into new rows that give no value for it (relative
//      references move with the row, absolute ones stay), and every new cell takes the style of the cell above it.
//   5. Every formula is recomputed (cacheResults) and Excel recalculates on open, like sheet_set_cells.
const MAX_APPEND = 500;
const SHEET_NAME = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_À-￿][\w.À-￿]*))!`;
const REF_AT = new RegExp(String.raw`(?:${SHEET_NAME})?(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?::(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7}))?(?![\w.(!À-￿])`, 'y');
const ROWS_AT = new RegExp(String.raw`(?:${SHEET_NAME})?(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\w.(!])`, 'y');

/**
 * Rewrite the A1 references of a formula (or a defined name's range). fn(ref) gets { sheet (name or null), r1, r2, c1, c2,
 * abs1, abs2 (row $), single } and returns { r1, r2 } for new rows, or null to leave it. Strings, structured references
 * ([…]) and whole-column references are left alone; function names that look like cells (LOG10) are skipped.
 */
export function mapRefs(formula, fn) {
  const f = String(formula);
  let out = '';
  for (let i = 0; i < f.length;) {
    const ch = f[i];
    if (ch === '"') { let j = i + 1; while (j < f.length && !(f[j] === '"' && f[j + 1] !== '"')) j += f[j] === '"' ? 2 : 1; out += f.slice(i, j + 1); i = j + 1; continue; }
    if (ch === '[') { let depth = 0, j = i; for (; j < f.length; j++) { if (f[j] === '[') depth++; else if (f[j] === ']' && --depth === 0) break; } out += f.slice(i, j + 1); i = j + 1; continue; }
    if (!/[\w.$À-￿]/.test(f[i - 1] || '') && (ch === "'" || /[\w$À-￿]/.test(ch))) {
      REF_AT.lastIndex = i;
      let m = REF_AT.exec(f);
      if (m) {
        const sheet = m[1] != null ? m[1].replace(/''/g, "'") : m[2] ?? null;
        const r1 = Number(m[6]), r2 = m[10] ? Number(m[10]) : r1;
        const next = fn({ sheet, r1, r2, c1: colNum(m[4]), c2: colNum(m[8] || m[4]), abs1: !!m[5], abs2: !!(m[10] ? m[9] : m[5]), single: !m[10] });
        if (!next) { out += m[0]; i += m[0].length; continue; }
        const prefix = m[1] != null ? `'${m[1]}'!` : m[2] != null ? `${m[2]}!` : '';
        out += `${prefix}${m[3]}${m[4]}${m[5]}${next.r1}${m[10] ? `:${m[7]}${m[8]}${m[9]}${next.r2}` : ''}`;
        i += m[0].length;
        continue;
      }
      ROWS_AT.lastIndex = i;
      m = ROWS_AT.exec(f);
      if (m) {
        const sheet = m[1] != null ? m[1].replace(/''/g, "'") : m[2] ?? null;
        const next = fn({ sheet, r1: Number(m[4]), r2: Number(m[6]), c1: 1, c2: 16384, abs1: !!m[3], abs2: !!m[5], single: false });
        const prefix = m[1] != null ? `'${m[1]}'!` : m[2] != null ? `${m[2]}!` : '';
        out += next ? `${prefix}${m[3]}${next.r1}:${m[5]}${next.r2}` : m[0];
        i += m[0].length;
        continue;
      }
      if (ch === "'") { let j = i + 1; while (j < f.length && !(f[j] === "'" && f[j + 1] !== "'")) j += f[j] === "'" ? 2 : 1; out += f.slice(i, j + 1); i = j + 1; continue; }
      const word = /^[\w$.À-￿]+/.exec(f.slice(i))[0]; // a name or number: copied whole, never read as a reference from its middle
      out += word; i += word.length; continue;
    }
    out += ch; i++;
  }
  return out;
}

/** A formula copied `delta` rows down: relative row references move, absolute ($) ones stay. */
export const translateRows = (formula, delta) => mapRefs(formula, ref => ({ r1: ref.abs1 ? ref.r1 : ref.r1 + delta, r2: ref.abs2 ? ref.r2 : ref.r2 + delta }));

const RANGE_A1 = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i;
const isFormula = v => v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v);
const hasValue = v => v != null && v !== '' && !(typeof v === 'object' && !isFormula(v) && !(v instanceof Date) && !v.richText && !v.text && !v.error && v.hyperlink == null);
const clone = o => (o ? structuredClone(o) : o);

/**
 * rows: [[value…] (from the table's first column) | { header: value }], sheet?: name (default: the first sheet).
 * → { buffer, sheet, range: 'Log!A11:C12', inserted (rows went in above totals), widened: [{ where, before, after }],
 *   carried: [column letters whose formula came down], problems, unchecked }. Throws (400) before touching anything.
 */
export async function sheetAppendRows(buffer, rows, { sheet } = {}) {
  const lost = await unsupportedParts(buffer);
  if (lost.length) throw bad(`This workbook has ${lost.join(', ')}, which I can’t keep when I save it, so I haven’t changed it. `
    + 'I can make a new spreadsheet with the rows added instead (make_spreadsheet), or they can add them in Excel.');
  if (!Array.isArray(rows) || !rows.length) throw bad('Give at least one row to add.');
  if (rows.length > MAX_APPEND) throw bad(`That’s more than ${MAX_APPEND} rows in one go; split them.`);
  const ExcelJS = await excelLib();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = sheet ? wb.worksheets.find(w => w.name.toLowerCase() === String(sheet).trim().toLowerCase()) : wb.worksheets[0];
  if (!ws) throw bad(`There’s no sheet called “${sheet}”. Sheets: ${wb.worksheets.map(w => w.name).join(', ')}.`);
  const same = name => name == null || name.toLowerCase() === ws.name.toLowerCase();

  // Shared formulas become plain ones first: references are about to move, and a clone is stored relative to its master.
  for (const w of wb.worksheets) w.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: false }, cell => {
    const v = cell.value;
    if (isFormula(v) && (v.sharedFormula || v.shareType)) cell.value = { formula: cell.formula, ...(v.result !== undefined ? { result: v.result } : {}) };
  }));

  // ---- 1. Where the data ends ----
  const used = r => { const row = ws.getRow(r); let any = false; row.eachCell({ includeEmpty: false }, c => { if (hasValue(c.value)) any = true; }); return any; };
  let lastUsed = 0, first = 0;
  ws.eachRow({ includeEmpty: false }, (row, r) => { if (used(r)) { lastUsed = r; first ||= r; } });
  if (!lastUsed) throw bad(`“${ws.name}” is empty: there’s no table to add to. Use sheet_set_cells to write the first rows (a header row, then data).`);
  const tables = ws.getTables().map(t => t.table || t.model).filter(t => t?.tableRef);
  const tableTotals = new Set(tables.filter(t => t.totalsRow).map(t => Number(RANGE_A1.exec(t.tableRef)?.[4])));
  const formulasOf = r => { const out = []; ws.getRow(r).eachCell({ includeEmpty: false }, (c, col) => { if (isFormula(c.value)) out.push({ col, formula: c.formula }); }); return out; };
  const isTotals = r => tableTotals.has(r) || formulasOf(r).some(({ col, formula }) => {
    let sums = false;
    mapRefs(formula, ref => { if (same(ref.sheet) && !ref.single && ref.r2 > ref.r1 && ref.r2 < r) sums = true; return null; });
    const above = ws.getCell(r - 1, col);
    return sums && !(isFormula(above.value) && translateRows(formula, -1) === above.formula); // filled down: a running total
  });
  let lastData = first, trailing = 0;
  for (let r = lastUsed; r > first; r--) {
    if (!used(r)) continue;
    if (trailing < 5 && isTotals(r)) { trailing++; continue; }
    lastData = r;
    break;
  }
  // The table: the unbroken run of rows ending at the last data row; its columns are what its last rows use (a title or a
  // summary cell above a blank row doesn't widen it).
  let top = lastData;
  while (top > first && used(top - 1)) top--;
  let c1 = Infinity, c2 = 0;
  for (let r = Math.max(top, lastData - 19); r <= lastData; r++) ws.getRow(r).eachCell({ includeEmpty: false }, (c, col) => { if (hasValue(c.value)) { c1 = Math.min(c1, col); c2 = Math.max(c2, col); } });
  // Its header (for rows given as { header: value }): the first all-text row at or above the data that is as full as the
  // fullest data row (a one-cell title above the table is skipped).
  const filled = r => { let k = 0; for (let c = c1; c <= c2; c++) if (hasValue(ws.getCell(r, c).value)) k++; return k; };
  const allText = r => { for (let c = c1; c <= c2; c++) { const v = ws.getCell(r, c).value; if (hasValue(v) && typeof v !== 'string' && !v?.richText) return false; } return true; };
  let fullest = 1;
  for (let r = Math.max(first, lastData - 19); r <= lastData; r++) fullest = Math.max(fullest, filled(r));
  let header = 0;
  for (let r = first; r <= lastData && !header; r++) if (allText(r) && filled(r) >= fullest) header = r;
  const hasData = !header || lastData > header;
  const headers = header ? Array.from({ length: c2 - c1 + 1 }, (_, k) => shown(ws.getCell(header, c1 + k).value).trim()) : [];

  // The new rows as value arrays across the table's columns.
  const grid = rows.map((row, n) => {
    if (Array.isArray(row)) {
      if (row.length > c2 - c1 + 1) throw bad(`Row ${n + 1} has ${row.length} values, but the table has ${c2 - c1 + 1} columns (${colName(c1)}–${colName(c2)}${headers.length ? `: ${headers.join(', ')}` : ''}).`);
      return Array.from({ length: c2 - c1 + 1 }, (_, k) => row[k]);
    }
    if (!row || typeof row !== 'object') throw bad(`Row ${n + 1} should be a list of values or an object of { header: value }.`);
    if (!headers.length) throw bad('This table has no header row, so give each row as a list of values.');
    const out = Array(c2 - c1 + 1).fill(undefined);
    for (const [k, v] of Object.entries(row)) {
      const at = headers.findIndex(h => h.toLowerCase() === k.trim().toLowerCase());
      if (at < 0) throw bad(`Row ${n + 1}: there’s no column “${k}”. Columns: ${headers.filter(Boolean).join(', ')}.`);
      out[at] = v;
    }
    return out;
  });

  // ---- 2 + 3. Make room (when something sits below) and move every reference ----
  const pos = lastData + 1, n = grid.length;
  let below = false;
  for (let r = pos; r <= lastUsed && !below; r++) for (let c = c1; c <= c2; c++) if (hasValue(ws.getCell(r, c).value)) { below = true; break; }
  const shiftRow = r => (below && r >= pos ? r + n : r);
  const widenable = ref => ref.r2 === lastData && ref.r1 <= lastData && ref.r1 >= first && ref.c1 <= c2 && ref.c2 >= c1;
  const move = (ref, { widen = true } = {}) => {
    let r1 = shiftRow(ref.r1), r2 = shiftRow(ref.r2);
    if (widen && hasData && !ref.single && widenable(ref)) r2 = lastData + n;
    return r1 === ref.r1 && r2 === ref.r2 ? null : { r1, r2 };
  };
  const widened = [];
  if (below) {
    const merges = (ws.model.merges || []).map(m => { const x = RANGE_A1.exec(m); return { m, r1: Number(x[2]), r2: Number(x[4] || x[2]), a: x[1], b: x[3] || x[1] }; });
    const split = merges.find(x => x.r1 < pos && x.r2 >= pos);
    if (split) throw bad(`Merged cells ${split.m} span the place the new rows go, so I can’t insert them without breaking it. They can unmerge it in Excel, or I can make a new spreadsheet.`);
    const moving = merges.filter(x => x.r1 >= pos);
    for (const x of moving) ws.unMergeCells(x.m);
    // Whole rows move through exceljs's row model (values, styles, notes, height), bottom first.
    for (let r = ws.rowCount; r >= pos; r--) {
      const m = ws.getRow(r).model ? structuredClone(ws.getRow(r).model) : null;
      const to = r + n;
      ws.getRow(to).model = m ? { ...m, number: to, cells: m.cells.map(c => ({ ...c, address: c.address.replace(/\d+$/, String(to)) })) } : { number: to, cells: [] };
      ws.getRow(r).model = { number: r, cells: [] };
    }
    for (const x of moving) ws.mergeCells(`${x.a}${x.r1 + n}:${x.b}${x.r2 + n}`);
    const dv = ws.dataValidations.model;
    const rowOf = key => Number(/^[A-Z]{1,3}(\d+)$/i.exec(key)?.[1] || 0);
    for (const key of Object.keys(dv).filter(k => rowOf(k) >= pos).sort((a, b) => rowOf(b) - rowOf(a))) {
      dv[key.replace(/\d+$/, String(rowOf(key) + n))] = dv[key];
      delete dv[key];
    }
  }
  // Formulas everywhere; the data rows' own formulas only move (never widen).
  for (const w of wb.worksheets) w.eachRow({ includeEmpty: false }, (row, r) => row.eachCell({ includeEmpty: false }, (cell, col) => {
    const v = cell.value;
    if (!isFormula(v)) return;
    const inData = w === ws && r >= top && r <= lastData && col >= c1 && col <= c2;
    let grew = false;
    const next = mapRefs(v.formula, ref => {
      if (!(ref.sheet == null ? w === ws : same(ref.sheet))) return null;
      const out = move(ref, { widen: !inData });
      if (out && !ref.single && out.r2 - out.r1 > ref.r2 - ref.r1) grew = true;
      return out;
    });
    if (next !== v.formula) {
      if (grew) widened.push({ where: `${sheetLabel(w.name)}!${colName(col)}${r}`, before: `=${v.formula}`, after: `=${next}` });
      cell.value = { formula: next, ...(v.result !== undefined ? { result: v.result } : {}) };
    }
  }));
  const moveRange = (text, where) => {
    const next = mapRefs(text, ref => (same(ref.sheet) ? move(ref) : null));
    if (next !== text && where) widened.push({ where, before: text, after: next });
    return next;
  };
  wb.definedNames.model = wb.definedNames.model.map(d => ({ ...d, ranges: d.ranges.map(rg => {
    const next = mapRefs(rg, ref => (ref.sheet && same(ref.sheet) ? move(ref) : null));
    if (next !== rg) widened.push({ where: `name ${d.name}`, before: rg, after: next });
    return next;
  }) }));
  for (const cf of ws.conditionalFormattings || []) {
    cf.ref = String(cf.ref).split(/\s+/).map(rg => moveRange(rg)).join(' ');
    for (const rule of cf.rules || []) if (Array.isArray(rule.formulae)) rule.formulae = rule.formulae.map(f => (typeof f === 'string' ? mapRefs(f, ref => (same(ref.sheet ?? ws.name) ? move(ref, { widen: false }) : null)) : f));
  }
  for (const t of tables) {
    t.tableRef = moveRange(t.tableRef, `table ${t.name}`);
    if (t.autoFilterRef) t.autoFilterRef = moveRange(t.autoFilterRef);
  }
  if (typeof ws.autoFilter === 'string') ws.autoFilter = moveRange(ws.autoFilter);
  if (ws.pageSetup?.printArea) ws.pageSetup.printArea = String(ws.pageSetup.printArea).split(',').map(rg => moveRange(rg)).join(',');

  // ---- 4. Write the rows: values, formulas carried down, the style and validation of the row above ----
  const carried = new Set();
  const model = hasData ? ws.getRow(lastData) : null;
  const dv = ws.dataValidations.model;
  grid.forEach((values, k) => {
    const r = pos + k, row = ws.getRow(r);
    if (model?.height) row.height = model.height;
    values.forEach((raw, j) => {
      const col = c1 + j, cell = row.getCell(col), above = model?.getCell(col);
      const ref = `${sheetLabel(ws.name)}!${colName(col)}${r}`;
      if (above) { cell.style = clone(above.style) || {}; const v = dv[`${colName(col)}${lastData}`]; if (v) dv[`${colName(col)}${r}`] = clone(v); }
      const empty = raw === undefined || raw === null || raw === '';
      if (empty && above && isFormula(above.value)) { cell.value = { formula: translateRows(above.formula, r - lastData) }; carried.add(colName(col)); return; }
      if (typeof raw === 'string' && raw.startsWith('=')) cell.value = { formula: excelFormula(raw, ref) };
      else if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && (above?.value instanceof Date || /[dmy]/i.test(cell.numFmt || ''))) cell.value = new Date(`${raw}T00:00:00Z`);
      else cell.value = empty ? null : raw;
    });
  });

  const check = cacheResults(wb);
  wb.calcProperties.fullCalcOnLoad = true;
  return {
    buffer: Buffer.from(await wb.xlsx.writeBuffer()), sheet: ws.name, range: `${sheetLabel(ws.name)}!${colName(c1)}${pos}:${colName(c2)}${pos + n - 1}`,
    inserted: below, widened, carried: [...carried], ...check,
  };
}

const sheetLabel = name => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

// ---- Word -----------------------------------------------------------------------------------------------------------
const PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const kids = (el, name) => [...el.childNodes].filter(n => n.nodeName === name);

/**
 * placeholders: { name: value } for {{name}} tags; replace: [{ find, replace }] phrases (exact, case-sensitive).
 * → { buffer, filled: [names], unfilled: [tags still in the document], notFound: [placeholder names / phrases with no match],
 *   replaced: [{ find, count }] }.
 */
export async function docxFill(buffer, { placeholders = {}, replace = [] } = {}) {
  let bytes = buffer;
  const filled = [], notFound = [];
  let unfilled = [];
  const names = Object.keys(placeholders || {});
  if (names.length) {
    const zip = new PizZip(bytes);
    let doc;
    try {
      doc = new Docxtemplater(zip, { delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true, errorLogging: false,
        parser: tag => ({ get: scope => scope[tag.trim()] }), // "{{ name }}" and "{{name}}" are the same placeholder
        nullGetter: part => `{{${part.value}}}` }); // a tag nobody gave a value for stays visible
    } catch (err) {
      const why = (err.properties?.errors || [err]).map(e => e.properties?.explanation || e.message).slice(0, 3).join('; ');
      throw bad(`The placeholders in this document can’t be read: ${why}. Fix them in Word, or use replace with the exact text.`);
    }
    // The document's tags, read from its text as docxtemplater joins it (a tag Word split across runs reads whole).
    const tags = [...new Set([...doc.getFullText().matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(x => x[1]))];
    if (tags.some(t => /^[#/^@]/.test(t))) throw bad(`This document uses template logic ({{#…}}, {{/…}}, {{@…}}) that I don’t fill. I only fill plain {{name}} placeholders.`);
    doc.render(Object.fromEntries(names.map(n => [n, placeholders[n] == null ? '' : String(placeholders[n])])));
    bytes = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    for (const n of names) (tags.includes(n) ? filled : notFound).push(n);
    unfilled = tags.filter(t => !names.includes(t));
  }
  const replaced = [];
  if ((replace || []).length) {
    const zip = await JSZip.loadAsync(bytes);
    const counts = new Map(replace.map(r => [r.find, 0]));
    for (const name of Object.keys(zip.files).filter(n => PARTS.test(n))) {
      const xml = await zip.file(name).async('string');
      const dom = new DOMParser().parseFromString(xml, 'text/xml');
      let touched = false;
      for (const p of [...dom.getElementsByTagName('w:p')]) {
        for (const { find, replace: to } of replace) {
          if (!find) continue;
          const n = replaceInParagraph(p, String(find), String(to ?? ''));
          if (n) { counts.set(find, counts.get(find) + n); touched = true; }
        }
      }
      if (touched) zip.file(name, dom.toString());
    }
    for (const [find, count] of counts) { replaced.push({ find, count }); if (!count) notFound.push(find); }
    bytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  }
  if (!names.length && !(replace || []).length) throw bad('Nothing to fill: give placeholders or phrases to replace.');
  return { buffer: Buffer.from(bytes), filled, unfilled, notFound, replaced };
}

// Runs whose content is only formatting and text can be merged and edited; anything else (a tab, a break, a picture, a
// field) is a wall a phrase can't cross.
const TEXT_ONLY = run => [...run.childNodes].every(n => n.nodeType !== 1 || ['w:rPr', 'w:t', 'w:lastRenderedPageBreak'].includes(n.nodeName));
const rPrOf = run => kids(run, 'w:rPr')[0]?.toString() || '';
const textOf = run => kids(run, 'w:t').map(t => t.textContent).join('');
function setText(run, text) {
  const ts = kids(run, 'w:t');
  for (const t of ts.slice(1)) t.remove();
  let t = ts[0];
  if (!t) { t = run.ownerDocument.createElement('w:t'); run.appendChild(t); }
  t.textContent = text;
  t.setAttribute('xml:space', 'preserve');
  for (const x of kids(run, 'w:lastRenderedPageBreak')) x.remove();
}

/** Replace every `find` in one paragraph's text (its own runs, not nested text boxes) → how many. */
function replaceInParagraph(p, find, to) {
  const own = el => { let a = el.parentNode; while (a && a.nodeName !== 'w:p') a = a.parentNode; return a === p; };
  // Spell-check marks sit between runs and split them; they carry nothing.
  for (const pe of [...p.getElementsByTagName('w:proofErr')].filter(own)) pe.remove();
  const runs = [...p.getElementsByTagName('w:r')].filter(own);
  if (!runs.map(textOf).join('').includes(find)) return 0;
  // Merge neighbours with the same formatting and parent.
  for (let i = runs.length - 1; i > 0; i--) {
    const a = runs[i - 1], b = runs[i];
    if (a.nextSibling === b && a.parentNode === b.parentNode && TEXT_ONLY(a) && TEXT_ONLY(b) && rPrOf(a) === rPrOf(b)) {
      setText(a, textOf(a) + textOf(b));
      b.remove();
      runs.splice(i, 1);
    }
  }
  // Groups of adjacent text-only runs (siblings with nothing between them); find within each group's text.
  let count = 0;
  const groups = [];
  for (const r of runs) {
    const last = groups.at(-1);
    if (!TEXT_ONLY(r)) { groups.push([]); continue; }
    if (last?.length && last.at(-1).nextSibling === r) last.push(r); else groups.push([r]);
  }
  for (const g of groups.filter(x => x.length)) {
    let from = 0;
    for (;;) {
      const texts = g.map(textOf);
      const at = texts.join('').indexOf(find, from);
      if (at < 0) break;
      let pos = 0, i = 0;
      while (pos + texts[i].length <= at) { pos += texts[i].length; i++; }
      const end = at + find.length;
      let j = i, jpos = pos;
      while (jpos + texts[j].length < end) { jpos += texts[j].length; j++; }
      if (i === j) setText(g[i], texts[i].slice(0, at - pos) + to + texts[i].slice(end - pos));
      else { // spans runs: the replacement takes the formatting of the run the phrase starts in
        setText(g[i], texts[i].slice(0, at - pos) + to);
        for (let k = i + 1; k < j; k++) setText(g[k], '');
        setText(g[j], texts[j].slice(end - jpos));
      }
      for (let k = g.length - 1; k > i; k--) if (!textOf(g[k])) { g[k].remove(); g.splice(k, 1); }
      from = at + to.length;
      count++;
    }
  }
  return count;
}
