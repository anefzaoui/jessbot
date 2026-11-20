// Hidden text never reaches Jess (Phase 18, decision #118). Pages and emails can carry text a person never sees — white on
// white, font-size 0, pushed off-screen, clipped to a pixel, fully transparent, "mso-hide:all" — which is the usual way
// to slip instructions to an AI reader. Three passes share the same rules:
//  - pruneInPage: runs INSIDE the browser page (page.evaluate) before we take its HTML, with computed styles, so rules
//    from stylesheets count too. It never changes the live page: it serialises a clone without the hidden text.
//  - pruneHiddenDocument(doc, { email }): the same rules on inline styles, on a linkedom document — for emails (plus their
//    <style> rules, and display:none, mso-hide and zero-height boxes, which only hide things in mail) and as the web
//    extractor's second pass (the whole defence when the page pass failed).
//  - inlineHidden(style): the pure classification of one style attribute.
// display:none on web pages is KEPT (tabs, accordions and "read more" hide real content that way) and counted; only when
// its text trips the injection patterns is it removed. Nothing here throws on odd markup.

// ---- Colours ------------------------------------------------------------------------------------------------------------
const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0], silver: [192, 192, 192, 1],
  gray: [128, 128, 128, 1], grey: [128, 128, 128, 1], snow: [255, 250, 250, 1], ivory: [255, 255, 240, 1], whitesmoke: [245, 245, 245, 1] };

/** '#fff' | '#ffffff' | 'rgb(…)' | 'rgba(…)' | a few names → [r, g, b, a], or null when we can't tell. */
export function parseColor(value) {
  const v = String(value || '').trim().toLowerCase().replace(/\s*!important$/, '');
  if (NAMED[v]) return NAMED[v];
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  return null;
}

const lum = ([r, g, b]) => {
  const c = x => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
/** WCAG contrast ratio between two opaque colours (1 = identical, 21 = black on white). */
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const SAME_COLOUR = 1.25; // below this contrast, text is not readable against its background

// ---- One style attribute --------------------------------------------------------------------------------------------------
/** 'a: b; c: d' → Map(prop → value), props lower-cased, values trimmed (without !important). */
export function parseStyle(style) {
  const out = new Map();
  for (const decl of String(style || '').split(';')) {
    const i = decl.indexOf(':');
    if (i < 1) continue;
    out.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).replace(/!important/i, '').trim().toLowerCase());
  }
  return out;
}

const px = v => {
  const m = /^(-?[\d.]+)(px|pt|em|rem|%)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return { px: n, pt: n * 4 / 3, em: n * 16, rem: n * 16, '%': n * 0.16 }[m[2] || 'px'];
};
const FAR = -1000; // px: further left/up than this is "pushed off-screen" (the trick uses -9999px)

/**
 * Why this inline style hides its text from a reader, or null. Inline display:none counts everywhere (Readability drops
 * it too). email: also mso-hide:all and zero-height boxes with overflow hidden (on web pages those are closed accordions,
 * real content, kept).
 * Colour is judged separately (it needs the background, see pruneHiddenDocument).
 */
export function inlineHidden(style, { email = false } = {}) {
  const s = style instanceof Map ? style : parseStyle(style);
  if (!s.size) return null;
  const get = k => s.get(k) || '';
  if (get('display') === 'none') return 'display:none';
  if (['hidden', 'collapse'].includes(get('visibility'))) return 'visibility';
  if (email && get('mso-hide') === 'all') return 'mso-hide';
  const op = parseFloat(get('opacity'));
  if (!Number.isNaN(op) && op < 0.05) return 'opacity';
  const fs = s.has('font-size') ? px(get('font-size')) : null;
  if (fs != null && fs < 2) return 'font-size';
  const overflowHidden = /hidden|clip/.test(get('overflow') || get('overflow-y') || get('overflow-x'));
  if (email && overflowHidden && ['max-height', 'height'].some(k => s.has(k) && px(get(k)) === 0)) return 'zero-height';
  if (overflowHidden && ['width', 'height'].every(k => s.has(k) && px(get(k)) != null && px(get(k)) <= 1)) return 'clipped';
  if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(get('clip')) || /inset\(\s*50%/.test(get('clip-path'))) return 'clipped';
  if (/absolute|fixed/.test(get('position')) && ['left', 'top'].some(k => s.has(k) && (px(get(k)) ?? 0) <= FAR)) return 'off-screen';
  if (s.has('text-indent') && (px(get('text-indent')) ?? 0) <= FAR) return 'off-screen';
  const color = s.has('color') ? parseColor(get('color')) : null;
  if (color && color[3] < 0.05 && !s.has('text-shadow') && !/text/.test(get('background-clip') + get('-webkit-background-clip'))) return 'transparent';
  return null;
}

