// DEV: interaction regression tests against the styleguide's simulated API (local Edge/Chrome, localhost only).
//   node scripts/ui-flows.js [--base http://127.0.0.1:3738]
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://127.0.0.1:3738'; // dev server
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));

const browser = await chromium.launch({ executablePath: exe, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
// 503: the simulated failures; 422: validation the flows trigger on purpose (shown inline); 409: a request that closed
// while its card was open (shown on the card). None is a page bug.
page.on('console', m => { if (m.type() === 'error' && !/\b(503|422|409)\b/.test(m.text())) errors.push(m.text()); });
page.on('response', r => { if (r.status() === 404) errors.push(`404 ${r.url()}`); }); // which resource (the console line doesn't say)

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

await page.goto(`${BASE}/styleguide/screens/chat`, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

await test('question dock: number key picks and auto-advances', async () => {
  await page.locator('[data-ask-dock="q1"] .ask-step[data-step="0"] .ask-option').first().click();
  await page.waitForTimeout(400);
  expect(await page.locator('[data-ask-dock="q1"] .ask-step[data-step="1"]').isVisible(), 'did not advance to step 2');
});

await test('question dock: draft survives a refresh', async () => {
  await page.locator('[data-ask-dock="q1"] .ask-step[data-step="1"] .ask-option').nth(1).click();
  await page.reload({ waitUntil: 'networkidle' });
  const step2 = page.locator('[data-ask-dock="q1"] .ask-step[data-step="1"]');
  expect(await step2.isVisible(), 'step position not restored');
  expect(await step2.locator('.ask-input').nth(1).isChecked(), 'multi-select answer lost after refresh');
  expect(await page.locator('[data-ask-dock="q1"] .ask-step[data-step="0"] .ask-input').first().isChecked(), 'step 1 answer lost');
});

await test('question dock: validation blocks empty answer', async () => {
  await page.locator('[data-ask-dock="q1"] [data-ask-next]').click(); // step 2 → 3
  await page.locator('[data-ask-dock="q1"] [data-ask-next]').click(); // submit with step 3 empty
  expect(await page.locator('[data-ask-dock="q1"] .ask-step[data-step="2"] [data-ask-error]').isVisible(), 'no validation message');
});

await test('question dock: submit swaps history card to answered', async () => {
  await page.locator('[data-ask-dock="q1"] .ask-step[data-step="2"] .ask-option').first().click();
  await page.locator('[data-ask-dock="q1"] [data-ask-next]').click();
  await page.waitForSelector('[data-question-card="q1"][data-status="answered"]', { timeout: 5000 });
  await page.waitForSelector('[data-ask-dock="q1"]', { state: 'detached', timeout: 2000 }); // after exit animation
  expect(!(await page.evaluate(() => localStorage.getItem('jb-ask-draft:q1'))), 'draft not cleared');
});

await test('composer: optimistic bubble → server message + queued run', async () => {
  await page.fill('[data-composer-input]', 'Add popcorn to the order please');
  await page.keyboard.press('Enter');
  expect(await page.locator('[data-client-id][data-delivery="sending"]').count() === 1, 'no optimistic "sending" bubble');
  await page.waitForSelector('[data-run-status="queued"]', { timeout: 5000 });
  expect(!(await page.locator('[data-client-id]').count()), 'optimistic bubble not replaced');
});

await test('composer: failure shows Not sent + Retry, keeps text', async () => {
  await page.fill('[data-composer-input]', 'please fail this one');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-delivery="failed"] [data-message-resend]', { timeout: 5000 });
  expect(await page.locator('.toast[role="alert"]').count() > 0, 'no error toast');
});

await test('composer: draft persists across refresh', async () => {
  await page.fill('[data-composer-input]', 'half-written thought');
  await page.reload({ waitUntil: 'networkidle' });
  expect(await page.inputValue('[data-composer-input]') === 'half-written thought', 'draft lost');
  await page.fill('[data-composer-input]', '');
});

await test('approval: approve updates every copy + badge', async () => {
  await page.locator('main [data-approval-id="ap1"] .approval-actions [data-approval-action="approve"]').first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-approval-id="ap1"]')].every(c => c.dataset.status === 'approved'), null, { timeout: 5000 });
  expect(await page.locator('[data-live-count="approvals"]').first().textContent() === '1', 'badge count not updated');
});

await test('command palette: Ctrl+K, filter, Enter navigates', async () => {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('#cmdk[open]');
  await page.keyboard.type('libr');
  // Assert the palette navigates to /library (auth/setup gates may redirect afterwards).
  await Promise.all([page.waitForRequest(r => new URL(r.url()).pathname === '/library'), page.keyboard.press('Enter')]);
});

await test('theme: dark toggle applies and persists', async () => {
  await page.goto(`${BASE}/styleguide`, { waitUntil: 'networkidle' });
  await page.click('[popovertarget="user-menu"]');
  await page.click('[data-theme-set="dark"]');
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'dark not applied');
  await page.reload({ waitUntil: 'networkidle' });
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'dark not persisted');
});

await test('activity: setActivity updates avatar, strip and title', async () => {
  await page.click('[data-sg-activity="editing"]');
  await page.waitForTimeout(300);
  expect(await page.locator('[data-status-label]').first().textContent() === 'Editing · Budget 2027.xlsx', 'strip label wrong');
  expect((await page.locator('[data-avatar]').first().getAttribute('data-activity')) === 'editing', 'avatar not updated');
  expect((await page.title()).includes('Editing'), 'tab title not updated');
});

await test('presence: expression swaps never go see-through (no flash)', async () => {
  await page.goto(`${BASE}/styleguide/screens/chat?time=day&weather=clear`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000); // greeting moment settles, frames warmed
  // Sample both portrait layers every animation frame while a reaction plays and returns.
  const minCover = await page.evaluate(async () => {
    const group = document.querySelector('#chat-avatar .presence-portrait');
    const [a, b] = group.querySelectorAll('img');
    let min = 1;
    const t0 = performance.now();
    document.dispatchEvent(new CustomEvent('jb:moment', { detail: { kind: 'done' } }));
    while (performance.now() - t0 < 4500) {
      const oa = a.getAttribute('src') ? parseFloat(getComputedStyle(a).opacity) : 0;
      const ob = b.getAttribute('src') ? parseFloat(getComputedStyle(b).opacity) : 0;
      min = Math.min(min, Math.max(oa, ob));
      await new Promise(r => requestAnimationFrame(r));
    }
    return min;
  });
  expect(minCover >= 0.99, `portrait coverage dipped to ${minCover.toFixed(2)} (sky shows through)`);
});

await test('lightbox: a picture in a message opens full screen; arrows step through the message; Esc closes', async () => {
  await page.goto(`${BASE}/styleguide/screens/chat`, { waitUntil: 'networkidle' });
  const px = c => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="${c}"/></svg>`)}`;
  await page.evaluate(([a, b]) => {
    const msg = document.createElement('div');
    msg.className = 'prose-jb';
    msg.innerHTML = `<p><img src="${a}" alt="first"> <img src="${b}" alt="second"></p>`;
    document.querySelector('main').prepend(msg);
  }, [px('teal'), px('tomato')]);
  await page.locator('main .prose-jb img[alt="first"]').click();
  await page.waitForSelector('dialog.lightbox[open]');
  expect((await page.locator('[data-lb-count]').innerText()) === '1 / 2', 'counter should read 1 / 2');
  await page.keyboard.press('ArrowRight');
  expect((await page.locator('[data-lb-img]').getAttribute('alt')) === 'second', 'ArrowRight did not move to the next picture');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  expect(!(await page.locator('dialog.lightbox[open]').count()), 'Escape did not close the lightbox');
});

