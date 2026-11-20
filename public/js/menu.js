// Dropdown menus on the native popover API.
// Markup: <button popovertarget="m1" data-menu-trigger>…</button>
//         <div id="m1" popover class="menu" role="menu" data-placement="bottom-end">
//           <button class="menu-item" role="menuitem">…</button>
//         </div>
// Native popover gives light-dismiss + Esc + top layer; we add positioning and arrow keys.
import { $$ } from './core.js';

const GAP = 6;
const MARGIN = 8;

export function position(floating, anchor, placement = 'bottom-start') {
  const a = anchor.getBoundingClientRect();
  const f = floating.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight;
  let [side, align] = placement.split('-');

  // Flip vertically if there's no room.
  if (side === 'bottom' && a.bottom + GAP + f.height > vh - MARGIN && a.top - GAP - f.height > MARGIN) side = 'top';
  else if (side === 'top' && a.top - GAP - f.height < MARGIN) side = 'bottom';

  let top, left;
  if (side === 'right' || side === 'left') {
    left = side === 'right' ? a.right + GAP : a.left - GAP - f.width;
    top = a.top + (a.height - f.height) / 2;
  } else {
    top = side === 'bottom' ? a.bottom + GAP : a.top - GAP - f.height;
    left = align === 'end' ? a.right - f.width : align === 'center' ? a.left + (a.width - f.width) / 2 : a.left;
  }
  left = Math.min(Math.max(MARGIN, left), vw - f.width - MARGIN);
  top = Math.min(Math.max(MARGIN, top), vh - f.height - MARGIN);

  floating.style.position = 'fixed';
  floating.style.inset = 'auto';
  floating.style.top = `${top}px`;
  floating.style.left = `${left}px`;
  floating.dataset.side = side;
}

const items = menu => $$('.menu-item:not([disabled]), [role="menuitem"]:not([disabled]), [role="menuitemradio"]', menu);

export function initMenus() {
  document.addEventListener('toggle', e => {
    const menu = e.target;
    if (!(menu instanceof HTMLElement) || !menu.classList.contains('menu')) return;
    const trigger = document.querySelector(`[popovertarget="${menu.id}"]`);
    trigger?.setAttribute('aria-expanded', String(e.newState === 'open'));
    if (e.newState !== 'open' || !trigger) return;
    position(menu, trigger, menu.dataset.placement);
    requestAnimationFrame(() => items(menu)[0]?.focus({ preventScroll: true }));
  }, true);

  document.addEventListener('keydown', e => {
    const menu = e.target.closest?.('.menu:popover-open');
    if (!menu) return;
    const list = items(menu);
    const i = list.indexOf(document.activeElement);
    const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (move) { e.preventDefault(); list[(i + move + list.length) % list.length]?.focus(); }
    if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    if (e.key === 'End') { e.preventDefault(); list.at(-1)?.focus(); }
    if (e.key === 'Tab') menu.hidePopover();
  });

  // Choosing an item closes its menu (unless it opts out).
  document.addEventListener('click', e => {
    const item = e.target.closest?.('.menu .menu-item');
    if (item && item.dataset.keepOpen === undefined) item.closest('.menu')?.hidePopover?.();
  });

  addEventListener('resize', () => $$('.menu:popover-open').forEach(m => m.hidePopover()));
}
