// You → Memory (Phase 25, decision #204): "How I work with you" (their lessons) and the weekly tidy's changes.
//  - Lessons: Keep / No on one she noted, Edit in place, Retire (kept below, "Use again" brings it back), Delete (asks
//    first). The row dims and its button works while the server decides; then the section is re-rendered from the server
//    (one source of markup) and the row flashes; a failure leaves it as it was and says why, with Try again.
//  - Tidy: Undo on one change. The row works, then the tidy card re-renders (the change now says Undone) and the memory list
//    above refreshes (the memories came back). A change that can't be undone says why on its row. /me/memory?tidy=<id>
//    (the Activity item) opens the card and scrolls to it.
// Server contract: GET /api/v1/me/lessons?fragment=1 → { lessons, html } · PATCH /api/v1/me/lessons/:id { rule, why, status } ·
//   POST …/:id/keep · DELETE …/:id (?reject=1 for "No") · POST /api/v1/me/memory-tidies/changes/:id/undo ·
//   GET /api/v1/me/memory-tidies/:id?fragment=1 → { tidy, html }.
import { $, on, api, withBusy } from './core.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';
import { showErrors, clearErrors } from './forms.js';

const url = id => `/api/v1/me/lessons/${encodeURIComponent(id)}`;
const DONE = { keep: 'Kept. I’ll work that way from now on.', reject: 'Dropped. I won’t guess that again.', retire: 'Retired. I’ve stopped using it.',
  restore: 'Back in use.', delete: 'Deleted.', edit: 'Saved.' };

function initLessons() {
  const slot = $('[data-lessons-slot]');
  if (!slot) return;
  const refresh = async id => {
    const r = await api('/api/v1/me/lessons?fragment=1');
    slot.innerHTML = r.html;
    if (id) slot.querySelector(`[data-my-lesson="${CSS.escape(String(id))}"]`)?.classList.add('just-changed');
  };
  const run = async (row, action, btn, body) => {
    if (row.hasAttribute('data-pending')) return;
    if (action === 'delete' && !(await confirmDialog({ title: 'Delete this rule?', body: row.querySelector('[dir="auto"]')?.textContent.trim() || '',
      confirmLabel: 'Delete', danger: true }))) return;
    row.setAttribute('data-pending', '');
    const id = row.dataset.myLesson;
    await withBusy(btn, async () => {
      try {
        if (action === 'keep') await api(`${url(id)}/keep`, { method: 'POST' });
        else if (action === 'reject') await api(`${url(id)}?reject=1`, { method: 'DELETE' });
        else if (action === 'delete') await api(url(id), { method: 'DELETE' });
        else if (action === 'retire' || action === 'restore') await api(url(id), { method: 'PATCH', body: { status: action === 'retire' ? 'retired' : 'active' } });
        else await api(url(id), { method: 'PATCH', body });
        await refresh(['delete', 'reject'].includes(action) ? null : id);
        toast.success(DONE[action]);
      } catch (err) {
        row.removeAttribute('data-pending');
        const form = row.querySelector('[data-my-lesson-form]');
        if (err.data?.errors && form && !form.hidden) showErrors(form, err.data.errors);
        else toast.error(err.message, { title: 'That didn’t go through', action: { label: 'Try again', onClick: () => btn.click() } });
      }
    });
  };
  on(slot, 'click', '[data-my-lesson-action]', (e, btn) => run(btn.closest('[data-my-lesson]'), btn.dataset.myLessonAction, btn));
  on(slot, 'click', '[data-my-lesson-edit]', (e, btn) => {
    const form = btn.closest('[data-my-lesson]').querySelector('[data-my-lesson-form]');
    form.hidden = false;
    form.elements.rule.focus();
  });
  on(slot, 'click', '[data-my-lesson-cancel]', (e, btn) => {
    const form = btn.closest('[data-my-lesson-form]');
    form.reset();
    clearErrors(form);
    form.hidden = true;
  });
  on(slot, 'submit', '[data-my-lesson-form]', (e, form) => {
    e.preventDefault();
    clearErrors(form);
    run(form.closest('[data-my-lesson]'), 'edit', e.submitter || form.querySelector('[type="submit"]'),
      { rule: form.elements.rule.value, why: form.elements.why.value });
  });
}

function initTidy() {
  const slot = $('[data-tidy-slot]');
  if (!slot) return;
  const card = () => $('[data-tidy]', slot);
  if (card()?.open && new URLSearchParams(location.search).has('tidy')) requestAnimationFrame(() => card().scrollIntoView({ block: 'start' }));
  on(slot, 'click', '[data-tidy-undo]', async (e, btn) => {
    const row = btn.closest('[data-tidy-change]');
    if (row.hasAttribute('data-pending')) return;
    const err = $('[data-tidy-error]', row);
    err.hidden = true;
    row.setAttribute('data-pending', '');
    await withBusy(btn, async () => {
      try {
        await api(`/api/v1/me/memory-tidies/changes/${encodeURIComponent(row.dataset.tidyChange)}/undo`, { method: 'POST' });
        try {
          const r = await api(`/api/v1/me/memory-tidies/${encodeURIComponent(card().dataset.tidy)}?fragment=1`);
          slot.innerHTML = r.html;
          slot.querySelector(`[data-tidy-change="${CSS.escape(row.dataset.tidyChange)}"]`)?.classList.add('just-changed');
        } catch { // undone all the same: say so on the row until the next visit redraws it
          row.dataset.undone = 'true';
          row.removeAttribute('data-pending');
          btn.hidden = true;
        }
        document.dispatchEvent(new CustomEvent('jb:memory-refresh')); // the list above re-renders (memory.js)
        toast.success('Undone. Those memories are back as they were.');
      } catch (e2) {
        row.removeAttribute('data-pending');
        err.textContent = e2.data?.errors ? Object.values(e2.data.errors).join(' ') : e2.message;
        err.hidden = false;
      }
    }, 'Undoing…');
  });
}

export function initMeLessons() {
  initLessons();
  initTidy();
}
