// Deterministic alpha cleanup for the transparent avatar PNGs (no dependencies, no re-generation).
//
//   node scripts/clean-avatar-alpha.js                       # every assets/avatars/<variant>/<state>.png
//   node scripts/clean-avatar-alpha.js assets/avatars/female/neutral.png
//
// The model's cut-outs come back with a faint glow halo (alpha fading out 8-30 px beyond the silhouette),
// a subject that is never fully opaque (alpha tops out at 250-254), and leftover glow colour stored in
// fully transparent pixels (visible in viewers that ignore alpha). This script:
//   1. keeps the raw model output as <name>.orig.png (created once, never overwritten here) and always
//      processes from it, so re-running is idempotent;
//   2. snaps alpha >= OPAQUE_FROM to 255 (pixels and colours of the subject are untouched);
//   3. removes the halo: outside a KEEP_PX band around the solid core (alpha >= 128), alpha below LOW is
//      set to 0, and anything farther than MAX_PX from the core is set to 0; soft hair edges near the
//      silhouette are kept;
//   4. clears the colour of fully transparent pixels: within BLEED_PX of visible pixels it takes the
//      nearest visible colour (avoids dark fringes in non-premultiplied resizers), farther out it is black.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const SETTINGS = { OPAQUE_FROM: 250, KEEP_PX: 3, LOW: 40, MAX_PX: 16, BLEED_PX: 8 };

// ---- PNG codec (8-bit, non-interlaced; RGB/RGBA in, RGBA out) --------------------------------
export function decodePng(buf) {
  let pos = 8, width, height, bitDepth, colorType, interlace;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace || ![2, 6].includes(colorType)) throw new Error(`Unsupported PNG (bitDepth ${bitDepth}, colorType ${colorType}, interlace ${interlace})`);
  const bpp = colorType === 6 ? 4 : 3, stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const r = raw[src + x], a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[dst - stride + x] : 0, c = y && x >= bpp ? px[dst - stride + x - bpp] : 0;
      let v;
      if (f === 0) v = r; else if (f === 1) v = r + a; else if (f === 2) v = r + b; else if (f === 3) v = r + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[dst + x] = v & 255;
    }
  }
  if (bpp === 4) return { width, height, rgba: px };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) { rgba[j] = px[i]; rgba[j + 1] = px[i + 1]; rgba[j + 2] = px[i + 2]; rgba[j + 3] = 255; }
  return { width, height, rgba };
}

