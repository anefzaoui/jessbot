// DEV: end-to-end test of first-run setup, invites, auth and admin guards on a THROWAWAY data dir.
// Spawns its own server (random port), drives it with the local Edge/Chrome, then cleans up.
//   node scripts/e2e-setup.js            (makes one real, tiny LLM call during the "Brain" step)
//   node scripts/e2e-setup.js --no-llm   (skips the real call)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, request, executablePath as exe } from './lib/test-browser.js';
import { devModelKey } from './lib/model-key.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-e2e-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const NO_LLM = process.argv.includes('--no-llm');

// Its own copy of .env (keys the server makes stay in the throwaway folder); the model key, now sealed in the app's
// database (#10), comes as an environment variable the throwaway server uses and never stores (scripts/lib/model-key.js).
if (fs.existsSync(path.join(ROOT, '.env'))) fs.copyFileSync(path.join(ROOT, '.env'), path.join(HOME, '.env'));
const modelKey = devModelKey();
if (modelKey) process.env.OPENROUTER_KEY = modelKey;
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, JESSBOT_HOME: HOME, JESSBOT_ENV_FILE: path.join(HOME, '.env'), PORT: String(PORT), NODE_ENV: 'development' } });
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 45000); // a fresh database runs every migration first
  server.stdout.on('data', () => { if (log.includes('listening')) { clearTimeout(t); resolve(); } });
});

const browser = await chromium.launch({ executablePath: exe, headless: true });
const errors = [];
const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  // "Failed to load resource" console lines carry no URL — record failing responses (with their URL) instead.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 404 && ![410, 422].includes(r.status())) errors.push(`${r.status()} ${r.url()} [${r.request().resourceType()} ${r.request().method()}] (during: ${current})`); });
  return page;
};

