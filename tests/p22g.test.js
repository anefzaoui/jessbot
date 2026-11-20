// Phase 22 part G (decisions #161–#163): seeing documents. PDF pages drawn as pictures (Library thumbnails, the page Jess
// looks at after filling a form), OCR of scans (opt-in per file, page cap, cost shown, budget-checked) and real previews
// of office files when LibreOffice is installed (found like the browser; a fake soffice stands in here, and a guarded test
// runs the real one only where it is installed). Run: npm test (throwaway data dir; model calls go to a local fake
// OpenAI-compatible server, never the network). The PNG-export test needs the browser (npm run browser:install) and is skipped without it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-p22g-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';

const { openDb, closeDb, get, all, run, settings } = await import('../src/db/index.js');
const { ensureDirs, paths } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser, getUser } = await import('../src/services/users.js');
const lib = await import('../src/services/library.js');
const render = await import('../src/services/pdf-render.js');
const office = await import('../src/services/office-render.js');
const ocr = await import('../src/services/ocr.js');
const prices = await import('../src/services/model-price.js');
const exp = await import('../src/services/page-export.js');
const { saveUpload } = await import('../src/services/uploads.js');
const { setPolicy } = await import('../src/services/policy.js');
const { isShotRef, shotImagePart } = await import('../src/services/page-check.js');
const { doctor } = await import('../src/services/system.js');
const { browserStatus, closeBrowser } = await import('../src/browser/index.js');
const { getTool } = await import('../src/agent/tools/registry.js');
await import('../src/agent/tools/library.js');
await import('../src/agent/tools/office.js');
const { mainThread } = await import('../src/services/threads.js');
const runs = await import('../src/services/runs.js');
const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');
const { createCanvas, loadImage } = await import('@napi-rs/canvas');

const BROWSER = browserStatus().installed;
const SAMPLE_PDF = fs.readFileSync(new URL('./fixtures/sample.pdf', import.meta.url));
const SAMPLE_DOCX = fs.readFileSync(new URL('./fixtures/sample.docx', import.meta.url));
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ---- A fake OpenAI-compatible model: prices at /models, OCR answers that echo the pages it was sent -----------------------
const calls = [];
let failCall = 0; // the Nth chat call answers 400 (0 = never)
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      return res.end(JSON.stringify({ data: [{ id: 'fake/vision', pricing: { prompt: '0.000001', completion: '0.000004', image: '0.0005' } }] }));
    }
    const json = JSON.parse(body || '{}');
    const parts = json.messages?.at(-1)?.content || [];
    const pages = parts.filter(p => p.type === 'text').map(p => /^--- page (\d+) ---$/.exec(p.text)?.[1]).filter(Boolean).map(Number);
    const images = parts.filter(p => p.type === 'image_url').length;
    calls.push({ pages, images, system: json.messages?.[0]?.content || '' });
    if (failCall && calls.length === failCall) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'model refused' } })); }
    const text = pages.length > 1 ? pages.map(n => `--- page ${n} ---\nINVOICE 4711 page ${n}\nTotal: 48.20`).join('\n')
      : `Scanned words: INVOICE 4711${pages[0] ? ` page ${pages[0]}` : ''}\nTotal: 48.20`;
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'fake/vision',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 1000 * images, completion_tokens: 60, total_tokens: 1000 * images + 60, cost: 0.002 * images } }));
  });
});

let alice, bob;
before(async () => {
  alice = await createUser({ name: 'Alice Scans', email: 'alice@p22g.dev', password: 'correct horse battery' });
  bob = await createUser({ name: 'Bob Budget', email: 'bob@p22g.dev', password: 'correct horse battery' });
  await listen(fake);
  settings.set('llm', { baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, model: 'fake/vision' });
  process.env.OPENROUTER_KEY = 'test-key';
});
after(async () => {
  await lib.previewsSettled();
  office.useSoffice(null);
  await closeBrowser();
  fake.close();
  closeDb();
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 5 });
});

// A tool call as the agent loop makes it (origin: chat unless given).
function toolCtx(user, { origin = 'chat' } = {}) {
  const thread = mainThread(user.id);
  const r = runs.createRun({ threadId: thread.id, userId: user.id, triggerMessageId: null, model: 'x', origin });
  return { user: getUser(user.id), thread, run: runs.getRun(r.id) };
}
const pdfItem = (user, buffer, title = 'Form') => lib.createFileItem({ user, title, type: 'pdf', ext: 'pdf', mime: 'application/pdf', buffer, sourceLabel: 'Uploaded' });
const docxItem = (user, title = 'Letter', sourceLabel = 'Uploaded') => lib.createFileItem({ user, title, type: 'doc', ext: 'docx', mime: DOCX_MIME,
  buffer: SAMPLE_DOCX, text: 'Dear Theo', preview: '<article class="prose-jb"><p>Dear Theo</p></article>', sourceLabel });

// Brightness spread and the height of the ink (rows with dark pixels) of a picture.
async function ink(buffer) {
  const img = await loadImage(buffer);
  const c = createCanvas(img.width, img.height);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const { data } = g.getImageData(0, 0, img.width, img.height);
  let top = Infinity, bottom = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] < 300) { top = Math.min(top, y); bottom = y; break; }
    }
  }
  return { width: img.width, height: img.height, inkHeight: bottom < 0 ? 0 : bottom - top + 1 };
}

