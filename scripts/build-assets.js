// Builds self-hosted static assets (no CDNs at runtime):
//  - public/icons.svg : SVG sprite (Phosphor glyphs, via scripts/icon-map.js) with only the icons the code references
//  - public/fonts/    : Geist variable font files (+ Noto Sans Arabic for RTL content)
// Icon names are discovered by scanning templates and client JS for
//   {{icon "name"}}  ·  icon="name"  ·  icon('name')  ·  data-icon="name"  ·  iconName: 'name'
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'public');

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, exts, out);
    else if (exts.includes(path.extname(entry.name))) out.push(p);
  }
  return out;
}

// ---- Icons ---------------------------------------------------------------
const PATTERNS = [
  /\{\{\s*icon\s+"([a-z0-9-]+)"/g,
  /\bicon="([a-z0-9-]+)"/g,
  /\bicon\(\s*['"]([a-z0-9-]+)['"]/g,
  /data-(?:cmd-)?icon="([a-z0-9-]+)"/g,
  /\biconName[=:]?\s*["']([a-z0-9-]+)["']/g,   // iconName="x" · iconName: 'x' · (default iconName "x")
];
const files = [
  ...walk(path.join(ROOT, 'src'), ['.hbs', '.js']),
  ...walk(path.join(ROOT, 'public', 'js'), ['.js']),
];
const names = new Set();
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const re of PATTERNS) for (const m of text.matchAll(re)) names.add(m[1]);
}

// Names are Jessbot's icon vocabulary; scripts/icon-map.js maps each to a Phosphor glyph (see the modifiers there).
const { default: ICON_MAP } = await import('./icon-map.js');
const phosphor = (glyph, weight) => {
  const file = path.join(NM, '@phosphor-icons', 'core', 'assets', weight, `${glyph}${weight === 'regular' ? '' : `-${weight}`}.svg`);
  if (!fs.existsSync(file)) return null;
  const svg = fs.readFileSync(file, 'utf8');
  return svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>')).replace(/\s*\n\s*/g, '');
};
const symbols = [];
const missing = [];
for (const name of [...names].sort()) {
  const [glyph, mod] = (ICON_MAP[name] || '').split(':');
  let inner = glyph && phosphor(glyph, mod === 'fill' ? 'fill' : 'regular');
  if (inner && mod === 'toggle') {
    const filled = phosphor(glyph, 'fill');
    // Custom properties inherit into <use> trees, so a pressed button can set --icon-fill: 1 to show the solid glyph.
    if (filled) inner = `<g style="opacity:calc(1 - var(--icon-fill, 0))">${inner}</g><g style="opacity:var(--icon-fill, 0)">${filled}</g>`;
  }
  if (inner && mod === 'flip') inner = `<g transform="matrix(-1 0 0 1 256 0)">${inner}</g>`;
  if (!inner) { missing.push(name); continue; }
  symbols.push(`<symbol id="${name}" viewBox="0 0 256 256" fill="currentColor">${inner}</symbol>`);
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icons.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg"><!-- Phosphor Icons (MIT) -->${symbols.join('')}</svg>\n`);
console.log(`[assets] icons.svg: ${symbols.length} icons`);
if (missing.length) {
  console.error(`[assets] unknown icon names (add them to scripts/icon-map.js): ${missing.join(', ')}`);
  process.exitCode = 1;
}

// ---- Fonts ---------------------------------------------------------------
// Geist (OFL): the UI face (DESIGN.md). Latin + Latin-ext; the browser picks by unicode-range.
const fontSrc = path.join(NM, '@fontsource-variable', 'geist', 'files');
const fontOut = path.join(OUT, 'fonts');
fs.mkdirSync(fontOut, { recursive: true });
for (const f of ['geist-latin-wght-normal.woff2', 'geist-latin-ext-wght-normal.woff2']) {
  fs.copyFileSync(path.join(fontSrc, f), path.join(fontOut, f));
}
// Arabic script (RTL content, decision #68): loaded by the browser only when Arabic characters are on the page.
fs.copyFileSync(path.join(NM, '@fontsource-variable', 'noto-sans-arabic', 'files', 'noto-sans-arabic-arabic-wght-normal.woff2'),
  path.join(fontOut, 'noto-sans-arabic-wght-normal.woff2'));
console.log('[assets] fonts copied');
