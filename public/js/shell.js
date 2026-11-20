// App shell behaviour: rail collapse, right panel (aside on xl, sheet below), shortcuts,
// live badge counts and screen-reader announcements.
import { $, $$, on, storage } from './core.js';
import { openModal } from './modal.js';
import { selectTab } from './tabs.js';

const xl = matchMedia('(min-width: 80rem)');
const root = document.documentElement;

export function toggleRail(force) {
  const collapsed = force ?? root.dataset.rail !== 'collapsed';
  if (collapsed) root.dataset.rail = 'collapsed'; else delete root.dataset.rail;
  storage.set('jb-rail', collapsed ? 'collapsed' : 'open');
}

// Open the panel, optionally on a tab (activity | approvals | upcoming | identity).
export function openPanel(tab) {
  if (xl.matches && $('.app-panel')) {
    delete root.dataset.panel;
    storage.set('jb-panel', 'shown');
    if (tab) selectPanelTab('aside', tab);
  } else {
    if (tab) selectPanelTab('sheet', tab);
    openModal('panel-sheet');
  }
}

function selectPanelTab(prefix, tab) {
  const t = document.getElementById(`${prefix}-tab-${tab}`);
  if (t) selectTab(t);
}

export function togglePanel() {
  if (!xl.matches) return openPanel();
  const hidden = root.dataset.panel !== 'hidden';
  if (hidden) root.dataset.panel = 'hidden'; else delete root.dataset.panel;
  storage.set('jb-panel', hidden ? 'hidden' : 'shown');
}

// Update every badge for a key (rail, tab bar, panel copies). 0 hides it.
export function setCount(key, n) {
  for (const el of $$(`[data-live-count="${key}"]`)) {
    el.textContent = n > 99 ? '99+' : String(n);
    el.hidden = !n;
  }
}

// Polite screen-reader announcement (agent replies, saves, errors).
export function announce(message) {
  const el = $('#announcer');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = message; }, 50);
}

export function initShell() {
  on(document, 'click', '[data-rail-toggle]', () => toggleRail());
  on(document, 'click', '[data-panel-toggle]', () => togglePanel());
  on(document, 'click', '[data-panel-open]', (e, el) => { e.preventDefault(); openPanel(el.dataset.panelOpen || undefined); });

  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === '[') { e.preventDefault(); toggleRail(); }
    if (e.key === '.') { e.preventDefault(); togglePanel(); }
  });

  // "/" focuses the composer when not typing elsewhere.
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    const composer = $('[data-composer-input]');
    if (composer) { e.preventDefault(); composer.focus(); }
  });
}
