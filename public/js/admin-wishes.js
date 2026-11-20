// Admin → System, "Asked for, can't do yet" (the wish log, Phase 25 decision #203): Remove takes a wish off the list. The
// row dims while the server removes it, then folds away and the counts follow; a failure puts it back as it was and says
// why, with Try again. (A wish asked again later comes back on its own.)
// Server contract: DELETE /api/v1/admin/wishes/:id → { ok }.
import { $, $$, on, api, withBusy } from './core.js';
import { toast } from './toast.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function initAdminWishes() {
  const box = $('[data-wishes]');
  if (!box) return;
  const list = $('[data-wish-list]', box);
  const recount = removed => {
    const total = Math.max(0, Number(box.dataset.total) - 1), asks = Math.max(0, Number(box.dataset.asks) - removed);
    box.dataset.total = total;
    box.dataset.asks = asks;
    const summary = $('[data-wish-summary]', box);
    summary.textContent = `${plural(total, 'wish', 'wishes')} · asked ${plural(asks, 'time', 'times')}`;
    summary.hidden = !total;
    const empty = !$$('[data-wish]', list).length;
    list.hidden = empty;
    $('[data-wish-empty]', box).hidden = !empty;
  };
  on(list, 'click', '[data-wish-remove]', async (e, btn) => {
    const row = btn.closest('[data-wish]');
    if (row.hasAttribute('data-pending')) return;
    row.setAttribute('data-pending', '');
    const text = $('p', row).textContent.trim();
    const fold = () => {
      const gone = () => { row.remove(); recount(Number(row.dataset.count) || 1); };
      const anim = row.animate?.([{ opacity: 0.5, height: `${row.offsetHeight}px` }, { opacity: 0, height: '0px', paddingBlock: '0px' }], { duration: 200, easing: 'ease-out' });
      anim ? anim.finished.then(gone) : gone();
    };
    await withBusy(btn, async () => {
      try {
        await api(`/api/v1/admin/wishes/${encodeURIComponent(row.dataset.wish)}`, { method: 'DELETE' });
        fold();
        toast.success(`Removed “${text.length > 60 ? `${text.slice(0, 60)}…` : text}”.`);
      } catch (err) {
        if (err.status === 404) { fold(); return; } // removed in another tab already: the list catches up

        row.removeAttribute('data-pending');
        toast.error(err.message, { title: 'Couldn’t remove it', action: { label: 'Try again', onClick: () => btn.click() } });
      }
    });
  });
}