await test('markdown editor: coloured layer matches the text; Ctrl+Shift+P previews (server-rendered) and back; errors offer Try again', async () => {
  await page.goto(`${BASE}/styleguide/screens/admin-personality`, { waitUntil: 'networkidle' });
  const ta = page.locator('#ws-body');
  expect(await page.locator('.md-layer .md-h1').innerText() === '# SOUL', 'heading not coloured');
  expect(await page.locator('.md-layer .md-comment').count() >= 2, 'identity markers not dimmed');
  await ta.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\n**Fresh** line with `code`');
  await page.waitForFunction(() => document.querySelector('.md-layer').textContent.includes('**Fresh** line'));
  expect(/unsaved/.test(await page.locator('[data-char-count]').innerText()), 'the unsaved marker did not update');
  // The layer wraps exactly like the textarea (same height, same text) — the caret sits on its letters.
  const same = await page.evaluate(() => { const t = document.querySelector('#ws-body'), l = document.querySelector('.md-layer');
    return { t: t.scrollHeight, l: l.scrollHeight, w: [t.offsetWidth, l.offsetWidth], text: l.textContent.trimEnd() === t.value.trimEnd() }; });
  expect(same.text && Math.abs(same.t - same.l) <= 2, `layer drifted: ${JSON.stringify(same)}`);
  await page.keyboard.press('Control+Shift+P');
  await page.locator('[data-md-preview] .prose-jb h1').waitFor({ timeout: 5000 });
  expect(await page.locator('.md-stage').isHidden(), 'the editor is still showing in Preview');
  expect(await page.locator('[data-md-preview] strong', { hasText: 'Fresh' }).count() === 1, 'my edit is not in the preview');
  expect(await page.locator('[data-md-mode="preview"]').getAttribute('aria-selected') === 'true', 'Preview tab not selected');
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.md-stage').waitFor({ state: 'visible' });
  expect(await page.evaluate(() => document.activeElement?.id === 'ws-body'), 'focus did not return to the text');
  await page.keyboard.type(' fail');
  await page.locator('[data-md-mode="preview"]').click();
  await page.locator('[data-md-preview] [data-md-retry]').waitFor({ timeout: 5000 });
  await page.locator('[data-md-mode="edit"]').click();
});

// ---- Lists (Phase 25): the styleguide's simulated household (src/dev/lists-sim.js, reset on every screen load) ----
await test('lists: New list opens the form, the kind sets the name hint, Create goes to the new list', async () => {
  await page.goto(`${BASE}/styleguide/screens/lists`, { waitUntil: 'networkidle' });
  await page.click('[data-list-new]');
  expect(await page.isVisible('[data-list-new-form]'), 'form did not open');
  await page.click('.li-kind-choice:has(input[value="todo"])');
  expect((await page.getAttribute('[data-list-new-title]', 'placeholder')) === 'To-do list', 'placeholder did not follow the kind');
  await page.click('.li-kind-choice:has(input[value="wish"])');
  await page.click('.segment-choice:has(input[value="Family"])');
  expect(await page.isVisible('[data-list-wisher="Family"] select'), 'no "whose wishes" picker for a shared wish list');
  await page.fill('[data-list-new-title]', 'Garden jobs');
  await page.click('.li-kind-choice:has(input[value="todo"])');
  await Promise.all([page.waitForRequest(r => /\/lists\/\d+$/.test(new URL(r.url()).pathname) && r.resourceType() === 'document', { timeout: 6000 }),
    page.click('[data-list-new-form] button:has-text("Create list")')]);
});

await test('lists: adding shows a pending row at once, then the server’s row in its aisle with its quantity', async () => {
  await page.goto(`${BASE}/styleguide/screens/list`, { waitUntil: 'networkidle' });
  await page.fill('[data-list-add-input]', 'Yoghurt 500 g');
  await page.keyboard.press('Enter');
  expect(await page.locator('[data-client-row].is-new').count() === 1, 'no optimistic row');
  expect((await page.inputValue('[data-list-add-input]')) === '', 'the field was not cleared');
  const row = page.locator('.li-group:has(h2:has-text("Dairy & eggs")) [data-item-id][data-text="Yoghurt"]');
  await row.waitFor({ timeout: 6000 });
  expect((await row.locator('.li-qty').innerText()) === '500 g', 'quantity not parsed on the server');
  expect(!(await page.locator('[data-client-row]').count()), 'the pending row was not replaced');
});

await test('lists: a tick shows at once, a ring waits for the server, then the row moves to the basket', async () => {
  const milk = page.locator('[data-item-id][data-text="Milk"]');
  await milk.locator('.li-main').click();
  expect((await milk.getAttribute('data-done')) === 'true', 'tick not instant');
  expect((await milk.getAttribute('data-pending')) !== null, 'no pending state while the server confirms');
  await page.locator('.li-done [data-item-id][data-text="Milk"]').waitFor({ timeout: 6000 });
  expect(!(await page.locator('.li-group:not(.li-done) [data-item-id][data-text="Milk"]').count()), 'Milk is still in its aisle');
});

await test('lists: a failed add stays on the list with Retry and says why', async () => {
  await page.fill('[data-list-add-input]', 'please fail this');
  await page.keyboard.press('Enter');
  await page.locator('[data-client-row].is-failed [data-row-retry]').waitFor({ timeout: 6000 });
  expect(/Not added/.test(await page.locator('[data-client-row].is-failed').innerText()), 'no reason shown');
  await page.locator('[data-client-row].is-failed [data-row-drop]').click();
  expect(!(await page.locator('[data-client-row]').count()), 'Remove did not drop the failed row');
});

await test('lists: the half-typed item survives a refresh', async () => {
  await page.fill('[data-list-add-input]', 'Half a thought');
  await page.reload({ waitUntil: 'networkidle' });
  expect((await page.inputValue('[data-list-add-input]')) === 'Half a thought', 'draft lost');
  await page.fill('[data-list-add-input]', '');
});

await test('lists: a to-do gets someone and a due date from its change form', async () => {
  await page.goto(`${BASE}/styleguide/screens/list-todo`, { waitUntil: 'networkidle' });
  const tap = page.locator('[data-item-id][data-text="Fix the dripping bathroom tap"]');
  await tap.hover();
  await tap.locator('[data-list-edit]').click();
  const form = tap.locator('[data-list-editor-form]');
  await form.waitFor();
  expect((await form.locator('input[name="text"]').inputValue()) === 'Fix the dripping bathroom tap', 'form not filled from the row');
  await form.locator('select[name="assigneeId"]').selectOption({ label: 'Maya' });
  await form.locator('input[name="due"]').fill('2030-05-04T18:30');
  await form.locator('button:has-text("Save")').click();
  await page.locator('[data-item-id][data-text="Fix the dripping bathroom tap"] .li-chip:has-text("Maya")').waitFor({ timeout: 6000 });
  expect(/4 May, 18:30/.test(await page.locator('[data-item-id][data-text="Fix the dripping bathroom tap"] .li-meta').innerText()), 'due date not shown');
});

