// Markdown → coloured HTML for the editor's highlight layer (md-editor.js). In-house, line by line, pure (also used by
// the unit tests). The output must keep every character of the input in place — the layer sits exactly under the
// textarea's text — so markers are wrapped, never removed or added.
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const span = (cls, s) => `<span class="${cls}">${s}</span>`;

// Inline spans, first match wins at each position: code, links, bare URLs, bold, italic, strike, HTML comments/tags.
const INLINE = [
  '(`+)([^`]|[^`][\\s\\S]*?[^`])\\1',                    // 1,2 inline code
  '(!?)\\[([^\\]\\n]*)\\]\\(([^)\\s]*)(\\s+"[^"]*")?\\)',  // 3–6 link / image
  '(https?:\\/\\/[^\\s<>)\\]]+)',                          // 7 bare URL
  '(\\*\\*|__)(?=\\S)([\\s\\S]*?\\S)\\8',                  // 8,9 bold
  '(?<![\\w*])(\\*|_)(?=[^\\s*_])([^*_\\n]*?[^\\s*_])\\10(?![\\w*])',  // 10,11 italic (not inside snake_case words)
  '(~~)(?=\\S)([\\s\\S]*?\\S)~~',                          // 12,13 strike
  '(<!--[\\s\\S]*?-->)',                                  // 14 comment
  '(<\\/?[a-zA-Z][^>\\n]*>)',                              // 15 tag
].join('|');

export function inline(text) {
  const re = new RegExp(INLINE, 'g'); // its own per call: nested spans recurse
  let out = '', last = 0, m;
  while ((m = re.exec(text))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out += esc(text.slice(last, m.index));
    if (m[1] !== undefined) out += span('md-icode', span('md-mark', esc(m[1])) + esc(m[2]) + span('md-mark', esc(m[1])));
    else if (m[4] !== undefined) {
      out += span(m[3] ? 'md-image' : 'md-link', span('md-mark', `${esc(m[3])}[`) + inline(m[4]) + span('md-mark', '](')
        + span('md-url', esc(m[5]) + esc(m[6] || '')) + span('md-mark', ')'));
    } else if (m[7] !== undefined) out += span('md-url', esc(m[7]));
    else if (m[8] !== undefined) out += span('md-b', span('md-mark', m[8]) + inline(m[9]) + span('md-mark', m[8]));
    else if (m[10] !== undefined) out += span('md-i', span('md-mark', m[10]) + inline(m[11]) + span('md-mark', m[10]));
    else if (m[12] !== undefined) out += span('md-s', span('md-mark', '~~') + inline(m[13]) + span('md-mark', '~~'));
    else if (m[14] !== undefined) out += span('md-comment', esc(m[14]));
    else out += span('md-tag', esc(m[15]));
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

/** The whole document → HTML with one line per input line (fenced code and comments span lines). */
export function highlight(src) {
  const lines = String(src ?? '').split('\n');
  const out = [];
  let fence = null;      // the open ``` / ~~~ marker
  let comment = false;   // inside a multi-line <!-- -->
  for (const line of lines) {
    if (fence) {
      const close = line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, '') === '';
      out.push(close ? span('md-fence', esc(line)) : span('md-code', esc(line)));
      if (close) fence = null;
      continue;
    }
    if (comment) {
      const end = line.indexOf('-->');
      if (end < 0) { out.push(span('md-comment', esc(line))); continue; }
      out.push(span('md-comment', esc(line.slice(0, end + 3))) + inline(line.slice(end + 3)));
      comment = false;
      continue;
    }
    let m;
    if ((m = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/))) {
      fence = m[2];
      out.push(span('md-fence', esc(m[1] + m[2]) + (m[3] ? span('md-lang', esc(m[3])) : '')));
    } else if (/^\s*<!--/.test(line) && !line.includes('-->')) {
      comment = true;
      out.push(span('md-comment', esc(line)));
    } else if ((m = line.match(/^(\s{0,3})(#{1,6})(\s+)(.*)$/))) {
      out.push(span(`md-h md-h${m[2].length}`, esc(m[1]) + span('md-mark', m[2]) + m[3] + inline(m[4])));
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(span('md-hr', esc(line)));
    } else if ((m = line.match(/^(\s*>+\s?)(.*)$/))) {
      out.push(span('md-quote', span('md-mark', esc(m[1])) + inline(m[2])));
    } else if ((m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/))) {
      out.push(esc(m[1]) + span('md-list', esc(m[2])) + m[3] + (m[4] ? span('md-task', esc(m[4])) : '') + inline(m[5]));
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      out.push(/^[\s|:-]+$/.test(line) ? span('md-mark', esc(line))
        : line.split('|').map(cell => inline(cell)).join(span('md-pipe', '|')));
    } else out.push(inline(line));
  }
  return out.join('\n');
}
