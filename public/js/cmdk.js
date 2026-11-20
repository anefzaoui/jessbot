// Command palette. Commands come from any element with data-cmd (+ data-cmd-group, data-cmd-icon)
// plus built-ins. Ctrl/⌘+K opens; Tab sends the query to chat as a draft.
import { $, $$, on, escapeHtml, icon } from './core.js';
import { openModal, closeModal } from './modal.js';
import { setTheme } from './theme.js';

let dlg, input, list, commands = [], results = [], active = 0;

function collect() {
  const seen = new Set();
  const found = $$('[data-cmd]').map(el => ({
    label: el.dataset.cmd,
    group: el.dataset.cmdGroup || 'Actions',
    iconName: el.dataset.cmdIcon || 'arrow-right',
    run: () => (el.href ? location.assign(el.href) : el.click()),
  }));
  const builtins = [
    { label: 'Toggle dark mode', group: 'Appearance', iconName: 'moon',
      run: () => setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark') },
    { label: 'Toggle sidebar', group: 'View', iconName: 'panel-left', run: () => $('[data-rail-toggle]')?.click() },
  ];
  return [...found, ...builtins].filter(c => !seen.has(c.label) && seen.add(c.label));
}

// Subsequence fuzzy score: consecutive and word-start matches rank higher.
function score(text, query) {
  if (!query) return 1;
  const t = text.toLowerCase(), q = query.toLowerCase();
  let ti = 0, s = 0, streak = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return 0;
    streak = i === ti ? streak + 1 : 0;
    s += 1 + streak * 2 + (i === 0 || t[i - 1] === ' ' ? 3 : 0);
    ti = i + 1;
  }
  return s - t.length * 0.05;
}

function render() {
  const q = input.value.trim();
  results = commands.map(c => ({ c, s: score(`${c.label} ${c.group}`, q) }))
    .filter(r => r.s > 0).sort((a, b) => b.s - a.s).map(r => r.c);
  active = Math.min(active, Math.max(0, results.length - 1));

  if (!results.length) {
    list.innerHTML = `<li class="px-3 py-8 text-center text-sm text-ink-3">No matches. Press <span class="kbd">Tab</span> to ask about “${escapeHtml(q)}”.</li>`;
    return;
  }
  let html = '', group = null;
  results.forEach((c, i) => {
    if (!q && c.group !== group) {
      group = c.group;
      html += `<li role="presentation" class="px-3 pt-3 pb-1 text-xs font-medium text-ink-3">${escapeHtml(group)}</li>`;
    }
    html += `<li role="option" id="cmdk-opt-${i}" aria-selected="${i === active}" data-index="${i}"
      class="flex h-10 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm ${i === active ? 'bg-surface-2 text-ink' : 'text-ink-2'}">
      <span class="text-ink-3">${icon(c.iconName)}</span><span class="flex-1">${escapeHtml(c.label)}</span>
      ${q ? `<span class="text-xs text-ink-3">${escapeHtml(c.group)}</span>` : ''}</li>`;
  });
  list.innerHTML = html;
  input.setAttribute('aria-activedescendant', `cmdk-opt-${active}`);
  $(`#cmdk-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
}

function runActive() {
  const c = results[active];
  if (!c) return;
  closeModal(dlg);
  c.run();
}

export function openPalette() {
  commands = collect();
  input.value = '';
  active = 0;
  render();
  openModal(dlg);
  input.focus();
}

export function initCmdk() {
  dlg = $('#cmdk');
  if (!dlg) return;
  input = $('[data-cmdk-input]', dlg);
  list = $('[data-cmdk-list]', dlg);

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      dlg.open ? closeModal(dlg) : openPalette();
    }
  });
  on(document, 'click', '[data-cmdk-open]', openPalette);
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % Math.max(1, results.length); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + results.length) % Math.max(1, results.length); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); runActive(); }
    else if (e.key === 'Tab' && input.value.trim()) {
      e.preventDefault();
      location.assign(`/chat?draft=${encodeURIComponent(input.value.trim())}`);
    }
  });
  list.addEventListener('pointermove', e => {
    const opt = e.target.closest('[data-index]');
    if (opt && Number(opt.dataset.index) !== active) { active = Number(opt.dataset.index); render(); }
  });
  list.addEventListener('click', e => { if (e.target.closest('[data-index]')) runActive(); });
}
