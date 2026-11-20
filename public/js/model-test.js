// Model connection form (setup wizard and Admin → Model): save the settings, run one tiny real call, show the result
// inline. <form data-model-test action="…"> with [data-test-button], [data-test-result]; optional [data-continue] is
// enabled once it connects (setup), [data-key-field] / [data-show-key-field] swap in a new key.
// Admin → Models (Phase 25 #203): a cancelable `model:before-save` on the form lets admin-models.js hold the save (a fallback
// still testing, or one that didn't answer); field errors (422: fallbacks, background…) show under their fields; a save
// that went through fires `model:saved` with the answer.
import { $, $$, on, api, withBusy, escapeHtml, icon } from './core.js';
import { toast } from './toast.js';
import { showErrors, clearErrors } from './forms.js';
import { t } from './i18n.js';

// The provider picker (#11, partials/setup/provider-fields.hbs): the chosen provider's fields and feature list show, its
// usual address fills in (unless someone typed another), and with Ollama the installed models fill the model list.
const OPENROUTER_MODEL = 'openai/gpt-6-luna';
function initProviderPicker(form) {
  if (!$('[data-provider-picker]', form)) return;
  const url = $('[data-base-url-input]', form), model = $('#f-model', form), list = $('[data-model-list]', form);
  const status = $('[data-ollama-status]', form);
  const statusHtml = status?.innerHTML;
  const radios = $$('input[name="provider"]', form);
  const defaults = Object.fromEntries(radios.map(r => [r.value, r.dataset.baseUrl || '']));
  const base = form.getAttribute('action').replace(/\/test$/, ''); // /setup/model or /admin/model
  let asked = 0;

  async function loadOllama(fillModel) {
    const n = ++asked;
    if (status) status.textContent = 'Looking for Ollama’s models…';
    let r;
    try { r = await api(`${base}/ollama?baseUrl=${encodeURIComponent(url.value.trim())}`); } catch (err) { r = { models: [], error: err.message }; }
    if (n !== asked) return; // a newer address or provider won
    list.replaceChildren(...r.models.map(m => new Option(m, m)));
    if (fillModel && r.models.length && !r.models.includes(model.value.trim())) model.value = r.models[0];
    if (!status) return;
    if (r.error) status.textContent = r.error;
    else if (!r.models.length) status.textContent = 'Ollama has no chat models yet. Pull one that can call tools, for example: ollama pull qwen2.5:7b';
    else status.textContent = `Installed: ${r.models.join(', ')}. Pick one that can call tools, 7B or larger, and start Ollama with OLLAMA_CONTEXT_LENGTH=32768.`;
  }

  function show(id, picked) {
    for (const el of $$('[data-provider-show]', form)) el.hidden = !el.dataset.providerShow.split(' ').includes(id);
    for (const el of $$('[data-provider-features]', form)) el.hidden = el.dataset.providerFeatures !== id;
    $('[data-key-block]', form).hidden = id === 'ollama';
    if (picked) {
      if (!url.value.trim() || Object.values(defaults).includes(url.value.trim())) url.value = defaults[id] || '';
      if (id === 'openrouter' && !model.value.trim()) model.value = OPENROUTER_MODEL;
      if (id !== 'openrouter' && model.value.trim() === OPENROUTER_MODEL) model.value = '';
    }
    list.replaceChildren();
    if (status && id === 'ollama' && statusHtml) status.innerHTML = statusHtml;
    if (id === 'ollama') loadOllama(picked);
  }

  form.addEventListener('change', e => { if (e.target.name === 'provider') show(e.target.value, true); });
  let t;
  url.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { if ($('input[name="provider"]:checked', form)?.value === 'ollama') loadOllama(false); }, 500);
  });
  const current = $('input[name="provider"]:checked', form)?.value;
  if (current) show(current, false);
}

// Ollama's context window against Jessbot's prompt (#69): a too-small one connects fine and then cuts every real prompt, so
// the test says so beside "Connected", with what to set on the server (the server writes the sentence).
function contextNote(c) {
  if (!c?.warning) return '';
  const bad = c.fits === false;
  const title = bad ? t('The context window is too small') : t('Check the context window');
  return `<div class="mt-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm animate-rise" ${bad ? 'role="alert"' : ''} data-context-warning>
    <p class="flex items-center gap-2 font-semibold text-warn-text">${icon('triangle-alert')} ${escapeHtml(title)}</p>
    <p class="mt-1 text-ink-2">${escapeHtml(c.warning)}</p></div>`;
}

export function initModelTest() {
  const form = $('[data-model-test]');
  if (!form || form.dataset.bound) return; // setup pages load both main.js and setup.js
  form.dataset.bound = '1';
  initProviderPicker(form);
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
            <p class="mt-1 text-ink-2">${escapeHtml(r.model)} replied “${escapeHtml(r.reply)}”${r.cost != null ? ` · cost $${Number(r.cost).toFixed(5)}` : ''}</p></div>`
            + contextNote(r.context);
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
