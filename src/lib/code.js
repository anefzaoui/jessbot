// Code blocks in chat (owner request): coloured by highlight.js on the server (language from the fence, or
// auto-detected among common ones), wrapped in one shared block with a language label and a Copy button.
// The same markup is produced by public/js/markdown-lite.js while a reply streams (without colours until it's done).
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import powershell from 'highlight.js/lib/languages/powershell';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import ini from 'highlight.js/lib/languages/ini';

const LANGS = { javascript, typescript, python, bash, shell, powershell, json, xml, css, sql, java, c, cpp, csharp, go, rust, php,
  ruby, yaml, markdown, diff, kotlin, swift, dockerfile, ini };
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);
const AUTO = ['javascript', 'typescript', 'python', 'bash', 'powershell', 'json', 'xml', 'css', 'sql', 'java', 'cpp', 'csharp', 'go', 'rust', 'php', 'ruby', 'yaml', 'dockerfile'];

const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const LABEL = { javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python', bash: 'Bash', shell: 'Shell', powershell: 'PowerShell', json: 'JSON',
  xml: 'HTML', css: 'CSS', sql: 'SQL', java: 'Java', c: 'C', cpp: 'C++', csharp: 'C#', go: 'Go', rust: 'Rust', php: 'PHP', ruby: 'Ruby',
  yaml: 'YAML', markdown: 'Markdown', diff: 'Diff', kotlin: 'Kotlin', swift: 'Swift', dockerfile: 'Dockerfile', ini: 'INI' };

/** One code block: header (language + Copy) and highlighted code. `lang` may be empty/unknown → auto-detect. */
export function codeBlock(code, lang = '') {
  const src = String(code).replace(/\n$/, '');
  const wanted = String(lang || '').trim().toLowerCase().split(/\s/)[0];
  let html, detected = null;
  try {
    if (wanted && hljs.getLanguage(wanted)) { html = hljs.highlight(src, { language: wanted, ignoreIllegals: true }).value; detected = hljs.getLanguage(wanted).name; }
    else if (src.length <= 100_000) {
      const r = hljs.highlightAuto(src, AUTO);
      if (r.relevance >= 2) { html = r.value; detected = LABEL[r.language] || r.language; } // it's already known to be code
    }
  } catch { /* plain below */ }
  const label = detected || (wanted ? wanted : 'Code');
  return `<div class="code-block"><div class="code-head"><span>${esc(label)}</span>`
    + '<button type="button" class="code-copy" data-code-copy aria-label="Copy code">Copy</button></div>'
    + `<pre><code class="hljs">${html ?? esc(src)}</code></pre></div>`;
}

/** Does unfenced text look like pasted code? Conservative: several lines, code punctuation, confident detection. */
export function looksLikeCode(text) {
  const t = String(text);
  const lines = t.split('\n').filter(l => l.trim());
  if (lines.length < 3 || t.length > 50_000) return false;
  const codey = lines.filter(l => /[;{}()=<>[\]]|^\s{2,}\S|^\s*(def|class|import|from|return|const|let|var|function|if|for|while|SELECT|INSERT|#include)\b/.test(l)).length;
  if (codey / lines.length < 0.6) return false;
  return hljs.highlightAuto(t, AUTO).relevance >= 3; // measured: code snippets ≥ 4, prose with brackets ≤ 2
}

/**
 * A person's own message: plain text (never markdown — what they typed is what they see), except that fenced
 * ```code``` blocks, or a whole message that is clearly pasted code, become code blocks. Returns null when there is
 * nothing to format (the template then shows the plain text).
 */
export function userMessageHtml(text) {
  const t = String(text ?? '');
  // Fences count only at the start of a line (Markdown's rule) — "use a ```js block" mid-sentence is just text.
  const FENCE = /^ {0,3}```\s*([\w+#.-]*)/;
  const lines = t.split('\n');
  if (lines.some(l => FENCE.test(l))) {
    let out = '', plain = [];
    const flush = () => { const p = plain.join('\n').replace(/^\n+|\n+$/g, ''); if (p) out += `<p class="whitespace-pre-wrap">${esc(p)}</p>`; plain = []; };
    for (let i = 0; i < lines.length; i++) {
      const m = FENCE.exec(lines[i]);
      if (!m) { plain.push(lines[i]); continue; }
      flush();
      const body = [];
      while (++i < lines.length && !/^ {0,3}```\s*$/.test(lines[i])) body.push(lines[i]);
      out += codeBlock(body.join('\n'), m[1]);
    }
    flush();
    return out;
  }
  return looksLikeCode(t) ? codeBlock(t) : null;
}
