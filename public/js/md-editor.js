// Markdown editors (Phase 15, docs/UI.md): every <textarea data-md-editor> gets coloured markdown under its text and an
// Edit / Preview switch. In-house: the textarea stays the real input (forms, counters, the unsaved-changes guard and
// right-to-left all keep working); a layer with identical metrics sits behind it and shows the same text, coloured
// (colour and backgrounds only — bold or italic would change widths and drift from the caret). Preview is rendered by
// the server with the chat's renderer (POST /api/v1/markdown/preview). Ctrl+Shift+P (⌘⇧P) switches.
import { $, $$, api, h, icon, escapeHtml } from './core.js';
import { highlight } from './md-highlight.js';

// What the layer must share with the textarea to put every letter in the same place.
const METRICS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontFeatureSettings', 'fontVariantLigatures', 'lineHeight',
  'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent', 'textTransform', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopStyle', 'borderRightStyle',
  'borderBottomStyle', 'borderLeftStyle', 'boxSizing'];

function enhance(ta) {
  if (ta.dataset.mdReady) return;
  ta.dataset.mdReady = '1';
  const label = ta.dataset.mdEditor || 'Markdown';
  const wrap = h(`<div class="md-editor" data-md-wrap data-mode="edit">
    <div class="md-bar">
      <div class="md-tabs" role="tablist" aria-label="${escapeHtml(label)}: edit or preview">
        <button type="button" role="tab" aria-selected="true" data-md-mode="edit">${icon('pencil-line', 'size-3.5')} Edit</button>
        <button type="button" role="tab" aria-selected="false" data-md-mode="preview">${icon('eye', 'size-3.5')} Preview</button>
      </div>
      <span class="md-hint" aria-hidden="true"><span class="kbd">Ctrl</span><span class="kbd">⇧</span><span class="kbd">P</span></span>
    </div>
    <div class="md-stage"><div class="md-layer" aria-hidden="true"></div></div>
    <div class="md-preview" data-md-preview role="tabpanel" tabindex="0" hidden></div>
  </div>`);
  ta.before(wrap);
  const stage = $('.md-stage', wrap), layer = $('.md-layer', wrap);
  stage.append(ta);
  ta.classList.add('md-input');
  wrap._ta = ta;

  // Same box, same font, same wrapping — then keep the scroll and the scrollbar gap in step.
  const fit = () => {
    const cs = getComputedStyle(ta);
    for (const k of METRICS) layer.style[k] = cs[k];
    layer.style.borderColor = 'transparent';
    const bar = ta.offsetWidth - ta.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    layer.style.paddingRight = `${parseFloat(cs.paddingRight) + Math.max(0, bar)}px`;
    layer.style.height = `${ta.offsetHeight}px`;
    layer.dir = ta.dir || 'auto';
  };
  let queued = false;
  const paint = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      // A div drops a trailing newline's empty line (a textarea keeps it): give that line a space to stand on.
      layer.innerHTML = highlight(ta.value) + (ta.value.endsWith('\n') ? ' ' : '');
      fit();
      layer.scrollTop = ta.scrollTop;
      layer.scrollLeft = ta.scrollLeft;
    });
  };
  ta.addEventListener('input', paint);
  ta.addEventListener('focus', paint); // values set by scripts (dialogs) don't fire input
  ta.addEventListener('scroll', () => { layer.scrollTop = ta.scrollTop; layer.scrollLeft = ta.scrollLeft; });
  new ResizeObserver(paint).observe(ta);
  ta.form?.addEventListener('reset', () => { setTimeout(() => { setMode(wrap, 'edit', { focus: false }); paint(); }, 0); });
  ta.addEventListener('md:refresh', paint);
  paint();
}

const lastRender = new WeakMap(); // wrap → { text, html }: switching back and forth re-renders only after an edit
async function showPreview(wrap) {
  const ta = wrap._ta, preview = $('[data-md-preview]', wrap);
  preview.style.minHeight = `${Math.max(160, ta.offsetHeight)}px`;
  const text = ta.value;
  const cached = lastRender.get(wrap);
  if (cached?.text === text) { preview.innerHTML = cached.html; return; }
  if (!text.trim()) { preview.innerHTML = '<p class="md-empty">Nothing to preview yet. Write something in Edit.</p>'; return; }
  preview.setAttribute('aria-busy', 'true');
  preview.innerHTML = `<div class="md-loading" role="status"><span class="md-skel w-2/5"></span><span class="md-skel w-11/12"></span>
    <span class="md-skel w-4/5"></span><span class="md-skel w-3/5"></span><span class="sr-only">Rendering the preview…</span></div>`;
  try {
    const r = await api('/api/v1/markdown/preview', { method: 'POST', body: { text } });
    if (ta.value !== text || wrap.dataset.mode !== 'preview') return; // they moved on
    const html = `<div class="prose-jb">${r.html}</div>`;
    lastRender.set(wrap, { text, html });
    preview.innerHTML = html;
  } catch (err) {
    preview.innerHTML = `<div class="md-error" role="alert">${icon('circle-alert', 'size-4 shrink-0')}<span class="flex-1">${escapeHtml(err.message)}</span>
      <button type="button" class="btn btn-secondary btn-sm" data-md-retry>${icon('rotate-ccw', 'size-3.5')} Try again</button></div>`;
  } finally { preview.removeAttribute('aria-busy'); }
}

function setMode(wrap, mode, { focus = true } = {}) {
  if (wrap.dataset.mode === mode && mode === 'edit') return;
  wrap.dataset.mode = mode;
  for (const b of $$('[data-md-mode]', wrap)) b.setAttribute('aria-selected', String(b.dataset.mdMode === mode));
  const stage = $('.md-stage', wrap), preview = $('[data-md-preview]', wrap);
  stage.hidden = mode === 'preview';
  preview.hidden = mode !== 'preview';
  if (mode === 'preview') { showPreview(wrap); if (focus) preview.focus({ preventScroll: true }); }
  else { wrap._ta.dispatchEvent(new Event('md:refresh')); if (focus) wrap._ta.focus({ preventScroll: true }); }
}

// The editor Ctrl+Shift+P is for: the one you're in, else one in an open dialog, else the first on the page.
function target() {
  const inside = document.activeElement?.closest?.('[data-md-wrap]');
  if (inside) return inside;
  const open = $$('dialog[open] [data-md-wrap]');
  if (open.length) return open[0];
  return $$('[data-md-wrap]').find(w => w.offsetParent !== null) || null;
}

export function initMdEditors(root = document) {
  $$('textarea[data-md-editor]', root).forEach(enhance);
  if (initMdEditors.bound) return;
  initMdEditors.bound = true;
  document.addEventListener('click', e => {
    const tab = e.target.closest?.('[data-md-mode]');
    if (tab) setMode(tab.closest('[data-md-wrap]'), tab.dataset.mdMode);
    const retry = e.target.closest?.('[data-md-retry]');
    if (retry) showPreview(retry.closest('[data-md-wrap]'));
  });
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 'p') return;
    const wrap = target();
    if (!wrap) return;
    e.preventDefault();
    setMode(wrap, wrap.dataset.mode === 'preview' ? 'edit' : 'preview');
  });
  // Arrow keys move between the two tabs (tablist pattern).
  document.addEventListener('keydown', e => {
    const tab = e.target.closest?.('[data-md-mode]');
    if (!tab || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const other = tab.dataset.mdMode === 'edit' ? 'preview' : 'edit';
    const wrap = tab.closest('[data-md-wrap]');
    setMode(wrap, other, { focus: false });
    $(`[data-md-mode="${other}"]`, wrap).focus();
  });
}
