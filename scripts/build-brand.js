// Build Jessbot's logo files from the default persona's portrait (dev-time; the outputs are committed).
//   public/img/avatars/female/neutral.webp (Jess, the default look) + public/img/scenes/night-clear.webp (her sky)
//   → docs/images/brand/: the round mark, the rounded-square app icon, favicons (ico, 16/32/180/192/512, maskable,
//     svg), the "Jessbot" wordmark lockups for light and dark backgrounds, and the 1280×640 social preview.
// The layering is the app's own living avatar (src/styles/input.css, "Living presence"): the sky scene, the
// transparent portrait over it, clipped round; small sizes crop toward the face the way the app's small avatars do.
// No new image generation: every pixel comes from the committed avatar and scene files (assets/*/manifest.json).
//   node scripts/build-brand.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'images', 'brand');
const PORTRAIT = path.join(ROOT, 'public', 'img', 'avatars', 'female', 'neutral.webp');
const SCENE = path.join(ROOT, 'public', 'img', 'scenes', 'night-clear.webp');
const GEIST = path.join(ROOT, 'node_modules', '@fontsource-variable', 'geist', 'files', 'geist-latin-wght-normal.woff2');
fs.mkdirSync(OUT, { recursive: true });

// How much of the 1024 px portrait a mark shows, and where its centre sits (the face is ~39% from the top).
const CROP = { full: { size: 0.86, cy: 0.45 }, face: { size: 0.6, cy: 0.41 } };
const MASTER = 1024;

async function layers(size, crop, { sky = 'scene' } = {}) {
  const c = Math.round(MASTER * crop.size);
  const left = Math.round((MASTER - c) / 2);
  const top = Math.max(0, Math.min(MASTER - c, Math.round(MASTER * crop.cy - c / 2)));
  const portrait = await sharp(PORTRAIT).extract({ left, top, width: c, height: c }).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer();
  // The sky: the scene's upper left (the moon sits inside the circle), slightly enlarged like the app's scene layer.
  const s = Math.round(MASTER * 0.8);
  const scene = await sharp(SCENE).extract({ left: 10, top: 0, width: s, height: s }).resize(size, size).png().toBuffer();
  return sharp(sky === 'scene' ? scene : { create: { width: size, height: size, channels: 4, background: sky } })
    .composite([{ input: portrait }]).png().toBuffer();
}

const shape = (size, radius) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`);
// A hairline of light just inside the edge (the app's presence clip has the same 1px inset ring), only where it shows.
const ring = (size, radius) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect x="${size / 512}" y="${size / 512}" width="${size - size / 256}" height="${size - size / 256}" rx="${radius}" ry="${radius}" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="${size / 256}"/></svg>`);

async function mark(size, { form = 'round', crop = CROP.full } = {}) {
  const radius = form === 'round' ? size / 2 : form === 'square' ? 0 : size * 0.225;
  const base = await layers(size, crop);
  const parts = [{ input: shape(size, radius), blend: 'dest-in' }];
  if (size >= 64 && form !== 'square') parts.push({ input: ring(size, radius) });
  return sharp(base).composite(parts).png({ compressionLevel: 9 }).toBuffer();
}

const write = async (name, buf) => { fs.writeFileSync(path.join(OUT, name), buf); return name; };
// Large PNGs go through a 256-colour palette with dithering: a quarter of the size, no visible loss at icon sizes.
const small = buf => sharp(buf).png({ palette: true, quality: 95, effort: 10, dither: 1, compressionLevel: 9 }).toBuffer();
const webp = (buf, q = 86) => sharp(buf).webp({ quality: q, alphaQuality: 90, effort: 6 }).toBuffer();
const made = [];

// The marks: round (avatar, README, site) and rounded square (app icon), as PNG masters and WebP for pages.
for (const [form, file] of [['round', 'mark'], ['rounded', 'mark-square']]) {
  for (const s of [1024, 512, 256, 128]) made.push(await write(`${file}-${s}.webp`, await webp(await mark(s, { form }))));
  if (form === 'round') made.push(await write('mark-512.png', await small(await mark(512, { form })))); // the square one is icon-512.png
}

// Favicons. 16 and 32 crop to the face (the head-and-shoulders view is a blur at that size).
const fav16 = await mark(16, { crop: CROP.face });
const fav32 = await mark(32, { crop: CROP.face });
const fav48 = await mark(48, { crop: CROP.face });
made.push(await write('favicon-16.png', fav16), await write('favicon-32.png', fav32));
made.push(await write('favicon.ico', ico([[16, fav16], [32, fav32], [48, fav48]])));
// Apple touch icon: opaque and full-bleed (iOS rounds the corners itself).
made.push(await write('apple-touch-icon.png', await small(await mark(180, { form: 'square' }))));
// Web app icons: rounded square with clear corners ("any"), and a full-bleed one with the face inside the
// 80% safe zone for launchers that mask icons into their own shape ("maskable").
for (const s of [192, 512]) made.push(await write(`icon-${s}.png`, await small(await mark(s, { form: 'rounded' }))));
made.push(await write('icon-maskable-512.png', await small(await mark(512, { form: 'square', crop: { size: 1, cy: 0.5 } }))));
// SVG favicon: a vector circle framing a small embedded WebP (for browsers that prefer SVG icons; ~10 KB).
const svgImg = (await webp(await layers(128, CROP.face), 80)).toString('base64');
made.push(await write('favicon.svg', Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">` +
  `<clipPath id="c"><circle cx="32" cy="32" r="32"/></clipPath>` +
  `<image clip-path="url(#c)" width="64" height="64" xlink:href="data:image/webp;base64,${svgImg}"/></svg>\n`)));