// A scanned document: each page only a picture (no text layer). Rectangles make a page non-blank whatever fonts exist.
async function scannedPdf(pages, { blank = [] } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pages; i++) {
    const c = createCanvas(300, 400);
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 300, 400);
    if (!blank.includes(i)) {
      g.fillStyle = '#000000';
      g.font = '20px sans-serif';
      g.fillText(`INVOICE 4711 page ${i}`, 20, 50);
      for (let r = 0; r < 10; r++) g.fillRect(20, 80 + r * 28, 120 + ((r * 37) % 140), 8);
    }
    const png = await doc.embedPng(await c.encode('png'));
    doc.addPage([300, 400]).drawImage(png, { x: 0, y: 0, width: 300, height: 400 });
  }
  return Buffer.from(await doc.save());
}
const pngWidth = buf => buf.readUInt32BE(16); // IHDR

// ---- Rendering --------------------------------------------------------------------------------------------------------
test('render: the sample PDF\'s first page is a non-blank PNG at the asked width; page 2 too; a missing page and broken bytes are clear 400s', async () => {
  const one = await render.renderPdfPage(SAMPLE_PDF, 1, { width: 640, format: 'png' });
  assert.equal(one.buffer.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(one.width, 640);
  assert.equal(one.count, 2);
  assert.ok(one.height > one.width, 'a portrait page');
  assert.deepEqual(one.points.map(Math.round), [420, 596]);
  assert.ok((await render.brightnessSpread(one.buffer)) > 5, 'not blank');
  const jpeg = await render.renderPdfPage(SAMPLE_PDF, 2, { width: 500 });
  assert.equal(jpeg.buffer[0], 0xff, 'JPEG by default');
  assert.ok((await ink(jpeg.buffer)).inkHeight > 10, 'page 2 (Arabic) has ink');
  await assert.rejects(render.renderPdfPage(SAMPLE_PDF, 5), err => err.status === 400 && /no page 5: it has 2 pages/.test(err.message));
  await assert.rejects(render.renderPdfPage(Buffer.from('not a pdf'), 1), err => err.status === 400 && /couldn’t be opened/.test(err.message));
  assert.equal(await render.pdfPageCount(SAMPLE_PDF), 2);
});

test('render: a PDF that doesn\'t embed its font (Helvetica) is drawn with the real face at full size, not a spaced-out substitute', async () => {
  // Regression: unpdf's bundled pdf.js can't load pdf.js's standard fonts in Node, and drew such text in a small wrong face.
  const doc = await PDFDocument.create();
  doc.addPage([400, 300]).drawText('Hello Helvetica', { x: 20, y: 200, size: 30, font: await doc.embedFont(StandardFonts.Helvetica) });
  const pic = await render.renderPdfPage(Buffer.from(await doc.save()), 1, { width: 400, format: 'png' });
  const { inkHeight } = await ink(pic.buffer);
  assert.ok(inkHeight >= 18, `cap height of 30 pt Helvetica is about 21 px, got ${inkHeight}`);
});

test('fitImage: a large picture comes back as a JPEG within the edge; a small PNG is kept as it is', async () => {
  const big = createCanvas(3000, 1000);
  big.getContext('2d').fillRect(0, 0, 100, 100);
  const fitted = await render.fitImage(await big.encode('png'), { maxEdge: 1500, mime: 'image/png' });
  assert.deepEqual([fitted.width, fitted.height, fitted.mime], [1500, 500, 'image/jpeg']);
  const small = await createCanvas(200, 100).encode('png');
  assert.equal((await render.fitImage(small, { mime: 'image/png' })).buffer, small);
  await assert.rejects(render.fitImage(Buffer.from('nope')), /couldn’t be read/);
});

// ---- PDF thumbnails in the Library --------------------------------------------------------------------------------------
test('thumbnails: a new PDF gets its first page as the card\'s thumbnail, in the item view and on the Library card', async () => {
  const item = pdfItem(alice, SAMPLE_PDF, 'Quarterly report');
  assert.equal(item.has_thumb, 0, 'drawn in the background, the save never waits');
  await lib.previewsSettled();
  const fresh = lib.getItem(item.id);
  assert.deepEqual([fresh.has_thumb, fresh.preview_version, fresh.preview_pages], [1, 1, 0]);
  const thumb = fs.readFileSync(lib.thumbFile(fresh));
  assert.equal(thumb[0], 0xff, 'a JPEG');
  assert.equal((await ink(thumb)).width, 640);
  const view = lib.itemView(fresh);
  assert.equal(view.thumbUrl, `/library/${fresh.public_id}/thumb.jpg?v=1`);
  assert.deepEqual(view.pagePictures, [], 'a PDF is shown by the browser itself; only office files get page pictures');
  assert.equal(lib.libraryData(alice).items.find(i => i.id === fresh.public_id).thumbUrl, view.thumbUrl);
});

test('thumbnails: a new version is redrawn; a broken PDF is tried once per version and not again; older PDFs are backfilled a few per view', async () => {
  const item = pdfItem(alice, SAMPLE_PDF, 'Versioned');
  await lib.previewsSettled();
  const v2 = lib.addFileVersion(lib.getItem(item.id), { buffer: SAMPLE_PDF, text: 'v2' });
  assert.equal(v2.has_thumb, 0, 'the old thumbnail no longer shows this version');
  await lib.previewsSettled();
  assert.deepEqual([lib.getItem(item.id).has_thumb, lib.getItem(item.id).preview_version], [1, 2]);
  assert.equal(lib.itemView(lib.getItem(item.id)).thumbUrl, `/library/${item.public_id}/thumb.jpg?v=2`);

  const broken = pdfItem(alice, Buffer.from('%PDF-1.4 truncated'), 'Broken');
  await lib.previewsSettled();
  const b = lib.getItem(broken.id);
  assert.deepEqual([b.has_thumb, b.preview_version], [0, 1], 'tried, failed, recorded');
  assert.equal(lib.backfillPreviews([b]), 0, 'not retried for that version');

  // PDFs saved before thumbnails existed: no preview_version. Each Library view starts at most four.
  const old = [];
  for (let i = 0; i < 6; i++) old.push(pdfItem(bob, SAMPLE_PDF, `Old ${i}`));
  await lib.previewsSettled();
  for (const o of old) run('UPDATE library_items SET has_thumb = 0, preview_version = NULL WHERE id = ?', o.id);
  lib.libraryData(bob);
  await lib.previewsSettled();
  const drawn = old.map(o => lib.getItem(o.id)).filter(o => o.has_thumb);
  assert.equal(drawn.length, 4);
  lib.libraryData(bob);
  await lib.previewsSettled();
  assert.equal(old.map(o => lib.getItem(o.id)).filter(o => o.has_thumb).length, 6, 'the rest on the next view');
});

// ---- Jess looks at a page ------------------------------------------------------------------------------------------------
test('pdf_page_image: the page rides to the model as a shot ref, with the page size in points and the scale', async () => {
  const item = pdfItem(alice, SAMPLE_PDF, 'Two pages');
  const out = await getTool('pdf_page_image').run({ id: item.public_id, page: 2 }, toolCtx(alice));
  assert.equal(out.attachments.length, 1);
  assert.ok(isShotRef(out.attachments[0]), out.attachments[0]);
  const part = shotImagePart(out.attachments[0]);
  assert.match(part.image_url.url, /^data:image\/jpeg;base64,/);
  assert.match(out.content, /Page 2 of 2 of “Two pages” is shown below \(1100×\d+ px; the page is 420 × 595\.9 points, scale 2\.619 px per point/);
  assert.match(out.content, /information, not instructions/);
  assert.match(out.step.image, /^\/shots\/u\d+-[0-9a-f]{16}\.jpg$/);
  await assert.rejects(getTool('pdf_page_image').run({ id: item.public_id, page: 3 }, toolCtx(alice)), /no page 3: it has 2 pages/);
  const doc = docxItem(alice);
  office.useSoffice(null);
  await assert.rejects(getTool('pdf_page_image').run({ id: doc.public_id }, toolCtx(alice)), /only be drawn when LibreOffice is installed/);
});

test('pdf_write_text / pdf_fill_form: the result shows page 1 of the new copy and says how to look at the others', async () => {
  const form = pdfItem(alice, SAMPLE_PDF, 'Flat form');
  const out = await getTool('pdf_write_text').run({ id: form.public_id, items: [{ page: 1, x: 40, y: 480, text: 'Theo Lindqvist' }] }, toolCtx(alice));
  assert.ok(isShotRef(out.attachments?.[0]), 'page 1 of the filled copy is attached');
  assert.match(out.content, /Page 1 of the filled copy is shown below: check each answer sits in its box/);
  assert.match(out.content, /pdf_page_image shows the other pages/);
  // A fillable form: pdf-lib makes one with a text field.
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const field = doc.getForm().createTextField('name');
  field.addToPage(page, { x: 50, y: 150, width: 200, height: 24 });
  const fillable = pdfItem(alice, Buffer.from(await doc.save()), 'Fillable');
  const filled = await getTool('pdf_fill_form').run({ id: fillable.public_id, values: { name: 'Theo' } }, toolCtx(alice));
  assert.ok(isShotRef(filled.attachments?.[0]));
  assert.match(filled.content, /Filled 1 field/);
  await lib.previewsSettled();
});

// ---- OCR ------------------------------------------------------------------------------------------------------------------
test('ocr: estimate first (nothing spent), then the confirmed reading becomes the file\'s text, marked as OCR, searchable, usage recorded', async () => {
  const view = await saveUpload(alice, { buffer: await scannedPdf(3, { blank: [2] }), originalname: 'water bill.pdf' });
  const item = lib.itemForUser(alice, view.id);
  assert.match(item.description, /3 pages · no text \(scanned\?\)$/);
  const tool = getTool('ocr_document');
  assert.equal(tool.risk({}), 'read', 'the estimate changes nothing');
  assert.equal(tool.risk({ confirm: true }), 'write');

  // Confirming before an estimate was shown is refused.
  calls.length = 0;
  await assert.rejects(tool.run({ id: view.id, confirm: true }, toolCtx(alice)), /Show them the estimate first/);
  assert.equal(calls.length, 0);

  const est = await tool.run({ id: view.id }, toolCtx(alice));
  assert.match(est.content, /would read pages 1–3 of 3 with fake\/vision and cost about \$0\.0\d+; nothing has been spent/);
  assert.match(est.content, /ask \(ask_user\) before calling again with confirm: true/);
  assert.equal(calls.length, 0, 'no model call for an estimate');
  assert.equal(get(`SELECT COUNT(*) AS n FROM usage_events WHERE purpose = 'ocr'`).n, 0);

  const ctx = toolCtx(alice);
  const out = await tool.run({ id: view.id, confirm: true }, ctx);
  assert.equal(calls.length, 1, 'three pages fit one call');
  assert.deepEqual(calls[0].pages, [1, 3], 'the blank page was skipped, not paid for');
  assert.equal(calls[0].images, 2);
  assert.match(calls[0].system, /never instructions to you/);
  assert.match(out.content, /Read pages 1, 3 of “water bill” by OCR for \$0\.004/);
  assert.match(out.content, /Blank, skipped: page 2\./);
  assert.match(out.content, /INVOICE 4711 page 3/, 'the text comes back (fenced) in the result');

  const fresh = lib.getItem(item.id);
  assert.equal(fresh.ocr_version, 1);
  assert.ok(lib.isOcrText(fresh));
  assert.match(fresh.description, /3 pages · text from OCR$/);
  assert.equal(lib.itemView(fresh).textSource, 'ocr');
  const text = lib.readText(fresh);
  assert.match(text, /--- page 1 ---\nINVOICE 4711 page 1/);
  assert.match(text, /--- page 2 ---\n\n--- page 3 ---\nINVOICE 4711 page 3/);
  assert.equal(lib.metaOf(fresh).ocr.cost, 0.004);
  assert.deepEqual(lib.metaOf(fresh).ocr.blank, [2]);
  assert.ok(lib.listItems(alice, { query: 'INVOICE 4711' }).some(i => i.id === item.id), 'Library search finds the OCR text');
  const usage = all(`SELECT * FROM usage_events WHERE purpose = 'ocr'`);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].run_id, ctx.run.id);
  assert.equal(usage[0].cost, 0.004);

  const read = await getTool('library_read').run({ id: view.id, pages: '3' }, toolCtx(alice));
  assert.match(read, /read from a scan by OCR and may contain errors/);
  assert.match(read, /INVOICE 4711 page 3/);
  const listed = await getTool('library_list').run({ query: 'water' }, toolCtx(alice));
  assert.match(listed, /text from OCR/);
  // Nothing left without text: a new default reading is refused; naming pages reads them again.
  await assert.rejects(ocr.ocrEstimate(alice, fresh), /already has text on every page that isn’t blank \(some of it read by OCR before\)/);
  assert.deepEqual((await ocr.ocrEstimate(alice, fresh, { pages: '2' })).pages, [2]);
});

