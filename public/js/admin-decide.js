// Admin → Models → Quick decisions (docs/JEV.md): save the switches and confidence bar, try a decision live, and keep
// the recent decisions list fresh while the page is open. Server contract: routes/api/v1/decide.js.
import { $, $$, on, api, withBusy, escapeHtml, icon } from './core.js';
import { toast } from './toast.js';

export function initAdminDecide() {
  const form = $('[data-decide-form]');
  if (!form) return;
  const list = $('[data-dec-list]');

  form.addEventListener('submit', e => {
    e.preventDefault();
    const uses = Object.fromEntries($$('input[name^="use:"]', form).map(cb => [cb.name.slice(4), cb.checked]));
    const body = { model: form.elements.model.value, textModel: form.elements.textModel.value, confidence: form.elements.confidence.value, uses };
    withBusy($('[data-decide-save]', form), async () => {
      try {
        const r = await api(form.getAttribute('action'), { method: 'POST', body });
        const on = Object.values(r.settings.uses).filter(Boolean).length;
        const tile = $('[data-tile-decide]');
        if (tile) tile.textContent = `${r.settings.model} · ${on} of ${Object.keys(r.settings.uses).length} on`;
        toast.success(`Saved. ${on} quick decision${on === 1 ? '' : 's'} on, acting at ${Math.round(r.settings.confidence * 100)}% sure.`);
      } catch (err) { toast.error(err.message, { title: 'Not saved' }); }
    }, 'Saving…');
  });

  // ---- Try a decision --------------------------------------------------------------------------------------------
  const tryForm = $('[data-decide-try]');
  const result = $('[data-dt-result]', tryForm);
  const syncKind = () => {
    const kind = tryForm.elements.kind.value;
    $('[data-dt-options]', tryForm).hidden = kind === 'noul';
    tryForm.elements.options.placeholder = kind === 'score' ? 'Not urgent\nSomewhat\nVery urgent' : 'Handle it today\nThis week\nJust FYI';
  };
  on(tryForm, 'change', 'input[name="kind"]', syncKind);
  syncKind();
  tryForm.addEventListener('submit', e => {
    e.preventDefault();
    for (const el of $$('[aria-invalid]', tryForm)) el.removeAttribute('aria-invalid');
    const body = Object.fromEntries(new FormData(tryForm));
    withBusy($('[data-dt-run]', tryForm), async () => {
      result.innerHTML = `<div class="dt-result"><span class="md-skel w-3/5"></span><span class="md-skel mt-2 w-full"></span><span class="md-skel mt-2 w-4/5"></span></div>`;
      try {
        const r = await api('/api/v1/admin/decide/try', { method: 'POST', body });
        result.innerHTML = `<div class="dt-result animate-rise">
          <p class="text-sm"><span class="text-ink-3">Answer:</span> <strong>${escapeHtml(r.summary)}</strong></p>
          <div class="mt-2 space-y-2">${r.bars.map(b => `<div class="dt-bar ${b.top ? 'is-top' : ''}"><span class="truncate">${escapeHtml(String(b.label))}</span>
            <span class="text-right tabular">${Math.round(b.p * 100)}%</span><span class="dt-bar-track"><span style="width:${Math.round(b.p * 100)}%"></span></span></div>`).join('')}</div>
          <p class="mt-2 text-[11px] text-ink-3">${r.confidence != null ? `${Math.round(r.confidence * 100)}% confident · ` : ''}${r.ms} ms · $${Number(r.cost).toFixed(6)}</p></div>`;
        refresh();
      } catch (err) {
        result.innerHTML = '';
        const fields = err.data?.errors;
        if (fields) for (const n of Object.keys(fields)) tryForm.elements[n]?.setAttribute('aria-invalid', 'true');
        toast.error(fields ? Object.values(fields).join(' ') : err.message, { title: 'No decision' });
      }
    }, 'Deciding…');
  });

  // ---- Recent decisions ---------------------------------------------------------------------------------------------
  let busy = false;
  async function refresh(btn = null) {
    if (busy) return;
    busy = true;
    btn?.setAttribute('aria-busy', 'true');
    try { const r = await api('/api/v1/admin/decide/recent'); list.innerHTML = r.html; }
    catch (err) { if (btn) toast.error(err.message, { title: 'Couldn’t refresh' }); }
    finally { busy = false; btn?.removeAttribute('aria-busy'); }
  }
  on(document, 'click', '[data-dec-refresh]', (e, btn) => refresh(btn));
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 20_000);
}
