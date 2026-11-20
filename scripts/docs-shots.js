// Screenshots for the README, the docs and the website (dev-time; the outputs in docs/images/ are committed).
//   node scripts/docs-shots.js capture [--base http://127.0.0.1:3738] [--only chat,feed] [--raw dir]
//       screenshots the app's own pages with its built-in demo household (the dev styleguide, /styleguide/screens/*,
//       the pages `npm run ui:check` tests) at desktop 1440×900 and phone 390×844 (2x), light and dark, into --raw.
//   node scripts/docs-shots.js crop [--raw dir]
//       cuts the main column out of the desktop shots the website's feature rows use (<name>-main-desktop-<theme>.png),
//       so their content reads at row size; frame them afterwards like any other.
//   node scripts/docs-shots.js frame [--raw dir] [--only name,…]
//       frames every raw PNG in --raw (these and any taken from a real install, named <name>-<desktop|phone>-<theme>.png)
//       into docs/images/<name>-<desktop|phone>-<theme>.webp: rounded corners, a hairline edge and a soft shadow on a
//       clear background, so they sit on light and dark pages alike; phones get a plain dark bezel.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const RAW = path.resolve(ROOT, arg('raw', 'ui-shots/docs-raw'));
const OUT = path.join(ROOT, 'docs', 'images');
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const cmd = process.argv[2];

// The screens the docs show, by styleguide page → the name the docs use.
export const SCREENS = {
  chat: 'chat', approvals: 'approvals', feed: 'feed', ideas: 'ideas', goals: 'goals', goal: 'goal', library: 'library',
  'library-item': 'library-item', lists: 'lists', list: 'list', upcoming: 'upcoming', projects: 'projects', project: 'project',
  activity: 'activity', 'admin-skills': 'admin-skills', 'admin-models': 'admin-models', 'admin-usage': 'admin-usage',
  'admin-overview': 'admin-overview', me: 'you', 'me-memory': 'you-memory', 'chat-background': 'chat-background',
};
const PHONE = ['chat', 'approvals', 'feed', 'lists', 'list', 'upcoming', 'goals', 'library'];

async function capture() {
  const { chromium, executablePath } = await import('./lib/test-browser.js');
  if (!executablePath) throw new Error('No Chromium-based browser found (npm run browser:install).');
  const BASE = arg('base', 'http://127.0.0.1:3738');
  fs.mkdirSync(RAW, { recursive: true });
  const browser = await chromium.launch({ executablePath, headless: true });
  const problems = [];
  for (const device of ['desktop', 'phone']) {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext(device === 'desktop'
        ? { viewport: { width: 1440, height: 900 }, colorScheme: theme }
        : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme });
      await ctx.addInitScript(t => { try { localStorage.setItem('jb-theme', t); } catch {} }, theme);
      for (const [page, name] of Object.entries(SCREENS)) {
        if (ONLY.length && !ONLY.includes(name)) continue;
        if (device === 'phone' && !PHONE.includes(page)) continue;
        const p = await ctx.newPage();
        p.on('pageerror', e => problems.push(`${name} ${device}/${theme}: ${e.message}`));
        await p.goto(`${BASE}/styleguide/screens/${page}`, { waitUntil: 'networkidle' });
        await p.waitForTimeout(700); // presence crossfades and count-ups settle
        await p.screenshot({ path: path.join(RAW, `${name}-${device}-${theme}.png`) });
        await p.close();
      }
      await ctx.close();
    }
  }
  await browser.close();
  if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; }
  console.log(`captured into ${path.relative(ROOT, RAW)}`);
}