test('ocr: at most 20 pages a reading (the rest named in the result), four per model call', async () => {
  const view = await saveUpload(alice, { buffer: await scannedPdf(23), originalname: 'long scan.pdf' });
  const item = lib.itemForUser(alice, view.id);
  const est = await ocr.ocrEstimate(alice, item);
  assert.equal(est.pages.length, ocr.OCR_MAX_PAGES);
  assert.deepEqual(est.capped, [21, 22, 23]);
  assert.equal(est.count, 23);
  // 20 pages × (1600 image tokens × $0.000001 + $0.0005 per image + 700 × $0.000004) + 5 calls × 250 tokens × $0.000001
  assert.ok(Math.abs(est.cost - (20 * (0.0016 + 0.0005 + 0.0028) + 5 * 0.00025)) < 1e-9, String(est.cost));
  assert.equal(est.priceSource, 'list');
  calls.length = 0;
  const out = await ocr.ocrItem(alice, item, {});
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map(c => c.images), [4, 4, 4, 4, 4]);
  assert.deepEqual(out.read, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(out.capped, [21, 22, 23]);
  // The next default reading picks up where the cap stopped.
  assert.deepEqual((await ocr.ocrEstimate(alice, lib.getItem(item.id))).pages, [21, 22, 23]);
  await assert.rejects(ocr.ocrEstimate(alice, item, { pages: '30-31' }), /aren’t in the file \(it has 23\)/);
});

