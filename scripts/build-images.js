// Build web assets from the raw generated masters (dev-time; outputs are committed, so installs never need sharp).
//   assets/avatars/<variant>/<frame>.png   →  public/img/avatars/<variant>/<frame>.webp (1024) + <frame>-256.webp
//   assets/backgrounds/<time>-<weather>.png →  public/img/scenes/<time>-<weather>.webp (1024) + -256.webp
//   + public/img/presence.json  { avatars: { female: [frames…] }, scenes: [names…] }
// Skips *.orig.png (raw pre-cleanup copies) and _rejected*/ _pilot* folders. Incremental by mtime.
//   node scripts/build-images.js [--force]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_AV = path.join(ROOT, 'assets', 'avatars');
const SRC_BG = path.join(ROOT, 'assets', 'backgrounds');
const OUT_AV = path.join(ROOT, 'public', 'img', 'avatars');
const OUT_BG = path.join(ROOT, 'public', 'img', 'scenes');
const FORCE = process.argv.includes('--force');

const isMaster = f => f.endsWith('.png') && !f.endsWith('.orig.png');
const stale = (src, out) => FORCE || !fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs;

async function convert(src, outBase, { alpha }) {
  const jobs = [
    [`${outBase}.webp`, 1024, alpha ? { quality: 86, alphaQuality: 90, effort: 5 } : { quality: 80, effort: 5 }],
    [`${outBase}-256.webp`, 256, alpha ? { quality: 84, alphaQuality: 90, effort: 5 } : { quality: 78, effort: 5 }],
  ];
  let wrote = 0;
  for (const [out, size, opts] of jobs) {
    if (!stale(src, out)) continue;
    await sharp(src).resize(size, size, { fit: 'cover' }).webp(opts).toFile(out);
    wrote++;
  }
  return wrote;
}

const manifest = { avatars: {}, scenes: [] };
let converted = 0, bytes = 0;

for (const variant of fs.existsSync(SRC_AV) ? fs.readdirSync(SRC_AV) : []) {
  const dir = path.join(SRC_AV, variant);
  if (!fs.statSync(dir).isDirectory() || variant.startsWith('_')) continue;
  fs.mkdirSync(path.join(OUT_AV, variant), { recursive: true });
  const frames = [];
  for (const f of fs.readdirSync(dir).filter(isMaster).sort()) {
    const name = f.replace(/\.png$/, '');
    converted += await convert(path.join(dir, f), path.join(OUT_AV, variant, name), { alpha: true });
    frames.push(name);
  }
  if (frames.length) manifest.avatars[variant] = frames;
}

fs.mkdirSync(OUT_BG, { recursive: true });
for (const f of (fs.existsSync(SRC_BG) ? fs.readdirSync(SRC_BG) : []).filter(isMaster).sort()) {
  const name = f.replace(/\.png$/, '');
  if (!/^(dawn|day|dusk|night)-(clear|cloudy|rain|storm|snow|fog)$/.test(name)) continue;
  converted += await convert(path.join(SRC_BG, f), path.join(OUT_BG, name), { alpha: false });
  manifest.scenes.push(name);
}

// Demo feed covers (dev styleguide only): assets/covers/<name>.png → public/img/demo/<name>.webp (1200w) + -480.webp
const SRC_CV = path.join(ROOT, 'assets', 'covers');
const OUT_CV = path.join(ROOT, 'public', 'img', 'demo');
fs.mkdirSync(OUT_CV, { recursive: true });
for (const f of (fs.existsSync(SRC_CV) ? fs.readdirSync(SRC_CV) : []).filter(isMaster).sort()) {
  const src = path.join(SRC_CV, f), name = f.replace(/\.png$/, '');
  for (const [out, w, q] of [[`${name}.webp`, 1200, 80], [`${name}-480.webp`, 480, 76]]) {
    const dest = path.join(OUT_CV, out);
    if (!stale(src, dest)) continue;
    await sharp(src).resize(w, Math.round(w * 2 / 3), { fit: 'cover' }).webp({ quality: q, effort: 5 }).toFile(dest);
    converted++;
  }
}

for (const dir of [OUT_AV, OUT_BG, OUT_CV]) {
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, String(f));
    if (p.endsWith('.webp')) bytes += fs.statSync(p).size;
  }
}
fs.writeFileSync(path.join(ROOT, 'public', 'img', 'presence.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`[images] ${converted} file(s) written · ${Object.entries(manifest.avatars).map(([v, f]) => `${v}: ${f.length} frames`).join(' · ')} · scenes: ${manifest.scenes.length} · total ${(bytes / 1024 / 1024).toFixed(1)} MB`);
