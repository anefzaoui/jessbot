// Admin → System, Phase 25 part D (#212–#213): the weekly self-review, "How I'm doing" and What's new in Jess.
//   Self-review: the switch waits for the server; Run now shows the card's "Reviewing…" state at once and re-renders it from
//   the server when the review is done (a review running when the page opened is polled until it finishes). Approve applies a
//   proposal and shows what it did; Reject asks why (optional) first. Each proposal paints its own state (data-status).
//   How I'm doing: 7 / 30 days re-renders the section. What's new: the lines are edited in place with a live preview; Save,
//   Draft it again (a model call: the form shows it's drafting), Publish (asks first) and Discard (asks first).
// Server contract: PUT /api/v1/admin/self-review { enabled } → { settings } · POST …/run → { review } · POST …/proposals/:id/
// approve → { proposal: { status, result } } · POST …/proposals/:id/reject { reason } → { proposal } · GET /admin/system/
// self-review → { running, pending, html } · GET /admin/system/summary?days → { html } · PUT /api/v1/admin/whats-new/:id
// { lines } → { entry } · POST …/:id/redraft | publish | discard → { entry } · GET /admin/system/whats-new → { html }.
import { $, $$, on, api, h, withBusy } from './core.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';
import { showErrors, clearErrors } from './forms.js';

const flash = el => { el.classList.remove('just-changed'); void el.offsetWidth; el.classList.add('just-changed'); };

function initSelfReview() {
  let card = $('[data-self-review]');
  if (!card) return;
  let polling = null;
  const swap = html => { const next = h(html); card.replaceWith(next); card = next; return next; };
  const refresh = async () => {
    const r = await api('/admin/system/self-review');
    swap(r.html);
    return r;
  };
  // A review still running: look again every few seconds (up to ~3 minutes), then say it's taking long.
  const poll = (tries = 0) => {
    clearTimeout(polling);
    polling = setTimeout(async () => {
      try {
        const r = await refresh();
        if (r.running && tries < 60) poll(tries + 1);
        else if (r.running) toast('The review is taking longer than usual. Its result shows here when you come back.');
      } catch { if (tries < 60) poll(tries + 1); }
    }, 3000);
  };
  if (card.dataset.running === 'true') poll();

  on(document, 'change', '[data-rv-enabled]', async (e, sw) => {
    const on_ = sw.checked;
    const label = $('[data-rv-switch-label]', card);
    sw.disabled = true;
    label.textContent = on_ ? 'Turning on…' : 'Turning off…';
    try {
      const r = await api('/api/v1/admin/self-review', { method: 'PUT', body: { enabled: on_ } });
      sw.checked = r.settings.enabled;
      label.textContent = r.settings.enabled ? 'Every 7 days' : 'Off';
      toast.success(r.settings.enabled ? 'The weekly review is on. The next one runs in your quiet hours.' : 'The weekly review is off. Run now still works.');
    } catch (err) {
      sw.checked = !on_;
      label.textContent = !on_ ? 'Every 7 days' : 'Off';
      toast.error(err.message, { title: 'Couldn’t change the weekly review' });
    } finally { sw.disabled = false; }
  });

  on(document, 'click', '[data-rv-run]', async (e, btn) => {
    if (btn.disabled) return;
    const body = $('[data-rv-body]', card);
    const before = body.innerHTML;
    btn.disabled = true;
    card.dataset.running = 'true';
    body.replaceChildren($('template[data-rv-running]', card).content.cloneNode(true));
    try {
      await api('/api/v1/admin/self-review/run', { method: 'POST' });
      const r = await refresh();
      flash(card);
      const n = Number(r.pending) || 0;
      toast.success(n ? `Done: ${n} ${n === 1 ? 'proposal' : 'proposals'} to decide.` : 'Done: nothing to change this time.');
    } catch (err) {
      card.dataset.running = 'false';
      body.innerHTML = before;
      btn.disabled = false;
      toast.error(err.data?.errors?.budget || err.message, { title: 'The review didn’t run', action: { label: 'Try again', onClick: () => btn.click() } });
    }
  });

  const setPending = () => {
    const n = $$('[data-rv-prop][data-status="pending"]', card).length;
    const badge = $('[data-rv-pending]', card);
    if (badge) { badge.textContent = `${n} to decide`; badge.hidden = !n; }
  };
  const decide = async (prop, btn, path, body) => withBusy(btn, async () => {
    prop.setAttribute('data-pending', '');
    try {
      const r = await api(`/api/v1/admin/self-review/proposals/${encodeURIComponent(prop.dataset.rvProp)}/${path}`, { method: 'POST', body });
      const p = r.proposal;
      if (p.result) $('[data-rv-result]', prop).textContent = p.result;
      $('[data-rv-reason]', prop).textContent = p.reason ? `Why: ${p.reason}` : 'Rejected without a reason.';
      prop.dataset.status = p.status;
      $('[data-rv-reject]', prop).hidden = true;
      flash(prop);
      setPending();
      if (p.status === 'approved') toast.success(p.result || 'Approved.');
    } catch (err) {
      if (err.status === 409) toast.error(err.message, { title: 'Already decided', action: { label: 'Reload', onClick: () => refresh() } });
      else toast.error(err.message, { title: path === 'approve' ? 'Couldn’t apply it' : 'Couldn’t reject it', action: { label: 'Try again', onClick: () => btn.click() } });
    } finally { prop.removeAttribute('data-pending'); }
  }, path === 'approve' ? 'Applying…' : 'Rejecting…');

  on(document, 'click', '[data-rv-approve]', (e, btn) => decide(btn.closest('[data-rv-prop]'), btn, 'approve', {}));
  on(document, 'click', '[data-rv-reject-open]', (e, btn) => {
    const form = $('[data-rv-reject]', btn.closest('[data-rv-prop]'));
    form.hidden = false;
    form.elements.reason.focus();
  });
  on(document, 'click', '[data-rv-reject-cancel]', (e, btn) => { btn.closest('[data-rv-reject]').hidden = true; });
  on(document, 'submit', '[data-rv-reject]', (e, form) => {
    e.preventDefault();
    decide(form.closest('[data-rv-prop]'), $('[type="submit"]', form), 'reject', { reason: form.elements.reason.value.trim() });
  });
}