export function encodePng({ width, height, rgba }) {
  const stride = width * 4, out = Buffer.alloc((stride + 1) * height), row = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const cur = rgba.subarray(y * stride, (y + 1) * stride), prev = y ? rgba.subarray((y - 1) * stride, y * stride) : null;
    let best = null, bestSum = Infinity, bestF = 0;
    for (let f = 0; f < 5; f++) { // pick the filter with the smallest sum of absolute residuals
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? cur[x - 4] : 0, b = prev ? prev[x] : 0, c = prev && x >= 4 ? prev[x - 4] : 0;
        let p;
        if (f === 0) p = 0; else if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
        else { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const v = (cur[x] - p) & 255;
        row[x] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; bestF = f; best = Buffer.from(row); }
    }
    out[y * (stride + 1)] = bestF; best.copy(out, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Distance transform (chamfer 1 / 1.414), optionally carrying the nearest seed index ----------
function distanceFrom(isSeed, width, height, carry = false) {
  const n = width * height, d = new Float32Array(n).fill(1e9), s = carry ? new Int32Array(n).fill(-1) : null;
  for (let i = 0; i < n; i++) if (isSeed(i)) { d[i] = 0; if (carry) s[i] = i; }
  const relax = (i, j, cost) => { if (d[j] + cost < d[i]) { d[i] = d[j] + cost; if (carry) s[i] = s[j]; } };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (x) relax(i, i - 1, 1);
    if (y) { relax(i, i - width, 1); if (x) relax(i, i - width - 1, 1.414); if (x < width - 1) relax(i, i - width + 1, 1.414); }
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x;
    if (x < width - 1) relax(i, i + 1, 1);
    if (y < height - 1) { relax(i, i + width, 1); if (x < width - 1) relax(i, i + width + 1, 1.414); if (x) relax(i, i + width - 1, 1.414); }
  }
  return { d, s };
}

// ---- Stats ------------------------------------------------------------------------------------
export function alphaStats({ width, height, rgba }) {
  const n = width * height, A = (i) => rgba[i * 4 + 3];
  const core = distanceFrom((i) => A(i) >= 128, width, height).d;
  const band = (lo, hi) => { let c = 0, sum = 0, max = 0; for (let i = 0; i < n; i++) if (core[i] > lo && core[i] <= hi) { c++; sum += A(i); if (A(i) > max) max = A(i); } return { meanAlpha: +(sum / (c || 1)).toFixed(2), maxAlpha: max }; };
  let zero = 0, full = 0, partial = 0, hidden = 0, maxA = 0;
  for (let i = 0; i < n; i++) {
    const a = A(i); if (a > maxA) maxA = a;
    if (a === 0) { zero++; hidden += (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3; } else if (a === 255) full++; else partial++;
  }
  const corners = [0, width - 1, (height - 1) * width, n - 1].map(A);
  return {
    cornerAlpha: corners, maxAlpha: maxA,
    pctTransparent: +(100 * zero / n).toFixed(2), pctOpaque: +(100 * full / n).toFixed(2), pctPartial: +(100 * partial / n).toFixed(2),
    halo: { '4-8px': band(4, 8), '8-16px': band(8, 16), '16-32px': band(16, 32), '32px+': band(32, 1e9) },
    hiddenRgbInTransparent: +(hidden / (zero || 1)).toFixed(1),
  };
}

// ---- Cleanup ----------------------------------------------------------------------------------
export function cleanAlpha(img, opts = SETTINGS) {
  const { width, height } = img, n = width * height, rgba = Buffer.from(img.rgba);
  const core = distanceFrom((i) => rgba[i * 4 + 3] >= 128, width, height).d;
  for (let i = 0; i < n; i++) {
    const k = i * 4 + 3, a = rgba[k];
    if (a >= opts.OPAQUE_FROM) rgba[k] = 255;
    else if (core[i] > opts.MAX_PX) rgba[k] = 0;
    else if (core[i] > opts.KEEP_PX && a < opts.LOW) rgba[k] = 0;
  }
  const { d, s } = distanceFrom((i) => rgba[i * 4 + 3] > 0, width, height, true);
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] !== 0) continue;
    const src = d[i] <= opts.BLEED_PX && s[i] >= 0 ? s[i] * 4 : -1;
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = src >= 0 ? rgba[src + c] : 0;
  }
  return { width, height, rgba };
}

export const origPathFor = (file) => file.replace(/\.png$/i, '.orig.png');

// Cleans `file` in place from its .orig.png (creating the .orig from `file` if it does not exist yet).
export function cleanAvatarFile(file) {
  const orig = origPathFor(file);
  if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);
  const img = decodePng(fs.readFileSync(orig));
  const cleaned = cleanAlpha(img);
  fs.writeFileSync(file, encodePng(cleaned));
  return { orig: path.basename(orig), settings: SETTINGS, before: alphaStats(img), after: alphaStats(cleaned) };
}

// ---- CLI ----------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const AV = path.join(ROOT, 'assets', 'avatars');
  let files = process.argv.slice(2).map((f) => path.resolve(ROOT, f));
  if (!files.length) {
    for (const v of fs.readdirSync(AV, { withFileTypes: true })) {
      if (!v.isDirectory() || v.name.startsWith('_')) continue;
      for (const f of fs.readdirSync(path.join(AV, v.name))) if (f.endsWith('.png') && !f.endsWith('.orig.png')) files.push(path.join(AV, v.name, f));
    }
  }
  const manifestFile = path.join(AV, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  for (const file of files) {
    const r = cleanAvatarFile(file);
    const rel = path.relative(AV, file).replaceAll('\\', '/');
    const fmt = (s) => `transparent ${s.pctTransparent}%  opaque ${s.pctOpaque}%  partial ${s.pctPartial}%  max ${s.maxAlpha}  halo 8-16px mean ${s.halo['8-16px'].meanAlpha} (max ${s.halo['8-16px'].maxAlpha})  hidden RGB ${s.hiddenRgbInTransparent}`;
    console.log(`${rel}\n  before: ${fmt(r.before)}\n  after:  ${fmt(r.after)}`);
    const entry = manifest?.images.find((e) => e.file === rel);
    if (entry) entry.alphaCleanup = r;
  }
  if (manifest) fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
}