// ---- A linkedom document (emails; the web extractor's second pass) ----------------------------------------------------------
const bgOf = el => {
  const s = parseStyle(el.getAttribute?.('style'));
  const bg = s.get('background-color') || s.get('background') || el.getAttribute?.('bgcolor') || '';
  if (!bg) return null;
  if (/url\(|gradient/.test(bg)) return 'unknown';
  const c = parseColor(bg.split(/\s+/)[0]);
  return c && c[3] >= 0.5 ? c : c ? null : 'unknown';
};
function effectiveBg(el) {
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    const bg = bgOf(e);
    if (bg) return bg;
  }
  return NAMED.white; // mail clients and browsers paint white by default
}
const textColorOf = el => {
  const c = parseStyle(el.getAttribute?.('style')).get('color') || (el.tagName === 'FONT' ? el.getAttribute('color') : '');
  return c ? parseColor(c) : null;
};

/** Same colour as its background (the white-on-white trick), judged from inline styles and bgcolor attributes. */
function sameColour(el) {
  const c = textColorOf(el);
  if (!c || c[3] < 0.5) return false;
  const bg = effectiveBg(el);
  return bg !== 'unknown' && contrast(c, bg) < SAME_COLOUR;
}

// Simple top-level <style> rules of an email ("…{display:none}"). At-rules are skipped whole: responsive mail shows or
// hides its mobile/desktop copies inside @media blocks, and both copies are real content.
export function cssRules(css) {
  const rules = [];
  const src = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    let depth = 1, j = open + 1;
    while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
    const head = src.slice(i, open);
    const selector = head.slice(head.lastIndexOf(';') + 1).trim(); // after "@charset …;" / "@import …;"
    if (selector && !selector.startsWith('@')) rules.push({ selector, style: parseStyle(src.slice(open + 1, j - 1)) });
    i = j;
  }
  return rules;
}
const styleRules = document => [...document.querySelectorAll('style')].flatMap(st => cssRules(st.textContent));

/**
 * Remove hidden elements and comments from a linkedom document, in place. → { removed, chars, comments, sample, reasons }.
 * sample: the removed text (up to 2000 characters) so the injection detector can check what was hidden.
 */
export function pruneHiddenDocument(document, { email = false } = {}) {
  const out = { removed: 0, chars: 0, comments: 0, sample: '', reasons: {} };
  const root = document?.documentElement;
  if (!root) return out;
  const drop = (el, why) => {
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    el.remove();
    if (!text) return;
    out.removed++;
    out.chars += text.length;
    out.reasons[why] = (out.reasons[why] || 0) + 1;
    if (out.sample.length < 2000) out.sample += `${out.sample ? '\n' : ''}${text.slice(0, 2000 - out.sample.length)}`;
  };
  if (email) {
    for (const r of styleRules(document)) {
      const why = inlineHidden(r.style, { email });
      if (!why) continue;
      try { for (const el of document.querySelectorAll(r.selector)) if (root.contains(el)) drop(el, why); } catch { /* a selector linkedom can't run */ }
    }
  }
  for (const el of [...document.querySelectorAll('[style], font[color], [hidden]')]) {
    if (!root.contains(el)) continue; // already inside something removed
    if (el.hasAttribute('hidden') && el.tagName !== 'INPUT') { drop(el, 'hidden'); continue; }
    const why = inlineHidden(el.getAttribute('style'), { email }) || (sameColour(el) ? 'same-colour' : null);
    if (why) drop(el, why);
  }
  const walk = node => {
    for (const child of [...(node.childNodes || [])]) {
      if (child.nodeType === 8) { child.remove(); out.comments++; } else if (child.nodeType === 1) walk(child);
    }
  };
  walk(root);
  return out;
}

// ---- Inside the page ------------------------------------------------------------------------------------------------------
/**
 * page.evaluate(pruneInPage, { patterns, maxMs, maxNodes }) → { html, removed, chars, displayNone, comments, sample,
 * reasons, partial, ms }, or null when there is no document or the copy didn't line up. Self-contained: it runs in the
 * page. Judges every visible text node by its computed style: tiny font, near-zero opacity, visibility hidden, clipped
 * to a pixel, far off-screen (left/up), same colour as its background, transparent. An element that makes ITSELF
 * invisible while animated (transition/animation) is spared the opacity and visibility rules: reveal-on-scroll content
 * starts invisible. display:none and zero-size boxes are kept and counted, unless their text matches `patterns` (the
 * injection detector's stage 1).
 */
