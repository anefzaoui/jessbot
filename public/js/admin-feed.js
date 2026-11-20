// Admin → Feed sources (decision #89): filter the list, fetch a source now, remove one for everyone.
// Server contract (routes/web/admin-ops.js): POST /admin/feed-sources/:id/check → { html, source, added } ·
// DELETE /admin/feed-sources/:id → { title, followers }.
import { $, $$, on, api, h, withBusy } from './core.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';

export function initAdminFeed() {
  const root = $('[data-admin-feed]');
  if (!root) return;
  let filter = 'all';

  const apply = () => {
    const rows = $$('[data-admin-source]', root);
    let shown = 0;
    for (const r of rows) {
      const show = filter === 'all' || (filter === 'failing' ? r.dataset.state === 'failing' : r.dataset.kind === filter);
      r.hidden = !show;
      if (show) shown++;
    }
    $('[data-admin-feed-empty]', root)?.classList.toggle('hidden', shown > 0 || !rows.length);
    const summary = $('[data-src-summary]', root);
    $('[data-count="total"]', summary).textContent = rows.length;
    const failing = rows.filter(r => r.dataset.state === 'failing').length;
    $('[data-count="failing"]', summary).textContent = failing;
    $('[data-count="failing"]', summary).parentElement.dataset.bad = String(failing > 0);
  };

  on(root, 'click', '[data-admin-feed-filter]', (e, btn) => {
    filter = btn.dataset.adminFeedFilter;
    for (const b of $$('[data-admin-feed-filter]', root)) b.setAttribute('aria-pressed', String(b === btn));
    apply();
  });

  on(root, 'click', '[data-admin-source-check]', (e, btn) => withBusy(btn, async () => {
    const row = btn.closest('[data-admin-source]');
    try {
      const out = await api(`/admin/feed-sources/${row.dataset.adminSource}/check`, { method: 'POST' });
      const next = h(out.html);
      row.replaceWith(next);
      next.classList.add('is-flash');
      apply();
      const s = out.source;
      if (s.state === 'failing') toast.error(`${s.title} isn’t answering${s.error ? `: ${s.error}` : ''}.`);
      else toast.success(out.added ? `${out.added} new ${out.added === 1 ? 'story' : 'stories'} from ${s.title}.` : `${s.title} answered, nothing new.`);
    } catch (err) { toast.error(err.message); }
  }, 'Fetching…'));

  on(root, 'click', '[data-admin-source-remove]', async (e, btn) => {
    const row = btn.closest('[data-admin-source]');
    const n = Number(row.dataset.followers) || 0;
    const ok = await confirmDialog({ title: `Remove ${row.dataset.title} for everyone?`, danger: true, confirmLabel: 'Remove',
      body: n ? `${n === 1 ? 'One person follows' : `${n} people follow`} it. Its stored stories go too, and their re-tunes won’t bring it back; they can add it again themselves.`
        : 'Nobody follows it now. Its stored stories go too.' });
    if (!ok) return;
    row.setAttribute('aria-busy', 'true');
    try {
      const out = await api(`/admin/feed-sources/${row.dataset.adminSource}`, { method: 'DELETE' });
      row.classList.add('is-leaving');
      row.addEventListener('animationend', () => { row.remove(); apply(); }, { once: true });
      toast.success(`Removed ${out.title || 'the source'}.`);
    } catch (err) { row.removeAttribute('aria-busy'); toast.error(err.message); }
  });
}
