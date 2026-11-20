// Progressive-enhancement forms: <form data-ajax action="/api/v1/…" method="post" [data-stay]
//   data-success="Saved" data-redirect="/next" data-reset>
// Sends JSON (or multipart when the form has files), shows a busy submit button, renders field errors
// from { errors: { field: "message" } }, then toasts / redirects / resets. Works without JS too.
import { $, $$, on, api, withBusy, ApiError } from './core.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';

function toBody(form) {
  const fd = new FormData(form);
  if ($('input[type="file"]', form)) return fd;
  const body = {};
  for (const [k, v] of fd) {
    if (k in body) body[k] = [].concat(body[k], v);
    else body[k] = v;
  }
  // Unchecked switches/checkboxes with data-bool are sent as false.
  for (const cb of $$('input[type="checkbox"][data-bool]', form)) body[cb.name] = cb.checked;
  return body;
}

// Field errors under their fields, from { errors: { field: message } } (also used by model-test.js).
export function clearErrors(form) {
  for (const el of $$('[aria-invalid="true"]', form)) el.removeAttribute('aria-invalid');
  for (const el of $$('[data-field-error]', form)) el.remove();
}

export function showErrors(form, errors) {
  let first;
  for (const [name, message] of Object.entries(errors)) {
    const field = form.elements[name];
    const el = field?.length && !field.tagName ? field[0] : field;
    if (!el) continue;
    el.setAttribute('aria-invalid', 'true');
    const p = document.createElement('p');
    p.className = 'field-error';
    p.dataset.fieldError = '';
    p.id = `${el.id || name}-error`;
    p.textContent = message;
    el.setAttribute('aria-describedby', p.id);
    (el.closest('[data-field]') || el).after(p);
    first ??= el;
  }
  first?.focus();
}

export function initForms() {
  on(document, 'submit', 'form[data-ajax]', async (e, form) => {
    e.preventDefault();
    // data-confirm="Question?" asks first (destructive actions).
    if (form.dataset.confirm && !(await confirmDialog({ title: form.dataset.confirm, confirmLabel: 'Yes, continue', danger: true }))) return;
    clearErrors(form);
    const submit = e.submitter || $('[type="submit"]', form);
    await withBusy(submit, async () => {
      try {
        // An empty/missing action means "this URL" — same as native HTML form submission.
        const res = await api(form.getAttribute('action') || form.dataset.url || location.pathname + location.search, {
          method: (form.getAttribute('method') || 'post').toUpperCase(),
          body: toBody(form),
        });
        form.dispatchEvent(new CustomEvent('ajax:success', { detail: res, bubbles: true }));
        if (form.dataset.success) toast.success(form.dataset.success);
        if (form.dataset.reset !== undefined) form.reset();
        // data-remove-closest="li": drop the owning row in place (e.g. revoke, delete).
        if (form.dataset.removeClosest) {
          const row = form.closest(form.dataset.removeClosest);
          row?.animate?.([{ opacity: 1 }, { opacity: 0, transform: 'translateX(8px)' }], { duration: 180 }).finished.then(() => row.remove());
        }
        // data-stay: update in place (the redirect is only for the no-JS path).
        const to = form.dataset.stay !== undefined ? null : (res?.redirect || form.dataset.redirect);
        if (to) location.assign(to);
      } catch (err) {
        if (err instanceof ApiError && err.data?.errors) showErrors(form, err.data.errors);
        else toast.error(err.message, { title: form.dataset.errorTitle || "Couldn't save" });
        form.dispatchEvent(new CustomEvent('ajax:error', { detail: err, bubbles: true }));
      }
    }, form.dataset.busy);
  });
}