// ---- You (Phase 25): memory import, filters, pin; busy sharing; signed-in sites (src/dev/you-sim.js) -------------------
await test('memory import: paste → a preview with problems and duplicates unticked → save the chosen → the list shows them', async () => {
  await page.goto(`${BASE}/styleguide/screens/me-memory`, { waitUntil: 'networkidle' });
  await page.click('[data-import-open]');
  await page.fill('[data-import-text]', 'I am allergic to penicillin\nMy bank password is hunter2\nPrefers short answers on weekdays, detailed ones on weekends.\nKeiko’s birthday is 3 June');
  await page.click('[data-import-preview-btn]');
  expect(await page.locator('[data-import-preview-slot] .loader').count() === 1, 'no loader while it reads');
  await page.locator('[data-import-preview]').waitFor({ timeout: 6000 });
  const rows = page.locator('.mem-import-row');
  expect(await rows.count() === 4, `expected 4 candidates, got ${await rows.count()}`);
  expect(await page.locator('.mem-import-row.is-problem [data-import-pick]').isDisabled(), 'a password line can be ticked');
  expect(!(await page.locator('.mem-import-row.is-duplicate [data-import-pick]').isChecked()), 'a duplicate starts ticked');
  expect(await page.locator('.mem-import-row .mem-chip:has-text("3 Jun, every year")').count() === 1, 'the date was not read');
  expect((await page.locator('[data-import-save]').innerText()).includes('2 memories'), 'save button does not count the ticked ones');
  await page.click('[data-import-save]');
  await page.locator('[data-import-step="done"]:not([hidden])').waitFor({ timeout: 6000 });
  expect(/Saved 2 memories/.test(await page.locator('[data-import-result]').innerText()), 'no result line');
  await page.locator('[data-memory-list] [data-memory-id][data-text="I am allergic to penicillin"]').waitFor({ timeout: 4000 });
});

await test('memory: filters narrow the list; pin shows at once and stays after the server says yes', async () => {
  await page.click('[data-memory-filter="dated"]');
  const shown = await page.locator('[data-memory-id]:not([hidden])').count();
  expect(shown === 2, `Dates filter shows ${shown}, expected 2`);
  await page.click('[data-memory-filter="all"]');
  const row = page.locator('[data-memory-id="mm3"]');
  await row.hover();
  await row.locator('[data-memory-pin]').click();
  expect((await row.locator('[data-memory-pin]').getAttribute('aria-pressed')) === 'true', 'pin not instant');
  await page.waitForFunction(() => document.querySelector('[data-memory-id="mm3"] [data-memory-pin]')?.getAttribute('aria-busy') !== 'true', null, { timeout: 5000 });
  expect((await row.locator('[data-memory-pin]').getAttribute('aria-pressed')) === 'true', 'pin did not stick');
});

await test('busy sharing: the switch waits for the server, then says what it means', async () => {
  await page.goto(`${BASE}/styleguide/screens/me-connections`, { waitUntil: 'networkidle' });
  await page.locator('[data-share-busy-switch]').click();
  expect((await page.getAttribute('[data-share-busy]', 'data-pending')) !== null, 'no pending state');
  await page.waitForFunction(() => !document.querySelector('[data-share-busy]').hasAttribute('data-pending'), null, { timeout: 5000 });
  expect(!(await page.isChecked('[data-share-busy-switch]')), 'the switch did not stay off');
  expect(/Off\./.test(await page.locator('[data-share-busy-state]').innerText()), 'no confirmation line');
});

await test('signed-in sites: Sign me out asks, shows it working, then the site is gone', async () => {
  await page.locator('[data-site-forget="amazon.fr"]').click();
  await page.locator('dialog[open] button:has-text("Sign out")').click();
  await page.locator('[data-site="amazon.fr"][data-pending]').waitFor({ timeout: 2000 });
  await page.locator('[data-site="amazon.fr"]').waitFor({ state: 'detached', timeout: 6000 });
  expect((await page.locator('[data-sites-count]').innerText()) === '2 sites', 'count not updated');
});

// ---- Library (Phase 25): title and description edited in place; a calendar file offers Add to calendar -----------
await test('library viewer: title and description are edited in place; an empty title is refused where it was typed', async () => {
  await page.goto(`${BASE}/styleguide/screens/library-item`, { waitUntil: 'networkidle' });
  expect(await page.locator('[data-library-about]').isHidden(), 'the strip shows with nothing to say');
  await page.click('[popovertarget="item-menu"]');
  await page.click('#item-menu [data-library-details-open]');
  const form = page.locator('[data-library-details]');
  await form.waitFor();
  await form.locator('input[name="title"]').fill('');
  await form.locator('button:has-text("Save")').click();
  await form.locator('[data-field-error]').waitFor({ timeout: 5000 });
  await form.locator('input[name="title"]').fill('Big Sur, October');
  await form.locator('textarea[name="description"]').fill('Two nights at Treebones with the kids');
  await form.locator('button:has-text("Save")').click();
  await page.locator('[data-library-details]').waitFor({ state: 'detached', timeout: 5000 });
  expect((await page.locator('[data-library-title]').innerText()) === 'Big Sur, October', 'title not updated');
  expect((await page.locator('[data-library-description]').innerText()) === 'Two nights at Treebones with the kids', 'description not shown');
  expect(await page.locator('[data-library-about]').isVisible(), 'the strip should now show the description');
});

await test('library: a calendar file offers Add to calendar on its card and in its viewer; slide cards carry no accent stripe', async () => {
  await page.goto(`${BASE}/styleguide/screens/library`, { waitUntil: 'networkidle' });
  expect(await page.locator('[data-library-id="l8"] .library-card-action:has-text("Add to calendar")').count() === 1, 'no Add to calendar on the card');
  expect(await page.locator('[data-library-id="l9"]:has-text("Downloaded from amazon.fr")').count() === 1, 'the origin is not on the card');
  await page.goto(`${BASE}/styleguide/screens/library-slides`, { waitUntil: 'networkidle' });
  const top = await page.evaluate(() => getComputedStyle(document.querySelector('.slide-card[data-layout="bullets"]')).borderTopWidth);
  expect(top === '1px', `slide card top border is ${top}`);
  expect(await page.locator('.slide-card[data-layout="stats"] strong').count() === 3, 'stats not rendered as figures');
});

await test('off the record: the header toggle waits for the server, then the chip and a line say so; pressing again brings it back', async () => {
  await page.goto(`${BASE}/styleguide/screens/side-chat`, { waitUntil: 'networkidle' });
  const chipsHidden = () => page.evaluate(() => [...document.querySelectorAll('[data-offrecord-chip]')].every(c => c.hidden));
  expect(await chipsHidden(), 'chip shows before it is on');
  await page.click('.offrecord-toggle');
  expect((await page.getAttribute('.offrecord-toggle', 'aria-busy')) === 'true', 'no pending state');
  await page.locator('[data-offrecord-chip]:visible').waitFor({ timeout: 5000 });
  expect(await page.locator('[data-sidechat-badge]').isHidden(), 'the chip takes the Side chat badge’s place');
  expect((await page.getAttribute('.offrecord-toggle', 'aria-pressed')) === 'true', 'toggle not pressed');
  expect(await page.locator('.toast:has-text("Off the record")').count() > 0, 'no line saying what changed');
  await page.waitForFunction(() => document.querySelector('.offrecord-toggle').getAttribute('aria-busy') !== 'true');
  await page.click('.offrecord-toggle');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-offrecord-chip]')].every(c => c.hidden), null, { timeout: 5000 });
  expect((await page.getAttribute('.offrecord-toggle', 'aria-pressed')) === 'false', 'toggle still pressed');
  expect((await page.getAttribute('#thread-menu [data-offrecord-toggle]', 'aria-checked')) === 'false', 'the menu item did not follow');
  await page.goto(`${BASE}/styleguide/screens/chat`, { waitUntil: 'networkidle' });
  expect(!(await page.locator('.offrecord-toggle').count()), 'the main chat must not offer it');
});

