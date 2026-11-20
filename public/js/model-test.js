// Model connection form (setup wizard and Admin → Model): save the settings, run one tiny real call, show the result
// inline. <form data-model-test action="…"> with [data-test-button], [data-test-result]; optional [data-continue] is
// enabled once it connects (setup), [data-key-field] / [data-show-key-field] swap in a new key.
// Admin → Models (Phase 25 #203): a cancelable `model:before-save` on the form lets admin-models.js hold the save (a fallback
// still testing, or one that didn't answer); field errors (422: fallbacks, background…) show under their fields; a save
// that went through fires `model:saved` with the answer.
import { $, on, api, withBusy, escapeHtml, icon } from './core.js';
import { toast } from './toast.js';
import { showErrors, clearErrors } from './forms.js';

export function initModelTest() {
  const form = $('[data-model-test]');
  if (!form || form.dataset.bound) return; // setup pages load both main.js and setup.js
  form.dataset.bound = '1';
  const result = $('[data-test-result]', form);
  const cont = $('[data-continue]');
  on(document, 'click', '[data-show-key-field]', (e, b) => { $('[data-key-field]').classList.remove('hidden'); b.remove(); $('#f-apiKey')?.focus(); });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!form.dispatchEvent(new CustomEvent('model:before-save', { cancelable: true }))) return;
    clearErrors(form);
    const body = Object.fromEntries(new FormData(form));
    await withBusy($('[data-test-button]', form), async () => {
      result.innerHTML = '';
      try {
        const r = await api(form.getAttribute('action'), { method: 'POST', body });
        if (r.ok) {
          result.innerHTML = `<div class="mt-3 rounded-xl border border-ok/30 bg-ok-soft px-4 py-3 text-sm animate-rise">
            <p class="flex items-center gap-2 font-semibold text-ok">${icon('circle-check')} Connected in ${(r.ms / 1000).toFixed(1)}s</p>
            <p class="mt-1 text-ink-2">${escapeHtml(r.model)} replied “${escapeHtml(r.reply)}”${r.cost != null ? ` · cost $${Number(r.cost).toFixed(5)}` : ''}</p></div>`;
          if (r.llm?.maskedKey) { const k = $('[data-masked-key]'); if (k) k.textContent = r.llm.maskedKey; }
          const key = $('#f-apiKey', form);
          if (key) key.value = '';
          if (cont) { cont.disabled = false; cont.focus(); }
        } else {
          result.innerHTML = `<div class="mt-3 rounded-xl border border-bad/30 bg-bad-soft px-4 py-3 text-sm animate-rise" role="alert">
            <p class="flex items-center gap-2 font-semibold text-bad">${icon('circle-x')} Couldn't connect</p>
            <p class="mt-1 text-ink-2">${escapeHtml(r.error || 'Unknown error')}</p></div>`;
        }
        // Saved either way (the test is of the connection): the page shows what is saved now.
        if (r.llm) form.dispatchEvent(new CustomEvent('model:saved', { detail: r }));
      } catch (err) {
        const fields = err.data?.errors;
        if (fields) {
          showErrors(form, fields);
          toast.error('Nothing new was saved for the fields marked below.', { title: 'Check the settings' });
        } else toast.error(err.message, { title: 'Test failed' });
      }
    }, 'Talking to the model…');
  });
}
