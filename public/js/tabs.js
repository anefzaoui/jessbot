// Accessible tabs. Markup:
//   <div role="tablist" data-tabs="panel-tabs" class="segmented">
//     <button role="tab" aria-controls="p-activity" aria-selected="true">…
//   <div role="tabpanel" id="p-activity">…
// data-tabs="key" remembers the chosen tab per key in localStorage.
import { $$, on, storage } from './core.js';

export function selectTab(tab, { focus = false, remember = true } = {}) {
  const list = tab.closest('[role="tablist"]');
  for (const t of $$('[role="tab"]', list)) {
    const selected = t === tab;
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(t.getAttribute('aria-controls'));
    if (panel) panel.hidden = !selected;
  }
  if (focus) tab.focus();
  if (remember && list.dataset.tabs) storage.set(`jb-tab:${list.dataset.tabs}`, tab.getAttribute('aria-controls').replace(/^[^-]+-/, ''));
  list.dispatchEvent(new CustomEvent('tabs:change', { detail: { tab }, bubbles: true }));
}

export function initTabs() {
  // Restore remembered tabs (ids are "<prefix>-<name>", so one choice applies to every copy of a panel).
  for (const list of $$('[role="tablist"][data-tabs]')) {
    const saved = storage.get(`jb-tab:${list.dataset.tabs}`);
    const tab = saved && $$('[role="tab"]', list).find(t => t.getAttribute('aria-controls').endsWith(`-${saved}`));
    if (tab) selectTab(tab, { remember: false });
  }

  on(document, 'click', '[role="tab"][aria-controls]', (e, tab) => selectTab(tab));
  on(document, 'keydown', '[role="tab"][aria-controls]', (e, tab) => {
    const tabs = $$('[role="tab"]', tab.closest('[role="tablist"]'));
    const i = tabs.indexOf(tab);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    selectTab(tabs[(next + tabs.length) % tabs.length], { focus: true });
  });
}
