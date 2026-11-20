// Admin → Personality → Lessons (Phase 25, decision #203): the owner reviews household lessons in place.
//  - Approve / Turn down / Retire / Use again / Promote: the card dims and its button works while the server decides, then
//    the server's re-rendered card takes its place (it flashes once) and the counts follow; a failure leaves the card as it
//    was and says why, with Try again. Promote asks first (it edits AGENTS.md; History can undo it).
//  - Edit opens the card's form (Save, or Save and approve on a proposal); errors show under the fields.
//  - Write a lesson: the form above the list; the new card appears at the top.
//  - Filters (All, Waiting, In use, …) show and hide cards in place; ?status= picks the first one.
// Server contract (admin-lessons.js), each with ?fragment=1 → { ok, lesson, waiting, html }: POST /admin/lessons { rule, why,
//   domain } · PATCH /admin/lessons/:id { rule, why, domain } · POST /admin/lessons/:id/(approve|reject|retire|promote).
import { $, $$, on, api, withBusy, h, botName } from './core.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';
import { showErrors, clearErrors } from './forms.js';

const DONE = { approve: 'Approved. Everyone’s tasks use it from now on.', reject: 'Turned down. I won’t suggest it again.', retire: 'Retired. It’s no longer used.',
  promote: 'Moved into AGENTS.md. You can undo it from the Operating rules history.', edit: 'Saved.', create: 'Saved. It’s in use now.' };
const STATUSES = ['proposed', 'active', 'promoted', 'retired', 'rejected'];

export function initAdminLessons() {
  const page = $('[data-lessons-page]');
  if (!page) return;
  const list = $('[data-lesson-list]', page);
  let filter = page.dataset.filter || 'all';

  const apply = () => {
    let shown = 0;
    for (const card of $$('[data-lesson]', list)) {
      card.hidden = filter !== 'all' && card.dataset.status !== filter;
      shown += !card.hidden;
    }
    const total = $$('[data-lesson]', list).length;
    $('[data-lesson-none]', page).hidden = !total || shown > 0;
    $('[data-lesson-empty]', page).hidden = total > 0;
    $('[data-lesson-filters]', page).hidden = !total;
  };
  const recount = waiting => {
    const cards = $$('[data-lesson]', list);
    for (const s of STATUSES) {
      const n = cards.filter(c => c.dataset.status === s).length;
      const stat = $(`[data-count="${s}"]`, page);
      if (stat) stat.textContent = n;
      const chip = $(`[data-filter-count="${s}"]`, page);
      if (chip) chip.textContent = n;
    }
    $('[data-filter-count="all"]', page).textContent = cards.length;
    $('[data-count="proposed"]', page).parentElement.dataset.tone = cards.some(c => c.dataset.status === 'proposed') ? 'warn' : '';
    const badge = $('[data-lessons-waiting]');
    if (badge && waiting != null) { badge.textContent = waiting; badge.hidden = !waiting; }
  };
  const swap = (card, html) => {
    const next = h(html);
    card.replaceWith(next);
    next.classList.add('just-changed');
    return next;
  };

  on(page, 'click', '[data-lesson-filter]', (e, chip) => {
    filter = chip.dataset.lessonFilter;
    for (const c of $$('[data-lesson-filter]', page)) c.setAttribute('aria-pressed', String(c === chip));
    apply();
  });

  // ---- Actions on a card
  const act = async (card, action, btn, body) => {
    if (card.hasAttribute('data-pending')) return;
    if (action === 'promote' && !(await confirmDialog({ title: 'Move this lesson into AGENTS.md?',
      body: `It becomes one of ${botName()}’s operating rules for everyone, under “Lessons learned”. The change is kept in the history, so you can undo it.`,
      confirmLabel: 'Promote' }))) return;
    card.setAttribute('data-pending', '');
    await withBusy(btn, async () => {
      try {
        const url = `/admin/lessons/${encodeURIComponent(card.dataset.lesson)}${action === 'edit' ? '' : `/${action}`}?fragment=1`;
        const r = await api(url, { method: action === 'edit' ? 'PATCH' : 'POST', body });
        swap(card, r.html);
        recount(r.waiting);
        apply();
        toast.success(DONE[action]);
      } catch (err) {
        card.removeAttribute('data-pending');
        const form = $('[data-lesson-edit]', card);
        if (err.data?.errors && form && !form.hidden) showErrors(form, err.data.errors);
        else toast.error(err.data?.errors ? Object.values(err.data.errors).join(' ') : err.message,
          { title: 'That didn’t go through', action: { label: 'Try again', onClick: () => btn.click() } });
      }
    });
  };
  on(list, 'click', '[data-lesson-action]', (e, btn) => act(btn.closest('[data-lesson]'), btn.dataset.lessonAction, btn));

  // ---- Edit in place
  on(list, 'click', '[data-lesson-edit-open]', (e, btn) => {
    const form = $('[data-lesson-edit]', btn.closest('[data-lesson]'));
    form.hidden = false;
    form.elements.rule.focus();
  });
  on(list, 'click', '[data-lesson-edit-cancel]', (e, btn) => {
    const form = btn.closest('[data-lesson-edit]');
    form.reset();
    clearErrors(form);
    form.hidden = true;
  });
  on(list, 'submit', '[data-lesson-edit]', (e, form) => {
    e.preventDefault();
    clearErrors(form);
    const card = form.closest('[data-lesson]');
    const body = { rule: form.elements.rule.value, why: form.elements.why.value, domain: form.elements.domain.value };
    const submit = e.submitter || $('[type="submit"]', form);
    act(card, submit?.value === 'approve' ? 'approve' : 'edit', submit, body);
  });

  // ---- Write a lesson
  const newForm = $('[data-lesson-new]', page);
  const opener = $('[data-lesson-new-open]', page);
  const ruleInput = $('[data-lesson-rule-input]', newForm);
  const count = () => { $('[data-lesson-rule-count]', newForm).textContent = `${ruleInput.value.length} / 220`; };
  ruleInput.addEventListener('input', count);
  const toggleNew = open => {
    newForm.hidden = !open;
    opener.setAttribute('aria-expanded', String(open));
    if (open) ruleInput.focus();
    else { newForm.reset(); clearErrors(newForm); count(); }
  };
  on(page, 'click', '[data-lesson-new-open]', () => toggleNew(newForm.hidden));
  on(newForm, 'click', '[data-lesson-new-cancel]', () => toggleNew(false));
  newForm.addEventListener('submit', async e => {
    e.preventDefault();
    clearErrors(newForm);
    const body = { rule: newForm.elements.rule.value, why: newForm.elements.why.value, domain: newForm.elements.domain.value };
    await withBusy(e.submitter || $('[type="submit"]', newForm), async () => {
      try {
        const r = await api('/admin/lessons?fragment=1', { method: 'POST', body });
        const card = h(r.html);
        list.prepend(card);
        card.classList.add('just-changed');
        toggleNew(false);
        recount(r.waiting);
        apply();
        toast.success(DONE.create);
      } catch (err) {
        if (err.data?.errors) showErrors(newForm, err.data.errors);
        else toast.error(err.message, { title: 'Couldn’t save the lesson' });
      }
    }, 'Saving…');
  });

  apply();
}
