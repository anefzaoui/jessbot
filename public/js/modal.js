// Modals and sheets on native <dialog> (focus trap, Esc and top layer for free).
// Markup:  <button data-modal-open="my-dialog">  ·  <dialog id="my-dialog" class="modal">…<button data-modal-close>
// Code:    openModal('id'), closeModal('id'), await confirmDialog({ title, body, confirmLabel, danger })
import { on, h, escapeHtml, icon } from './core.js';

let lastTrigger = null;

export function openModal(idOrEl, trigger) {
  const dlg = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
  if (!dlg || dlg.open) return dlg;
  lastTrigger = trigger || document.activeElement;
  dlg.showModal();
  dlg.dispatchEvent(new CustomEvent('modal:open'));
  return dlg;
}

export function closeModal(idOrEl, returnValue) {
  const dlg = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
  if (dlg?.open) dlg.close(returnValue);
}

export function initModals() {
  on(document, 'click', '[data-modal-open]', (e, el) => {
    e.preventDefault();
    openModal(el.dataset.modalOpen, el);
  });
  on(document, 'click', '[data-modal-close]', (e, el) => {
    closeModal(el.closest('dialog'), el.value || '');
  });
  // Click on the backdrop (the dialog element itself, outside its content box) closes it.
  document.addEventListener('click', e => {
    const dlg = e.target;
    if (!(dlg instanceof HTMLDialogElement) || !dlg.open || dlg.dataset.static !== undefined) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dlg.close('');
  });
  document.addEventListener('close', e => {
    if (e.target instanceof HTMLDialogElement && lastTrigger?.isConnected) lastTrigger.focus({ preventScroll: true });
  }, true);
}

// Promise-based single-field prompt (e.g. rename). Resolves the trimmed value, or null if cancelled.
export function promptDialog({ title, label = title, value = '', confirmLabel = 'Save', maxLength = 80 } = {}) {
  return new Promise(resolve => {
    const dlg = h(`
      <dialog class="modal max-w-md" aria-labelledby="pd-title">
        <form method="dialog">
          <div class="modal-header"><h2 id="pd-title" class="text-base font-semibold">${escapeHtml(title)}</h2></div>
          <div class="modal-body">
            <label class="sr-only" for="pd-input">${escapeHtml(label)}</label>
            <input id="pd-input" class="input" maxlength="${maxLength}" value="${escapeHtml(value)}" autocomplete="off">
          </div>
          <div class="modal-footer">
            <button value="cancel" class="btn btn-secondary">Cancel</button>
            <button value="ok" class="btn btn-primary">${escapeHtml(confirmLabel)}</button>
          </div>
        </form>
      </dialog>`);
    document.body.append(dlg);
    const input = dlg.querySelector('input');
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok' && input.value.trim() ? input.value.trim() : null);
      setTimeout(() => dlg.remove(), 300);
    }, { once: true });
    openModal(dlg);
    input.select();
  });
}

// Promise-based confirmation. Resolves true/false — or, with `checkbox: { label, items?, checked }`, { ok, checked }.
export function confirmDialog({ title, body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, checkbox = null } = {}) {
  return new Promise(resolve => {
    const dlg = h(`
      <dialog class="modal max-w-md" aria-labelledby="cfm-title">
        <form method="dialog">
          <div class="modal-header">
            <div class="flex gap-3">
              <span class="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full ${danger ? 'bg-bad-soft text-bad' : 'bg-accent-soft text-accent-text'}">
                ${icon(danger ? 'triangle-alert' : 'circle-help', 'size-[18px]')}
              </span>
              <div>
                <h2 id="cfm-title" class="text-base font-semibold">${escapeHtml(title)}</h2>
                ${body ? `<p class="mt-1 text-sm text-ink-2">${escapeHtml(body)}</p>` : ''}
              </div>
            </div>
          </div>
          ${checkbox ? `<div class="modal-body"><label class="flex items-start gap-2.5 rounded-xl border border-line bg-surface-2/50 p-3 text-sm">
            <input type="checkbox" class="check mt-0.5" data-confirm-check ${checkbox.checked ? 'checked' : ''}>
            <span><span class="font-medium">${escapeHtml(checkbox.label)}</span>${checkbox.items?.length ? `<ul class="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-ink-2">${checkbox.items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}</span>
          </label></div>` : ''}
          <div class="modal-footer">
            <button value="cancel" class="btn btn-secondary">${escapeHtml(cancelLabel)}</button>
            <button value="ok" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" autofocus>${escapeHtml(confirmLabel)}</button>
          </div>
        </form>
      </dialog>`);
    document.body.append(dlg);
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      resolve(checkbox ? { ok, checked: !!dlg.querySelector('[data-confirm-check]')?.checked } : ok);
      setTimeout(() => dlg.remove(), 300);
    }, { once: true });
    openModal(dlg);
  });
}
