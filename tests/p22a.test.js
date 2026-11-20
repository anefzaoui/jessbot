// Phase 22 part A (decisions #131–#134): office files that are right when opened anywhere, one theme table, slides with
// layouts and a fit check, Word polish, make_pdf page breaks + maths, in-place edits of uploads, PDF forms for families.
// Run: npm test  (node --test, throwaway data dir, no network). Files are read back with independent readers
// (mammoth, officeparser, JSZip on the raw XML, pdf.js via unpdf), not with the library that wrote them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-p22a-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';

const { openDb, closeDb } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser } = await import('../src/services/users.js');
const office = await import('../src/services/office.js');
const themes = await import('../src/services/themes.js');
const JSZip = (await import('jszip')).default;
const mammoth = (await import('mammoth')).default;
const ExcelJS = (await import('exceljs')).default;
const { parseOffice } = await import('officeparser');

const fx = f => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', f));
const xmlOf = async (buf, name) => (await JSZip.loadAsync(buf)).file(name)?.async('string');
const officeParserText = async buf => { const ast = await parseOffice(buf, { newlineDelimiter: '\n' }); return String((await ast.to('text')).value || ''); };

// A real PNG (solid teal), made here so the test needs no image files.
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o + 1] = 113; raw[o + 2] = 124; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let alice;
before(async () => { alice = await createUser({ name: 'Alice Office', email: 'alice.office@t.dev', password: 'correct horse battery' }); });
after(() => { closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

// A tool call as the agent loop makes it.
async function toolCtx(user) {
  const { mainThread } = await import('../src/services/threads.js');
  const runs = await import('../src/services/runs.js');
  const thread = mainThread(user.id);
  const r = runs.createRun({ threadId: thread.id, userId: user.id, triggerMessageId: null, model: 'x' });
  return { user, thread, run: runs.getRun(r.id) };
}
async function tool(name) {
  const { getTool } = await import('../src/agent/tools/registry.js');
  await import('../src/agent/tools/index.js');
  return getTool(name);
}

// ---- Themes ---------------------------------------------------------------------------------------------------------
test('themes: every theme passes WCAG contrast for how each role is used; the default is Harbor, not violet', () => {
  assert.ok(themes.THEME_IDS.length >= 8 && themes.THEME_IDS.length <= 12);
  assert.equal(themes.DEFAULT_THEME, 'jess');
  for (const id of themes.THEME_IDS) {
    const t = themes.THEMES[id];
    for (const role of ['paper', 'ink', 'muted', 'accent', 'accent2', 'tint', 'line', 'dark', 'onDark', 'onDarkMuted']) assert.match(t[role], /^[0-9A-F]{6}$/, `${id}.${role} is 6-digit hex`);
    const c = (a, b) => themes.contrast(t[a], t[b]);
    assert.ok(c('ink', 'paper') >= 4.5, `${id}: body text on paper`);
    assert.ok(c('muted', 'paper') >= 4.5, `${id}: secondary text on paper`);
    assert.ok(c('accent', 'paper') >= 4.5, `${id}: headings and links on paper`);
    assert.ok(c('accent2', 'paper') >= 3, `${id}: big numbers / chart series on paper (large text, graphics)`);
    assert.ok(c('ink', 'tint') >= 4.5, `${id}: table header text on its fill`);
    assert.ok(c('onDark', 'dark') >= 4.5 && c('onDarkMuted', 'dark') >= 4.5, `${id}: text on title slides`);
    assert.ok(['Noto Sans', 'Noto Serif'].includes(t.headFont) && ['Noto Sans', 'Noto Serif'].includes(t.bodyFont), `${id}: PDF fonts are bundled ones`);
    assert.ok(['Calibri', 'Cambria', 'Arial', 'Georgia'].includes(t.officeFonts.head) && ['Calibri', 'Arial'].includes(t.officeFonts.body), `${id}: Office-safe fonts`);
  }
  assert.equal(themes.contrast('000000', 'FFFFFF').toFixed(0), '21');
  assert.equal(themes.themeOf('nope').id, 'jess', 'an unknown theme falls back to the default');
  const jess = themes.themeOf();
  for (const violet of ['6D5BF4', '8B7CF6', 'EEEBFD', '3B2FC9']) assert.ok(!Object.values(jess).includes(violet));
  assert.match(fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'services', 'themes-LICENSE.txt'), 'utf8'), /Apache License[\s\S]*Anthropic/, 'the adapted palettes carry their licence');
});

