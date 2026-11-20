// Admin → Models (Phase 25, decision #203): the fallback chain as rows, the background model, and the Pictures card.
//  - A fallback is added by typing its id and pressing Test and add: the row appears at once in "Asking it a tiny
//    question…", then says how fast it answered, or why it didn't. Rows move up and down (the order is the order they
//    answer in), test again, or go. At most data-max rows. The hidden `fallbacks` field always holds the rows in order.
//  - The background model has the same Test and the same states.
//  - Save (model-test.js) waits while a test runs and refuses a model that didn't answer (model:before-save), and marks
//    every row saved once the server has them (model:saved). The server tests each new one again on save.
//  - Pictures: Save checks the id on the provider's image model list and shows the price, how it was worked out, and any
//    warning; the card says on or off.
// Server contract: POST /admin/model/test { model } → { ok, ms, cost, error, model } · POST /api/v1/admin/images { model } →
//   { settings: { model }, price: { label, source } | null, warning }.
import { $, $$, on, api, withBusy } from './core.js';
import { toast } from './toast.js';
import { showErrors, clearErrors } from './forms.js';

const MODEL_ID = /^[\w.-]+\/[\w.:-]+$|^[\w.:-]+$/;
const seconds = ms => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)} s`;
const PRICE_SOURCE = { list: 'From the model’s published price.', history: 'From what its pictures cost here lately.', fallback: 'A careful guess: no price is published for it.' };

async function testModel(model) {
  try {
    return await api('/admin/model/test', { method: 'POST', body: { model } });
  } catch (err) {
    return { ok: false, error: err.data?.errors ? Object.values(err.data.errors).join(' ') : err.message };
  }
}

function initFallbacks(form) {
  const box = $('[data-fallbacks]', form);
  if (!box) return;
  const list = $('[data-fb-list]', box), input = $('[data-fb-input]', box), addBtn = $('[data-fb-add-btn]', box);
  const value = $('[data-fb-value]', box), addError = $('[data-fb-add-error]', box), tpl = $('[data-fb-template]', box);
  const max = Number(box.dataset.max) || 3;
  const rows = () => $$('[data-fb-row]', list);
  const main = () => ($('#f-model', form)?.value || '').trim();

  const sync = () => {
    value.value = rows().map(r => r.dataset.model).join(', ');
    const n = rows().length;
    $('[data-fb-count]', box).textContent = `${n} of ${max}`;
    $('[data-fb-add]', box).toggleAttribute('data-full', n >= max);
    rows().forEach((r, i, all) => {
      $('[data-fb-move="up"]', r).disabled = i === 0;
      $('[data-fb-move="down"]', r).disabled = i === all.length - 1;
    });
  };
  const sayAdd = msg => { addError.textContent = msg || ''; addError.hidden = !msg; input.toggleAttribute('aria-invalid', !!msg); };

  const runTest = async row => {
    const model = row.dataset.model;
    row.dataset.state = 'testing';
    const r = await testModel(model);
    if (!row.isConnected || row.dataset.model !== model) return;
    row.dataset.state = r.ok ? 'ok' : 'failed';
    if (r.ok) $('[data-fb-ms]', row).textContent = seconds(r.ms);
    else $('[data-fb-error]', row).textContent = `Didn’t answer: ${r.error || 'no reason given'}`;
  };

  const add = async () => {
    const model = input.value.trim();
    sayAdd('');
    if (!model) return sayAdd('Type a model id first, like anthropic/claude-sonnet.');
    if (!MODEL_ID.test(model)) return sayAdd('That doesn’t look like a model id. Use one like anthropic/claude-sonnet.');
    if (model === main()) return sayAdd('That’s the main model already: pick a different one to fall back to.');
    if (rows().some(r => r.dataset.model === model)) return sayAdd('That one is in the list already.');
    if (rows().length >= max) return sayAdd(`At most ${max} fallback models: remove one first.`);
    const row = tpl.content.firstElementChild.cloneNode(true);
    row.dataset.model = model;
    const name = $('[data-fb-model]', row);
    name.textContent = model;
    name.title = model;
    const labels = { '[data-fb-move="up"]': `Move ${model} earlier`, '[data-fb-move="down"]': `Move ${model} later`,
      '[data-fb-test]': `Test ${model} again`, '[data-fb-remove]': `Remove ${model}` };
    for (const [sel, label] of Object.entries(labels)) $(sel, row).setAttribute('aria-label', label);
    list.append(row);
    input.value = '';
    sync();
    await withBusy(addBtn, () => runTest(row), 'Testing…');
    input.focus();
  };

  addBtn.addEventListener('click', add);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  input.addEventListener('input', () => sayAdd(''));
  on(list, 'click', '[data-fb-test]', (e, b) => runTest(b.closest('[data-fb-row]')));
  on(list, 'click', '[data-fb-remove]', (e, b) => {
    const row = b.closest('[data-fb-row]');
    row.animate?.([{ opacity: 1 }, { opacity: 0, transform: 'translateX(8px)' }], { duration: 160 }).finished.then(() => { row.remove(); sync(); });
    if (!row.animate) { row.remove(); sync(); }
  });
  on(list, 'click', '[data-fb-move]', (e, b) => {
    const row = b.closest('[data-fb-row]');
    const up = b.dataset.fbMove === 'up';
    const other = up ? row.previousElementSibling : row.nextElementSibling;
    if (!other?.matches('[data-fb-row]')) return;
    up ? other.before(row) : other.after(row);
    row.classList.remove('just-moved'); void row.offsetWidth; row.classList.add('just-moved');
    b.focus();
    sync();
  });
  sync();
  return {
    // Save waits for tests and refuses a model that didn't answer; says which, beside the list.
    blocked() {
      const testing = rows().filter(r => r.dataset.state === 'testing');
      const failed = rows().filter(r => r.dataset.state === 'failed');
      if (testing.length) return `Wait a moment: ${testing[0].dataset.model} is still being tested.`;
      if (failed.length) return `${failed[0].dataset.model} didn’t answer. Test it again, or remove it, before saving.`;
      return null;
    },
    saved(llm) { for (const r of rows()) r.dataset.state = 'saved'; if (llm?.fallbacks != null) value.value = llm.fallbacks; },
  };
}

function initBackground(form) {
  const box = $('[data-bg]', form);
  if (!box) return null;
  const input = $('[data-bg-input]', box), btn = $('[data-bg-test]', box);
  const idle = () => { const v = input.value.trim(); box.dataset.state = !v ? 'empty' : v === box.dataset.saved ? 'saved' : 'changed'; };
  input.addEventListener('input', idle);
  btn.addEventListener('click', async () => {
    const model = input.value.trim();
    if (!model) { idle(); return input.focus(); }
    box.dataset.state = 'testing';
    const r = await withBusy(btn, () => testModel(model), 'Testing…');
    if (input.value.trim() !== model) return idle();
    box.dataset.state = r.ok ? 'ok' : 'failed';
    if (r.ok) $('[data-bg-ms]', box).textContent = seconds(r.ms);
    else $('[data-bg-error]', box).textContent = `Didn’t answer: ${r.error || 'no reason given'}`;
  });
  return {
    blocked: () => (box.dataset.state === 'testing' ? 'Wait a moment: the background model is still being tested.'
      : box.dataset.state === 'failed' ? 'The background model didn’t answer. Test it again, change it, or clear it, before saving.' : null),
    saved(llm) { box.dataset.saved = llm?.background ?? input.value.trim(); input.value = box.dataset.saved; idle(); },
  };
}

function initModelForm() {
  const form = $('form[data-model-test][action="/admin/model"]');
  if (!form || form.dataset.chainBound) return;
  form.dataset.chainBound = '1';
  const parts = [initFallbacks(form), initBackground(form)].filter(Boolean);
  form.addEventListener('model:before-save', e => {
    const why = parts.map(p => p.blocked()).find(Boolean);
    if (!why) return;
    e.preventDefault();
    toast.error(why, { title: 'Not saved yet' });
  });
  form.addEventListener('model:saved', e => {
    for (const p of parts) p.saved(e.detail?.llm);
    const main = $('[data-fb-main]', form);
    if (main && e.detail?.llm?.model) { main.textContent = e.detail.llm.model; main.title = e.detail.llm.model; }
  });
}

// ---- Pictures --------------------------------------------------------------------------------------------------------
function initImages() {
  const form = $('[data-images-form]');
  if (!form) return;
  const submit = $('[data-img-save]', form);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    clearErrors(form);
    const before = form.dataset.state;
    const model = form.elements.model.value.trim();
    form.dataset.state = 'checking';
    await withBusy(submit, async () => {
      try {
        const r = await api(form.getAttribute('action'), { method: 'POST', body: { model } });
        const on_ = !!r.settings?.model;
        form.dataset.state = on_ ? 'on' : 'off';
        const line = $('[data-img-line]', form);
        line.textContent = on_ ? r.settings.model : 'No image model chosen, so nobody can make pictures.';
        line.classList.toggle('font-mono', on_);
        const check = $('[data-img-check]', form);
        check.hidden = !on_;
        $('[data-img-price]', form).hidden = !r.price;
        if (r.price) {
          $('[data-img-price-label]', form).textContent = r.price.label;
          $('[data-img-price-source]', form).textContent = PRICE_SOURCE[r.price.source] || '';
        }
        $('[data-img-warning]', form).hidden = !r.warning;
        $('[data-img-warning-text]', form).textContent = r.warning || '';
        const at = $('[data-img-checked-at]', form);
        if (at) at.textContent = 'Checked just now';
        if (r.warning) toast(r.warning, { title: 'Saved, with a warning' });
        else toast.success(on_ ? `Pictures are on${r.price ? `: ${r.price.label}` : ''}.` : 'Pictures are off.');
      } catch (err) {
        form.dataset.state = before;
        if (err.data?.errors) showErrors(form, err.data.errors);
        else toast.error(err.message, { title: 'Couldn’t save the image model' });
      }
    }, model ? 'Checking the model…' : 'Saving…');
  });
}

export function initAdminModels() {
  initModelForm();
  initImages();
}