// ---- Phase 25 part B (decisions #194-#196) ----------------------------------------------------------------------
await test('approval card: a long preview folds and opens in place; deny stamps it; a closed request says so', async () => {
  await page.goto(`${BASE}/styleguide/screens/approvals-states`, { waitUntil: 'networkidle' });
  const box = page.locator('main [data-approval-id="ap5"] [data-approval-preview-box]');
  expect(await box.getAttribute('data-folded') !== null, 'long letter not folded');
  const folded = await box.locator('[data-approval-preview]').evaluate(el => el.clientHeight);
  await box.locator('[data-approval-expand]').click();
  expect(await box.getAttribute('data-open') !== null, 'did not open');
  expect(await box.locator('[data-approval-preview]').evaluate(el => el.clientHeight) > folded, 'did not grow');
  expect(await page.locator('main [data-approval-id="ap6"] .approval-why[data-level="high"]').count() === 1, 'injection not shown');
  await page.locator('main [data-approval-id="ap7"] .approval-actions [data-approval-action="deny"]').click();
  await page.waitForFunction(() => document.querySelector('main [data-approval-id="ap7"]').dataset.status === 'denied', null, { timeout: 5000 });
  expect(await page.locator('main [data-approval-id="ap7"] [data-stamp="denied"]').isVisible(), 'no Denied stamp');
  expect(await page.locator('main [data-approval-id="ap7"] .approval-actions').isHidden(), 'actions still shown');
  await page.locator('main [data-approval-id="ap-closed"] .approval-actions [data-approval-action="approve"]').first().click();
  await page.waitForFunction(() => document.querySelector('main [data-approval-id="ap-closed"]').dataset.status === 'expired', null, { timeout: 5000 });
  expect(await page.locator('main [data-approval-id="ap-closed"] .approval-result:has-text("nothing was done")').count() === 1, 'closed line missing');
  expect(await page.locator('main [data-approval-id="ap-closed"] [data-stamp="expired"]').isVisible(), 'no Not done stamp');
});

await test('admin skills: words, status and category filter the list; the recommended set approves one by one', async () => {
  await page.goto(`${BASE}/styleguide/screens/admin-skills`, { waitUntil: 'networkidle' });
  const visible = () => page.locator('[data-skill-list] > [data-skill]:visible').count();
  const all = await visible();
  await page.fill('[data-skill-q]', 'flight');
  expect(await visible() === 1, 'search did not narrow to one');
  await page.fill('[data-skill-q]', 'zzzz');
  expect(await page.locator('[data-skill-none]').isVisible(), 'no empty note');
  await page.click('[data-skill-clear]');
  expect(await visible() === all, 'clear did not bring them back');
  await page.click('[data-skill-status="broken"]');
  expect(await visible() === 1, 'status filter');
  await page.click('[data-skill-status="all"]');
  await page.selectOption('[data-skill-category]', 'travel');
  expect(await visible() === 2, 'category filter');
  await page.selectOption('[data-skill-category]', '');
  await page.click('[data-skill-rec-approve]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-rec]')].every(li => ['ok', 'skipped', 'failed'].includes(li.dataset.result)), null, { timeout: 15000 });
  expect(await page.locator('[data-rec][data-result="ok"]').count() === 4, 'not every recommended skill was approved');
});

await test('skill review: the cost first, then the test with a bar per request and a proposal; approve anyway needs the tick', async () => {
  await page.goto(`${BASE}/styleguide/screens/skill-review`, { waitUntil: 'networkidle' });
  await page.evaluate(() => sessionStorage.clear());
  expect(await page.locator('[data-tt-run]').isHidden(), 'run offered before the cost');
  await page.check('[data-tt-suggest]');
  await page.click('[data-tt-dry]');
  await page.locator('[data-tt-run]:visible').waitFor({ timeout: 5000 });
  expect((await page.locator('[data-tt-estimate]').innerText()).includes('$0.004'), 'no cost shown');
  await page.fill('[data-tt-row] [data-tt-text] >> nth=0', 'who takes the kids to school tomorrow');
  expect(await page.locator('[data-tt-run]').isHidden(), 'an edit after the estimate must ask for the cost again');
  await page.click('[data-tt-dry]');
  await page.locator('[data-tt-run]:visible').waitFor({ timeout: 5000 });
  await page.click('[data-tt-run]');
  await page.locator('.skt-row.is-running').first().waitFor({ timeout: 2000 });
  await page.locator('.skt-summary').waitFor({ timeout: 8000 });
  expect(await page.locator('.skt-row .skt-bar').count() === 5, 'a bar per request');
  expect(await page.locator('[data-tt-suggestion]:has-text("nothing was changed")').count() === 1, 'the suggestion must say it is only a proposal');
  await page.reload({ waitUntil: 'networkidle' }); // the edited request survives a refresh
  expect(await page.inputValue('[data-tt-row] [data-tt-text] >> nth=0') === 'who takes the kids to school tomorrow', 'edited request lost');
  await page.click('[data-approve-anyway]');
  await page.locator('dialog[open] [data-confirm-check]').waitFor();
  await page.click('dialog[open] button[value="ok"]');
  await page.locator('.toast:has-text("Tick that you read")').waitFor({ timeout: 3000 });
});

await test('upcoming: Run it now on a failed task says Running now at once; a missed task’s note runs it from the chat', async () => {
  await page.goto(`${BASE}/styleguide/screens/upcoming`, { waitUntil: 'networkidle' });
  const card = page.locator('main [data-job-id="j2"]');
  expect(await card.locator('.job-run-now').isVisible(), 'no Run it now on a failed task');
  expect(await page.locator('main [data-job-id="j1"] .job-run-now').isHidden(), 'Run it now shown on a task that went fine');
  await card.locator('.job-run-now').click();
  expect(await card.getAttribute('data-status') === 'running', 'not Running now at once');
  expect(await card.locator('[data-when="running"]').isVisible(), 'the running line is hidden');
  await page.locator('.toast:has-text("Started")').waitFor({ timeout: 5000 });
  expect(await page.locator('main [data-job-id="j5"] [data-when="retrying"]:has-text("14:05")').isVisible(), 'retry time not shown');
  expect(await page.locator('[data-upcoming-dates] .up-date').count() === 3, 'dates missing');
  await page.goto(`${BASE}/styleguide/screens/run-states`, { waitUntil: 'networkidle' });
  const note = page.locator('.run-missed [data-schedule-run]');
  await note.click();
  await page.locator('.run-missed :text("Started below")').waitFor({ timeout: 5000 });
});

