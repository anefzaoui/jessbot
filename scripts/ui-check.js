// DEV: screenshot pages at desktop + phone widths in light + dark, and fail on any browser console error.
// Uses the locally installed Edge/Chrome via playwright-core — localhost only (Jessbot's own web access
// goes through the browser; see docs/DECISIONS.md #15).
//   node scripts/ui-check.js [--out dir] [--only chat,feed] [--base http://127.0.0.1:3738]
import fs from 'node:fs';
import path from 'node:path';
import { chromium, executablePath as exe } from './lib/test-browser.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://127.0.0.1:3738'); // the dev server (npm run dev)
const OUT = path.resolve(arg('out', 'ui-shots'));
const ONLY = arg('only', '')?.split(',').filter(Boolean);

// --pages "name=/path?query,name2=/path2" overrides the default set; --viewport desktop|phone; --theme light|dark;
// --wait ms (extra settle time, e.g. to let presence animations play).
const CUSTOM = arg('pages', '')?.split(',').filter(Boolean).map(p => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; });
const PAGES = CUSTOM.length ? CUSTOM : ['chat', 'run-states', 'voice', 'chat-empty', 'side-chat', 'side-chat-off', 'project-proposal', 'project', 'project-soul', 'project-files', 'projects', 'feed', 'feed-sources', 'admin-feed-sources', 'admin-model', 'admin-personality', 'ideas', 'goals', 'goal', 'goal-new', 'library', 'library-item', 'library-audio', 'library-slides', 'library-ics', 'library-form',
  'activity', 'approvals', 'upcoming', 'me', 'me-memory', 'me-connections', 'lists', 'lists-empty', 'list', 'list-todo', 'list-wish',
  'approvals-states', 'admin-skills', 'skill-review', 'goal-round2', 'library-scan', 'library-reading', 'library-ocr', 'library-picture', 'library-listening', 'admin-browser',
  'admin-models', 'admin-usage', 'admin-system', 'admin-overview', 'admin-groups', 'admin-lessons', 'me-lessons', 'feed-diet', 'feed-story-gone', 'chat-reminders',
  'chat-feedback', 'chat-whats-new', 'chat-background', 'side-chat-background', 'side-chat-prep', 'ideas-ready', 'me-notifications', 'admin-system-running',
].map(p => [p, `/styleguide/screens/${p}`]).concat([['styleguide', '/styleguide']]);
const VIEWPORTS = [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]
  .filter(([n]) => !arg('viewport') || n === arg('viewport'));
const THEMES = ['light', 'dark'].filter(t => !arg('theme') || t === arg('theme'));
const WAIT = Number(arg('wait', 400));

if (!exe) { console.error('No local Chromium-based browser found.'); process.exit(1); }

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, headless: true });
const problems = [];

for (const [vpName, viewport] of VIEWPORTS) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: vpName === 'phone' ? 2 : 1 });
    await ctx.addInitScript(t => { try { localStorage.setItem('jb-theme', t); } catch {} }, theme);
    for (const [name, url] of PAGES) {
      if (ONLY.length && !ONLY.includes(name)) continue;
      const page = await ctx.newPage();
      page.on('console', m => { if (m.type() === 'error') problems.push(`${name} [${vpName}/${theme}] console: ${m.text()}`); });
      page.on('pageerror', e => problems.push(`${name} [${vpName}/${theme}] pageerror: ${e.message}`));
      page.on('requestfailed', r => problems.push(`${name} [${vpName}/${theme}] requestfailed: ${r.url()}`));
      page.on('response', r => { if (r.status() >= 400) problems.push(`${name} [${vpName}/${theme}] HTTP ${r.status()}: ${r.url()}`); });
      await page.goto(BASE + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(WAIT);
      // Shell invariant: only inner regions scroll. If the window can scroll, an anchor jump (#usage) shifts the whole
      // app up and clips it (an absolutely positioned element escaping its scroll container).
      const overflow = await page.evaluate(() => (document.querySelector('.app-shell')
        ? document.scrollingElement.scrollHeight - innerHeight : 0));
      if (overflow > 1) problems.push(`${name} [${vpName}/${theme}] window scrolls by ${overflow}px — something escapes the shell`);
      // Inner regions scroll vertically only: content wider than the main column is clipped off-screen (a grid item
      // whose nowrap text sets its min-width, a fixed-width row on a phone). Name the widest culprit.
      const wide = await page.evaluate(() => {
        const main = document.querySelector('main#main');
        if (!main || main.scrollWidth - main.clientWidth <= 1) return null;
        const edge = main.getBoundingClientRect().right;
        let worst = null;
        for (const el of main.querySelectorAll('*')) {
          if (el.closest('[class*="overflow-x"], .feed-carousel, pre, table')) continue; // meant to scroll sideways
          const over = el.getBoundingClientRect().right - edge;
          if (over > 1 && (!worst || over > worst.over)) worst = { over: Math.round(over), el: `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join('.')}` };
        }
        return { by: main.scrollWidth - main.clientWidth, worst };
      });
      if (wide) problems.push(`${name} [${vpName}/${theme}] main is ${wide.by}px wider than the screen${wide.worst ? ` (e.g. ${wide.worst.el})` : ''}`);
      await page.screenshot({ path: path.join(OUT, `${name}-${vpName}-${theme}.png`) });
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of [...new Set(problems)]) console.log('  ' + p);
  process.exitCode = 1;
} else {
  console.log(`OK — screenshots in ${OUT}, no console errors.`);
}