// ---- Excel ----------------------------------------------------------------------------------------------------------
test('xlsx: formula problems reported by cell; results cached; recalculated on open; functions Excel needs prefixed', async () => {
  const book = await office.makeWorkbook([{ name: 'Budget', columns: [{ header: 'Item' }, { header: 'Qty', format: 'integer', input: true }, { header: 'Price', format: 'currency' }, { header: 'Total', format: 'currency' }, { header: 'Note' }],
    rows: [['Rent', 1, 900, '=B2*C2', '=IFS(B2>0,"yes",TRUE,"no")'], ['Food', 0, 75.5, '=C3/B3', '=TEXTJOIN(", ",TRUE,A2:A3)'], ['Loan', 1, 2, '=PMT(0.05/12,360,200000)', '=COUNTA(A2:A4)'],
      ['Loop', 1, 1, '=D5+1', '=NOSUCHFN(1)'], ['Look', 1, 1, '=XLOOKUP("Food",A2:A3,C2:C3)', '=STDEV.S(C2:C4)']], totals: [3],
    notes: [{ cell: 'C2', text: 'From the lease' }], freeze: { rows: 1, columns: 1 } }], { title: 'Budget', theme: 'ocean' });
  // What Jess is told.
  assert.deepEqual(book.problems.map(p => [p.ref, p.error, p.formula]), [['Budget!D3', '#DIV/0!', '=C3/B3'], ['Budget!D5', '#CIRCULAR', '=D5+1'], ['Budget!E5', '#NAME?', '=NOSUCHFN(1)']]);
  assert.match(book.problems[2].hint, /NOSUCHFN isn’t an Excel function/);
  assert.deepEqual(book.unchecked, ['XLOOKUP'], 'a real Excel function we can’t compute is left for Excel, not called a mistake');
  const report = office.formulaReport(book);
  assert.match(report, /^3 formula problems: Budget!D3 = #DIV\/0! \(=C3\/B3\); Budget!D5 = #CIRCULAR/);
  assert.match(report, /couldn’t compute XLOOKUP/);
  assert.equal(office.formulaReport({ problems: [], unchecked: [] }), '');

  // The raw XML (independent of exceljs): prefixes, cached values, error cells, full calc on load, freeze, the note.
  const sheet = await xmlOf(book.buffer, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<c r="E2"[^>]*t="str"><f>_xlfn\.IFS\(B2&gt;0,&quot;yes&quot;,TRUE,&quot;no&quot;\)<\/f><v>yes<\/v>/);
  assert.match(sheet, /<f>_xlfn\.TEXTJOIN\([^<]*<\/f><v>Rent, Food<\/v>/);
  assert.match(sheet, /<f>_xlfn\.XLOOKUP\(/);
  assert.match(sheet, /<f>_xlfn\.STDEV\.S\(C2:C4\)<\/f><v>498\.59/);
  assert.match(sheet, /<c r="D2"[^>]*><f>B2\*C2<\/f><v>900<\/v>/, 'a plain formula keeps its result');
  assert.match(sheet, /<c r="D3"[^>]*t="e"><f>C3\/B3<\/f><v>#DIV\/0!<\/v>/, 'an Excel error is stored as an error');
  assert.match(sheet, /<f>PMT\(0\.05\/12,360,200000\)<\/f><v>-1073\.64/, 'PMT (via formulajs) computes');
  assert.match(sheet, /<f>COUNTA\(A2:A4\)<\/f><v>3<\/v>/);
  assert.doesNotMatch(sheet, /<f>D5\+1<\/f><v>/, 'no made-up value for a circular reference');
  assert.match(sheet, /<pane xSplit="1" ySplit="1"[^>]*state="frozen"/);
  assert.match(await xmlOf(book.buffer, 'xl/workbook.xml'), /<calcPr[^>]*fullCalcOnLoad="1"/);
  const zip = await JSZip.loadAsync(book.buffer);
  const comments = await zip.file(Object.keys(zip.files).find(f => /comments\d*\.xml$/.test(f))).async('string');
  assert.match(comments, /From the lease/);
  // officeparser reads the cached values (what a previewer that doesn't calculate shows).
  const text = await officeParserText(book.buffer);
  assert.match(text, /yes/); assert.match(text, /Rent, Food/); assert.match(text, /-1073\.6/);
  // exceljs: input styling and the themed header, only on the table's own cells.
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(book.buffer);
  const ws = wb.getWorksheet('Budget');
  assert.equal(ws.getCell('B2').font.color.argb, 'FF0000FF', 'input column: blue text');
  assert.equal(ws.getCell('B2').fill.fgColor.argb, 'FFFFF8DC', 'input column: light fill');
  assert.equal(ws.getCell('A1').fill.fgColor.argb, `FF${themes.THEMES.ocean.tint}`);
  assert.equal(ws.getCell('F1').fill, undefined, 'the header fill stops at the table');
  // Previews and Jess read the computed values.
  const shown = office.sheetsText(await office.xlsxSheets(book.buffer));
  // Numbers as their column's format shows them (#207): currency with 2 decimals, integers with none.
  assert.match(shown, /\| Rent \| 1 \| 900\.00 \| 900\.00 \| yes \|/);
  assert.match(shown, /\| Food \| 0 \| 75\.50 \| #DIV\/0! \|/);
});

test('xlsx: dynamic-array functions are refused with a clear message; strings and sheet names are never rewritten', async () => {
  for (const f of ['=FILTER(A2:A9,B2:B9>1)', '=SUM(UNIQUE(A2:A9))', '=SORT(A2:A9)', '=SEQUENCE(5)', '=LET(x,1,x+1)', '=_xlfn._xlws.FILTER(A:A,B:B)']) {
    await assert.rejects(office.makeWorkbook([{ name: 'S', columns: [{ header: 'A' }], rows: [[f]] }]),
      err => err.status === 400 && /S!A2 uses [A-Z]+, a dynamic-array function/.test(err.message) && /SUMIFS/.test(err.message), f);
  }
  assert.equal(office.excelFormula(`=IF(A1="IFS(",CONCAT("x",'IFS sheet'!A1),_xlfn.IFS(1,2))`), `IF(A1="IFS(",_xlfn.CONCAT("x",'IFS sheet'!A1),_xlfn.IFS(1,2))`);
  assert.equal(office.excelFormula('=ifna(A1,0)+Sum(B1:B2)'), '_xlfn.IFNA(A1,0)+Sum(B1:B2)', 'case-insensitive; classic functions untouched');
  assert.equal(office.excelFormula('="He said ""FILTER("" once"'), '="He said ""FILTER("" once"'.slice(1), 'a function name inside a string is text');
});

// ---- Word -----------------------------------------------------------------------------------------------------------
test('docx: DXA table widths on table, grid and cells; page size by locale; Page X of Y footer; contents with 3+ sections; Library images', async () => {
  const images = new Map([['abcdef123', { data: png(400, 200), type: 'png', width: 400, height: 200, title: 'Teal' }]]);
  const md = '# Family plan\n\nIntro with a [link](https://example.com) and an [app link](/library/xyz).\n\n## Budget\n\n| Item | Monthly cost | Note |\n|---|---|---|\n'
    + '| Rent | 900 | Due on the 1st of every month, paid by bank transfer |\n\n## Trips\n\n![Our photo](/library/abcdef123)\n\n## School\n\nText.\n\n### Details\n\nمرحبا بك في الفريق.';
  assert.deepEqual(office.libraryImageIds(md), ['abcdef123']);
  const docx = await office.docxFromMarkdown(md, { title: 'Plan', theme: 'ocean', page: 'Letter', images });
  const xml = await xmlOf(docx, 'word/document.xml');
  const textWidth = 12240 - 2 * 1440;
  assert.match(xml, new RegExp(`<w:tblW w:type="dxa" w:w="${textWidth}"/>`), 'the table is as wide as the text, in DXA');
  const grid = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(m => Number(m[1]));
  assert.equal(grid.length, 3);
  assert.equal(grid.reduce((a, b) => a + b, 0), textWidth, 'column widths add up to the text width');
  assert.ok(grid[2] > grid[1] && grid[1] > grid[0], `wider columns for longer content: ${grid}`);
  assert.deepEqual([...xml.matchAll(/<w:tcW w:type="dxa" w:w="(\d+)"\/>/g)].slice(0, 3).map(m => Number(m[1])), grid, 'every cell carries its width');
  assert.doesNotMatch(xml, /w:type="pct"/, 'no percentage widths');
  assert.match(xml, /<w:pgSz w:w="12240" w:h="15840"/, 'Letter');
  assert.match(xml, /<w:instrText xml:space="preserve">TOC \\h \\o &quot;2-3&quot;<\/w:instrText>/, 'a contents field over the sections');
  assert.match(xml, /<w:bidi\/>[\s\S]*مرحبا/, 'Arabic stays right-to-left');
  const zip = await JSZip.loadAsync(docx);
  const footer = await zip.file(Object.keys(zip.files).find(f => /^word\/footer\d*\.xml$/.test(f))).async('string');
  assert.match(footer, /Page <\/w:t>[\s\S]*PAGE[\s\S]* of <\/w:t>[\s\S]*NUMPAGES/, 'a Page X of Y footer');
  assert.match(footer, /<w:jc w:val="center"\/>/);
  assert.ok(Object.keys(zip.files).some(f => /^word\/media\/.+\.png$/.test(f)), 'the Library picture is embedded');
  // mammoth (an independent reader) sees the structure.
  const html = (await mammoth.convertToHtml({ buffer: docx })).value;
  assert.match(html, /<h1>Family plan<\/h1><p>Intro with a <a href="https:\/\/example.com">link<\/a> and an app link\.<\/p><h2>Contents<\/h2>/, 'contents after the intro; app links become plain text');
  assert.match(html, /<thead><tr><th>[\s\S]*Item[\s\S]*<\/thead><tbody><tr><td><p>Rent<\/p><\/td>/, 'one header row, then body rows');
  assert.match(html, /<img alt="Our photo" src="data:image\/png;base64,/);
  // Two sections: no contents; A4 by default; a missing picture shows its alt text.
  const small = await office.docxFromMarkdown('# Note\n\n## One\n\nx\n\n## Two\n\n![Gone](/library/missing99)');
  const smallXml = await xmlOf(small, 'word/document.xml');
  assert.doesNotMatch(smallXml, /TOC \\h/);
  assert.match(smallXml, /<w:pgSz w:w="11906" w:h="16838"/, 'A4');
  assert.match(smallXml, /\[Gone\]/);
  // Paper by locale.
  assert.equal(office.paperFor({ countryCode: 'us' }), 'Letter');
  assert.equal(office.paperFor({ countryCode: 'DE', timezone: 'America/New_York' }), 'A4', 'a known country wins over the clock');
  assert.equal(office.paperFor({ timezone: 'America/Toronto' }), 'Letter');
  assert.equal(office.paperFor({ timezone: 'America/Sao_Paulo' }), 'A4');
  assert.equal(office.paperFor({}), 'A4');
});

// ---- PowerPoint -----------------------------------------------------------------------------------------------------
const SLIDES = [
  { layout: 'bullets', title: 'Why we should move in spring', bullets: ['Rent is 12% lower from March', 'The school year ends in June'], notes: 'Mention the lease end date.' },
  { layout: 'section', title: 'The numbers' },
  { layout: 'stats', title: 'What changes', stats: [{ value: '−12%', label: 'monthly rent' }, { value: '25 min', label: 'shorter school run' }, { value: '3', label: 'bedrooms' }] },
  { layout: 'two_column', title: 'Two neighbourhoods', columns: [{ heading: 'Hillside', bullets: ['Closer to school'] }, { heading: 'Riverside', bullets: ['Cheaper', 'Bigger flats'] }] },
  { layout: 'comparison', title: 'Three flats', columns: [{ heading: 'Flat A', bullets: ['900 EUR'] }, { heading: 'Flat B', bullets: ['850 EUR'] }, { heading: 'Flat C', bullets: ['1,000 EUR'] }] },
  { layout: 'quote', title: 'What the kids said', quote: 'Can we have a room each this time?', attribution: 'Theo, 9' },
  { layout: 'timeline', title: 'The plan', steps: [{ label: 'Oct', text: 'Visit flats' }, { label: 'Dec', text: 'Sign' }, { label: 'Mar', text: 'Move in' }] },
  { layout: 'chart', title: 'Monthly costs', chart: { type: 'bar', labels: ['Rent', 'Food'], series: [{ name: 'Now', values: [1000, 600] }, { name: 'After', values: [880, 600] }] }, caption: 'Food stays the same.' },
  { layout: 'chart', title: 'Where it goes', chart: { type: 'pie', labels: ['Rent', 'Food'], series: [{ name: 'Share', values: [880, 600] }] } },
  { layout: 'image', title: 'The garden at Flat B', image: 'img123456', caption: 'Photo from the visit.' },
  { layout: 'two_column', title: 'Flat B up close', bullets: ['South facing', 'Parking'], image: 'img123456' },
  { layout: 'closing', title: 'Questions?', bullets: ['Tell me which flat you like'] },
];
const IMAGES = new Map([['img123456', { data: png(320, 200), type: 'png', width: 320, height: 200 }]]);

test('pptx: every layout renders and reads back (LTR and RTL); charts are native; no stripes; notes kept', async () => {
  const buf = await office.pptxFromSlides(SLIDES, { title: 'Moving house', subtitle: 'A plan for spring', theme: 'sunset', images: IMAGES });
  const text = await office.officeText(buf); // officeparser: an independent reader
  for (const s of ['Moving house', 'A plan for spring', 'Rent is 12% lower from March', '01', 'The numbers', '−12%', 'shorter school run', 'Hillside', 'Closer to school',
    'Flat C', '1,000 EUR', 'Can we have a room each this time?', 'Theo, 9', 'Visit flats', 'Food stays the same.', 'The garden at Flat B', 'Questions?', 'Mention the lease end date.']) {
    assert.ok(text.includes(s), `“${s}” is in the deck`);
  }
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  assert.equal(slides.length, SLIDES.length + 1, 'a title slide plus every slide');
  const charts = Object.keys(zip.files).filter(f => /^ppt\/charts\/chart\d+\.xml$/.test(f));
  assert.equal(charts.length, 2, 'two native charts');
  const chartXml = (await Promise.all(charts.map(f => zip.file(f).async('string')))).join('');
  assert.match(chartXml, /<c:barChart>/); assert.match(chartXml, /<c:pieChart>/);
  assert.match(chartXml, new RegExp(themes.THEMES.sunset.accent2), 'chart colours come from the theme');
  assert.ok(Object.keys(zip.files).some(f => /^ppt\/media\//.test(f)), 'the Library picture is in the deck');
  const slideXml = n => zip.file(`ppt/slides/slide${n}.xml`).async('string');
  assert.match(await slideXml(1), new RegExp(`<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${themes.THEMES.sunset.dark}"`), 'a dark title slide');
  assert.match(await slideXml(2), /<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/, 'light content slides');
  for (const f of slides) {
    const xml = await zip.file(f).async('string');
    const bars = [...xml.matchAll(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>[\s\S]{0,200}?prstGeom prst="rect"/g)]
      .filter(m => Number(m[3]) > 11_000_000 && Number(m[4]) < 300_000 || Number(m[3]) < 150_000 && Number(m[4]) > 900_000);
    assert.equal(bars.length, 0, `${f}: no full-width bar or vertical stripe`);
  }
  // Right-to-left slides: marked RTL, columns and steps run right to left.
  const rtl = await office.pptxFromSlides([
    { layout: 'bullets', title: 'الخطة', bullets: ['الإطلاق في أكتوبر'] },
    { layout: 'timeline', title: 'المراحل', steps: [{ label: 'أكتوبر', text: 'زيارة' }, { label: 'ديسمبر', text: 'توقيع' }, { label: 'مارس', text: 'الانتقال' }] },
    { layout: 'two_column', title: 'حيّان', columns: [{ heading: 'المنزه', bullets: ['قريب من المدرسة'] }, { heading: 'أريانة', bullets: ['أرخص'] }] },
  ], { title: 'خطة الانتقال' });
  const rz = await JSZip.loadAsync(rtl);
  const s2 = await rz.file('ppt/slides/slide2.xml').async('string');
  assert.match(s2, /rtl="1"[\s\S]*الإطلاق في أكتوبر/);
  const s3 = await rz.file('ppt/slides/slide3.xml').async('string');
  const xOf = label => Number(new RegExp(`<a:off x="(\\d+)"[^]*?${label}`).exec(s3.slice(0, s3.indexOf(label) + label.length).split('<p:sp>').at(-1))?.[1]);
  assert.ok(xOf('أكتوبر') > xOf('مارس'), 'the first step is on the right');
  assert.match(await office.officeText(rtl), /خطة الانتقال[\s\S]*المراحل[\s\S]*قريب من المدرسة/);
});

test('pptx: the fit check shrinks text to a 14 pt floor, then refuses by slide name; malformed layouts are refused the same way', async () => {
  const wide = { w: 12.1, h: 5, start: 24, indent: 0.3, gap: 8 };
  assert.equal(office.fitSize(['Short one', 'Short two'], wide), 24);
  const many = Array.from({ length: 12 }, (_, i) => `Point ${i} with enough words that it wraps across the whole width of the slide at the larger sizes`);
  const size = office.fitSize(many, wide);
  assert.ok(size >= 14 && size < 24, `stepped down (${size})`);
  assert.equal(office.fitSize(Array.from({ length: 30 }, () => many[0]), wide), null);
  assert.equal(office.fitSize(['مرحبا بكم في خطة الانتقال'], { w: 3, h: 0.6, start: 20, maxLines: 1 }), 16, 'Arabic is measured too');
  const refused = async (slides, re) => assert.rejects(office.pptxFromSlides(slides, { title: 'T' }), err => err.status === 400 && re.test(err.message));
  await refused([{ title: 'Fine' }, { layout: 'bullets', title: 'Budget details', bullets: Array.from({ length: 30 }, () => many[0]) }],
    /^Slide 3 \(“Budget details”\) has more text than its layout holds, even at 14 pt: split it/);
  await refused([{ layout: 'stats', title: 'One number', stats: [{ value: '4' }] }], /Slide 2 .* needs 2 to 4 numbers/);
  await refused([{ layout: 'timeline', title: 'Two steps', steps: [{ label: 'a' }, { label: 'b' }] }], /needs 3 to 6 steps/);
  await refused([{ layout: 'chart', title: 'Bad chart', chart: { type: 'bar', labels: ['a', 'b'], series: [{ name: 'x', values: [1] }] } }], /values don’t match its 2 labels/);
  await refused([{ layout: 'chart', title: 'Two pies', chart: { type: 'pie', labels: ['a'], series: [{ values: [1] }, { values: [2] }] } }], /exactly one series/);
  await refused([{ layout: 'image', title: 'No picture', image: 'nothere99' }], /needs an image from the Library/);
  await refused([{ layout: 'comparison', title: 'One column', columns: [{ heading: 'x', bullets: ['y'] }] }], /needs 2 or 3 columns/);
  await refused([{ layout: 'bullets', title: 'A title that goes on and on and on, far past anything that could fit on two lines of a slide at twenty-two points, and then some more words, and yet more words again until it clearly cannot fit on two lines at all, not even at the smallest title size' }], /title too long/);
  // The preview and the text sidecar carry every layout's content, escaped.
  const all = [{ layout: 'title', title: 'Deck <1>' }, ...SLIDES];
  const preview = office.slidesPreviewHtml(all);
  assert.match(preview, /Deck &lt;1&gt;/);
  assert.match(preview, /data-layout="stats"[\s\S]*<strong>−12%<\/strong> monthly rent/);
  assert.match(preview, /data-layout="chart"[\s\S]*Bar chart: Rent, Food/);
  assert.match(preview, /class="slide-card is-title" data-layout="closing"/);
  const text = office.slidesText(all);
  assert.match(text, /Slide 4: What changes \(stats\)\n−12%: monthly rent/);
  assert.match(text, /Chart \(bar\): Now: Rent 1000, Food 600; After: Rent 880, Food 600/);
  assert.match(text, /Notes: Mention the lease end date\./);
});

// ---- make_pdf -------------------------------------------------------------------------------------------------------
test('make_pdf HTML: \\newpage breaks, $…$ / $$…$$ become MathML (bad ones reported), bundled fonts, theme colours; chat rendering unchanged', async () => {
  const { renderMarkdown, renderDocument } = await import('../src/lib/markdown.js');
  const md = '# Worksheet\n\nSolve $x^2 - 5x + 6 = 0$. Prices like $5 and $10 stay text; so does \\$3.\n\n$$\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$\n\n'
    + 'Inline display: $$a+b$$ here.\n\none\n\\newpage\ntwo\n\n`$code$` and a bad one: $\\frac{1$ end.\n\n![Pic](/library/abcdef123)';
  const images = new Map([['abcdef123', { data: png(4, 4), type: 'png', width: 4, height: 4 }]]);
  const { html, math, mathErrors, footer } = office.pdfHtml(md, { title: 'Worksheet', theme: 'arctic', images });
  assert.equal(math, 4);
  assert.deepEqual(mathErrors.map(e => e.tex), ['\\frac{1']);
  assert.match(html, /Solve <math><mrow><msup><mi>x<\/mi><mn[^>]*>2<\/mn><\/msup>/);
  assert.match(html, /Prices like \$5 and \$10 stay text; so does \$3\./, 'dollar amounts stay text');
  assert.match(html, /<math display="block"[^>]*><mfrac>/);
  assert.match(html, /<p dir="ltr">one<\/p>\n<div class="page-break"><\/div>\n<p dir="ltr">two<\/p>/);
  assert.match(html, /\.page-break \{ break-after: page;/);
  assert.match(html, /<code>\$code\$<\/code>/, 'code stays code');
  assert.match(html, /<code class="math-error">\$\\frac\{1\$<\/code>/, 'an unreadable formula shows its source');
  assert.match(html, /<img src="data:image\/png;base64,[^"]+" alt="Pic">/, 'Library pictures are inlined (the print page loads nothing)');
  assert.match(html, /@font-face\{font-family:"Noto Sans"[^}]*src:url\(data:font\/woff2;base64,/);
  assert.match(html, /@font-face\{font-family:"Noto Naskh Arabic"/);
  assert.match(html, /@font-face\{font-family:"STIX Two Math"/, 'the math face comes with formulas');
  assert.match(html, new RegExp(`h2 \\{[^}]*color: #${themes.THEMES.arctic.accent}`));
  assert.doesNotMatch(html, /#3b2fc9|#8b7cf6|#eeebfd/i, 'no old violet');
  assert.match(footer, /Page <span class="pageNumber"><\/span> of <span class="totalPages"><\/span>/);
  const plain = office.pdfHtml('# Hello\n\nNo formulas.');
  assert.doesNotMatch(plain.html, /@font-face\{font-family:"STIX Two Math"/, 'no math face when there are no formulas');
  assert.match(office.pdfHtml('# مرحبا\n\nنص عربي.').footer, /صفحة/, 'an Arabic document numbers pages in Arabic');
  // Chat rendering is untouched: no maths, no page breaks, still no raw HTML.
  assert.equal(renderMarkdown('A $x^2$ and\n\\newpage'), '<p dir="ltr">A $x^2$ and<br>\n\\newpage</p>\n');
  assert.doesNotMatch(renderDocument('<b>x</b> $\\href{javascript:alert(1)}{y}$').html, /<b>|href=/, 'no raw HTML and no links from formulas');
});

test('make_spreadsheet tool: a problem report Jess must act on; a clean book says nothing extra', async () => {
  const ctx = await toolCtx(alice);
  const make = await tool('make_spreadsheet');
  const bad = await make.run({ title: 'Split costs', sheets: [{ name: 'Costs', columns: [{ header: 'Who' }, { header: 'Paid', format: 'currency' }, { header: 'Share', format: 'percent' }],
    rows: [['Sam', 30, '=B2/B4'], ['Ali', 0, '=B3/B4']] }] }, ctx);
  assert.match(bad.content, /Not right yet: 2 formula problems: Costs!C2 = #DIV\/0! \(=B2\/B4\); Costs!C3 = #DIV\/0!/);
  assert.match(bad.content, /make it again with id "[\w-]+"/);
  const good = await make.run({ title: 'Totals', theme: 'forest', sheets: [{ name: 'T', columns: [{ header: 'Item' }, { header: 'A', format: 'number' }], rows: [['x', 1], ['y', 2]], totals: [1] }] }, ctx);
  assert.doesNotMatch(good.content, /problem/);
  assert.match(good.content, /^Saved “Totals” as a spreadsheet/);
});

// ---- Their own files: never regenerated; edited in place as new versions --------------------------------------------
test('uploads are never replaced by a regenerated file: a new item is made and Jess is told why; her own files get a version', async () => {
  const up = await import('../src/services/uploads.js');
  const lib = await import('../src/services/library.js');
  const u = await createUser({ name: 'Uploader Office', email: 'up.office@t.dev', password: 'correct horse battery' });
  const ctx = await toolCtx(u);
  const book = await office.xlsxFromSheets([{ name: 'Budget', columns: [{ header: 'Item' }, { header: 'Amount' }], rows: [['Rent', 900]] }]);
  const upSheet = await up.saveUpload(u, { buffer: book, originalname: 'family budget.xlsx' });
  const upDoc = await up.saveUpload(u, { buffer: fx('sample.docx'), originalname: 'notes.docx' });
  const sheetOut = await (await tool('make_spreadsheet')).run({ id: upSheet.id, title: 'Budget v2', sheets: [{ name: 'S', columns: [{ header: 'A' }], rows: [['x']] }] }, ctx);
  assert.match(sheetOut.content, /“family budget” is a file they uploaded, so I didn’t replace it[\s\S]*sheet_set_cells[\s\S]*saved “Budget v2”/);
  assert.equal(lib.itemForUser(u, upSheet.id).version, 1, 'the upload is untouched');
  assert.deepEqual(lib.readBytes(lib.itemForUser(u, upSheet.id)), book);
  const docOut = await (await tool('make_word_document')).run({ id: `/library/${upDoc.id}`, title: 'Notes v2', markdown: '# New' }, ctx);
  assert.match(docOut.content, /didn’t replace it[\s\S]*docx_fill/);
  assert.equal(lib.itemForUser(u, upDoc.id).version, 1);
  // A file Jess's browser downloaded for them is theirs too.
  const dl = await up.saveDownload(u, { buffer: book, filename: 'bank statement.xlsx', url: 'https://bank.example/statement.xlsx' });
  const dlOut = await (await tool('make_spreadsheet')).run({ id: dl.id, title: 'Statement v2', sheets: [{ name: 'S', columns: [{ header: 'A' }], rows: [['x']] }] }, ctx);
  assert.match(dlOut.content, /didn’t replace it/);
  assert.equal(lib.itemForUser(u, dl.id).version, 1);
  const mine = await (await tool('make_word_document')).run({ title: 'Mine', markdown: '# One' }, ctx);
  const id = /\/library\/([\w-]+)\)/.exec(mine.content)[1];
  const again = await (await tool('make_word_document')).run({ id, title: 'Mine', markdown: '# Two' }, ctx);
  assert.match(again.content, /^Updated “Mine” as a Word document \(docx, version 2\)/, 'a file Jess made is revised as a new version');
});

test('sheet_set_cells: cells, ranges and defined names change in place (a new version); everything else survives; unkeepable workbooks refused', async () => {
  const edit = await import('../src/services/office-edit.js');
  const up = await import('../src/services/uploads.js');
  const lib = await import('../src/services/library.js');
  const u = await createUser({ name: 'Sheet Editor', email: 'sheet.edit@t.dev', password: 'correct horse battery' });
  const ctx = await toolCtx(u);
  // A workbook as a person might have it: two sheets, a style, a note, a defined name, a live total.
  const book = await office.makeWorkbook([{ name: 'Budget', columns: [{ header: 'Item' }, { header: 'Amount', format: 'currency', input: true }], rows: [['Rent', 900], ['Food', 300]], totals: [1],
    notes: [{ cell: 'B2', text: 'From the lease' }] }, { name: 'Notes', columns: [{ header: 'Note' }], rows: [['keep me']] }]);
  const wb0 = new ExcelJS.Workbook(); await wb0.xlsx.load(book.buffer); wb0.definedNames.add("'Budget'!$B$2", 'RentCost');
  const item = await up.saveUpload(u, { buffer: Buffer.from(await wb0.xlsx.writeBuffer()), originalname: 'budget.xlsx' });
  const out = await (await tool('sheet_set_cells')).run({ id: item.id, changes: [{ target: 'RentCost', value: 950 }, { target: 'B3', formula: 'B2/3' }, { target: 'Budget!A5:B5', values: ['Bills', 120] }] }, ctx);
  assert.match(out.content, /Changed 4 cells in “budget” \(now version 2[\s\S]*Budget!B2: 900 → 950; Budget!B3: 300 → =B2\/3; Budget!A5: \(empty\) → Bills/);
  const fresh = lib.itemForUser(u, item.id);
  assert.equal(fresh.version, 2);
  assert.equal(fresh.source_label, 'Uploaded', 'still their file (so still protected from regeneration)');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(lib.readBytes(fresh));
  const ws = wb.getWorksheet('Budget');
  assert.equal(ws.getCell('B2').value, 950);
  assert.equal(ws.getCell('B2').font.color.argb, 'FF0000FF', 'the cell keeps its style');
  const note = ws.getCell('B2').note;
  assert.equal(typeof note === 'string' ? note : note?.texts?.map(t => t.text).join(''), 'From the lease', 'and its note');
  assert.equal(wb.getWorksheet('Notes').getCell('A2').value, 'keep me', 'other sheets untouched');
  const sheetXml = await xmlOf(lib.readBytes(fresh), 'xl/worksheets/sheet1.xml');
  assert.match(sheetXml, /<f>SUM\(B2:B3\)<\/f><v>1266\.66/, 'formulas recomputed: the stored total is current');
  assert.match(lib.readText(fresh), /\| Rent \| 950\.00 \|/, 'Jess reads the new values (as the currency format shows them, #207)');
  assert.ok(lib.readBytes(lib.itemForUser(u, item.id), 1).length > 0, 'version 1 stays downloadable');
  // Refusals leave the file alone.
  await assert.rejects((await tool('sheet_set_cells')).run({ id: item.id, changes: [{ target: 'Nope!A1', value: 1 }] }, ctx), /no sheet called “Nope”\. Sheets: Budget, Notes/);
  assert.equal(lib.itemForUser(u, item.id).version, 2);
  await assert.rejects(edit.sheetSetCells(book.buffer, [{ target: 'A1:B2', values: [1, 2] }]), /2 × 2 cells, but the values given are 2 × 1/);
  await assert.rejects(edit.sheetSetCells(book.buffer, [{ target: 'B2', value: '=SORT(A1:A3)' }]), /dynamic-array/);
  await assert.rejects(edit.sheetSetCells(book.buffer, [{ target: 'not a cell!', value: 1 }]), /isn’t a cell/);
  const pic = new ExcelJS.Workbook(); const pws = pic.addWorksheet('P'); pws.getCell('A1').value = 1;
  pws.addImage(pic.addImage({ buffer: png(2, 2), extension: 'png' }), 'B2:C3');
  const picItem = await up.saveUpload(u, { buffer: Buffer.from(await pic.xlsx.writeBuffer()), originalname: 'with picture.xlsx' });
  await assert.rejects((await tool('sheet_set_cells')).run({ id: picItem.id, changes: [{ target: 'A1', value: 2 }] }, ctx), /has pictures or shapes, which I can’t keep[\s\S]*make_spreadsheet/);
  assert.equal(lib.itemForUser(u, picItem.id).version, 1);
  assert.deepEqual(await edit.unsupportedParts(book.buffer), []);
});

test('docx_fill: {{placeholders}} (split across runs too) and phrases across runs keep their formatting; a new version; odd templates refused', async () => {
  const edit = await import('../src/services/office-edit.js');
  const up = await import('../src/services/uploads.js');
  const lib = await import('../src/services/library.js');
  const u = await createUser({ name: 'Doc Filler', email: 'doc.fill@t.dev', password: 'correct horse battery' });
  const ctx = await toolCtx(u);
  const item = await up.saveUpload(u, { buffer: fx('sample.docx'), originalname: 'meeting.docx' });
  // "Decision:" is bold, " ship the beta on Friday." is not: the phrase crosses the runs.
  const out = await (await tool('docx_fill')).run({ id: item.id, replace: [{ find: 'Decision: ship', replace: 'Agreed: launch' }, { find: 'Friday', replace: 'Monday' }, { find: 'nothere', replace: 'x' }] }, ctx);
  assert.match(out.content, /Updated “meeting” \(now version 2[\s\S]*Replaced “Decision: ship” 1×\. Replaced “Friday” 1×\. Not found: “nothere”/);
  const fresh = lib.itemForUser(u, item.id);
  const html = (await mammoth.convertToHtml({ buffer: lib.readBytes(fresh) })).value;
  assert.equal(html, '<h1>Meeting notes</h1><p><strong>Agreed: launch</strong> the beta on Monday.</p>', 'heading and bold kept; the replacement takes the formatting it starts in');
  assert.match(lib.readText(fresh), /\*\*Agreed: launch\*\* the beta on Monday/, 'Jess reads the new text');
  await assert.rejects((await tool('docx_fill')).run({ id: item.id, replace: [{ find: 'absent phrase', replace: 'x' }] }, ctx), /Nothing changed[\s\S]*“absent phrase”/);
  assert.equal(lib.itemForUser(u, item.id).version, 2, 'nothing changed → no version');
  // Placeholders, including one Word split across runs (bold middle), values escaped, unknown tags left visible.
  const tpl = await office.docxFromMarkdown('# Letter\n\nDear {{name}},\n\nYour appointment is on {{ date }} at **{{time}}**. Ref {{ref**no**}}.\n\nRegards, {{sender}}');
  const f = await edit.docxFill(tpl, { placeholders: { name: 'Theo & <Co>', date: '3 October', time: '10:30', refno: 'A-17', extra: 'x' } });
  assert.deepEqual([f.filled, f.unfilled, f.notFound], [['name', 'date', 'time', 'refno'], ['sender'], ['extra']]);
  const filled = (await mammoth.convertToHtml({ buffer: f.buffer })).value;
  assert.match(filled, /Dear Theo &amp; &lt;Co&gt;,/);
  assert.match(filled, /on 3 October at <strong>10:30<\/strong>\. Ref A-17\./);
  assert.match(filled, /Regards, \{\{sender\}\}/);
  await assert.rejects(edit.docxFill(await office.docxFromMarkdown('{{#items}}x{{/items}}'), { placeholders: { items: 'x' } }), /template logic/);
  await assert.rejects(edit.docxFill(await office.docxFromMarkdown('broken {{name here'), { placeholders: { name: 'x' } }), /can’t be read: The tag beginning with "\{\{name here" is unclosed/);
  await assert.rejects(edit.docxFill(tpl, {}), /Nothing to fill/);
});

test('make_word_document / make_presentation / make_pdf take Library pictures the person owns; others are named, not copied', async () => {
  const up = await import('../src/services/uploads.js');
  const lib = await import('../src/services/library.js');
  const u = await createUser({ name: 'Picture Owner', email: 'pic.owner@t.dev', password: 'correct horse battery' });
  const other = await createUser({ name: 'Other Person', email: 'pic.other@t.dev', password: 'correct horse battery', role: 'admin' });
  const pic = await up.saveUpload(u, { buffer: png(60, 30), originalname: 'garden.png' });
  const ctx = await toolCtx(u);
  const doc = await (await tool('make_word_document')).run({ title: 'With picture', markdown: `# Garden\n\n![Our garden](/library/${pic.id})\n\n![Gone](/library/zzzzzz99)` }, ctx);
  assert.match(doc.content, /Pictures left out \(shown as their alt text\): \/library\/zzzzzz99 isn’t in their Library\./);
  const item = lib.itemForUser(u, /\/library\/([\w-]+)\)/.exec(doc.content)[1]);
  const zip = await JSZip.loadAsync(lib.readBytes(item));
  assert.ok(Object.keys(zip.files).some(f => /^word\/media\/.+\.png$/.test(f)), 'the picture is in the file');
  const deck = await (await tool('make_presentation')).run({ title: 'Garden', slides: [{ layout: 'image', title: 'The garden', image: pic.id, caption: 'June' }] }, ctx);
  assert.match(deck.content, /as a presentation/);
  // An admin may view another person's files but never copies them into their own documents.
  const adminCtx = await toolCtx(other);
  await assert.rejects((await tool('make_presentation')).run({ title: 'Borrowed', slides: [{ layout: 'image', title: 'Theirs', image: pic.id }] }, adminCtx),
    /needs an image from the Library[\s\S]*isn’t in their Library/);
});

// ---- PDF forms ----------------------------------------------------------------------------------------------------
async function familyForm() {
  const { PDFDocument, StandardFonts, PDFName, PDFHexString } = await import('@cantoo/pdf-lib');
  const d = await PDFDocument.create();
  const page = d.addPage([595, 842]);
  const helv = await d.embedFont(StandardFonts.Helvetica);
  const form = d.getForm();
  const text = (s, x, y, size = 11) => page.drawText(s, { x, y, size, font: helv });
  text('School enrolment form', 72, 780, 18);
  text('Full name:', 72, 720); form.createTextField('Text1').addToPage(page, { x: 150, y: 714, width: 250, height: 20 });
  text('Date of birth (DD/MM/YYYY)', 72, 680);
  const dob = form.createTextField('Text2'); dob.setMaxLength(10); dob.addToPage(page, { x: 72, y: 650, width: 120, height: 20 });
  dob.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Birth date'));
  form.createCheckBox('Check Box 7').addToPage(page, { x: 72, y: 610, width: 12, height: 12 }); text('Needs the school bus', 90, 612);
  text('City:', 72, 570); const city = form.createDropdown('Dropdown3'); city.addOptions(['Lisbon', 'Porto']); city.addToPage(page, { x: 110, y: 564, width: 120, height: 20 });
  text('Parent name (Arabic)', 72, 540); form.createTextField('Text4').addToPage(page, { x: 72, y: 512, width: 250, height: 20 });
  d.addPage([595, 842]);
  return Buffer.from(await d.save());
}

test('pdf_form_fields: page, rectangle, printed label, tooltip, max length, checkbox value, top to bottom; a flat PDF gives its text with positions', async () => {
  const pdfs = await import('../src/services/pdf.js');
  const fields = await pdfs.pdfFormFields(await familyForm());
  assert.deepEqual(fields.map(f => [f.name, f.label]), [['Text1', 'Full name'], ['Text2', 'Date of birth (DD/MM/YYYY)'], ['Check Box 7', 'Needs the school bus'],
    ['Dropdown3', 'City'], ['Text4', 'Parent name (Arabic)']]);
  const dob = fields[1];
  assert.equal(dob.page, 1); assert.equal(dob.maxLength, 10); assert.equal(dob.tooltip, 'Birth date');
  assert.ok(Math.abs(dob.rect.x - 72) < 2 && Math.abs(dob.rect.y - 650) < 2 && Math.abs(dob.rect.width - 120) < 2, JSON.stringify(dob.rect));
  assert.equal(fields[2].exportValue, 'Yes');
  assert.deepEqual(fields[3].options, ['Lisbon', 'Porto']);
  // The fixture is a flat, two-page PDF (English and Arabic text): no fields, but positioned text for pdf_write_text.
  assert.deepEqual(await pdfs.pdfFormFields(fx('sample.pdf')), []);
  const pages = await pdfs.pageText(fx('sample.pdf'));
  assert.equal(pages.length, 2);
  const seg = pages.flatMap(p => p.segments).find(s => /Revenue grew 12 percent/.test(s.text));
  assert.ok(seg && seg.x > 0 && seg.y > 0 && seg.x2 > seg.x && seg.size > 0, JSON.stringify(seg));
  assert.ok(pages.flatMap(p => p.segments).some(s => s.rtl && /الأرباح/.test(s.text)), 'Arabic lines read in order and are marked right-to-left');
  // The tool: labels in the listing; the flat form's text with coordinates.
  const u = await createUser({ name: 'Form Reader', email: 'form.read@t.dev', password: 'correct horse battery' });
  const ctx = await toolCtx(u);
  const up = await import('../src/services/uploads.js');
  const formItem = await up.saveUpload(u, { buffer: await familyForm(), originalname: 'enrolment.pdf' });
  const listing = await (await tool('pdf_form_fields')).run({ id: formItem.id }, ctx);
  assert.match(listing, /- "Text2" \(text, page 1, label “Date of birth \(DD\/MM\/YYYY\)”, tooltip “Birth date”, max 10 characters\) · at x=71\.5 y=649\.5/);
  assert.match(listing, /- "Check Box 7" \(checkbox, page 1, label “Needs the school bus”, checked value "Yes"\)/);
  const flat = await up.saveUpload(u, { buffer: fx('sample.pdf'), originalname: 'report.pdf' });
  const flatListing = await (await tool('pdf_form_fields')).run({ id: flat.id }, ctx);
  assert.match(flatListing, /no fillable fields: it’s a flat form[\s\S]*page 1 is [\d.]+ × [\d.]+[\s\S]*- p1 x=[\d.]+–[\d.]+ y=[\d.]+ \([\d.]+pt\): “[^”]*Revenue grew/);
});

test('pdf_fill_form: Unicode answers; Arabic keeps NeedAppearances and stays editable; a flattened copy writes it onto the page', async () => {
  const pdfs = await import('../src/services/pdf.js');
  const { PDFDocument, PDFName } = await import('@cantoo/pdf-lib');
  const blank = await familyForm();
  const out = await pdfs.fillPdfForm(blank, { Text1: 'Amélie Laurent', Text2: '01/02/2015', 'Check Box 7': 'yes', Dropdown3: 'porto', Text4: 'مريم الحسن' });
  assert.deepEqual(out.filled, ['Text1', 'Text2', 'Check Box 7', 'Dropdown3', 'Text4']);
  assert.deepEqual(out.viewerDrawn, ['Text4']);
  assert.equal(out.flattened, false);
  const doc = await PDFDocument.load(out.buffer);
  assert.equal(String(doc.getForm().acroForm.dict.get(PDFName.of('NeedAppearances'))), 'true', 'the viewer is asked to draw the Arabic answer');
  const back = await pdfs.pdfFormFields(out.buffer);
  assert.equal(back.find(f => f.name === 'Text4').value, 'مريم الحسن', 'the value itself is in the field');
  assert.equal(back.find(f => f.name === 'Text1').value, 'Amélie Laurent');
  const latinOnly = await pdfs.fillPdfForm(blank, { Text1: 'Zoë', Text2: '01/02/2015' });
  assert.deepEqual(latinOnly.viewerDrawn, []);
  assert.equal((await PDFDocument.load(latinOnly.buffer)).getForm().acroForm.dict.get(PDFName.of('NeedAppearances')), undefined, 'not needed when every answer has a font');
  // The final copy: no fields left, every answer on the page (the Arabic one shaped by our layout).
  const flat = await pdfs.fillPdfForm(blank, { Text1: 'Amélie Laurent', Text4: 'مريم الحسن 12', 'Check Box 7': true }, { flatten: true });
  assert.equal(flat.flattened, true);
  assert.deepEqual(flat.drawnOnPage, ['Text4']);
  assert.equal((await pdfs.pdfFormFields(flat.buffer)).length, 0);
  const onPage = (await pdfs.pageText(flat.buffer))[0].segments.map(s => s.text).join(' | ');
  assert.match(onPage, /Amélie Laurent/);
  assert.match(onPage, /12/);
  assert.match(onPage, /\p{Script=Arabic}/u, 'Arabic glyphs are on the page');
});

test('pdf_write_text: answers and ticks placed on a copy (the original stays); off-page items reported; nothing to write refused', async () => {
  const pdfs = await import('../src/services/pdf.js');
  const lib = await import('../src/services/library.js');
  const up = await import('../src/services/uploads.js');
  const res = await pdfs.writeOnPdf(fx('sample.pdf'), [{ page: 1, x: 72, y: 60, text: 'Checked by Zoë Łódź, 26/09' }, { page: 1, x: 400, y: 40, text: 'موافق 12' },
    { page: 2, x: 72, y: 40, tick: true, size: 12 }, { page: 3, x: 1, y: 1, text: 'x' }, { page: 1, x: 5000, y: 10, text: 'x' }, { page: 1, x: 10, y: 10 }]);
  assert.deepEqual(res.placed.map(p => p.page), [1, 1, 2]);
  assert.equal(res.problems.length, 3);
  assert.match(res.problems[0], /^item 4: there is no page 3 \(the file has 2\)$/);
  assert.match(res.problems[1], /^item 5: \(5000, 10\) is off page 1, which is [\d.]+ × [\d.]+ points$/);
  assert.equal(res.problems[2], 'item 6: nothing to write');
  const segs = (await pdfs.pageText(res.buffer))[0].segments;
  const mine = segs.find(s => /Checked by Zoë Łódź, 26\/09/.test(s.text));
  assert.ok(mine && Math.abs(mine.x - 72) < 1 && Math.abs(mine.y - 60) < 1, `read back at its place: ${JSON.stringify(mine)}`);
  const arabic = segs.find(s => /12/.test(s.text) && s.y < 45);
  assert.ok(arabic && Math.abs(arabic.x2 - 400) < 2.5, `right-to-left text ends at x: ${JSON.stringify(arabic)}`);
  const u = await createUser({ name: 'Form Writer', email: 'form.write@t.dev', password: 'correct horse battery' });
  const ctx = await toolCtx(u);
  const item = await up.saveUpload(u, { buffer: fx('sample.pdf'), originalname: 'flat form.pdf' });
  const out = await (await tool('pdf_write_text')).run({ id: item.id, items: [{ page: 1, x: 72, y: 60, text: 'Theo Lindqvist' }] }, ctx);
  assert.match(out.content, /Saved “flat form \(filled\)” as a PDF[\s\S]*Wrote 1 item\.[\s\S]*They should also check it in the preview/);
  assert.equal(lib.itemForUser(u, item.id).version, 1, 'the original stays as it was');
  await assert.rejects((await tool('pdf_write_text')).run({ id: item.id, items: [{ page: 9, x: 1, y: 1, text: 'x' }] }, ctx), /Nothing was written: item 1: there is no page 9/);
});
