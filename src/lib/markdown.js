// The one markdown renderer for model output, feed posts and documents.
// Raw HTML is disabled: model output can never inject markup. External links open in a new tab, no referrer;
// links inside Jessbot (/library/…, /chat/…) stay in the app. Code blocks are coloured with a Copy button (lib/code.js).
// renderDocument is the same renderer plus what printed documents need (make_pdf only, never chat): a line holding only
// \newpage breaks the page, and $…$ / $$…$$ are formulas, turned into MathML on the server by temml (MIT), which the
// browser draws natively (no script or stylesheet in the page).
import MarkdownIt from 'markdown-it';
import temml from 'temml';
import { codeBlock } from './code.js';
import { textDir } from '../../public/js/bidi.js';

// Right-to-left content (decision #68): each top-level block gets the direction most of its words have (bidi.js), so an
// Arabic paragraph or list reads and bullets right-to-left inside an English reply, even when it opens with an English
// name. Top-level only: nested blocks inherit their list's / quote's direction.
const DIR_BLOCKS = new Set(['paragraph_open', 'heading_open', 'bullet_list_open', 'ordered_list_open', 'blockquote_open', 'table_open']);

function base() {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
  md.renderer.rules.fence = (tokens, idx) => codeBlock(tokens[idx].content, tokens[idx].info);
  md.renderer.rules.code_block = (tokens, idx) => codeBlock(tokens[idx].content);
  const defaultLink = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    if (/^https?:\/\//i.test(tokens[idx].attrGet('href') || '')) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
    }
    return defaultLink(tokens, idx, options, env, self);
  };
  md.core.ruler.push('dir_blocks', state => {
    const { tokens } = state;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.level !== 0 || !DIR_BLOCKS.has(t.type)) continue;
      const close = t.type.replace('_open', '_close');
      let text = '';
      for (let j = i + 1; j < tokens.length && !(tokens[j].level === 0 && tokens[j].type === close); j++) {
        if (tokens[j].type === 'inline') text += ` ${tokens[j].content}`;
      }
      t.attrSet('dir', textDir(text) || 'auto');
    }
  });
  return md;
}

const md = base();
export const renderMarkdown = text => md.render(String(text ?? ''));

// ---- Documents (make_pdf) ------------------------------------------------------------------------------------------
const doc = base();

// A formula → MathML. A formula temml can't read is shown as its source (so nothing silently disappears) and noted in
// env.mathErrors for the tool to report. temml's `trust` stays off: no \href, \class or \style from model text.
function mathml(tex, display, env) {
  env.math = (env.math || 0) + 1;
  try { return temml.renderToString(tex, { displayMode: display, throwOnError: true, trust: false }); } catch (err) {
    (env.mathErrors ||= []).push({ tex, error: String(err.message || err).replace(/\s+/g, ' ').trim().slice(0, 160) });
    const src = doc.utils.escapeHtml(display ? `$$${tex}$$` : `$${tex}$`);
    return display ? `<pre class="math-error">${src}</pre>` : `<code class="math-error">${src}</code>`;
  }
}

// Inline $…$ (Pandoc's rule, so prices like "$5 and $10" stay text: no space just inside the dollars, no digit right
// after the closing one) and $$…$$ inside a line (shown as a display formula). \$ is a plain dollar (escape rule first).
doc.inline.ruler.after('escape', 'math_inline', (state, silent) => {
  const { src, pos } = state;
  if (src[pos] !== '$') return false;
  const display = src[pos + 1] === '$';
  const open = display ? 2 : 1;
  const start = pos + open;
  if (start >= src.length || /\s/.test(src[start]) || (!display && src[start] === '$')) return false;
  let end = start;
  for (;;) {
    end = src.indexOf(display ? '$$' : '$', end);
    if (end < 0) return false;
    if (src[end - 1] === '\\') { end++; continue; }
    if (!display && (/\s/.test(src[end - 1]) || /[0-9]/.test(src[end + 1] || ''))) { end++; continue; }
    break;
  }
  if (end === start) return false;
  if (!silent) {
    const token = state.push(display ? 'math_display_inline' : 'math_inline', 'math', 0);
    token.content = src.slice(start, end);
    token.markup = display ? '$$' : '$';
  }
  state.pos = end + open;
  return true;
});

// A $$ block: $$ at the start of a line, the formula, $$ at the end of a line (one line or several).
doc.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4 || state.src.slice(pos, pos + 2) !== '$$') return false;
  const first = state.src.slice(pos + 2, max);
  let content, line = startLine;
  if (/\$\$\s*$/.test(first) && first.trim().length > 2) content = first.replace(/\$\$\s*$/, '');
  else {
    const lines = [first];
    for (line = startLine + 1; line < endLine; line++) {
      pos = state.bMarks[line] + state.tShift[line];
      max = state.eMarks[line];
      const text = state.src.slice(pos, max);
      if (/\$\$\s*$/.test(text)) { lines.push(text.replace(/\$\$\s*$/, '')); break; }
      lines.push(text);
    }
    if (line >= endLine) return false; // never closed: not a formula
    content = lines.join('\n');
  }
  if (silent) return true;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, line + 1];
  token.markup = '$$';
  state.line = line + 1;
  return true;
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

// \newpage alone on a line: a page break (it also ends the paragraph above it).
doc.block.ruler.before('paragraph', 'page_break', (state, startLine, endLine, silent) => {
  const text = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trim();
  if (text !== '\\newpage' || state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (silent) return true;
  const token = state.push('page_break', 'div', 0);
  token.block = true;
  token.map = [startLine, startLine + 1];
  state.line = startLine + 1;
  return true;
}, { alt: ['paragraph'] });

doc.renderer.rules.math_inline = (tokens, idx, o, env) => mathml(tokens[idx].content, false, env);
doc.renderer.rules.math_display_inline = (tokens, idx, o, env) => mathml(tokens[idx].content, true, env);
doc.renderer.rules.math_block = (tokens, idx, o, env) => `${mathml(tokens[idx].content, true, env)}\n`;
doc.renderer.rules.page_break = () => '<div class="page-break"></div>\n';
// Images: env.imageSrc may swap a source (make_pdf inlines Library images as data: URIs, since the print page loads nothing).
const defaultImage = doc.renderer.rules.image;
doc.renderer.rules.image = (tokens, idx, options, env, self) => {
  const src = tokens[idx].attrGet('src');
  const swapped = env.imageSrc ? env.imageSrc(src) : src;
  tokens[idx].attrSet('src', swapped ?? '');
  return defaultImage(tokens, idx, options, env, self);
};

/**
 * Markdown for a printed document → { html, math: formulas found, mathErrors: [{ tex, error }] }.
 * imageSrc(src) → the source to use for an image (or null to drop it).
 */
export function renderDocument(text, { imageSrc } = {}) {
  const env = { imageSrc };
  const html = doc.render(String(text ?? ''), env);
  return { html, math: env.math || 0, mathErrors: env.mathErrors || [] };
}