// Lockups and the social preview are laid out in HTML with the app's own font (Geist) and colours (Harbor).
const { chromium, executablePath } = await import('./lib/test-browser.js');
if (!executablePath) throw new Error('No Chromium-based browser found for the lockups (npm run browser:install).');
const browser = await chromium.launch({ executablePath, headless: true });
const dataUrl = (buf, type) => `data:${type};base64,${buf.toString('base64')}`;
const font = `@font-face { font-family: Geist; src: url(${dataUrl(fs.readFileSync(GEIST), 'font/woff2')}) format('woff2'); font-weight: 100 900; }`;
const markUrl = dataUrl(await mark(512), 'image/png');
const INK = { light: 'oklch(0.2 0.018 245)', dark: 'oklch(0.95 0.005 240)' };

async function render(html, { width, height, transparent, scale = 1 }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${font} html,body{margin:0;background:${transparent ? 'transparent' : 'none'}}</style>${html}`);
  await page.evaluate(() => document.fonts.ready);
  const buf = await page.screenshot({ omitBackground: !!transparent, type: 'png' });
  await page.close();
  return buf;
}

// Wordmark lockup: the round mark and "Jessbot" set in Geist; one file for light backgrounds, one for dark.
for (const theme of ['light', 'dark']) {
  const buf = await render(`<div style="display:flex;align-items:center;gap:22px;padding:8px 14px 8px 8px;width:max-content">
      <img src="${markUrl}" width="104" height="104" style="display:block">
      <span style="font:620 84px/1 Geist;letter-spacing:-0.035em;color:${INK[theme]};padding-bottom:6px">Jessbot</span></div>`,
  { width: 480, height: 120, transparent: true, scale: 2 });
  const trimmed = await sharp(buf).trim({ threshold: 1 }).extend({ top: 8, bottom: 8, left: 8, right: 8, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  made.push(await write(`wordmark-${theme}.png`, await small(trimmed)));
}

// Social preview (GitHub's repository card, link previews): 1280×640, the important part inside a 40 px margin.
const sky = dataUrl(await sharp(SCENE).resize(1024, 1024).webp({ quality: 88 }).toBuffer(), 'image/webp');
const portrait = dataUrl(await sharp(PORTRAIT).webp({ quality: 90, alphaQuality: 95 }).toBuffer(), 'image/webp');
const social = await render(`
  <div style="position:relative;width:1280px;height:640px;overflow:hidden;background:oklch(0.155 0.01 245);font-family:Geist;color:oklch(0.95 0.005 240)">
    <div style="position:absolute;inset:0 auto 0 0;width:640px;-webkit-mask-image:linear-gradient(90deg,#000 72%,transparent);mask-image:linear-gradient(90deg,#000 72%,transparent)">
      <div style="position:absolute;inset:0;background:url(${sky}) 20% 0/cover"></div>
      <img src="${portrait}" style="position:absolute;left:-20px;bottom:-56px;width:620px;height:620px">
    </div>
    <div style="position:absolute;left:640px;right:64px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:26px">
      <div style="font:640 112px/0.95 Geist;letter-spacing:-0.045em">Jessbot</div>
      <div style="font:450 38px/1.22 Geist;letter-spacing:-0.015em;color:oklch(0.86 0.008 240)">A self-hosted AI agent<br>for your household.</div>
      <div style="font:450 27px/1.4 Geist;color:oklch(0.8 0.075 200)">Works in the background.<br>Asks before it sends, spends or books.</div>
      <div style="font:500 22px/1.45 Geist;color:oklch(0.64 0.012 240);margin-top:12px">Free and open source (GPL-3.0)<br>github.com/anefzaoui/jessbot</div>
    </div>
  </div>`, { width: 1280, height: 640 });
made.push(await write('social-preview.png', await small(social)));
await browser.close();

let bytes = 0;
for (const f of made) bytes += fs.statSync(path.join(OUT, f)).size;
console.log(`brand: ${made.length} files, ${(bytes / 1024).toFixed(0)} KB → ${path.relative(ROOT, OUT)}`);

// ICO with PNG-compressed entries (Windows Vista and later, every current browser).
function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(([size, png], i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, o); head.writeUInt8(size >= 256 ? 0 : size, o + 1);
    head.writeUInt8(0, o + 2); head.writeUInt8(0, o + 3); head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(png.length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...entries.map(e => e[1])]);
}
