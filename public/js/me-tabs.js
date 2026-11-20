// You page tabs: each tab has its own address (/me/places …). Switching is instant (no reload) and goes into
// history, so Back/Forward and refresh land on the same tab. Old /me#memory links are mapped once.
import { $, $$, on } from './core.js';

export function initMeTabs() {
  const nav = $('[data-me-tabs]');
  if (!nav) return;
  const show = tab => {
    if (!$(`[data-me-panel="${tab}"]`)) return false;
    for (const p of $$('[data-me-panel]')) p.hidden = p.dataset.mePanel !== tab;
    for (const a of $$('[data-me-tab]', nav)) {
      if (a.dataset.meTab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    document.title = `You · ${$(`[data-me-tab="${tab}"]`, nav)?.textContent} · ${document.documentElement.dataset.botName || 'Jessbot'}`;
    return true;
  };
  on(nav, 'click', '[data-me-tab]', (e, a) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; // new tab/window: let the browser do it
    e.preventDefault();
    if (show(a.dataset.meTab)) history.pushState({ meTab: a.dataset.meTab }, '', a.href);
  });
  addEventListener('popstate', () => show(location.pathname.split('/')[2] || 'profile'));
  const legacy = location.hash.slice(1);
  if (legacy && show(legacy)) history.replaceState({ meTab: legacy }, '', `/me/${legacy}`);
}