export function pruneInPage({ patterns = [], maxMs = 1500, maxNodes = 40000 } = {}) {
  const t0 = performance.now();
  const root = document.documentElement;
  if (!root || !document.body) return null;
  const res = { removed: 0, chars: 0, displayNone: 0, comments: 0, sample: '', reasons: {}, partial: false, ms: 0 };
  const tests = patterns.map(p => { try { return new RegExp(p, 'iu'); } catch { return null; } }).filter(Boolean);
  const trips = text => tests.some(re => re.test(text));
  const parse = c => { const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/.exec(c || ''); return m ? [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]] : null; };
  const lum = ([r, g, b]) => { const f = x => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const info = new Map();
  const TOP = { opacity: 1, none: false, bg: [255, 255, 255, 1], bgUnknown: false, clipped: false, collapsed: false, visHidden: false, visExempt: false };
  const infoOf = el => {
    if (!el || el.nodeType !== 1) return TOP;
    let v = info.get(el);
    if (v) return v;
    const p = infoOf(el.parentElement);
    const cs = getComputedStyle(el);
    // Only the element that makes itself invisible is judged by its own animation (reveal-on-scroll starts invisible).
    const animated = cs.animationName !== 'none' || cs.transitionDuration.split(',').some(d => parseFloat(d) > 0);
    const op = parseFloat(cs.opacity);
    const visHidden = cs.visibility !== 'visible';
    let bg = p.bg, bgUnknown = p.bgUnknown;
    const own = parse(cs.backgroundColor);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') bgUnknown = true;
    else if (own && own[3] >= 0.5) { bg = own; bgUnknown = false; }
    let clipped = p.clipped, collapsed = p.collapsed;
    if (cs.overflow !== 'visible' || cs.clip !== 'auto' || (cs.clipPath && cs.clipPath !== 'none')) {
      const r = el.getBoundingClientRect();
      if (!el.getClientRects().length) collapsed = true; // not laid out at all: like display:none, kept
      // The "visually hidden" pattern: a 1-pixel box, or an explicit zero clip.
      else if (/rect\(0px,? 0px,? 0px,? 0px\)/.test(cs.clip) || /inset\(50%/.test(cs.clipPath) || (r.width <= 2 && r.height <= 2 && r.width + r.height > 0)) clipped = true;
      // A box collapsed to nothing in one direction or both: a closed accordion or a collapsed table (max-height: 0,
      // Wikipedia's collapsed climate boxes) — real content, kept like display:none.
      else if (r.width <= 2 || r.height <= 2) collapsed = true;
    }
    v = { opacity: p.opacity * (Number.isNaN(op) ? 1 : op < 0.05 && animated ? 1 : op), none: p.none || cs.display === 'none', bg, bgUnknown,
      clipped, collapsed, visHidden, visExempt: visHidden ? (p.visHidden ? p.visExempt : animated) : false, cs };
    info.set(el, v);
    return v;
  };
  const hidden = new Set(); // live nodes to leave out of the copy
  const note = (node, why, text) => {
    hidden.add(node);
    res.removed++;
    res.chars += text.length;
    res.reasons[why] = (res.reasons[why] || 0) + 1;
    if (res.sample.length < 2000) res.sample += `${res.sample ? '\n' : ''}${text.slice(0, 2000 - res.sample.length)}`;
  };
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const noneSeen = new Set();
  let n = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    const el = node.parentElement;
    if (!text || !el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    if (++n > maxNodes || performance.now() - t0 > maxMs) { res.partial = true; break; }
    const i = infoOf(el);
    const cs = i.cs;
    if (i.none || i.collapsed) {
      // Kept (tabs, accordions) — but the topmost hidden box goes when its text talks to an AI.
      let top = el;
      while (top.parentElement && (infoOf(top.parentElement).none || infoOf(top.parentElement).collapsed)) top = top.parentElement;
      if (!noneSeen.has(top)) {
        noneSeen.add(top);
        const all = String(top.textContent || '').replace(/\s+/g, ' ').trim();
        if (trips(all)) note(top, 'display:none', all); else res.displayNone++;
      }
      continue;
    }
    if (i.clipped) { note(node, 'clipped', text); continue; }
    if (i.opacity < 0.05) { note(node, 'opacity', text); continue; }
    if (i.visHidden && !i.visExempt) { note(node, 'visibility', text); continue; }
    if (parseFloat(cs.fontSize) < 2) { note(node, 'font-size', text); continue; }
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { res.displayNone++; continue; } // not laid out (e.g. a closed <details>): kept
    if (r.right + scrollX < -1000 || r.bottom + scrollY < -1000) { note(node, 'off-screen', text); continue; }
    const shadow = cs.textShadow && cs.textShadow !== 'none';
    const color = parse(cs.color);
    if (color && !i.bgUnknown && !shadow) {
      if (color[3] < 0.05) { note(node, 'transparent', text); continue; }
      if (color[3] >= 0.5 && ratio(color, i.bg) < 1.25) { note(node, 'same-colour', text); continue; }
    }
  }
  // Copy the document without the hidden nodes and comments (the live page is never changed).
  const order = [];
  const w1 = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  for (let x = w1.currentNode; x; x = w1.nextNode()) order.push(x);
  const drop = new Set();
  order.forEach((x, idx) => { if (hidden.has(x) || x.nodeType === 8) drop.add(idx); });
  const clone = root.cloneNode(true);
  const copy = [];
  const w2 = document.createTreeWalker(clone, NodeFilter.SHOW_ALL);
  for (let x = w2.currentNode; x; x = w2.nextNode()) copy.push(x);
  if (copy.length !== order.length) return null; // the copy doesn't line up with the page: the caller uses the plain HTML
  for (const idx of drop) {
    const x = copy[idx];
    if (!x || x === clone) continue;
    if (x.nodeType === 8) res.comments++;
    x.remove();
  }
  res.html = `<!DOCTYPE html>\n${clone.outerHTML}`;
  res.ms = Math.round(performance.now() - t0);
  return res;
}
