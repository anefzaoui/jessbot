// Goals: suggested goals (adopt / dismiss + Undo), the goal page (skip questions, plan switches, check-in, retry,
// edit, pause/resume/done/horizon/archive) and live refresh on 'goal.updated'. Server contract (routes/api/v1/goals.js):
//   POST /api/v1/goals/:id/(adopt|dismiss|restore|skip|checkin|retry) · PATCH /api/v1/goals/:id { title?, category?, state?, horizon? }
//   POST /api/v1/goals/:id/tasks/:taskId { enabled } | { after: [step ids] } → { task }
//   POST /api/v1/goals/:id/measures/:measureId/logs { value, note? } → { measure, progress, html (the card again) }
//   POST /api/v1/goals/:id/measures { label, unit?, start?, target?, per_week? } → 201 { measure, html } (#212)
import { $, on, api, withBusy, h, escapeHtml } from './core.js';
import { toast } from './toast.js';
import { confirmDialog, closeModal } from './modal.js';

const goalUrl = (id, action = '') => `/api/v1/goals/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;

// Re-render from the server when something changed — but never under someone's fingers (typing, a dialog open).
function reloadWhenIdle() {
  const busy = () => document.querySelector('dialog[open]') || document.activeElement?.matches?.('input[type=text], textarea');
  if (!busy()) return location.reload();
  setTimeout(reloadWhenIdle, 1500);
}

function initGoalList() {
  on(document, 'click', '[data-goal-action]', async (e, btn) => {
    const card = btn.closest('[data-goal-id]');
    const id = card.dataset.goalId;
    if (btn.dataset.goalAction === 'adopt') {
      await withBusy(btn, async () => {
        try { location.assign((await api(goalUrl(id, 'adopt'), { method: 'POST' })).redirect); }
        catch (err) { toast.error(err.message, { title: "Couldn't set that goal" }); }
      }, 'Setting up…');
      return;
    }
    const parent = card.parentElement, next = card.nextSibling;
    card.remove();
    try {
      await api(goalUrl(id, 'dismiss'), { method: 'POST' });
      toast("Okay, I won't suggest that again.", { action: { label: 'Undo', onClick: async () => {
        parent.insertBefore(card, next);
        try { await api(goalUrl(id, 'restore'), { method: 'POST' }); } catch (err) { toast.error(err.message); }
      } } });
    } catch (err) {
      parent.insertBefore(card, next);
      toast.error(err.message, { title: 'Not saved' });
    }
  });
}

function initGoalPage(page) {
  const id = page.dataset.goalId;

  const post = (btn, action, label, done) => withBusy(btn, async () => {
    try { await api(goalUrl(id, action), { method: 'POST' }); done?.(); }
    catch (err) { toast.error(err.message, { title: "Couldn't do that" }); }
  }, label);

  on(document, 'click', '[data-goal-skip]', (e, b) => post(b, 'skip', 'One moment…', () => location.reload()));
  on(document, 'click', '[data-goal-retry]', (e, b) => post(b, 'retry', 'Retrying…', () => location.reload()));
  on(document, 'click', '[data-goal-checkin]', (e, b) => post(b, 'checkin', 'Checking in…', () => toast('Checking in. This page updates when I’m done.')));

  // Answered the intake questions → the plan is being written; show that state.
  document.addEventListener('ask:answered', e => { if (e.detail.id === `goal-${id}`) location.reload(); });

  on(document, 'change', '[data-plan-toggle]', async (e, sw) => {
    const row = sw.closest('[data-plan-id]');
    const on_ = sw.checked;
    sw.disabled = true;
    try {
      const { task } = await api(goalUrl(id, `tasks/${row.dataset.planId}`), { method: 'POST', body: { enabled: on_ } });
      sw.checked = task.enabled;
      if (on_ && task.queued) toast.success(`Queued. It starts by itself when ${task.after.join(' and ')} ${task.after.length > 1 ? 'are' : 'is'} done.`);
      else if (on_) toast.success(row.dataset.kind === 'once' ? 'On it. The result lands on this goal’s timeline and in its chat.' : 'Scheduled. I’ll do this on its rhythm.');
    } catch (err) {
      sw.checked = !on_;
      toast.error(err.message, { title: 'Not saved' });
    } finally { sw.disabled = false; }
  });

  on(document, 'click', '[data-goal-patch]', async (e, item) => {
    const [key, value] = item.dataset.goalPatch.split(':');
    if (value === 'archived' && !(await confirmDialog({ title: 'Archive this goal?', body: 'Its recurring steps stop. The chat and anything I made stay.', confirmLabel: 'Archive', danger: true }))) return;
    try {
      const res = await api(goalUrl(id), { method: 'PATCH', body: { [key]: value } });
      if (res.redirect) location.assign(res.redirect); else location.reload();
    } catch (err) { toast.error(err.message, { title: 'Not saved' }); }
  });

  on(document, 'submit', '[data-goal-edit]', async (e, form) => {
    e.preventDefault();
    const btn = form.querySelector('.btn-primary');
    await withBusy(btn, async () => {
      try {
        await api(goalUrl(id), { method: 'PATCH', body: { title: form.elements.title.value, category: form.elements.category.value } });
        closeModal('goal-edit');
        location.reload();
      } catch (err) { toast.error(err.data?.errors?.title || err.message, { title: 'Not saved' }); }
    }, 'Saving…');
  });

  // A number for a measure (#196): the button says it's logging, the server's new card replaces this one (its line, this
  // week, progress); a refused value stays where it was typed with the reason.
  on(document, 'submit', '[data-measure-log]', async (e, form) => {
    e.preventDefault();
    const card = form.closest('[data-measure-id]');
    const input = form.elements.value, err = form.querySelector('.field-error');
    err?.remove();
    input.closest('[data-field]').removeAttribute('aria-invalid');
    if (input.value.trim() === '' || !Number.isFinite(Number(input.value))) {
      input.closest('[data-field]').setAttribute('aria-invalid', 'true');
      form.insertAdjacentHTML('beforeend', '<p class="field-error basis-full">Type a number, like 72.5.</p>');
      return input.focus();
    }
    await withBusy(form.querySelector('button'), async () => {
      try {
        const res = await api(goalUrl(id, `measures/${card.dataset.measureId}/logs`), { method: 'POST', body: { value: Number(input.value), note: form.elements.note.value } });
        if (res.html) {
          const fresh = h(res.html);
          fresh.classList.add('just-logged');
          card.replaceWith(fresh);
        }
        toast.success(`Logged. ${res.measure.weekLabel || res.measure.line}`);
      } catch (error) {
        input.closest('[data-field]').setAttribute('aria-invalid', 'true');
        form.insertAdjacentHTML('beforeend', `<p class="field-error basis-full">${escapeHtml(error.data?.errors ? Object.values(error.data.errors).join(' ') : error.message)}</p>`);
      }
    }, 'Logging…');
  });

  // A new number to track (#212): the form opens under the heading; the server's card joins the grid; a refused one says why.
  const newForm = $('[data-measure-new]');
  const openNew = on_ => {
    newForm.hidden = !on_;
    $('[data-measure-new-open]')?.setAttribute('aria-expanded', String(on_));
    if (on_) newForm.elements.label.focus();
  };
  on(document, 'click', '[data-measure-new-open]', () => newForm && openNew(newForm.hidden));
  on(document, 'click', '[data-measure-new-cancel]', () => openNew(false));
  on(document, 'submit', '[data-measure-new]', async (e, form) => {
    e.preventDefault();
    const err = form.querySelector('[data-measure-new-error]');
    err.hidden = true;
    const val = n => (form.elements[n].value.trim() === '' ? null : Number(form.elements[n].value));
    const body = { label: form.elements.label.value.trim(), unit: form.elements.unit.value.trim() || null, start: val('start'), target: val('target'), per_week: val('per_week') };
    await withBusy(form.querySelector('[type="submit"]'), async () => {
      try {
        const res = await api(goalUrl(id, 'measures'), { method: 'POST', body });
        if (res.html) {
          const card = h(res.html);
          card.classList.add('just-logged');
          $('[data-goal-measures]').append(card);
        }
        $('[data-measure-none]')?.remove();
        form.reset();
        openNew(false);
        toast.success(`I’m counting ${res.measure.label.toLowerCase()} now.`);
      } catch (error) {
        err.textContent = error.data?.errors ? Object.values(error.data.errors).join(' ') : error.message;
        err.hidden = false;
      }
    }, 'Adding…');
  });

  // What a step waits for (#196): an editor under the step from the page's <template>; saving sends { after: [ids] } and the
  // page re-renders (an order that goes round in a circle is refused with the reason, in the editor).
  on(document, 'click', '[data-step-order]', (e, btn) => {
    const step = btn.closest('[data-plan-id]');
    const open = step.querySelector('[data-step-order-form]');
    if (open) return open.remove();
    document.querySelectorAll('[data-step-order-form]').forEach(f => f.remove());
    const form = $('[data-order-template]').content.firstElementChild.cloneNode(true);
    const after = new Set(btn.dataset.after.trim().split(/\s+/).filter(Boolean));
    form.querySelector(`[data-order-for="${step.dataset.planId}"]`)?.remove();
    for (const cb of form.querySelectorAll('input[name="after"]')) cb.checked = after.has(cb.value);
    step.append(form);
    form.querySelector('input')?.focus();
  });
  on(document, 'click', '[data-order-cancel]', (e, b) => b.closest('[data-step-order-form]').remove());
  on(document, 'submit', '[data-step-order-form]', async (e, form) => {
    e.preventDefault();
    const step = form.closest('[data-plan-id]');
    const errEl = form.querySelector('[data-order-error]');
    errEl.hidden = true;
    const after = [...form.querySelectorAll('input[name="after"]:checked')].map(cb => cb.value);
    await withBusy(form.querySelector('.btn-primary'), async () => {
      try {
        const { task } = await api(goalUrl(id, `tasks/${step.dataset.planId}`), { method: 'POST', body: { after } });
        form.remove();
        toast.success(task.after ? `Saved. “${step.dataset.planTitle}” waits for ${task.after.join(' and ')}.` : `Saved. “${step.dataset.planTitle}” doesn’t wait for anything.`);
        reloadWhenIdle();
      } catch (err) {
        errEl.textContent = err.data?.errors?.after || err.message;
        errEl.hidden = false;
      }
    }, 'Saving…');
  });

  document.addEventListener('jb:ws:goal.updated', e => { if (String(e.detail.data.id) === id) reloadWhenIdle(); });
}

export function initGoals() {
  const page = $('[data-goal-page]');
  if (page) return initGoalPage(page);
  if (location.pathname === '/goals') {
    initGoalList();
    document.addEventListener('jb:ws:goal.updated', reloadWhenIdle); // statuses, suggestions, "working on it" badges
  }
}
