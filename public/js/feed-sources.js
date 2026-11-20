// /feed/sources (decision #89): a person's topics and the sources behind them. Every change shows pending → result, and
// the server answers with the re-rendered topic card (partials/feed/topic-sources.hbs), so the page never builds markup.
// Server contract (routes/api/v1/feed.js): POST /feed/topics { label, query, when } → 201 { topic, html } ·
// POST /feed/topics/:key/edit (same body) · POST /feed/topics/:key/pause { paused } → { topic, html } · DELETE /feed/topics/:key
// → { label } · POST /feed/topics/:key/sources { url } → { html, source, how, added, message } · DELETE
// /feed/topics/:key/sources/:id → { html, message } · POST /feed/sources/:id/check { topic } → { html, source, added }.
import { $, $$, on, api, h, withBusy, loader } from './core.js';
import { toast } from './toast.js';
import { openModal, closeModal, confirmDialog } from './modal.js';

const topicUrl = key => `/api/v1/feed/topics/${encodeURIComponent(key)}`;

export function initFeedSources() {
  const root = $('[data-feed-sources]');
  if (!root) return;
  const list = $('[data-topic-list]', root);
  const dlg = $('#topic-editor');
  const form = $('[data-topic-form]', dlg);
  let editing = null; // topic key while editing, null for a new topic

  // Swap a topic card for the server's fresh copy, and let it glow once so the eye finds what changed.
  const swap = (card, html, flashSel) => {
    const next = h(html);
    card.replaceWith(next);
    const target = flashSel ? $(flashSel, next) : next;
    target?.classList.add('is-flash');
    recount();
    return next;
  };

  function recount() {
    const summary = $('[data-src-summary]', root);
    if (!summary) return;
    const rows = $$('[data-source-row]', root);
    const counts = { topics: $$('[data-topic]', root).length, sources: rows.length, mine: rows.filter(r => r.dataset.mine === 'true').length,
      failing: rows.filter(r => r.dataset.state === 'failing').length };
    for (const [k, v] of Object.entries(counts)) { const el = $(`[data-count="${k}"]`, summary); if (el) el.textContent = v; }
    $('[data-count="failing"]', summary).parentElement.dataset.bad = String(counts.failing > 0);
  }

  // ---- Topics ----------------------------------------------------------------------------------------------------
  const fillForm = (t = {}) => {
    form.reset();
    form.elements.label.value = t.label || '';
    form.elements.query.value = t.query && t.query !== t.label ? t.query : '';
    for (const r of $$('input[name="when"]', form)) r.checked = r.value === (t.when || 'any');
    for (const el of $$('[aria-invalid]', form)) el.removeAttribute('aria-invalid');
    $('[data-topic-form-title]', form).textContent = editing ? `Edit “${t.label}”` : 'New topic';
  };

  on(document, 'click', '[data-topic-new]', (e, btn) => { editing = null; fillForm(); openModal(dlg, btn); });
  on(root, 'click', '[data-topic-edit]', (e, btn) => {
    const card = btn.closest('[data-topic]');
    editing = card.dataset.topic;
    fillForm({ label: card.dataset.label, query: card.dataset.query, when: card.dataset.when });
    openModal(dlg, btn);
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const body = { label: form.elements.label.value.trim(), query: form.elements.query.value.trim(), when: form.elements.when.value };
    for (const el of $$('[aria-invalid]', form)) el.removeAttribute('aria-invalid');
    withBusy($('[data-topic-save]', form), async () => {
      try {
        const out = await api(editing ? `${topicUrl(editing)}/edit` : '/api/v1/feed/topics', { method: 'POST', body });
        closeModal(dlg);
        if (editing) {
          swap($(`[data-topic="${CSS.escape(editing)}"]`, root), out.html);
          toast.success(`Saved “${out.topic.label}”. New stories follow the new words.`);
        } else if (!$('[data-src-summary]', root)) {
          location.reload(); // the first topic: the page gains its summary and explainer
        } else {
          list.append(h(out.html));
          const card = list.lastElementChild;
          card.classList.add('is-flash');
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          recount();
          $('input[name="url"]', card)?.focus({ preventScroll: true });
          toast.success(`Added “${out.topic.label}”. It searches Google News now. Add sites to it below.`);
        }
      } catch (err) {
        const fields = err.data?.errors;
        if (fields) for (const n of Object.keys(fields)) form.elements[n]?.setAttribute?.('aria-invalid', 'true');
        toast.error(fields ? Object.values(fields).join(' ') : err.message, { title: 'Not saved' });
      }
    }, 'Saving…');
  });

  on(root, 'click', '[data-topic-pause]', (e, btn) => withBusy(btn, async () => {
    const card = btn.closest('[data-topic]');
    const pausing = card.dataset.paused !== 'true';
    try {
      const out = await api(`${topicUrl(card.dataset.topic)}/pause`, { method: 'POST', body: { paused: pausing } });
      swap(card, out.html);
      toast.success(pausing ? `Paused “${out.topic.label}”. No new stories from it until you resume.` : `“${out.topic.label}” is back on.`);
    } catch (err) { toast.error(err.message); }
  }, pausing(btn) ? 'Pausing…' : 'Resuming…'));

  on(root, 'click', '[data-topic-delete]', async (e, btn) => {
    const card = btn.closest('[data-topic]');
    const label = card.dataset.label;
    const ok = await confirmDialog({ title: `Delete “${label}”?`, danger: true, confirmLabel: 'Delete topic',
      body: 'Its sources go too, and re-tuning won’t bring it back. Stories you already have stay in your feed’s history.' });
    if (!ok) return;
    card.setAttribute('aria-busy', 'true');
    try {
      await api(topicUrl(card.dataset.topic), { method: 'DELETE' });
      card.classList.add('is-leaving');
      card.addEventListener('animationend', () => { card.remove(); recount(); }, { once: true });
      toast.success(`Deleted “${label}”.`);
    } catch (err) { card.removeAttribute('aria-busy'); toast.error(err.message); }
  });

  // ---- Sources ---------------------------------------------------------------------------------------------------
  on(root, 'submit', '[data-source-add]', (e, f) => {
    e.preventDefault();
    const input = f.elements.url;
    const value = input.value.trim();
    if (!value) { input.setAttribute('aria-invalid', 'true'); input.focus(); toast.error('Paste a site (like theverge.com) or a feed link.'); return; }
    input.removeAttribute('aria-invalid');
    const card = f.closest('[data-topic]');
    const status = $('[data-source-add-status]', f);
    const host = value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    status.innerHTML = loader(`Looking for ${host}’s feed…`, { motion: 'searching', iconName: 'rss' });
    status.hidden = false;
    input.readOnly = true;
    // Finding a feed can take a while on slow sites: say so instead of leaving a silent spinner.
    const slow = setTimeout(() => { const l = $('.loader-label', status); if (l) l.textContent = `Still looking. ${host} is slow to answer. This can take up to a minute.`; }, 9000);
    withBusy($('button', f), async () => {
      try {
        const out = await api(`${topicUrl(card.dataset.topic)}/sources`, { method: 'POST', body: { url: value } });
        swap(card, out.html, `[data-source-row="${out.source.id}"]`);
        if (out.how === 'search') toast(out.message); else toast.success(out.message);
      } catch (err) {
        input.readOnly = false;
        status.hidden = true;
        const msg = err.data?.errors ? Object.values(err.data.errors).join(' ') : err.message;
        input.setAttribute('aria-invalid', 'true');
        toast.error(msg, { title: 'Not added' });
      } finally { clearTimeout(slow); }
    }, 'Adding…');
  });

  on(root, 'click', '[data-source-check]', (e, btn) => withBusy(btn, async () => {
    const row = btn.closest('[data-source-row]');
    const card = btn.closest('[data-topic]');
    const title = $('[data-source-title]', row)?.textContent.trim() || 'That source';
    try {
      const out = await api(`/api/v1/feed/sources/${row.dataset.sourceRow}/check`, { method: 'POST', body: { topic: card.dataset.topic } });
      const next = h(out.html);
      row.replaceWith(next);
      next.classList.add('is-flash');
      recount();
      if (out.source.state === 'failing') toast.error(`${title} isn’t answering${out.source.error ? `: ${out.source.error}` : ''}. I’ll keep trying on my own.`);
      else toast.success(out.added ? `${out.added} new ${out.added === 1 ? 'story' : 'stories'} from ${title}.` : `${title} is up to date.`);
    } catch (err) { toast.error(err.message); }
  }));

  on(root, 'click', '[data-source-remove]', async (e, btn) => {
    const row = btn.closest('[data-source-row]');
    const card = btn.closest('[data-topic]');
    const title = $('[data-source-title]', row)?.textContent.trim() || 'this source';
    const ok = await confirmDialog({ title: `Remove ${title}?`, danger: true, confirmLabel: 'Remove',
      body: `No more stories from it in “${card.dataset.label}”. Re-tuning won’t bring it back; you can add it again any time.` });
    if (!ok) return;
    row.setAttribute('aria-busy', 'true');
    try {
      const out = await api(`${topicUrl(card.dataset.topic)}/sources/${row.dataset.sourceRow}`, { method: 'DELETE' });
      row.classList.add('is-leaving');
      row.addEventListener('animationend', () => { swap(card, out.html); }, { once: true });
      toast.success(out.message);
    } catch (err) { row.removeAttribute('aria-busy'); toast.error(err.message); }
  });
}

const pausing = btn => btn.closest('[data-topic]')?.dataset.paused !== 'true';
