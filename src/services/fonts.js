// Bundled fonts for the files Jess makes (decision #133), so a PDF looks the same whichever machine prints it and
// Arabic always has a face. All SIL OFL 1.1, from Fontsource npm packages; each package keeps the font's licence
// (its LICENSE file is the OFL text) next to the font files we read:
//   Noto Sans, Noto Serif (@fontsource/noto-sans, noto-serif) · Noto Naskh Arabic (@fontsource/noto-naskh-arabic) ·
//   STIX Two Math (@fontsource/stix-two-math: the whole font with its OpenType MATH table, for MathML formulas).
// PDFs (the browser prints HTML) embed them as data: @font-face rules split by unicode-range, the way Fontsource ships
// them, with font-display: swap (a face still loading can never make text vanish; services/print.js also waits for the
// fonts before printing). Known limit: text copied out of such a PDF in Arabic comes out as presentation forms with
// gaps (the browser can't map every shaped glyph back to a letter from a subset font); what Jess and search read is the
// markdown kept next to the file, so only copy-paste is affected. pdf-lib (form answers, text written onto a PDF) needs whole TrueType-flavoured files: the .woff versions of
// the same subsets, picked per piece of text by which one has the glyphs (see pdfLibFont in services/pdf.js).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dirOf = pkg => path.dirname(require.resolve(`@fontsource/${pkg}/package.json`));
const ranges = pkg => JSON.parse(fs.readFileSync(path.join(dirOf(pkg), 'unicode.json'), 'utf8'));
const file = (pkg, name) => fs.readFileSync(path.join(dirOf(pkg), 'files', name));

// css family → [package, [subset, [[weight, style]…]]…]: italics and bold where body text needs them; the rarer
// subsets in regular and bold only (the browser slants them itself when needed).
const REGULAR_BOLD = [[400, 'normal'], [700, 'normal']];
const FACES = {
  'Noto Sans': ['noto-sans', [['latin', [...REGULAR_BOLD, [400, 'italic'], [700, 'italic']]], ['latin-ext', REGULAR_BOLD], ['greek', REGULAR_BOLD], ['cyrillic', REGULAR_BOLD]]],
  'Noto Serif': ['noto-serif', [['latin', [...REGULAR_BOLD, [400, 'italic']]], ['latin-ext', REGULAR_BOLD]]],
  'Noto Naskh Arabic': ['noto-naskh-arabic', [['arabic', REGULAR_BOLD]]],
};
export const DOCUMENT_FAMILIES = Object.keys(FACES);

const cssCache = new Map();
let mathCache = null;
/** @font-face rules (data: URIs) for the given families (Noto Sans, Noto Serif, Noto Naskh Arabic). Built once each. */
export function documentFontCss(families = DOCUMENT_FAMILIES) {
  return families.filter(f => FACES[f]).map(family => {
    if (cssCache.has(family)) return cssCache.get(family);
    const [pkg, subsets] = FACES[family];
    const range = ranges(pkg);
    const rules = subsets.flatMap(([subset, faces]) => faces.map(([weight, style]) => `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};`
      + `font-display:swap;src:url(data:font/woff2;base64,${file(pkg, `${pkg}-${subset}-${weight}-${style}.woff2`).toString('base64')}) format("woff2");unicode-range:${range[subset]}}`));
    cssCache.set(family, rules.join('\n'));
    return cssCache.get(family);
  }).join('\n');
}

/** The math face for MathML (only added to documents that have formulas: it's ~400 KB). */
export function mathFontCss() {
  if (mathCache) return mathCache;
  const data = file('stix-two-math', 'stix-two-math-latin-400-normal.woff2').toString('base64');
  return (mathCache = `@font-face{font-family:"STIX Two Math";font-style:normal;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,${data}) format("woff2")}`);
}

let libCache = null;
/**
 * Font files for pdf-lib, most general first: [{ id, bytes, test(codePoint) }]. pdf-lib embeds one font per piece of
 * text, so text is split into runs by the first font that has every glyph (Latin, Latin Extended, Greek, Cyrillic,
 * Arabic — the Arabic face is shaped by fontkit, so joined letters come out right).
 */
export function pdfLibFonts() {
  if (libCache) return libCache;
  const parse = spec => spec.split(',').map(r => { const [a, b] = r.replace(/U\+/g, '').split('-'); return [parseInt(a, 16), parseInt(b || a, 16)]; });
  const sans = ranges('noto-sans'), naskh = ranges('noto-naskh-arabic');
  const pick = (id, pkg, subset, spec) => { const rs = parse(spec); return { id, bytes: file(pkg, `${pkg}-${subset}-400-normal.woff`), test: cp => rs.some(([a, b]) => cp >= a && cp <= b) }; };
  return (libCache = [
    pick('latin', 'noto-sans', 'latin', sans.latin),
    pick('latin-ext', 'noto-sans', 'latin-ext', sans['latin-ext']),
    pick('greek', 'noto-sans', 'greek', sans.greek),
    pick('cyrillic', 'noto-sans', 'cyrillic', sans.cyrillic),
    pick('arabic', 'noto-naskh-arabic', 'arabic', naskh.arabic),
  ]);
}