test('ocr: pages already read are kept when a later call fails; the budget refuses a reading it can\'t cover; never in a scheduled task', async () => {
  const view = await saveUpload(alice, { buffer: await scannedPdf(6), originalname: 'failing.pdf' });
  const item = lib.itemForUser(alice, view.id);
  await ocr.ocrEstimate(alice, item);
  calls.length = 0;
  failCall = 2;
  const out = await ocr.ocrItem(alice, item, {});
  failCall = 0;
  assert.deepEqual(out.read, [1, 2, 3, 4], 'the first call\'s pages are kept (they were paid for)');
  assert.match(out.error, /model refused/);
  assert.match(lib.readText(lib.getItem(item.id)), /INVOICE 4711 page 4/);

  // Budget: used up → refused; more than what's left → refused, naming the amounts; nothing is sent either way.
  const scan = lib.itemForUser(bob, (await saveUpload(bob, { buffer: await scannedPdf(2), originalname: 'bob.pdf' })).id);
  setPolicy('user', bob.id, { weeklyBudget: 0.01 }, null);
  run(`INSERT INTO usage_events (user_id, purpose, model, cost) VALUES (?, 'chat', 'fake/vision', 0.009)`, bob.id);
  const est = await ocr.ocrEstimate(bob, scan);
  assert.equal(est.budget.left.toFixed(3), '0.001');
  calls.length = 0;
  await assert.rejects(ocr.ocrItem(bob, scan, {}), err => err.status === 400 && /more than is left of this week's budget \(\$0\.001 of \$0\.01\)/.test(err.message));
  run(`INSERT INTO usage_events (user_id, purpose, model, cost) VALUES (?, 'chat', 'fake/vision', 0.01)`, bob.id);
  await ocr.ocrEstimate(bob, scan);
  await assert.rejects(ocr.ocrItem(bob, scan, {}), /budget \(\$0\.01\) is used up/);
  assert.equal(calls.length, 0);

  // A scheduled task has nobody to say yes.
  const tool = getTool('ocr_document');
  await tool.run({ id: view.id, pages: '5-6' }, toolCtx(alice, { origin: 'schedule' }));
  await assert.rejects(tool.run({ id: view.id, pages: '5-6', confirm: true }, toolCtx(alice, { origin: 'schedule' })), /needs their yes in a chat/);
  // Only PDFs and pictures.
  await assert.rejects(ocr.ocrEstimate(alice, docxItem(alice)), /only PDFs and pictures are read by OCR/);
});

test('ocr: a photo of a paper is read into its text; library_read then gives the text; project search reads it too', async () => {
  const c = createCanvas(900, 600);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 600); g.fillStyle = '#000';
  for (let r = 0; r < 8; r++) g.fillRect(40, 60 + r * 60, 500, 12);
  const view = await saveUpload(alice, { buffer: await c.encode('png'), originalname: 'receipt.png' });
  const before = await getTool('library_read').run({ id: view.id }, toolCtx(alice));
  assert.match(before, /is an image.*ocr_document can read it/);
  const tool = getTool('ocr_document');
  const est = await tool.run({ id: view.id }, toolCtx(alice));
  assert.match(est.content, /would read the picture with fake\/vision/);
  calls.length = 0;
  const out = await tool.run({ id: view.id, confirm: true }, toolCtx(alice));
  assert.equal(calls[0].images, 1);
  assert.match(out.content, /Read the picture of “receipt” by OCR/);
  const read = await getTool('library_read').run({ id: view.id }, toolCtx(alice));
  assert.match(read, /Scanned words: INVOICE 4711/);
  assert.match(read, /check names, numbers and dates against the picture \(view_image\)/);
  // In a project, the picture's OCR text is searchable next to its caption.
  const { projectFromThread } = await import('../src/services/projects.js');
  const { searchProject } = await import('../src/services/project-files.js');
  const { createSideThread } = await import('../src/services/threads.js');
  const project = projectFromThread(getUser(alice.id), createSideThread(alice.id, 'Receipts'), { name: 'Receipts' });
  run('UPDATE library_items SET project_id = ? WHERE public_id = ?', project.id, view.id);
  assert.ok(searchProject(project, 'INVOICE 4711').some(h => h.public_id === view.id), 'project search finds the OCR text');
});

