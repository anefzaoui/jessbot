// Admin → Usage (Phase 25, decision #203): "Read it now" on the OpenRouter balance card. The card shows it is reading (the
// numbers dim and shimmer, the arrow turns), then the server's re-rendered card and its gap note take its place; a failure
// keeps the old card and says why, with Try again.
// Server contract: GET /admin/usage/balance?refresh=1 → { balance, html, gapHtml }.
import { $, on, api } from './core.js';
import { toast } from './toast.js';

export function initAdminUsage() {
  const slot = $('[data-balance-slot]');
  if (!slot) return;
  on(slot, 'click', '[data-balance-refresh]', async (e, btn) => {
    const card = btn.closest('[data-balance]');
    if (card.hasAttribute('data-pending')) return;
    card.setAttribute('data-pending', '');
    card.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    try {
      const r = await api('/admin/usage/balance?refresh=1');
      slot.innerHTML = r.html;
      const gap = $('[data-balance-gap]');
      if (gap) gap.innerHTML = r.gapHtml || '';
      toast.success(r.balance?.amount ? `Balance read: ${r.balance.amount}.` : 'OpenRouter didn’t give a balance for this key.');
    } catch (err) {
      card.removeAttribute('data-pending');
      card.removeAttribute('aria-busy');
      btn.disabled = false;
      toast.error(err.message, { title: 'Couldn’t read the balance', action: { label: 'Try again', onClick: () => btn.click() } });
    }
  });
}