await test('goal: log a number (the card comes back with it), a refused value stays; step order saves, a loop is refused in place', async () => {
  await page.goto(`${BASE}/styleguide/screens/goal`, { waitUntil: 'networkidle' });
  const card = page.locator('[data-measure-id="m1"]');
  await card.locator('button:has-text("Log it")').click();
  await card.locator('.field-error').waitFor({ timeout: 2000 });
  await card.locator('input[name="value"]').fill('640');
  await card.locator('button:has-text("Log it")').click();
  await page.locator('[data-measure-id="m1"].just-logged').waitFor({ timeout: 5000 });
  expect((await page.locator('[data-measure-id="m1"] [data-measure-latest]').innerText()) === '640', 'latest not updated');
  expect(await page.locator('[data-measure-id="m1"] .spark').count() === 1, 'no sparkline');
  await page.click('[data-plan-id="pl1"] [data-step-order]');
  const form = page.locator('[data-plan-id="pl1"] [data-step-order-form]');
  expect(await form.locator('[data-order-for="pl1"]').count() === 0, 'a step can’t wait for itself');
  await form.locator('input[value="pl3"]').check();
  await form.locator('button:has-text("Save the order")').click();
  await form.locator('[data-order-error]:has-text("round in a circle")').waitFor({ timeout: 5000 });
  await form.locator('input[value="pl3"]').uncheck();
  expect(await form.locator('input[value="pl4"]').isDisabled(), 'a repeating step must not be offered');
  await Promise.all([page.waitForEvent('load', { timeout: 8000 }), form.locator('button:has-text("Save the order")').click()]);
  await page.goto(`${BASE}/styleguide/screens/goal-round2`, { waitUntil: 'networkidle' });
  expect((await page.locator('[data-ask-dock] h2').first().innerText()).startsWith('A couple more'), 'round 2 title');
});

await test('ideas: ✕ asks why; a reason dismisses with Undo; Not now brings it back later; a failure keeps the card', async () => {
  await page.goto(`${BASE}/styleguide/screens/ideas`, { waitUntil: 'networkidle' });
  const first = page.locator('[data-idea-grid] [data-idea-id]').first();
  const id = await first.getAttribute('data-idea-id');
  await first.locator('[data-idea-action="dismiss"]').click();
  await first.locator('[data-idea-why]').waitFor();
  await first.locator('[data-idea-reason="already_doing"]').click();
  await page.locator('.toast:has-text("Good to know")').waitFor({ timeout: 5000 });
  expect(await page.locator(`[data-idea-id="${id}"]`).count() === 0, 'card still there');
  const second = page.locator('[data-idea-grid] [data-idea-id]').first();
  await second.locator('[data-idea-action="dismiss"]').click();
  await second.locator('[data-idea-note]').fill('please fail');
  await second.locator('[data-idea-reason="not_for_me"]').click();
  await second.locator('[data-idea-why-error]:visible').waitFor({ timeout: 5000 });
  await second.locator('[data-idea-note]').fill('');
  await second.locator('[data-idea-reason="not_now"]').click();
  await page.locator('.toast:has-text("bring it back later")').waitFor({ timeout: 5000 });
});

await test('library: Listen says how long first, then records part by part; a scan shows the cost before it is read', async () => {
  await page.goto(`${BASE}/styleguide/screens/library-item`, { waitUntil: 'networkidle' });
  const box = page.locator('[data-library-listen-box]');
  expect(await box.isHidden(), 'the listen box shows before Listen');
  await page.click('[data-library-listen]');
  expect((await box.getAttribute('data-state')) === 'checking', 'no working state while it measures');
  await page.locator('[data-library-listen-box][data-state="estimate"]').waitFor({ timeout: 5000 });
  expect((await box.locator('[data-listen-length]').innerText()).startsWith('About 6 minutes'), 'no length');
  await box.locator('[data-library-listen-confirm]').click();
  await page.locator('[data-library-listen-box][data-state="recording"]').waitFor({ timeout: 5000 });
  expect((await box.locator('[data-listen-parts]').innerText()) === '4', 'parts not shown');
  await page.goto(`${BASE}/styleguide/screens/library-scan`, { waitUntil: 'networkidle' });
  const scan = page.locator('[data-library-ocr-box]');
  await scan.locator('[data-when="offer"][data-library-ocr]').click();
  await page.locator('[data-library-ocr-box][data-state="estimate"]').waitFor({ timeout: 5000 });
  expect((await scan.locator('[data-ocr-cost]').innerText()).includes('$0.031'), 'no cost before reading');
  expect((await scan.locator('[data-ocr-cost]').innerText()).includes('left this week'), 'no budget left');
  await Promise.all([page.waitForEvent('load', { timeout: 8000 }), scan.locator('[data-library-ocr-confirm]').click()]);
  await page.locator('.toast:has-text("Read 13 pages")').waitFor({ timeout: 3000 });
  await page.goto(`${BASE}/styleguide/screens/library-ocr`, { waitUntil: 'networkidle' });
  expect(await page.locator('[data-library-ocr-mark]:has-text("may contain errors")').isVisible(), 'no OCR marker');
  await page.goto(`${BASE}/styleguide/screens/library`, { waitUntil: 'networkidle' });
  expect(await page.locator('[data-library-id="l7"] [data-audio-play]').count() === 1, 'audio card has no play button');
});

// ---- Phase 25 part C (decisions #203-#205) ------------------------------------------------------------------------
await test('models: a fallback is tested as it is added (a failing one blocks Save), rows reorder, and Save marks them saved', async () => {
  await page.goto(`${BASE}/styleguide/screens/admin-models`, { waitUntil: 'networkidle' });
  const rows = page.locator('[data-fb-row]');
  expect(await rows.count() === 2, 'two saved fallbacks expected');
  await page.fill('[data-fb-input]', 'mistral/is-down');
  await page.click('[data-fb-add-btn]');
  const bad = page.locator('[data-fb-row][data-model="mistral/is-down"]');
  expect(await bad.getAttribute('data-state') === 'testing', 'a new row starts testing');
  await page.waitForFunction(() => document.querySelector('[data-fb-row][data-model="mistral/is-down"]')?.dataset.state === 'failed', null, { timeout: 5000 });
  expect(await page.locator('[data-fb-add]').getAttribute('data-full') !== null, 'three rows: the add field hides');
  await page.click('[data-test-button]');
  await page.locator('.toast', { hasText: 'didn’t answer' }).first().waitFor({ timeout: 3000 });
  await bad.locator('[data-fb-remove]').click();
  await page.waitForFunction(() => !document.querySelector('[data-fb-row][data-model="mistral/is-down"]'));
  await page.fill('[data-fb-input]', 'meta/llama-5');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-fb-row][data-model="meta/llama-5"]')?.dataset.state === 'ok', null, { timeout: 5000 });
  expect(/Answered in/.test(await page.locator('[data-fb-row][data-model="meta/llama-5"] .mdl-state').innerText()), 'no answer time');
  await page.locator('[data-fb-row][data-model="meta/llama-5"] [data-fb-move="up"]').click();
  expect((await page.inputValue('[data-fb-value]')) === 'anthropic/claude-sonnet-4.6, meta/llama-5, google/gemini-3-flash', 'order not kept in the field');
  await page.click('[data-test-button]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-fb-row]')].every(r => r.dataset.state === 'saved'), null, { timeout: 5000 });
  await page.fill('[data-bg-input]', 'openai/gpt-6-nano');
  expect(await page.locator('[data-bg]').getAttribute('data-state') === 'changed', 'background not marked changed');
  await page.click('[data-bg-test]');
  await page.waitForFunction(() => document.querySelector('[data-bg]').dataset.state === 'ok', null, { timeout: 5000 });
});

