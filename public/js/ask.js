// Question dock (ask_user). Enhances server-rendered [data-ask-dock] forms:
// stepping, 1-9 / Enter / Esc keys, validation, preview pane, draft persistence (survives refresh),
// minimize ↔ pill, and submit with feedback. History cards re-open the dock via [data-ask-open].
import { $, $$, on, api, withBusy, storage, h } from './core.js';
import { toast } from './toast.js';
import { announce } from './shell.js';

const docks = new Map(); // id → controller

function controller(dock) {
  const id = dock.dataset.askDock;
  const form = $('[data-ask-form]', dock);
  const steps = $$('.ask-step', dock);
  const chips = $$('[data-ask-goto]', dock);
  const pill = document.querySelector(`[data-ask-pill="${id}"]`);
  const nextBtn = $('[data-ask-next]', dock);
  const nextLabel = $('[data-ask-next-label]', dock);
  const backBtn = $('[data-ask-back]', dock);
  const progress = $('[data-ask-progress]', dock);
  const draftKey = `jb-ask-draft:${id}`;
  let index = 0;

  const kindOf = step => step.dataset.kind;
  const isLast = () => index === steps.length - 1;

  function show(i, { focus = true } = {}) {
    index = Math.max(0, Math.min(i, steps.length - 1));
    steps.forEach((s, n) => { s.hidden = n !== index; });
    chips.forEach((c, n) => {
      if (n === index) c.setAttribute('aria-current', 'step'); else c.removeAttribute('aria-current');
      c.classList.toggle('is-done', n !== index && answered(steps[n]));
    });
    backBtn.hidden = index === 0;
    nextLabel.textContent = isLast() ? (steps.length > 1 ? 'Send answers' : 'Send answer') : 'Next';
    if (progress) progress.textContent = `${index + 1} / ${steps.length}`;
    if (focus) focusStep();
    saveDraft();
  }

  function focusStep() {
    const step = steps[index];
    const target = $('.ask-input:checked', step) || $('.ask-input', step) || $('input, textarea', step);
    target?.focus({ preventScroll: true });
  }

  function valueOf(step) {
    const qid = step.dataset.qid;
    const kind = kindOf(step);
    if (kind === 'text' || kind === 'longtext') return { questionId: qid, value: form.elements[qid].value.trim() };
    const checked = $$(`.ask-input:checked`, step).map(i => i.value);
    const other = $('[data-ask-other]', step)?.value.trim() || '';
    const value = kind === 'multi' ? checked : (checked[0] ?? '');
    return { questionId: qid, value, ...(checked.includes('__other__') ? { other } : {}) };
  }

  function answered(step) {
    const v = valueOf(step);
    if (Array.isArray(v.value)) return v.value.length > 0 && (!v.value.includes('__other__') || v.other);
    return v.value !== '' && (v.value !== '__other__' || !!v.other);
  }

  function validate(step) {
    const err = $('[data-ask-error]', step);
    const ok = answered(step);
    const v = valueOf(step);
    err.hidden = ok;
    if (!ok) {
      err.textContent = (v.value === '__other__' || v.value?.includes?.('__other__')) ? 'Type your own answer, or pick an option.'
        : kindOf(step) === 'multi' ? 'Pick at least one.' : kindOf(step).includes('text') ? 'Type an answer to continue.' : 'Pick an option to continue.';
      focusStep();
    }
    return ok;
  }

  // ---- Draft persistence (refresh keeps partial answers) ----
  function saveDraft() {
    storage.set(draftKey, { step: index, answers: steps.map(valueOf) });
  }
  function restoreDraft() {
    const draft = storage.get(draftKey);
    if (!draft) return;
    for (const a of draft.answers || []) {
      const step = steps.find(s => s.dataset.qid === a.questionId);
      if (!step) continue;
      const kind = kindOf(step);
      if (kind === 'text' || kind === 'longtext') { form.elements[a.questionId].value = a.value || ''; continue; }
      const values = [].concat(a.value || []);
      $$('.ask-input', step).forEach(i => { i.checked = values.includes(i.value); });
      const other = $('[data-ask-other]', step);
      if (other && a.other) other.value = a.other;
    }
    show(draft.step || 0, { focus: false });
  }

  // ---- Minimize ----
  function minimize() {
    dock.hidden = true;
    if (pill) pill.hidden = false;
    storage.set(`jb-ask-min:${id}`, true);
    pill?.focus();
  }
  function restore() {
    dock.hidden = false;
    if (pill) pill.hidden = true;
    storage.remove(`jb-ask-min:${id}`);
    dock.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    focusStep();
  }

  // ---- Submit ----
  async function submit() {
    const bad = steps.find(s => !answered(s));
    if (bad) { show(steps.indexOf(bad)); validate(bad); return; }
    const answers = steps.map(valueOf);
    await withBusy(nextBtn, async () => {
      try {
        const res = await api(dock.dataset.answerUrl, { method: 'POST', body: { answers } });
        storage.remove(draftKey);
        storage.remove(`jb-ask-min:${id}`);
        const card = document.querySelector(`[data-question-card="${id}"]`);
        if (card && res?.cardHtml) card.replaceWith(h(res.cardHtml));
        dock.style.animation = 'toast-out .2s ease-in forwards';
        setTimeout(() => { dock.remove(); pill?.remove(); }, 200);
        docks.delete(id);
        announce('Answers sent.');
        document.dispatchEvent(new CustomEvent('ask:answered', { detail: { id, answers, response: res } }));
      } catch (err) {
        toast.error(err.message, { title: "Couldn't send your answers", action: { label: 'Retry', onClick: submit } });
      }
    }, 'Sending…');
  }

  // ---- Events ----
  form.addEventListener('submit', e => {
    e.preventDefault();
    if (!validate(steps[index])) return;
    if (isLast()) submit(); else show(index + 1);
  });
  backBtn.addEventListener('click', () => show(index - 1));
  chips.forEach((c, n) => c.addEventListener('click', () => show(n)));
  $('[data-ask-minimize]', dock).addEventListener('click', minimize);
  pill?.addEventListener('click', restore);

  form.addEventListener('change', e => {
    const step = e.target.closest('.ask-step');
    if (!step) return;
    $('[data-ask-error]', step).hidden = true;
    if (e.target.value === '__other__' && e.target.checked) $('[data-ask-other]', step)?.focus();
    saveDraft();
    // Single choice (not "Other"): advance automatically, like picking in a menu.
    if (['single', 'yesno'].includes(kindOf(step)) && e.target.classList.contains('ask-input') && e.target.value !== '__other__' && !isLast()) {
      setTimeout(() => show(index + 1), 220);
    }
  });
  form.addEventListener('input', e => {
    if (e.target.matches('[data-ask-other]')) {
      const radio = e.target.closest('.ask-option').querySelector('.ask-input');
      if (e.target.value && !radio.checked) radio.checked = true;
    }
    saveDraft();
  });

  // Preview pane follows hover / focus / selection.
  const preview = el => {
    const pane = $('[data-ask-preview]', el.closest('.ask-step'));
    if (pane && el.dataset.preview) pane.textContent = el.dataset.preview;
  };
  on(dock, 'pointerover', '.ask-option[data-preview]', (e, el) => preview(el));
  on(dock, 'focusin', '.ask-option[data-preview]', (e, el) => preview(el));

  dock.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); minimize(); return; }
    const inText = e.target.matches('input[type="text"], textarea');
    if (e.target.matches('textarea') && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); return; }
    if (inText) return;
    if (/^[1-9]$/.test(e.key)) {
      const option = $$('.ask-option', steps[index])[Number(e.key) - 1];
      const input = option?.querySelector('.ask-input');
      if (!input) return;
      e.preventDefault();
      input.checked = input.type === 'checkbox' ? !input.checked : true;
      input.focus();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  restoreDraft();
  if (storage.get(`jb-ask-min:${id}`)) { dock.hidden = true; if (pill) pill.hidden = false; }
  return { restore, minimize };
}

// Enhance a dock (page-rendered, or inserted live when Jess asks something mid-conversation).
export function mountDock(dock) {
  if (docks.has(dock.dataset.askDock)) return docks.get(dock.dataset.askDock);
  const c = controller(dock);
  docks.set(dock.dataset.askDock, c);
  return c;
}

export function initAsk() {
  for (const dock of $$('[data-ask-dock]')) mountDock(dock);
  on(document, 'click', '[data-ask-open]', (e, el) => docks.get(el.dataset.askOpen)?.restore());
}
