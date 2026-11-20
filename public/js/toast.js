// Toasts: short, non-blocking feedback. Errors linger longer and can offer Retry.
// toast('Saved', { type: 'success' })
// toast('Deleted', { action: { label: 'Undo', onClick: () => … } })
import { h, escapeHtml, icon } from './core.js';

const TYPES = {
  info: { icon: 'info', cls: 'text-run' },
  success: { icon: 'circle-check', cls: 'text-ok' },
  warn: { icon: 'triangle-alert', cls: 'text-warn' },
  error: { icon: 'circle-x', cls: 'text-bad' },
};

export function toast(message, { type = 'info', title, action, duration } = {}) {
  const region = document.getElementById('toasts');
  if (!region) return;
  const t = TYPES[type] || TYPES.info;
  const ms = duration ?? (type === 'error' ? 8000 : action ? 6000 : 3500);

  const el = h(`
    <div class="toast" role="${type === 'error' ? 'alert' : 'status'}">
      <span class="mt-0.5 ${t.cls}">${icon(t.icon, 'size-[18px]')}</span>
      <div class="min-w-0 flex-1">
        ${title ? `<p class="font-semibold">${escapeHtml(title)}</p>` : ''}
        <p class="${title ? 'text-ink-2' : ''}">${escapeHtml(message)}</p>
      </div>
      ${action ? `<button type="button" class="btn btn-sm btn-soft -my-1" data-toast-action>${escapeHtml(action.label)}</button>` : ''}
      <button type="button" class="btn btn-ghost btn-icon btn-sm -my-1 -mr-2" data-toast-close aria-label="Dismiss">${icon('x')}</button>
    </div>`);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  const arm = () => { timer = setTimeout(dismiss, ms); };

  el.querySelector('[data-toast-close]').addEventListener('click', dismiss);
  el.querySelector('[data-toast-action]')?.addEventListener('click', () => { dismiss(); action.onClick?.(); });
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', arm);

  region.append(el);
  while (region.children.length > 4) region.firstElementChild.remove();
  arm();
  return dismiss;
}

/**
 * A toast for slow work (UX rule: nothing is fire-and-forget): shows a spinner until it's settled, then turns into the
 * result in place — one toast, not two. const t = toast.pending('Summarizing…'); … t.done('Done.') / t.info(m) / t.fail(m)
 */
toast.pending = (message, { title } = {}) => {
  const region = document.getElementById('toasts');
  const el = h(`
    <div class="toast" role="status" aria-live="polite">
      <span class="mt-0.5 text-run" data-toast-icon><span class="spinner size-[18px]"></span></span>
      <div class="min-w-0 flex-1">
        ${title ? `<p class="font-semibold">${escapeHtml(title)}</p>` : ''}
        <p class="${title ? 'text-ink-2' : ''}" data-toast-text>${escapeHtml(message)}</p>
      </div>
    </div>`);
  region?.append(el);
  const settle = (msg, type) => {
    const t = TYPES[type] || TYPES.info;
    const iconBox = el.querySelector('[data-toast-icon]');
    iconBox.className = `mt-0.5 ${t.cls}`;
    iconBox.innerHTML = icon(t.icon, 'size-[18px]');
    el.querySelector('[data-toast-text]').textContent = msg;
    if (type === 'error') el.setAttribute('role', 'alert');
    setTimeout(() => { el.classList.add('is-leaving'); el.addEventListener('animationend', () => el.remove(), { once: true }); }, type === 'error' ? 8000 : 3500);
  };
  return { done: m => settle(m, 'success'), info: m => settle(m, 'info'), fail: m => settle(m, 'error') };
};

toast.success = (m, o) => toast(m, { ...o, type: 'success' });
toast.error = (m, o) => toast(m, { ...o, type: 'error' });
toast.warn = (m, o) => toast(m, { ...o, type: 'warn' });