await test('pictures: saving shows the price and how it was worked out', async () => {
  await page.fill('#f-imodel', 'google/gemini-image');
  await page.click('[data-img-save]');
  await page.waitForFunction(() => document.querySelector('[data-images-form]').dataset.state === 'on', null, { timeout: 5000 });
  expect((await page.locator('[data-img-price-label]').innerText()) === 'about $0.039 a picture', 'price not shown');
  expect(/cost here lately/.test(await page.locator('[data-img-price-source]').innerText()), 'source not shown');
});

await test('usage: Read it now re-renders the balance card', async () => {
  await page.goto(`${BASE}/styleguide/screens/admin-usage`, { waitUntil: 'networkidle' });
  await page.click('[data-balance-refresh]');
  await page.waitForFunction(() => /About 6 days/.test(document.querySelector('[data-balance]').textContent), null, { timeout: 5000 });
  expect(await page.locator('[data-balance-gap] .bal-gap').count() === 1, 'gap note lost');
});

await test('wish log: Remove folds the row away and the counts follow; Arabic reads right to left', async () => {
  await page.goto(`${BASE}/styleguide/screens/admin-system`, { waitUntil: 'networkidle' });
  expect(await page.locator('[data-wish="3"] p[dir="auto"]').evaluate(el => getComputedStyle(el).direction) === 'rtl', 'Arabic wish not RTL');
  await page.hover('[data-wish="1"]');
  await page.click('[data-wish="1"] [data-wish-remove]');
  await page.waitForFunction(() => !document.querySelector('[data-wish="1"]'), null, { timeout: 5000 });
  expect((await page.locator('[data-wish-summary]').innerText()) === '2 wishes · asked 3 times', 'summary not updated');
});

await test('lessons: approve a proposal and retire one in place; promote asks first; a personal detail is refused inline', async () => {
  await page.goto(`${BASE}/styleguide/screens/admin-lessons`, { waitUntil: 'networkidle' });
  await page.click('[data-lesson="11"] [data-lesson-action="approve"]');
  await page.waitForFunction(() => document.querySelector('[data-lesson="11"]')?.dataset.status === 'active', null, { timeout: 5000 });
  expect((await page.locator('[data-count="proposed"]').innerText()) === '0', 'waiting count not updated');
  await page.click('[data-lesson="13"] [data-lesson-action="retire"]');
  await page.waitForFunction(() => document.querySelector('[data-lesson="13"]')?.dataset.status === 'retired', null, { timeout: 5000 });
  await page.click('[data-lesson-filter="retired"]');
  expect(await page.locator('[data-lesson]:visible').count() === 2, 'retired filter');
  await page.click('[data-lesson-filter="all"]');
  await page.click('[data-lesson="12"] [data-lesson-action="promote"]');
  await page.locator('dialog[open]').waitFor({ timeout: 3000 });
  await page.locator('dialog[open] button', { hasText: 'Promote' }).click();
  await page.waitForFunction(() => document.querySelector('[data-lesson="12"]')?.dataset.status === 'promoted', null, { timeout: 5000 });
  await page.locator('[data-lesson-new-open]').first().click();
  await page.fill('#ln-rule', 'Write to alex@example.com first');
  await page.click('[data-lesson-new] [type="submit"]');
  await page.locator('[data-lesson-new] .field-error').waitFor({ timeout: 5000 });
});

await test('you: keep a noted lesson; undo one change of the weekly tidy; a change that cannot be undone says why', async () => {
  await page.goto(`${BASE}/styleguide/screens/me-lessons`, { waitUntil: 'networkidle' });
  await page.click('[data-my-lesson="21"] [data-my-lesson-action="keep"]');
  await page.waitForFunction(() => document.querySelector('[data-my-lesson="21"]')?.dataset.status === 'active', null, { timeout: 5000 });
  await page.click('[data-tidy-change="51"] [data-tidy-undo]');
  await page.waitForFunction(() => document.querySelector('[data-tidy-change="51"]')?.dataset.undone === 'true', null, { timeout: 5000 });
  expect(!(await page.locator('[data-tidy-change="51"] [data-tidy-undo]').count()), 'Undo still offered');
  await page.click('[data-tidy-change="53"] [data-tidy-undo]');
  await page.locator('[data-tidy-change="53"] [data-tidy-error]:visible').waitFor({ timeout: 5000 });
});

await test('sources: OPML paste shows what was added and skipped; muted words add and remove (Arabic works)', async () => {
  await page.goto(`${BASE}/styleguide/screens/feed-sources`, { waitUntil: 'networkidle' });
  await page.click('[data-opml-paste-open]');
  await page.fill('[data-opml-text]', '<opml version="2.0"><body><outline text="Tech"><outline text="Ars" xmlUrl="https://arstechnica.com/feed/"/>'
    + '<outline text="Ars again" xmlUrl="https://arstechnica.com/feed/"/><outline text="Reuters" xmlUrl="https://reuters.com/rss"/>'
    + '<outline text="Bad" xmlUrl="nope"/></outline></body></opml>');
  await page.click('[data-opml-import]');
  await page.locator('[data-opml-result]').waitFor({ timeout: 5000 });
  expect(/Added 1 feed, skipped 3/.test(await page.locator('[data-opml-result]').innerText()), 'summary wrong');
  expect(await page.locator('[data-opml-result] [data-skip]').count() === 3, 'skip reasons not grouped');
  await page.fill('[data-mute-input]', 'كرة القدم');
  await page.click('[data-mute-add]');
  await page.waitForSelector('[data-mute="كرة القدم"]', { timeout: 5000 });
  expect((await page.locator('[data-mute-count]').innerText()) === '2 of 100', 'count not updated');
  await page.click('[data-mute="spoiler"] [data-unmute]');
  await page.waitForFunction(() => !document.querySelector('[data-mute="spoiler"]'), null, { timeout: 5000 });
  await page.fill('[data-mute-input]', 'one two three four five six');
  await page.click('[data-mute-add]');
  await page.locator('[data-mute-form] .field-error').waitFor({ timeout: 5000 });
});

await test('feed: the diet card shows once a month and hides until next month; a gone story explains itself', async () => {
  await page.goto(`${BASE}/styleguide/screens/feed-diet`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('jb-diet-hidden'));
  await page.reload({ waitUntil: 'networkidle' });
  expect(await page.locator('[data-diet]').isVisible(), 'diet card hidden');
  await page.click('[data-diet-dismiss]');
  await page.reload({ waitUntil: 'networkidle' });
  expect(!(await page.locator('[data-diet]').count()), 'dismissed card came back this month');
  await page.goto(`${BASE}/styleguide/screens/feed-story-gone`, { waitUntil: 'networkidle' });
  expect(await page.locator('text=That story isn’t here any more').count() === 1, 'no gone-story state');
});

