// Admin → Personality: live character count, a guard against leaving with unsaved edits, and a fresh history
// list after each save.
import { $ } from './core.js';

const form = $('[data-personality-form]');
if (form) {
  const ta = $('textarea', form), count = $('[data-char-count]', form);
  let saved = ta.value;
  const update = () => { count.textContent = `${ta.value.length.toLocaleString()} / ${Number(count.dataset.max).toLocaleString()}${ta.value !== saved ? ' · unsaved' : ''}`; };
  ta.addEventListener('input', update);
  update();
  addEventListener('beforeunload', e => { if (ta.value !== saved) e.preventDefault(); });
  form.addEventListener('ajax:success', e => {
    saved = ta.value;
    update();
    if (e.detail?.changed) setTimeout(() => location.reload(), 700); // show the new version in History
  });
}
