// Tooltips: <button data-tooltip="Copy" data-tooltip-kbd="C">…
// One shared, positioned element; shows on hover (delayed) and on keyboard focus.
import { position } from './menu.js';
import { escapeHtml } from './core.js';

const DELAY = 400;
let tip, timer, current;

function show(el) {
  const text = el.dataset.tooltip;
  if (!text) return;
  // Rail labels are visible when expanded; only show their tooltips when collapsed.
  if (el.dataset.tooltipRail !== undefined && document.documentElement.dataset.rail !== 'collapsed') return;
  current = el;
  tip.innerHTML = escapeHtml(text) + (el.dataset.tooltipKbd
    ? ` <span class="ml-1 rounded bg-canvas/15 px-1 font-mono text-[10px]">${escapeHtml(el.dataset.tooltipKbd)}</span>` : '');
  tip.classList.add('is-visible');
  position(tip, el, el.dataset.tooltipPlacement || (el.dataset.tooltipRail !== undefined ? 'right' : 'top-center'));
  el.setAttribute('aria-describedby', 'jb-tooltip');
}

function hide() {
  clearTimeout(timer);
  tip?.classList.remove('is-visible');
  current?.removeAttribute('aria-describedby');
  current = null;
}

export function initTooltips() {
  tip = document.createElement('div');
  tip.id = 'jb-tooltip';
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);

  document.addEventListener('pointerover', e => {
    const el = e.target.closest?.('[data-tooltip]');
    if (el === current) return;
    hide();
    if (el && e.pointerType !== 'touch') timer = setTimeout(() => show(el), DELAY);
  });
  document.addEventListener('focusin', e => {
    const el = e.target.closest?.('[data-tooltip]');
    hide();
    if (el?.matches(':focus-visible')) show(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  addEventListener('scroll', hide, true);
}