await test('reminders: Done closes the reminder on its cards; the consent card takes a Yes', async () => {
  await page.goto(`${BASE}/styleguide/screens/chat-reminders`, { waitUntil: 'networkidle' });
  expect(await page.locator('[data-reminder-card][data-post="901"] .rem-earlier').isVisible(), 'older nudge not folded');
  const card = page.locator('[data-reminder-card][data-post="902"]');
  expect(/Nudge 1 of 3/.test(await card.innerText()), 'nudge line missing');
  await card.locator('[data-reminder-done]:visible').click();
  await page.waitForFunction(() => document.querySelector('[data-reminder-card][data-post="902"]').dataset.state === 'closed', null, { timeout: 5000 });
  expect(/Done at/.test(await card.innerText()), 'closed line missing');
  expect(await page.locator('[data-reminder-card][data-post="901"]').getAttribute('data-state') === 'closed', 'the older card of the same reminder not repainted');
  await page.locator('[data-consent-card] [data-consent-answer="yes"]').first().click();
  await page.waitForFunction(() => document.querySelector('[data-consent-card]').dataset.status === 'granted', null, { timeout: 5000 });
  expect(await page.locator('[data-consent-card] [data-consent-answer="no"]:visible').count() === 1, 'no way to change the answer');
});

await test('admin browser: Forget a learned search page, turn blocking back on for a site, a wrong LibreOffice path is refused inline', async () => {
  await page.goto(`${BASE}/styleguide/screens/admin-browser`, { waitUntil: 'networkidle' });
  await page.locator('[data-recipe="1"] [data-recipe-delete]').click();
  await page.locator('[data-recipe="1"]').waitFor({ state: 'detached', timeout: 5000 });
  await page.locator('.toast:has-text("Forgot the search page on leboncoin.fr")').waitFor({ timeout: 3000 });
  await page.locator('[data-off-host="lemonde.fr"] [data-adblock-on]').click();
  await page.locator('[data-off-host="lemonde.fr"]').waitFor({ state: 'detached', timeout: 5000 });
  await page.fill('#office-path', 'C:/nowhere/notes.txt');
  await page.click('[data-office-form] button:has-text("Save")');
  await page.locator('[data-office-form] .field-error, [data-office-form] [aria-invalid="true"]').first().waitFor({ timeout: 5000 });
  await page.fill('#office-path', 'C:/Program Files/LibreOffice/program/soffice.exe');
  await page.click('[data-office-form] button:has-text("Save")');
  await page.locator('[data-office-status]:has-text("LibreOffice found at")').waitFor({ timeout: 5000 });
  expect(await page.locator('[data-browser-searxng][data-state="error"]').count() === 1, 'SearXNG line missing');
});

await test('reply actions: Simpler sends the plain turn with simpler: true; a follow-up chip sends its question', async () => {
  await page.goto(`${BASE}/styleguide/screens/chat`, { waitUntil: 'networkidle' });
  const reply = page.locator('[data-message-id="m3"]');
  await reply.hover();
  const [req] = await Promise.all([page.waitForRequest(r => r.url().endsWith('/threads/main/messages') && r.method() === 'POST'),
    reply.locator('[data-message-simpler]').click()]);
  const body = req.postDataJSON();
  expect(body.simpler === true && body.text.startsWith('Explain that again more simply'), 'Simpler did not send its turn');
  await page.locator('[data-message-list] .msg-user:has-text("Explain that again more simply")').last().waitFor({ timeout: 5000 });
  expect(await reply.locator('[data-follow-up]').count() === 3, 'chips missing');
  const [req2] = await Promise.all([page.waitForRequest(r => r.url().endsWith('/threads/main/messages') && r.method() === 'POST'),
    reply.locator('[data-follow-up]').first().click()]);
  expect(req2.postDataJSON().text === 'Do they take a deposit for Friday?' && !req2.postDataJSON().simpler, 'the chip did not send its question');
  await page.locator('[data-message-list] .msg-user:has-text("Do they take a deposit")').last().waitFor({ timeout: 5000 });
});

// ---- Phase 25 part D (#211–#213) -------------------------------------------------------------------------------------------
await test('thumbs-down: "What was off?" opens; Skip gives a Noted guess with Keep / No; No says it won’t guess again', async () => {
  await page.goto(`${BASE}/styleguide/screens/chat-feedback`, { waitUntil: 'networkidle' });
  const reply = page.locator('[data-db-id="7102"]');
  await reply.hover();
  const [req] = await Promise.all([page.waitForRequest(r => r.url().endsWith('/messages/7102/feedback')), reply.locator('[data-message-feedback="down"]').click()]);
  expect(req.postDataJSON().noteFirst === true, 'the thumbs-down was not saved at once with noteFirst');
  await reply.locator('[data-fb-note][data-state="asking"]').waitFor({ timeout: 3000 });
  expect(await reply.locator('[data-fb-note-text]').evaluate(el => el === document.activeElement), 'the field is not focused');
  await reply.locator('[data-fb-note-skip]').click();
  expect(await reply.locator('[data-fb-note][data-state="thinking"]').count() === 1, 'no working state after Skip');
  await reply.locator('[data-noted][data-state="proposed"]').waitFor({ timeout: 5000 });
  await reply.locator('[data-noted-no="reject"]').click();
  await reply.locator('[data-noted][data-state="rejected"]').waitFor({ timeout: 5000 });
  expect(/won’t guess it again/.test(await reply.locator('[data-noted]').innerText()), 'rejected words missing');
});

await test('thumbs-down: taking it back clears the form; their words make a rule in use (Remove, no Keep)', async () => {
  const reply = page.locator('[data-db-id="7102"]');
  await reply.hover();
  await reply.locator('[data-message-feedback="down"]').click(); // take it back
  await page.waitForFunction(() => document.querySelector('[data-db-id="7102"] [data-noted-slot]').hidden, null, { timeout: 3000 });
  await reply.locator('[data-message-feedback="down"]').click();
  await reply.locator('[data-fb-note-text]').fill('Too long, I only needed the one train.');
  await reply.locator('[data-fb-note-text]').press('Control+Enter');
  await reply.locator('[data-noted][data-state="active"]').waitFor({ timeout: 5000 });
  expect(await reply.locator('[data-noted-keep]:visible').count() === 0 && await reply.locator('[data-noted-no="remove"]:visible').count() === 1, 'wrong buttons for a rule from their words');
});

await test('thumbs-down: Keep on a guess from the page load; a reply with nothing to learn says thanks', async () => {
  await page.click('[data-noted="701"] [data-noted-keep]');
  await page.locator('[data-noted="701"][data-state="kept"]').waitFor({ timeout: 5000 });
  expect(await page.locator('[data-noted="701"] a[href="/me/memory#h-lessons"]:visible').count() === 1, 'no link to How I work with you');
  expect(await page.locator('[data-db-id="7104"] [data-noted][data-state="active"]').count() === 1, 'a rule from their words shows on load');
  const other = page.locator('[data-db-id="7105"]');
  await other.hover();
  await other.locator('[data-message-feedback="down"]').click({ timeout: 5000 });
  await other.locator('[data-fb-note-skip]').click({ timeout: 5000 });
  await other.locator('[data-fb-note][data-state="thanks"]').waitFor({ timeout: 5000 });
});

await test('paused task note: Resume turns it back on; the trust chip lists what the reply rests on', async () => {
  await page.click('[data-schedule-resume]');
  await page.locator('[data-schedule-paused]:has-text("Resumed")').waitFor({ timeout: 5000 });
  await page.click('[data-db-id="7102"] [data-trust] summary');
  expect(await page.locator('[data-db-id="7102"] .trust-item').count() === 5, 'sources not listed');
});