test('model prices: listed by the endpoint, else inferred from this model\'s own usage, else unknown', async () => {
  prices.resetPrices();
  assert.deepEqual(await prices.modelPrice('fake/vision'), { prompt: 0.000001, completion: 0.000004, image: 0.0005, source: 'list' });
  run(`INSERT INTO usage_events (user_id, purpose, model, prompt_tokens, completion_tokens, cost) VALUES (?, 'chat', 'other/model', 900, 100, 0.01)`, alice.id);
  assert.deepEqual(await prices.modelPrice('other/model'), { prompt: 0.00001, completion: 0.00001, image: 0, source: 'history' });
  assert.equal(await prices.modelPrice('never/used'), null);
  assert.equal(prices.estimateCost(null, { promptTokens: 5 }), null);
  assert.equal(prices.dollars(0.0123), '$0.012');
  assert.equal(prices.dollars(1.5), '$1.50');
  assert.equal(prices.dollars(null), 'unknown');
});

test('ocr text helpers: pages split and join by their markers; unmarked text is page 1', () => {
  const m = ocr.splitPages('--- page 1 ---\nA\n\n--- page 3 ---\nC');
  assert.deepEqual([...m], [[1, 'A'], [3, 'C']]);
  assert.equal(ocr.joinPages(new Map([[3, 'C'], [1, 'A']])), '--- page 1 ---\nA\n\n--- page 3 ---\nC');
  assert.deepEqual([...ocr.splitPages('just text')], [[1, 'just text']]);
  assert.equal(ocr.splitPages('').size, 0);
});

// ---- LibreOffice ----------------------------------------------------------------------------------------------------------
test('LibreOffice detection: none on an empty PATH with no standard install; found on PATH; a setting wins; previews can be switched off', () => {
  const empty = fs.mkdtempSync(path.join(HOME, 'empty-'));
  const win = process.platform === 'win32';
  const none = office.locateSoffice({ env: { PATH: empty }, standard: [], config: {} });
  assert.equal(none, null);
  const bin = fs.mkdtempSync(path.join(HOME, 'bin-'));
  const exe = path.join(bin, win ? 'soffice.exe' : 'soffice');
  fs.writeFileSync(exe, '');
  assert.deepEqual(office.locateSoffice({ env: { PATH: `${empty}${win ? ';' : ':'}${bin}` }, standard: [], config: {} }), { path: exe, source: 'path' });
  assert.deepEqual(office.locateSoffice({ env: { PATH: empty }, standard: [exe], config: {} }), { path: exe, source: 'standard' });
  assert.deepEqual(office.locateSoffice({ env: { PATH: empty }, standard: [], config: { soffice: exe } }), { path: exe, source: 'setting' });
  assert.equal(office.locateSoffice({ env: { PATH: bin }, standard: [], config: { soffice: path.join(bin, 'missing.exe') } }), null, 'a wrong setting is not silently replaced');
  assert.equal(office.locateSoffice({ env: { PATH: bin }, standard: [exe], config: { previews: false } }), null);
  assert.deepEqual(office.locateSoffice({ env: { PATH: empty, JESSBOT_SOFFICE: exe }, standard: [], config: {} }), { path: exe, source: 'env' });
  assert.ok(office.standardSofficePaths({ ProgramFiles: 'C:\\Program Files' }, 'win32')[0].endsWith(path.join('LibreOffice', 'program', 'soffice.exe')));
  assert.deepEqual(office.standardSofficePaths({}, 'darwin'), ['/Applications/LibreOffice.app/Contents/MacOS/soffice']);
});

