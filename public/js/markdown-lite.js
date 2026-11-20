// In-house streaming markdown for replies as they arrive (the server's markdown-it render replaces it when the reply
// is done). Safe by construction: every character is HTML-escaped first; only tags generated here are emitted, and
// links are limited to http(s), mailto and same-site paths. Blocks carry a direction like the server's (bidi.js, decision #68). Tolerates half-written input (open code fence, lone **).
import { escapeHtml } from './core.js';
import { dirAttr } from './bidi.js';

const safeHref = u => (/^(https?:\/\/|mailto:|\/(?!\/))/i.test(u) ? u : null);

function inline(src) {
  // Code spans first, parked as placeholders so their contents stay literal.
  const code = [];
  let s = escapeHtml(src).replace(/`([^`\n]+)`/g, (m, c) => `\u0000${code.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const href = safeHref(url.replace(/&amp;/g, '&'));
    return href ? `<a href="${escapeHtml(href)}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>` : m;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${code[i]}</code>`);
}

export function renderMarkdownLite(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const out = [];
  let para = [], list = null, quote = [];
  const flushPara = () => { if (para.length) out.push(`<p${dirAttr(para.join(' '))}>${para.map(inline).join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}${dirAttr(list.items.join(' '))}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; };
  const flushQuote = () => { if (quote.length) out.push(`<blockquote${dirAttr(quote.join(' '))}><p>${quote.map(inline).join('<br>')}</p></blockquote>`); quote = []; };
  const flush = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      flush();
      const body = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
      // Same block as the server's (src/lib/code.js) minus colours, which arrive with the final render.
      // An unclosed fence (still streaming) is fine.
      out.push(`<div class="code-block"><div class="code-head"><span>${escapeHtml(fence[1] || 'Code')}</span>`
        + '<button type="button" class="code-copy" data-code-copy aria-label="Copy code">Copy</button></div>'
        + `<pre><code class="hljs">${escapeHtml(body.join('\n'))}</code></pre></div>`);
      continue;
    }
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); const n = Math.min(m[1].length + 1, 4); out.push(`<h${n}${dirAttr(m[2])}>${inline(m[2])}</h${n}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote.push(m[1]); continue; }
    if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flushPara(); flushQuote();
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flushList(); flushQuote();
    para.push(line);
  }
  flush();
  return out.join('');
}