await test('background: the delegate link stays visible; #run-<id> opens at that reply; the side chat shows its folded brief', async () => {
  await page.goto(`${BASE}/styleguide/screens/chat-background#run-8101`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#run-8101.is-target', { timeout: 3000 });
  expect(await page.locator('#run-8101 .run-bg-link[href$="side-chat-background"]').count() === 1, 'delegate link missing');
  expect(await page.locator('.msg-assistant .badge:has-text("Background task")').count() === 1, 'post-back badge missing');
  await page.goto(`${BASE}/styleguide/screens/side-chat-background`, { waitUntil: 'networkidle' });
  const fold = page.locator('[data-bg-brief="delegate"] details');
  expect(!(await fold.getAttribute('open')), 'brief not folded');
  await fold.locator('summary').click();
  expect(/Constraints: under €450/.test(await fold.innerText()), 'brief text missing');
  expect(await page.locator('[data-bg-brief] a[href*="#run-8101"]').count() === 1, 'no link back to where it started');
  expect(await page.locator('.rail-link:has-text("Working on: Compare 3 standing desks") .rail-bg-tag').count() === 1, 'rail badge missing');
});

await test('overnight prep: the You switch saves and says so; the Ready card starts the idea; the admin cap saves', async () => {
  await page.goto(`${BASE}/styleguide/screens/me-notifications`, { waitUntil: 'networkidle' });
  await page.click('[data-prep-switch]');
  await page.waitForFunction(() => document.querySelector('[data-prep]').dataset.value === 'ideas', null, { timeout: 5000 });
  expect(/On\. Tonight/.test(await page.locator('[data-prep-state]').innerText()), 'no confirmation line');
  await page.goto(`${BASE}/styleguide/screens/ideas-ready`, { waitUntil: 'networkidle' });
  expect(await page.locator('[data-idea-grid] [data-idea-id="i3"]').count() === 0, 'the ready idea is also in the grid');
  await Promise.all([page.waitForURL(/screens\/chat$/, { timeout: 5000 }), page.click('[data-ready] [data-idea-action="start"]')]);
  await page.goto(`${BASE}/styleguide/screens/admin-usage`, { waitUntil: 'networkidle' });
  await page.fill('#prep-cap', '5');
  await page.click('[data-prep-cap] [type="submit"]');
  await page.locator('[data-prep-cap] .field-error').waitFor({ timeout: 5000 });
  await page.fill('#prep-cap', '0.1');
  await page.click('[data-prep-cap] [type="submit"]');
  await page.locator('[data-prep-cap-state]:has-text("up to $0.10 a night")').waitFor({ timeout: 5000 });
});

await test('self-review: approve one (it says what it did), reject one with a reason, Run now re-renders the card', async () => {
  await page.goto(`${BASE}/styleguide/screens/admin-system`, { waitUntil: 'networkidle' });
  await page.click('[data-rv-prop="51"] [data-rv-approve]');
  await page.locator('[data-rv-prop="51"][data-status="approved"]').waitFor({ timeout: 5000 });
  expect(/AGENTS\.md saved/.test(await page.locator('[data-rv-prop="51"] [data-rv-result]').innerText()), 'result not shown');
  await page.click('[data-rv-prop="52"] [data-rv-reject-open]');
  await page.fill('[data-rv-prop="52"] [name="reason"]', 'We still send faxes to the town hall');
  await page.click('[data-rv-prop="52"] [data-rv-reject] [type="submit"]');
  await page.locator('[data-rv-prop="52"][data-status="rejected"]').waitFor({ timeout: 5000 });
  expect(/town hall/.test(await page.locator('[data-rv-prop="52"] [data-rv-reason]').innerText()), 'reason not shown');
  expect((await page.locator('[data-rv-pending]').innerText()) === '1 to decide', 'pending badge not updated');
  await page.click('[data-rv-run]');
  await page.locator('[data-self-review] .rv-running').waitFor({ timeout: 2000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-rv-prop][data-status="pending"]').length === 3, null, { timeout: 8000 });
  await page.click('[data-doing-days="30"]');
  await page.waitForFunction(() => document.querySelector('[data-doing]').dataset.days === '30', null, { timeout: 5000 });
});

await test('what’s new: the preview follows the lines; Publish asks, then the note shows as published', async () => {
  const entry = page.locator('[data-wn-entry="42"]');
  await entry.locator('[data-wn-lines]').fill('One line people will read.\nAnother one.\nA third.');
  expect(await entry.locator('[data-wn-preview] li').count() === 3, 'preview did not follow');
  expect((await entry.locator('[data-wn-count]').innerText()) === '3 of 6 lines', 'count did not follow');
  await entry.locator('[data-wn-publish]').click();
  await page.locator('dialog[open]').waitFor({ timeout: 3000 });
  await page.locator('dialog[open] button', { hasText: 'Publish' }).click();
  await page.locator('[data-wn-entry="42"][data-status="published"]').waitFor({ timeout: 6000 });
});

await test('what’s new card: shown once in the chat; Got it folds it away and it stays gone after a reload', async () => {
  await page.goto(`${BASE}/styleguide/screens/chat-whats-new?reset=1`, { waitUntil: 'networkidle' });
  const card = page.locator('[data-whats-new]');
  expect(await card.isVisible(), 'card not shown');
  expect(await card.locator('[data-wn-lines] li:visible').count() === 4 && await card.locator('[data-wn-more]').isVisible(), 'long note not folded');
  await card.locator('[data-whats-new-seen]').click();
  await card.waitFor({ state: 'detached', timeout: 5000 });
  await page.goto(`${BASE}/styleguide/screens/chat-whats-new`, { waitUntil: 'networkidle' });
  expect(!(await page.locator('[data-whats-new]').count()), 'the card came back');
});

await test('library: a kind chip filters and lives in the address; search finds a match inside a file', async () => {
  await page.goto(`${BASE}/styleguide/screens/library`, { waitUntil: 'networkidle' });
  await page.click('[data-filter-key="pdf"]');
  expect(/[?&]type=pdf/.test(page.url()), 'the filter is not in the address');
  expect(await page.locator('[data-library-id]:visible').count() === 4, 'PDF filter wrong');
  await page.reload({ waitUntil: 'networkidle' });
  expect(await page.locator('[data-filter-key="pdf"]').getAttribute('aria-pressed') === 'true', 'filter lost on reload');
  await page.click('[data-filter-key="all"]');
  await page.fill('[data-library-search]', 'endgame');
  await page.locator('[data-library-search-state]:has-text("inside the files")').waitFor({ timeout: 5000 });
  expect(await page.locator('[data-library-id="l1"]:visible').count() === 1, 'the file with the word inside is not shown');
});

await test('goals: a new number to track joins the grid; a missing target is refused inline', async () => {
  await page.goto(`${BASE}/styleguide/screens/goal`, { waitUntil: 'networkidle' });
  const before = await page.locator('[data-goal-measures] [data-measure-id]').count();
  await page.click('[data-measure-new-open]');
  await page.fill('#mn-label', 'Pages read');
  await page.click('[data-measure-new] [type="submit"]');
  await page.locator('[data-measure-new-error]:visible').waitFor({ timeout: 5000 });
  await page.fill('#mn-week', '5');
  await page.click('[data-measure-new] [type="submit"]');
  await page.waitForFunction(n => document.querySelectorAll('[data-goal-measures] [data-measure-id]').length === n + 1, before, { timeout: 5000 });
});

await test('no uncaught page errors', async () => { expect(!errors.length, errors.join(' | ')); });

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