test('without LibreOffice: office files keep their content previews, get no pictures, and the doctor says it is optional', async () => {
  office.useSoffice(null);
  settings.set('office', { previews: false }); // this machine may have LibreOffice: switch it off for the test
  office.findSoffice({ refresh: true });
  const doc = docxItem(alice, 'Plain letter');
  assert.equal(lib.wantsPreview(doc), false);
  await lib.previewsSettled();
  const fresh = lib.getItem(doc.id);
  assert.deepEqual([fresh.has_thumb, fresh.preview_version], [0, null], 'not marked: it is drawn once LibreOffice is there');
  assert.equal(lib.itemView(fresh).thumbUrl, null);
  assert.equal(lib.renderedDoc(fresh), '<article class="prose-jb"><p>Dear Theo</p></article>');
  const line = doctor({ cli: true }).checks.find(c => c.id === 'office');
  assert.equal(line.status, 'ok');
  assert.match(line.detail, /Switched off in settings \(optional\): Word, Excel and PowerPoint files are previewed from their content/);
  settings.set('office', {});
  office.findSoffice({ refresh: true });
});

// A stand-in for soffice: records how it was called, then writes a PDF where LibreOffice would (or hangs).
const FAKE = path.join(HOME, 'fake-soffice.mjs');
fs.writeFileSync(FAKE, `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
const outDir = args[args.indexOf('--outdir') + 1];
const input = args.at(-1);
const profile = fileURLToPath(args.find(a => a.startsWith('-env:UserInstallation=')).slice('-env:UserInstallation='.length));
const xcu = fs.readFileSync(path.join(profile, 'user', 'registrymodifications.xcu'), 'utf8');
const log = line => fs.appendFileSync(process.env.FAKE_SOFFICE_LOG, JSON.stringify(line) + '\\n');
log({ at: 'start', t: Date.now(), pid: process.pid, args, input: fs.existsSync(input), macrosOff: xcu.includes('DisableMacrosExecution'), proxy: process.env.HTTP_PROXY });
if (process.env.FAKE_SOFFICE_MODE === 'hang') setInterval(() => {}, 1000);
else {
  await new Promise(r => setTimeout(r, 150));
  fs.copyFileSync(process.env.FAKE_SOFFICE_PDF, path.join(outDir, path.basename(input).replace(/\\.\\w+$/, '.pdf')));
  log({ at: 'end', t: Date.now() });
}
`);
const LOG = path.join(HOME, 'fake-soffice.log');
const logLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
function useFake(mode = 'ok') {
  fs.rmSync(LOG, { force: true });
  process.env.FAKE_SOFFICE_LOG = LOG;
  process.env.FAKE_SOFFICE_PDF = fileURLToPath(new URL('./fixtures/sample.pdf', import.meta.url)); // (a path with spaces or ~ too)
  process.env.FAKE_SOFFICE_MODE = mode;
  office.useSoffice({ bin: process.execPath, pre: [FAKE] });
}

