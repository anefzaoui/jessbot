// npm run browser:sandbox [-- --engine chromium|chrome|cloakbrowser] (node scripts/sandbox-probe.mjs) — start the browser engine the way Jessbot does and
// report whether Chromium's sandbox is on (#37): the launch outcome, Chromium's own chrome://sandbox page, and a real page
// load. Uses its own throwaway settings (no database); JESSBOT_BROWSER_SANDBOX applies as usual.
import '../src/config/index.js';
import { ENGINES } from '../src/browser/engines/index.js';
import { sandboxMode, sandboxState } from '../src/browser/engines/server.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const ids = arg('engine', null) ? [arg('engine')] : Object.keys(ENGINES);
const url = arg('url', 'https://example.com/');
let failed = 0;
for (const id of ids) {
  const engine = ENGINES[id];
  if (!engine) { console.log(`${id}: no such engine`); failed++; continue; }
  let info;
  try { info = engine.info(); } catch (err) { info = { installed: false, unsupported: err.message }; }
  if (!info.installed) { console.log(`${engine.label}: not installed here (${info.unsupported || 'skipped'})`); continue; }
  let browser;
  try {
    const t0 = Date.now();
    browser = await engine.launch();
    const s = sandboxState();
    const page = await (await browser.newContext()).newPage();
    let report = '';
    try {
      await page.goto('chrome://sandbox', { timeout: 15000 });
      await page.waitForFunction(() => /Renderer|Sandbox(ed)?.*:|Seccomp|Namespace/i.test(document.body.innerText.replace(/^Sandbox Status/, '')), null, { timeout: 5000 }).catch(() => {});
      report = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    } catch (err) { report = `(chrome://sandbox unavailable: ${String(err.message).split('\n')[0]})`; }
    const res = await page.goto(url, { timeout: 30000 }).catch(err => ({ status: () => String(err.message).split('\n')[0] }));
    const title = await page.title().catch(() => '');
    console.log(`${engine.label} ${browser.version()} · mode ${sandboxMode()} · sandbox ${s?.on ? 'ON' : `OFF (${s?.reason})`} · started in ${Date.now() - t0} ms`);
    console.log(`  chrome://sandbox: ${report.slice(0, 600)}`);
    console.log(`  ${url} → ${res?.status?.()} "${title}"`);
    if (!s?.on && sandboxMode() !== 'off') failed++;
  } catch (err) {
    console.log(`${engine.label}: launch failed: ${String(err.message).split('\n').slice(0, 3).join(' | ')}`);
    failed++;
  } finally {
    if (browser) await (engine.stop ? engine.stop(browser) : browser.close()).catch(() => {});
  }
}
process.exit(failed ? 1 : 0);