function initDoing() {
  const slot = $('[data-doing-slot]');
  if (!slot) return;
  on(slot, 'click', '[data-doing-days]', async (e, btn) => {
    if (btn.getAttribute('aria-pressed') === 'true') return;
    const tiles = $('[data-doing-tiles]', slot);
    const was = $('[data-doing-days][aria-pressed="true"]', slot);
    $$('[data-doing-days]', slot).forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    tiles.dataset.pending = '';
    try {
      const r = await api(`/admin/system/summary?days=${encodeURIComponent(btn.dataset.doingDays)}`);
      slot.innerHTML = r.html;
    } catch (err) {
      delete tiles.dataset.pending;
      $$('[data-doing-days]', slot).forEach(b => b.setAttribute('aria-pressed', String(b === was)));
      toast.error(err.message, { title: 'Couldn’t count that period' });
    }
  });
}

function initWhatsNewAdmin() {
  const slot = $('[data-wn-admin-slot]');
  if (!slot) return;
  const linesOf = form => form.elements.lines.value.split('\n').map(l => l.trim()).filter(Boolean);
  const reload = async () => { slot.innerHTML = (await api('/admin/system/whats-new')).html; };
  const paint = (form, lines) => {
    const list = $('[data-wn-preview]', form);
    list.replaceChildren(...lines.map(l => { const li = document.createElement('li'); li.dir = 'auto'; li.textContent = l; return li; }));
    $('[data-wn-preview-box]', form).hidden = !lines.length;
    const count = $('[data-wn-count]', form);
    const max = Number(count.dataset.max) || 6;
    count.textContent = `${lines.length} of ${max} lines`;
    count.classList.toggle('text-bad', lines.length > max);
  };
  on(slot, 'input', '[data-wn-lines]', (e, ta) => paint(ta.form, linesOf(ta.form)));

  const call = async (form, path, method, body) => {
    const entry = form.closest('[data-wn-entry]');
    return api(`/api/v1/admin/whats-new/${encodeURIComponent(entry.dataset.wnEntry)}${path}`, { method, body });
  };
  // Save (the form's submit): the lines as they are.
  on(slot, 'submit', '[data-wn-form]', async (e, form) => {
    e.preventDefault();
    clearErrors(form);
    await withBusy($('[data-wn-save]', form), async () => {
      try {
        const r = await call(form, '', 'PUT', { lines: linesOf(form) });
        form.elements.lines.value = r.entry.lines.join('\n');
        paint(form, r.entry.lines);
        flash(form.closest('[data-wn-entry]'));
        toast.success(r.entry.status === 'published' ? 'Saved. New readers see the corrected note.' : 'Draft saved.');
      } catch (err) {
        if (err.data?.errors) showErrors(form, err.data.errors); else toast.error(err.message, { title: 'Couldn’t save the note' });
      }
    }, 'Saving…');
  });
  on(slot, 'click', '[data-wn-redraft]', async (e, btn) => {
    const form = btn.closest('[data-wn-form]');
    if (linesOf(form).length && !(await confirmDialog({ title: 'Draft the note again?', body: 'The lines here are replaced by a new draft from the release’s commits.', confirmLabel: 'Draft it again' }))) return;
    const drafting = $('[data-wn-drafting]', form);
    drafting.hidden = false;
    form.dataset.drafting = '';
    await withBusy(btn, async () => {
      try {
        const r = await call(form, '/redraft', 'POST');
        form.elements.lines.value = r.entry.lines.join('\n');
        paint(form, r.entry.lines);
        flash(form.closest('[data-wn-entry]'));
        if (!r.entry.lines.length) toast('Nothing in this release looked worth telling people about. Write lines yourself, or discard it.');
      } catch (err) { toast.error(err.data?.errors?.budget || err.message, { title: 'Couldn’t draft it', action: { label: 'Try again', onClick: () => btn.click() } }); }
      finally { drafting.hidden = true; delete form.dataset.drafting; }
    }, 'Drafting…');
  });
  on(slot, 'click', '[data-wn-publish]', async (e, btn) => {
    const form = btn.closest('[data-wn-form]');
    const lines = linesOf(form);
    if (!(await confirmDialog({ title: 'Publish this note?', body: `Everyone sees these ${lines.length} ${lines.length === 1 ? 'line' : 'lines'} once, above their chat. You can still fix a typo afterwards.`, confirmLabel: 'Publish' }))) return;
    clearErrors(form);
    await withBusy(btn, async () => {
      try {
        await call(form, '', 'PUT', { lines }); // what's on screen is what gets published
        await call(form, '/publish', 'POST');
        await reload();
        toast.success('Published. Everyone sees it once, the next time they open their chat.');
      } catch (err) {
        if (err.data?.errors) showErrors(form, err.data.errors); else toast.error(err.message, { title: 'Couldn’t publish it' });
      }
    }, 'Publishing…');
  });
  on(slot, 'click', '[data-wn-discard]', async (e, btn) => {
    const form = btn.closest('[data-wn-form]');
    if (!(await confirmDialog({ title: 'Discard this note?', body: 'Nobody will see it. The release itself isn’t affected.', confirmLabel: 'Discard', danger: true }))) return;
    await withBusy(btn, async () => {
      try { await call(form, '/discard', 'POST'); await reload(); toast.success('Discarded.'); }
      catch (err) { toast.error(err.message, { title: 'Couldn’t discard it' }); }
    }, 'Discarding…');
  });
}

export function initAdminReview() {
  initSelfReview();
  initDoing();
  initWhatsNewAdmin();
}