const svg = s => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${s}</svg>`);

async function frame(file) {
  const img = sharp(file);
  const { width: w, height: h } = await img.metadata();
  const phone = /-phone-/.test(file);
  const dark = /-dark\.png$/.test(file);
  // Phones: shown at half their 2x size is still crisp on a high-density screen; the bezel is part of the device.
  const scale = phone ? 0.5 : 1;
  const sw = Math.round(w * scale), sh = Math.round(h * scale);
  const radius = phone ? 34 : 12;
  const bezel = phone ? 9 : 0;
  const bw = sw + bezel * 2, bh = sh + bezel * 2;
  const pad = phone ? 40 : 56;
  const W = bw + pad * 2, H = bh + pad * 2;
  const screen = await img.resize(sw, sh, { kernel: 'lanczos3' })
    .composite([{ input: svg(`width="${sw}" height="${sh}"><rect width="${sw}" height="${sh}" rx="${radius - bezel}" fill="#fff"/>`), blend: 'dest-in' }])
    .png().toBuffer();
  // A soft shadow falling from above (offset, wide blur), tinted with the interface's slate hue.
  const shadow = await sharp(svg(`width="${W}" height="${H}"><rect x="${pad}" y="${pad + 14}" width="${bw}" height="${bh}" rx="${radius}" fill="rgb(20,28,40)" fill-opacity="${dark ? 0.42 : 0.24}"/>`))
    .blur(22).png().toBuffer();
  const tight = await sharp(svg(`width="${W}" height="${H}"><rect x="${pad}" y="${pad + 2}" width="${bw}" height="${bh}" rx="${radius}" fill="rgb(20,28,40)" fill-opacity="0.12"/>`))
    .blur(2).png().toBuffer();
  const layers = [{ input: shadow }, { input: tight }];
  if (phone) layers.push({ input: svg(`width="${W}" height="${H}"><rect x="${pad}" y="${pad}" width="${bw}" height="${bh}" rx="${radius}" fill="#101318"/><rect x="${pad + 0.5}" y="${pad + 0.5}" width="${bw - 1}" height="${bh - 1}" rx="${radius}" fill="none" stroke="#3a414c" stroke-width="1"/>`) });
  layers.push({ input: screen, left: pad + bezel, top: pad + bezel });
  // A hairline around the screen so a light page doesn't melt into a light background.
  if (!phone) layers.push({ input: svg(`width="${W}" height="${H}"><rect x="${pad + 0.5}" y="${pad + 0.5}" width="${bw - 1}" height="${bh - 1}" rx="${radius}" fill="none" stroke="rgb(20,28,40)" stroke-opacity="${dark ? 0.55 : 0.14}"/>`) });
  const out = path.join(OUT, path.basename(file).replace(/\.png$/, '.webp'));
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers).webp({ quality: 84, alphaQuality: 80, effort: 6, smartSubsample: true }).toFile(out);
  return out;
}

async function frameAll() {
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs.readdirSync(RAW).filter(f => /-(desktop|phone)-(light|dark)\.png$/.test(f))
    .filter(f => !ONLY.length || ONLY.some(o => f.startsWith(`${o}-`)));
  let bytes = 0;
  for (const f of files) bytes += fs.statSync(await frame(path.join(RAW, f))).size;
  console.log(`framed ${files.length} screenshots, ${(bytes / 1048576).toFixed(1)} MB → ${path.relative(ROOT, OUT)}`);
}

// The website's feature rows: the main column (between the 264 px rail and the right panel at 1080 px), top 720 px.
async function crop() {
  for (const base of ['feed', 'goals', 'library', 'upcoming', 'admin-people-real']) for (const theme of ['light', 'dark']) {
    await sharp(path.join(RAW, `${base}-desktop-${theme}.png`)).extract({ left: 264, top: 0, width: 816, height: 720 })
      .toFile(path.join(RAW, `${base}-main-desktop-${theme}.png`));
  }
  console.log('cropped 10 main columns');
}

if (cmd === 'crop') await crop();
else if (cmd === 'capture') await capture();
else if (cmd === 'frame') await frameAll();
else { console.log('usage: node scripts/docs-shots.js capture|crop|frame [options]'); process.exitCode = 1; }