test('LibreOffice conversion (stand-in): a throwaway locked-down profile, headless, offline proxies; one at a time; a hang is killed at the limit', async () => {
  useFake();
  const [a, b] = await Promise.all([office.officeToPdf(SAMPLE_DOCX, 'docx'), office.officeToPdf(SAMPLE_DOCX, 'docx')]);
  assert.equal(a.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(b.length > 0);
  const lines = logLines();
  const starts = lines.filter(l => l.at === 'start'), ends = lines.filter(l => l.at === 'end');
  assert.equal(starts.length, 2);
  assert.ok(starts[1].t >= ends[0].t, 'the second conversion started after the first ended');
  const { args } = starts[0];
  for (const flag of ['--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf', '--outdir']) assert.ok(args.includes(flag), flag);
  assert.match(args.find(x => x.startsWith('-env:UserInstallation=')), /^-env:UserInstallation=file:\/\/\//);
  assert.ok(starts[0].input && starts[0].macrosOff, 'the file and the locked-down profile were in place');
  assert.equal(starts[0].proxy, 'http://127.0.0.1:9', 'network pointed at a closed port');
  assert.match(office.PROFILE_XCU, /BlockUntrustedRefererLinks[\s\S]*ooInetProxyType/);
  await assert.rejects(office.officeToPdf(SAMPLE_DOCX, 'odt'), /Not an office file/);

  useFake('hang');
  await assert.rejects(office.officeToPdf(SAMPLE_DOCX, 'docx', { timeoutMs: 1500 }), err => err.name === 'TimeoutError' && /longer than 2 s/.test(err.message));
  const { pid } = logLines().find(l => l.at === 'start');
  let alive = true;
  for (let i = 0; i < 30 && alive; i++) { await new Promise(r => setTimeout(r, 100)); try { process.kill(pid, 0); } catch { alive = false; } }
  assert.equal(alive, false, 'the hung process was killed');
  office.useSoffice(null);
});

test('with LibreOffice (stand-in): an office file gets page pictures, a thumbnail and a printed preview above its content; make_* shows Jess page 1', async () => {
  useFake();
  const doc = docxItem(alice, 'Printed letter');
  assert.equal(lib.wantsPreview(doc), true);
  await lib.previewsSettled();
  const fresh = lib.getItem(doc.id);
  assert.deepEqual([fresh.has_thumb, fresh.preview_version, fresh.preview_pages], [1, 1, 2], 'the sample prints two pages');
  assert.ok(fs.existsSync(lib.renderFileOf(fresh)), 'the printed PDF is kept for pdf_page_image');
  const view = lib.itemView(fresh);
  assert.deepEqual(view.pagePictures, [1, 2].map(n => `/library/${fresh.public_id}/pages/${n}.jpg?v=1`));
  assert.equal((await ink(fs.readFileSync(lib.pageFileOf(fresh, 1)))).width, 1000);
  const html = lib.renderedDoc(fresh);
  assert.match(html, new RegExp(`<img src="/library/${fresh.public_id}/pages/1\\.jpg\\?v=1" alt="Page 1"`));
  assert.match(html, /<figcaption>Page 1 of 2, as printed<\/figcaption>/, 'each printed page says which it is (Phase 25, #196)');
  assert.match(html, /<div class="lib-pages-text"><p class="lib-pages-text-h">The text in it<\/p><article class="prose-jb"><p>Dear Theo<\/p><\/article><\/div>$/, 'the content preview stays below');

  const look = await getTool('pdf_page_image').run({ id: fresh.public_id, page: 2 }, toolCtx(alice));
  assert.ok(isShotRef(look.attachments[0]));
  assert.match(look.content, /Page 2 of 2 of “Printed letter”/);

  const made = await getTool('make_word_document').run({ title: 'Made letter', markdown: '# Hello\n\nA short letter.' }, toolCtx(alice));
  assert.ok(isShotRef(made.attachments?.[0]), 'first version: page 1 as it prints');
  assert.match(made.content, /Page 1 as it prints is shown below: fix only a real defect/);
  const again = await getTool('make_word_document').run({ id: made.item.public_id, title: 'Made letter', markdown: '# Hello\n\nA longer letter.' }, toolCtx(alice));
  assert.equal(again.attachments, undefined, 'a revision was already looked at');
  await lib.previewsSettled();
  assert.equal(lib.getItem(again.item.id).preview_version, 2, 'the new version is printed again for the Library');
  office.useSoffice(null);
  const plain = await getTool('make_word_document').run({ title: 'No office', markdown: '# Hi' }, toolCtx(alice));
  assert.equal(plain.attachments, undefined, 'without LibreOffice there is nothing to show');
});

test('LibreOffice (real, only where installed): a Word file converts to a PDF whose first page draws', { skip: !office.locateSoffice() && 'LibreOffice is not installed' }, async () => {
  office.useSoffice(null);
  office.findSoffice({ refresh: true });
  const pdf = await office.officeToPdf(SAMPLE_DOCX, 'docx');
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  const page = await render.renderPdfPage(pdf, 1, { format: 'png' });
  assert.ok((await render.brightnessSpread(page.buffer)) > 2);
});

// ---- The web: page pictures and the OCR API --------------------------------------------------------------------------------
test('web: page pictures are served to the owner by version; the OCR API estimates, then reads after that estimate', async () => {
  const { createApp } = await import('../src/app.js');
  const { createSession } = await import('../src/services/sessions.js');
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  const server = await listen(createApp());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Bearer ${createSession(alice.id, { kind: 'app', device: 'test' })}` };
  const other = { Authorization: `Bearer ${createSession(bob.id, { kind: 'app', device: 'test' })}` };
  try {
    useFake();
    const doc = docxItem(alice, 'Served');
    await lib.previewsSettled();
    office.useSoffice(null);
    const pic = await fetch(`${base}/library/${doc.public_id}/pages/1.jpg?v=1`, { headers: auth });
    assert.equal(pic.status, 200);
    assert.equal(pic.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(`${base}/library/${doc.public_id}/pages/3.jpg`, { headers: auth })).status, 404, 'the sample has two pages');
    assert.equal((await fetch(`${base}/library/${doc.public_id}/pages/1.jpg`, { headers: other })).status, 404, 'not someone else\'s');
    const page = await (await fetch(`${base}/library/${doc.public_id}`, { headers: auth })).text();
    assert.match(page, new RegExp(`/library/${doc.public_id}/pages/2\\.jpg\\?v=1`), 'the viewer shows the printed pages');

    const scan = await saveUpload(alice, { buffer: await scannedPdf(1), originalname: 'api scan.pdf' });
    const post = body => fetch(`${base}/api/v1/library/${scan.id}/ocr`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ confirm: true })).status, 400, 'no estimate shown yet');
    const est = await (await post({})).json();
    assert.deepEqual(est.estimate.pages, [1]);
    assert.match(est.estimate.costLabel, /^\$0\.00\d$/);
    const done = await (await post({ confirm: true })).json();
    assert.deepEqual(done.read, [1]);
    assert.equal(done.item.textSource, 'ocr');
    const item = await (await fetch(`${base}/api/v1/library/${scan.id}`, { headers: auth })).json();
    assert.equal(item.item.textSource, 'ocr');
  } finally {
    server.close();
    office.useSoffice(null);
  }
});

// ---- One way in for outside files; email files have their own origin (p22e follow-ups) ------------------------------------
test('storeFile: uploads, downloads and email files share it (title, source label, a kind already sniffed); refusals stay clear', async () => {
  const { storeFile, sniff } = await import('../src/services/uploads.js');
  const kind = await sniff(SAMPLE_PDF, 'x.pdf');
  const view = await storeFile(alice, { buffer: SAMPLE_PDF, name: 'scan_0042.pdf', title: 'Invoice 12' }, { sourceLabel: 'From email: “Invoice 12”', kind });
  assert.equal(view.title, 'Invoice 12');
  assert.equal(view.sourceLabel, 'From email: “Invoice 12”');
  assert.equal(view.origin, 'email');
  assert.equal(view.description, '2 pages', 'text extracted like an upload');
  assert.equal((await storeFile(alice, { buffer: SAMPLE_PDF, name: 'plain name.pdf' })).title, 'plain name', 'the title defaults to the name');
  await assert.rejects(storeFile(alice, { buffer: Buffer.alloc(0), name: 'empty.pdf' }), err => /is empty/.test(err.errors.file));
  await assert.rejects(storeFile(alice, { buffer: Buffer.from('MZ'), name: 'a.exe' }), err => /can’t read “a\.exe”/.test(err.errors.file));
  await lib.previewsSettled();
});

test('email origin: "From email: …" files are outside files like uploads and downloads (fenced, described, never regenerated over)', async () => {
  const mail = await import('../src/services/mail-files.js');
  assert.equal(mail.emailSourceLabel('Invoice 12'), 'From email: “Invoice 12”');
  const item = lib.createFileItem({ user: alice, title: 'invoice', type: 'doc', ext: 'docx', mime: DOCX_MIME, buffer: SAMPLE_DOCX, text: 'Dear Theo',
    sourceLabel: mail.emailSourceLabel('Invoice 12') });
  assert.equal(lib.originOf(item), 'email');
  assert.ok(lib.isOutsideFile(item));
  assert.equal(lib.fromWords(item), 'from email: “Invoice 12”');
  assert.equal(lib.outsideSource(item), 'an email: “Invoice 12”');
  const legacy = { source_label: 'Downloaded from an email: “Old”', public_id: 'x' };
  assert.equal(lib.originOf(legacy), 'downloaded', 'files saved before the email label still count as outside files');
  assert.equal(lib.fromWords({ source_label: 'Uploaded' }), 'uploaded by them');
  assert.equal(lib.fromWords({ source_label: 'from your budget question' }), 'made by you');
  // Office tools never regenerate over it; library_read fences it and says where it came from; library_list names it.
  const made = await getTool('make_word_document').run({ id: item.public_id, title: 'invoice', markdown: '# New' }, toolCtx(alice));
  assert.match(made.content, /“invoice” is a file from an email, so I didn’t replace it/);
  assert.notEqual(made.item.id, item.id);
  const read = await getTool('library_read').run({ id: item.public_id }, toolCtx(alice));
  assert.match(read, /from="from email: “Invoice 12”"|from email: “Invoice 12”/);
  assert.match(await getTool('library_list').run({ query: 'invoice' }, toolCtx(alice)), /· from email: “Invoice 12”/);
  await lib.previewsSettled();
});

// ---- PNG exports at print quality ------------------------------------------------------------------------------------------
test('PNG export scale: paper sizes are drawn at 2 pixels per CSS pixel, the social frames at exactly their size', () => {
  assert.equal(exp.pngScale('A4'), 2);
  assert.equal(exp.pngScale('A5'), 2);
  assert.equal(exp.pngScale('Letter'), 2);
  assert.equal(exp.pngScale('square'), 1);
  assert.equal(exp.pngScale('story'), 1);
});

test('make_pdf (real render): the first version comes with page 1 for Jess; a revision does not', { skip: !BROWSER && 'the browser is not installed (npm run browser:install)' }, async () => {
  const made = await getTool('make_pdf').run({ title: 'Menu', markdown: '# Menu\n\nSoup of the day.' }, toolCtx(alice));
  assert.ok(isShotRef(made.attachments?.[0]));
  assert.match(made.content, /Page 1 as it prints is shown below/);
  const again = await getTool('make_pdf').run({ id: made.item.public_id, title: 'Menu', markdown: '# Menu\n\nSoup and bread.' }, toolCtx(alice));
  assert.equal(again.attachments, undefined);
  await lib.previewsSettled();
});

test('PNG export (real render): an A5 PNG is 1118 px wide (2× its 559 px frame); a square stays 1080 px', { skip: !BROWSER && 'the browser is not installed (npm run browser:install)' }, async () => {
  const html = '<!doctype html><html><head><style>body{margin:0;font-family:"Noto Sans"}</style></head><body><h1>Menu</h1><p>Soup</p></body></html>';
  const a5 = await exp.exportPage(html, { format: 'png', size: 'A5' });
  assert.equal(pngWidth(a5.buffer), 1118);
  assert.equal(a5.scale, 2);
  const square = await exp.exportPage(html, { format: 'png', size: 'square' });
  assert.equal(pngWidth(square.buffer), 1080);
  assert.equal(square.scale, 1);
});