let passed = 0, failed = 0, current = '';
async function test(name, fn) {
  current = name;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

const owner = await newPage();
let inviteLink;

try {
  await test('fresh install redirects to setup', async () => {
    await owner.goto(`${BASE}/chat`);
    expect(owner.url().endsWith('/setup/account'), `landed on ${owner.url()}`);
    expect(log.includes('setup code'), 'claim code not printed to console');
    expect(await owner.locator('#f-claim').count() === 1, 'the setup code field is missing (it is asked from every device)');
  });

  await test('account: validation errors render inline', async () => {
    await owner.fill('#f-name', 'Alex');
    await owner.fill('#f-email', 'owner@example.com');
    await owner.fill('#f-password', 'short');
    await owner.fill('#f-claim', /setup code[^:\n]*: ([A-Z0-9-]+)/.exec(log)?.[1] || ''); // the right code: only the password is wrong
    await owner.click('button:has-text("Create my account")');
    await owner.waitForSelector('[data-field-error]');
    expect(await owner.locator('#f-password[aria-invalid="true"]').count() === 1, 'password not flagged by server');
  });

  await test('account: creates owner and signs in', async () => {
    await owner.fill('#f-email', 'owner@example.com');
    await owner.fill('#f-password', 'correct horse battery');
    await owner.fill('#f-claim', 'WRONG-CODE1');
    await owner.click('button:has-text("Create my account")');
    await owner.waitForSelector('#f-claim[aria-invalid="true"]');
    expect(/doesn’t match/.test(await owner.locator('main').innerText()), 'a wrong setup code was not refused');
    const code = /setup code[^:\n]*: ([A-Z0-9-]+)/.exec(log)?.[1];
    expect(code, 'no setup code in the server log');
    await owner.fill('#f-password', 'correct horse battery');
    await owner.fill('#f-claim', code.toLowerCase()); // case doesn't matter
    await owner.click('button:has-text("Create my account")');
    await owner.waitForURL(/\/setup\/model/);
  });

  await test(`brain: ${NO_LLM ? 'skip' : 'real connection test'} → continue`, async () => {
    if (NO_LLM) {
      await owner.click('button:has-text("Skip for now")');
    } else {
      await owner.click('[data-test-button]');
      await owner.waitForSelector('[data-test-result] :text("Connected")', { timeout: 60000 });
      await owner.click('[data-continue]');
    }
    await owner.waitForURL(/\/setup\/browser/);
  });

  await test('internet: browser status shows (Ready when the binary is present) → continue', async () => {
    const state = await owner.getAttribute('[data-browser-state]', 'data-browser-state');
    expect(['ready', 'missing', 'installing'].includes(state), `unexpected browser state ${state}`);
    if (state === 'missing') expect(await owner.locator('button:has-text("Install browser")').count() === 1, 'no install button');
    const live = await owner.evaluate(() => fetch('/setup/browser/status').then(r => r.json()));
    expect(live.statusHtml?.includes('data-browser-state'), 'status endpoint returns no rendered card');
    if (process.env.E2E_SHOTS) await owner.screenshot({ path: path.join(process.env.E2E_SHOTS, 'setup-browser.png') });
    await owner.click('[data-continue]');
    await owner.waitForURL(/\/setup\/identity/);
  });

  await test('identity: live preview + saves SOUL.md', async () => {
    if (process.env.E2E_SHOTS) {
      await owner.screenshot({ path: path.join(process.env.E2E_SHOTS, 'setup-identity.png') });
      await owner.click('.choice-card:has(input[value="male"])');
      await owner.waitForTimeout(400);
      await owner.screenshot({ path: path.join(process.env.E2E_SHOTS, 'setup-identity-male.png') });
      await owner.click('.choice-card:has(input[value="female"])');
    }
    await owner.fill('#f-name', 'Jane');
    expect(await owner.textContent('[data-preview-name]') === 'Jane', 'preview name not live');
    expect((await owner.textContent('[data-preview-lineage]')).includes('originally Jess'), 'lineage missing');
    await owner.fill('#f-description', 'Our family organizer.');
    await owner.click('button:has-text("That\'s who they are")');
    await owner.waitForURL(/\/setup\/people/);
    const soul = fs.readFileSync(path.join(HOME, 'workspace', 'SOUL.md'), 'utf8');
    expect(soul.includes('**Name:** Jane') && soul.includes('The original Jessbot is called Jess'), 'SOUL.md identity block wrong');
    expect(fs.existsSync(path.join(HOME, 'workspace', 'AGENTS.md')), 'AGENTS.md not created');
  });

  await test('people: add group in place + create invite link', async () => {
    await owner.fill('#f-group', 'Family');
    await owner.click('[data-group-form] button');
    await owner.waitForSelector('[data-group-list] :text("Family")');
    await owner.fill('[data-invite-form] #f-name', 'Maya');
    await owner.selectOption('[data-invite-form] #f-groupId', { label: 'Family' });
    await owner.click('[data-invite-form] button:has-text("Create invite link")');
    await owner.waitForSelector('[data-invite-links] input');
    inviteLink = await owner.inputValue('[data-invite-links] input');
    expect(/\/invite\/[\w-]{20,}$/.test(inviteLink), `bad link ${inviteLink}`);
  });

  await test('finish → chat with the new name', async () => {
    await owner.click('button:has-text("Finish")');
    await owner.waitForURL(/\/chat/);
    expect((await owner.title()).includes('Jane'), `title is ${await owner.title()}`);
  });

  await test('setup is locked after completion', async () => {
    await owner.goto(`${BASE}/setup/account`);
    expect(owner.url().endsWith('/chat'), `setup reachable: ${owner.url()}`);
  });

  await test('admin: per-person instructions save + version history', async () => {
    await owner.goto(`${BASE}/admin/people`);
    await owner.click('main a[href^="/admin/people/"]:has-text("Alex")'); // the person row, not the rail's account menu
    await owner.waitForURL(/\/admin\/people\/\d+$/);
    const save = async text => {
      await owner.fill('textarea[name="body"]', text);
      await Promise.all([
        owner.waitForResponse(r => r.url().endsWith('/instructions') && r.request().method() === 'POST'),
        owner.click('form[action$="/instructions"] button:has-text("Save")'),
      ]);
    };
    await save('Keep it brief on weekdays.');
    await save('Keep it brief on weekdays. Use metric units.');
    await owner.goto(owner.url());
    expect((await owner.inputValue('textarea[name="body"]')).includes('metric'), 'latest version not shown');
    expect(await owner.locator('summary:has-text("Previous versions")').count() === 1, 'no version history');
    expect(await owner.locator('form[action$="/instructions"] .md-editor .md-layer').count() === 1, 'instructions have no markdown editor');
  });

  await test('admin: per-person permissions save and survive reload; defaults page renders', async () => {
    const form = owner.locator('form[action^="/admin/policy/user/"]');
    await form.locator('label.segment-choice:has(input[name="toolsets[memory]"][value="ask"])').click();
    await form.locator('select[name="approver"]').selectOption('admin');
    await Promise.all([
      owner.waitForResponse(r => r.url().includes('/admin/policy/user/') && r.request().method() === 'POST' && r.ok()),
      form.locator('button:has-text("Save")').click(),
    ]);
    await owner.goto(owner.url());
    expect(await owner.isChecked('form[action^="/admin/policy/user/"] input[name="toolsets[memory]"][value="ask"]'), 'memory=ask not persisted');
    expect((await owner.inputValue('form[action^="/admin/policy/user/"] select[name="approver"]')) === 'admin', 'approver not persisted');
    if (process.env.E2E_SHOTS) await owner.screenshot({ path: path.join(process.env.E2E_SHOTS, 'admin-person-permissions.png'), fullPage: true });
    await owner.goto(`${BASE}/admin/tools`);
    if (process.env.E2E_SHOTS) await owner.screenshot({ path: path.join(process.env.E2E_SHOTS, 'admin-tools.png'), fullPage: true });
    expect(await owner.locator('td:has-text("remember")').count() > 0, 'tool list missing remember');
  });

  let shotHref = null;
  await test('admin browser: real search + screenshot through the browser, settings persist, bad key rejected', async () => {
    await owner.goto(`${BASE}/admin/browser`);
    const state = await owner.getAttribute('[data-browser-state]', 'data-browser-state');
    if (state !== 'ready') { console.log(`      (browser ${state} — skipping live checks)`); return; }
    await owner.fill('#try-q', 'Lyon France');
    await owner.click('[data-browser-search] button');
    await owner.waitForSelector('[data-browser-result] ol li a', { timeout: 60000 });
    await owner.click('[data-browser-shot] button');
    await owner.waitForSelector('[data-browser-result] img', { timeout: 60000 });
    await owner.waitForFunction(() => document.querySelector('[data-browser-result] img')?.naturalWidth > 0, null, { timeout: 15000 });
    shotHref = await owner.getAttribute('[data-browser-result] img', 'src');
    await owner.waitForSelector('[data-browser-recent] li', { timeout: 15000 });
    if (process.env.E2E_SHOTS) await owner.screenshot({ path: path.join(process.env.E2E_SHOTS, 'admin-browser.png'), fullPage: true });

    await owner.click('label:has(input[name="blockMedia"])');
    await Promise.all([
      owner.waitForResponse(r => r.url().endsWith('/admin/browser/settings') && r.ok()),
      owner.click('form[action="/admin/browser/settings"] button:has-text("Save settings")'),
    ]);
    await owner.reload();
    expect(!(await owner.isChecked('input[name="blockMedia"]')), 'blockMedia setting not persisted');

    // The engine (decision #218): Chromium by default, no licence section; switching keeps the other settings.
    // The default (#221): the installed Google Chrome through Patchright when there is one, else Chromium.
    const firstEngine = await owner.getAttribute('input[name="engine"]:checked', 'value');
    expect(['chrome', 'chromium'].includes(firstEngine), `unexpected default engine ${firstEngine}`);
    expect(await owner.locator('form[action="/admin/browser/license"]').count() === 0, `a licence form shows for ${firstEngine}`);
    // Switch, then wait for the reloaded page to show the engine as saved (its server-rendered `checked`), not for a
    // navigation event that can come and go before the wait starts.
    const switchEngine = async id => {
      await owner.click(`label:has(input[name="engine"][value="${id}"])`);
      const [res] = await Promise.all([owner.waitForResponse(r => r.url().endsWith('/admin/browser/engine') && r.request().method() === 'POST'),
        owner.click('form[action="/admin/browser/engine"] button')]);
      expect(res.ok(), `switching to ${id} failed (${res.status()})`);
      await owner.waitForFunction(v => document.querySelector(`input[name="engine"][value="${v}"]`)?.defaultChecked, id, { timeout: 15000 });
    };
    await switchEngine('cloakbrowser');
    await owner.waitForSelector('form[action="/admin/browser/license"]');
    expect((await owner.innerText('[data-browser-status] h2')).includes('CloakBrowser'), 'status card not on CloakBrowser');
    expect(!(await owner.isChecked('input[name="blockMedia"]')), 'switching the engine reset another setting');
    await owner.fill('#bs-key', 'not-a-key');
    await owner.click('form[action="/admin/browser/license"] button');
    await owner.waitForSelector('form[action="/admin/browser/license"] [data-field-error]');
    await switchEngine(firstEngine);
    expect(await owner.getAttribute('[data-browser-state]', 'data-browser-state') === 'ready', `${firstEngine} not ready after switching back`);
  });

  const maya = await newPage();
  await test('invite: Maya joins, lands in chat', async () => {
    await maya.goto(inviteLink);
    expect((await maya.inputValue('#f-name')) === 'Maya', 'name not prefilled');
    await maya.fill('#f-email', 'maya@example.com');
    await maya.fill('#f-password', 'another good passphrase');
    await maya.fill('#f-confirm', 'another good passphrase');
    await maya.click('button:has-text("Join")');
    await maya.waitForURL(/\/chat/);
  });

  await test('invite link is single-use', async () => {
    const other = await newPage();
    const res = await other.goto(inviteLink);
    expect(res.status() === 410, `status ${res.status()}`);
  });

  await test('member cannot open admin', async () => {
    const res = await maya.goto(`${BASE}/admin`);
    expect(res.status() === 403, `status ${res.status()}`);
    expect((await maya.request.get(`${BASE}/admin/browser/status`)).status() === 403, 'member reached browser status');
    for (const p of ['/admin/usage', '/admin/system', '/admin/model', '/admin/system/logs']) {
      expect((await maya.request.get(`${BASE}${p}`)).status() === 403, `member reached ${p}`);
    }
  });

  await test('lists: two people on one shared list see each other’s adds and ticks live (no reload)', async () => {
    // The owner joins Family (Admin → People), so the shopping list can be shared with Maya.
    await owner.goto(`${BASE}/admin/people/1`, { waitUntil: 'networkidle' });
    await owner.check('form[action="/admin/people/1/groups"] input[name="groups"]');
    await owner.click('form[action="/admin/people/1/groups"] button:has-text("Save groups")');
    await owner.waitForSelector('.toast:has-text("Groups updated")');
    await owner.goto(`${BASE}/lists`, { waitUntil: 'networkidle' });
    await owner.click('[data-list-start="shopping"]');
    await owner.click('.segment-choice:has(input[value="Family"])');
    await owner.fill('[data-list-new-title]', 'Weekly shop');
    await Promise.all([owner.waitForURL(/\/lists\/\d+$/), owner.click('[data-list-new-form] button:has-text("Create list")')]);
    const listUrl = owner.url();
    await owner.fill('[data-list-add-input]', 'Milk 1L');
    await owner.keyboard.press('Enter');
    await owner.waitForSelector('[data-item-id][data-text="Milk"] .li-qty:has-text("1 L")');
    // Maya opens the same list; her page is live.
    await maya.goto(listUrl, { waitUntil: 'networkidle' });
    expect(await maya.locator('[data-item-id][data-text="Milk"]').count() === 1, 'Maya does not see Milk');
    await maya.waitForTimeout(800); // the socket is connected
    await owner.locator('[data-item-id][data-text="Milk"] .li-main').click();
    await maya.waitForSelector('.li-done [data-item-id][data-text="Milk"][data-done="true"]', { timeout: 8000 });
    expect(/Alex ticked it/.test(await maya.locator('.li-done [data-item-id][data-text="Milk"] .li-meta').innerText()), 'Maya can’t see who ticked it');
    await maya.fill('[data-list-add-input]', '12 eggs');
    await maya.keyboard.press('Enter');
    await owner.waitForSelector('[data-item-id][data-text="eggs"]', { timeout: 8000 });
    // Her Lists page shows it too.
    await maya.goto(`${BASE}/lists`, { waitUntil: 'networkidle' });
    expect(await maya.locator('.list-card:has-text("Weekly shop")').count() === 1, 'the shared list is not on Maya’s Lists page');
  });

  await test('admin skills: built-ins wait for review; Approve turns one on; members can’t reach the page', async () => {
    // Background requests don't indicate whether the skills are ready to review.
    await owner.goto(`${BASE}/admin/skills`, { waitUntil: 'domcontentloaded' });
    await owner.locator('[data-skill][data-status="review"]').first().waitFor();
    expect(await owner.locator('[data-skill][data-status="review"]').count() >= 4, 'built-in skills not listed for review');
    await owner.locator('[data-skill="research-report"] [data-skill-action="approve"]').click();
    await owner.waitForSelector('[data-skill="research-report"][data-status="active"]', { timeout: 15000 });
    // Writing a skill: its instructions editor colours markdown and previews it.
    await owner.locator('[data-skill-new]').first().click();
    await owner.locator('#skill-editor[open] #sk-body').fill('1. **Check** the calendar\n2. Then `book` it');
    await owner.waitForFunction(() => !!document.querySelector('#skill-editor .md-layer .md-b'), null, { timeout: 5000 });
    await owner.locator('#skill-editor [data-md-mode="preview"]').click();
    await owner.locator('#skill-editor [data-md-preview] ol li strong', { hasText: 'Check' }).waitFor({ timeout: 10000 });
    await owner.locator('#skill-editor [data-modal-close]').first().click();
    expect((await maya.request.get(`${BASE}/admin/skills`)).status() === 403, 'a member reached Admin → Skills');
  });

  await test('projects: a side chat becomes a project; the brief is edited in its panel; the switcher and rail list it; Maya can’t see it', async () => {
    await owner.goto(`${BASE}/chat/new`, { waitUntil: 'networkidle' });
    const sideUrl = owner.url();
    await owner.click('[popovertarget="thread-menu"]');
    await owner.click('[data-make-project]');
    await owner.fill('dialog[open] input', 'Home woodwork');
    await owner.click('dialog[open] button[value="ok"]');
    await owner.waitForURL(/\/projects\/[\w-]+$/, { timeout: 15000 });
    const url = owner.url();
    expect(await owner.locator('.chat-switch').innerText() === 'Home woodwork', 'header shows the project name');
    expect(await owner.locator('[data-rail-projects] a[aria-current="page"]').innerText() === 'Home woodwork', 'rail lists it as current');
    // The brief: add a next step, tick it off, edit a row (it becomes theirs), remove one.
    const panel = owner.locator('.proj-aside');
    await panel.locator('[data-brief-add] select').selectOption('next');
    await panel.locator('[data-brief-add] input').fill('Buy three oak boards');
    await panel.locator('[data-brief-add] button').click();
    await panel.locator('.brief-row', { hasText: 'Buy three oak boards' }).waitFor({ timeout: 10000 });
    await panel.locator('[data-brief-add] select').selectOption('decision');
    await panel.locator('[data-brief-add] input').fill('Oak, 30 mm shelves');
    await panel.locator('[data-brief-add] button').click();
    await panel.locator('.brief-row', { hasText: 'Oak, 30 mm' }).waitFor({ timeout: 10000 });
    await panel.locator('.brief-row', { hasText: 'Buy three oak boards' }).locator('[data-brief-done]').click();
    await panel.locator('details .brief-row.is-done', { hasText: 'Buy three oak boards' }).waitFor({ state: 'attached', timeout: 10000 });
    await panel.locator('.brief-row', { hasText: 'Oak, 30 mm' }).hover();
    await panel.locator('.brief-row', { hasText: 'Oak, 30 mm' }).locator('[data-brief-edit]').click();
    await owner.fill('dialog[open] input', 'Oak, 32 mm shelves');
    await owner.click('dialog[open] button[value="ok"]');
    await panel.locator('.brief-row', { hasText: 'Oak, 32 mm shelves' }).locator('.brief-mine').waitFor({ timeout: 10000 });
    await owner.reload({ waitUntil: 'networkidle' });
    expect(await owner.locator('.proj-aside .brief-row', { hasText: 'Oak, 32 mm shelves' }).count() === 1, 'brief edit did not survive a reload');
    // Edit the project itself: name and colour show everywhere after saving.
    await owner.click('[popovertarget="thread-menu"]');
    await owner.click('[data-project-edit]');
    await owner.fill('#pe-name', 'Workshop builds');
    await owner.locator('#project-editor .proj-icon-opt').nth(3).click();
    await owner.click('[data-project-save]');
    await owner.waitForFunction(() => document.querySelector('.chat-switch')?.innerText.trim() === 'Workshop builds', null, { timeout: 15000 });
    // Old /chat/:id links land on the project; the switcher lists it; the list page shows it.
    await owner.goto(sideUrl, { waitUntil: 'networkidle' });
    expect(owner.url() === url, `the old chat address did not open the project (${owner.url()})`);
    await owner.click('.chat-switch');
    expect(await owner.locator('#chat-switcher a', { hasText: 'Workshop builds' }).count() === 1, 'switcher lacks the project');
    await owner.keyboard.press('Escape');
    await owner.goto(`${BASE}/projects`, { waitUntil: 'networkidle' });
    expect(await owner.locator('.proj-tilecard', { hasText: 'Workshop builds' }).count() === 1, 'projects page lacks it');
    const id = url.split('/').pop();
    expect((await maya.request.get(`${BASE}/projects/${id}`)).status() === 404, 'another person opened the project');
    expect((await maya.request.get(`${BASE}/api/v1/projects/${id}`, { headers: { 'X-Requested-With': 'jessbot' } })).status() === 404, 'another person read the project API');
    // Phone: the brief opens as a sheet from the header.
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.goto(url, { waitUntil: 'networkidle' });
    await owner.click('[data-modal-open="project-sheet"]');
    await owner.locator('#project-sheet[open] .brief-row', { hasText: 'Oak, 32 mm shelves' }).waitFor({ timeout: 5000 });
    await owner.keyboard.press('Escape');
    await owner.setViewportSize({ width: 1280, height: 800 });
    // Delete: the chat and brief go; the list is empty again.
    await owner.click('[popovertarget="thread-menu"]');
    await owner.click('[data-project-delete]');
    await owner.click('dialog[open] button[value="ok"]');
    await owner.waitForURL(/\/projects$/, { timeout: 15000 });
    expect(await owner.locator('.proj-tilecard').count() === 0, 'deleted project still listed');
  });

  await test('feed sources: make a topic, add a site, pause, edit, remove — every step shows its result; admin sees it; members can’t', async () => {
    await owner.goto(`${BASE}/feed/sources`, { waitUntil: 'networkidle' });
    await owner.locator('[data-topic-new]').first().click();
    await owner.fill('#tp-label', 'Brazilian Football');
    await owner.fill('#tp-query', '"Flamengo" OR "Palmeiras"');
    await owner.click('[data-topic-save]');
    const card = owner.locator('[data-topic="brazilian-football"]');
    await card.waitFor({ timeout: 15000 });
    expect(await card.locator('[data-source-row]').count() === 1, 'a new topic starts with its Google News search');
    // A site with no feed is followed through Google News; the row shows up with a loader while it looks.
    await card.locator('input[name="url"]').fill('example.com');
    await card.locator('[data-source-add] button').click();
    expect(await owner.locator('[data-topic="brazilian-football"] .loader').count() === 1, 'no pending state while adding');
    await owner.waitForFunction(() => document.querySelectorAll('[data-topic="brazilian-football"] [data-source-row]').length === 2, null, { timeout: 90000 });
    expect(await owner.locator('[data-topic="brazilian-football"] [data-source-row][data-mine="true"]').count() === 1, 'added site not marked as theirs');
    expect(await owner.locator('[data-count="mine"]').innerText() === '1', 'summary not updated');
    await owner.locator('[data-topic="brazilian-football"] [data-topic-pause]').click();
    await owner.waitForSelector('[data-topic="brazilian-football"][data-paused="true"]', { timeout: 10000 });
    await owner.locator('[data-topic="brazilian-football"] [data-topic-pause]').click();
    await owner.waitForSelector('[data-topic="brazilian-football"][data-paused="false"]', { timeout: 10000 });
    await owner.locator('[data-topic="brazilian-football"] [data-topic-edit]').click();
    await owner.fill('#tp-query', 'Brasileirão Série A');
    await owner.click('[data-topic-save]');
    await owner.waitForFunction(() => document.querySelector('[data-topic="brazilian-football"]')?.dataset.query === 'Brasileirão Série A', null, { timeout: 10000 });
    await owner.locator('[data-topic="brazilian-football"] [data-source-row][data-mine="true"] [data-source-remove]').click();
    await owner.locator('dialog[open] button[value="ok"]').click();
    await owner.waitForFunction(() => document.querySelectorAll('[data-topic="brazilian-football"] [data-source-row]').length === 1, null, { timeout: 10000 });
    await owner.reload({ waitUntil: 'networkidle' });
    expect(await owner.locator('[data-topic="brazilian-football"] [data-source-row]').count() === 1, 'the removal did not survive a reload');
    // Admin → Feed sources lists it with its follower; members get 403.
    await owner.goto(`${BASE}/admin/feed-sources`, { waitUntil: 'networkidle' });
    expect(await owner.locator('[data-admin-source]').count() >= 1, 'admin list empty');
    expect((await maya.request.get(`${BASE}/admin/feed-sources`)).status() === 403, 'a member reached Admin → Feed sources');
    await owner.goto(`${BASE}/feed/sources`, { waitUntil: 'networkidle' });
    await owner.locator('[data-topic="brazilian-football"] [data-topic-delete]').click();
    await owner.locator('dialog[open] button[value="ok"]').click();
    await owner.waitForSelector('[data-topic="brazilian-football"]', { state: 'detached', timeout: 10000 });
  });

  await test('admin system: health, usage and model pages; Back up now → downloadable archive; live log', async () => {
    await owner.goto(`${BASE}/admin/usage`, { waitUntil: 'networkidle' });
    expect(await owner.locator('.usage-bar').count() === 30, 'no 30-day chart');
    await owner.goto(`${BASE}/admin/model`, { waitUntil: 'networkidle' });
    expect(await owner.locator('[data-model-test] #f-model').count() === 1, 'no model form');
    await owner.goto(`${BASE}/admin/system`, { waitUntil: 'networkidle' });
    expect(await owner.locator('[data-health] .health-row').count() >= 8, 'health checks missing');
    await owner.click('[data-backup-now]');
    const link = owner.locator('[data-backup-list] a[href*="jessbot-manual-"]').first();
    await link.waitFor({ timeout: 30000 });
    const dl = await owner.request.get(`${BASE}${await link.getAttribute('href')}`);
    expect(dl.ok() && (await dl.body()).subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])), 'backup is not a gzip archive');
    expect((await owner.request.get(`${BASE}/admin/system/backups/..%2F..%2Fjessbot.sqlite`)).status() === 404, 'backup download escaped the folder');
    const logs = await owner.request.get(`${BASE}/admin/system/logs?level=info`, { headers: { 'X-Requested-With': 'jessbot' } });
    expect(logs.ok() && Array.isArray((await logs.json()).lines), 'log tail failed');
  });

  await test('admin personality: /admin/soul opens the editor; save → history; restore brings it back', async () => {
    await owner.goto(`${BASE}/admin/soul`, { waitUntil: 'networkidle' });
    expect(/\/admin\/personality\/soul$/.test(owner.url()), `landed on ${owner.url()}`);
    const original = await owner.inputValue('#ws-body');
    await owner.fill('#ws-body', `${original}\n\n## Extra\nLoves terrible puns.`);
    // Markdown editor (Phase 15): the coloured layer follows the text; Ctrl+Shift+P shows the server's rendering, and back.
    await owner.waitForFunction(() => [...document.querySelectorAll('.md-layer .md-h2')].some(h => h.textContent === '## Extra'), null, { timeout: 5000 });
    await owner.focus('#ws-body');
    await owner.keyboard.press('Control+Shift+P');
    await owner.locator('[data-md-preview] .prose-jb h2', { hasText: 'Extra' }).waitFor({ timeout: 10000 });
    await owner.keyboard.press('Control+Shift+P');
    await owner.locator('#ws-body').waitFor({ state: 'visible' });
    await Promise.all([owner.waitForResponse(r => r.url().endsWith('/admin/personality/soul') && r.request().method() === 'POST' && r.ok()), owner.click('[data-personality-form] button:has-text("Save")')]);
    await owner.waitForLoadState('networkidle');
    await owner.goto(`${BASE}/admin/personality/soul`, { waitUntil: 'networkidle' });
    expect((await owner.inputValue('#ws-body')).includes('terrible puns'), 'edit not saved');
    expect(fs.readFileSync(path.join(HOME, 'workspace', 'SOUL.md'), 'utf8').includes('terrible puns'), 'SOUL.md on disk not updated');
    const restore = owner.locator('form[action*="/restore/"] button').last(); // the original
    owner.once('dialog', d => d.accept());
    await restore.click();
    await owner.locator('dialog[open] button[value="ok"]').click();
    await owner.waitForURL(/\/admin\/personality\/soul$/);
    await owner.waitForFunction(() => !document.querySelector('#ws-body')?.value.includes('terrible puns'), null, { timeout: 10000 });
    expect(!fs.readFileSync(path.join(HOME, 'workspace', 'SOUL.md'), 'utf8').includes('terrible puns'), 'restore did not revert the file');
  });

  await test('You page: real tabs — own addresses, instant switch, Back, old #links', async () => {
    await owner.goto(`${BASE}/me/memory`, { waitUntil: 'networkidle' });
    expect(await owner.isVisible('[data-me-panel="memory"]') && !(await owner.isVisible('[data-me-panel="profile"]')), '/me/memory did not open the Memory tab');
    await owner.evaluate(() => { window.__noReload = true; });
    await owner.click('[data-me-tab="places"]');
    await owner.waitForURL(/\/me\/places$/);
    expect(await owner.evaluate(() => window.__noReload === true), 'switching tabs reloaded the page');
    expect(await owner.isVisible('[data-me-panel="places"]'), 'Places panel not shown');
    await owner.goBack();
    await owner.waitForURL(/\/me\/memory$/);
    expect(await owner.isVisible('[data-me-panel="memory"]'), 'Back did not return to Memory');
    await owner.goto(`${BASE}/me#usage`, { waitUntil: 'networkidle' });
    await owner.waitForURL(/\/me\/usage$/);
    expect(await owner.isVisible('[data-me-panel="usage"]'), 'old #usage link did not open Usage');
    expect((await owner.request.get(`${BASE}/me/nope`)).status() === 404, 'unknown tab should 404');
  });

  await test('screenshots are private to their owner', async () => {
    if (!shotHref) { console.log('      (no screenshot taken — skipped)'); return; }
    // An isolated request context with Maya's cookies: the expected 404 must not show up as a page error.
    const asMaya = await request.newContext({ storageState: await maya.context().storageState() });
    expect((await asMaya.get(`${BASE}${shotHref}`)).status() === 404, 'member could open the owner\'s screenshot');
    await asMaya.dispose();
    expect((await owner.request.get(`${BASE}${shotHref}`)).status() === 200, 'owner cannot open own screenshot');
  });

  await test('login: wrong password → inline error; right password → next', async () => {
    const p = await newPage();
    await p.goto(`${BASE}/admin/people`);
    expect(p.url().includes('/login?next='), 'not redirected to login');
    await p.fill('#f-email', 'owner@example.com');
    await p.fill('#f-password', 'wrong password here');
    await p.click('button:has-text("Sign in")');
    await p.waitForSelector('[data-field-error]');
    await p.fill('#f-password', 'correct horse battery');
    await p.click('button:has-text("Sign in")');
    await p.waitForURL(/\/admin\/people/);
  });

  await test('API: bearer login (Android) → /me; bad token → 401', async () => {
    const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maya@example.com', password: 'another good passphrase', device: 'Pixel 9' }) });
    const { token } = await r.json();
    expect(r.ok && token, `login failed ${r.status}`);
    const me = await (await fetch(`${BASE}/api/v1/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(me.user?.name === 'Maya', 'me wrong');
    const bad = await fetch(`${BASE}/api/v1/me`, { headers: { Authorization: 'Bearer nope' } });
    expect(bad.status === 401, `bad token status ${bad.status}`);
  });

  await test('CSRF: cross-origin cookie POST is blocked', async () => {
    const cookies = await owner.context().cookies();
    const c = cookies.find(x => x.name === 'jb_session');
    const r = await fetch(`${BASE}/admin/groups`, { method: 'POST', headers: { Cookie: `jb_session=${c.value}`, Origin: 'https://evil.example', 'Content-Type': 'application/json', 'X-Requested-With': 'jessbot' }, body: '{"name":"Evil"}' });
    expect(r.status === 403, `status ${r.status}`);
  });

  await test('no uncaught page errors', async () => { expect(!errors.length, errors.join(' | ')); });
} finally {
  await browser.close();
  server.kill();
  await new Promise(r => setTimeout(r, 300));
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`\n--- server log ---\n${log.slice(-3000)}`);
process.exitCode = failed ? 1 : 0;
