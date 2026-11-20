// You → Connections, the parts that aren't mailboxes: "Share when I'm busy with my household" (a switch that shows it is
// waiting for the server, says what changed, and goes back if it failed) and the sites my browser is signed in to for
// this person (Sign me out: confirm → pending row → gone, with the count of what was removed).
// Server contract: POST /api/v1/me/profile { shareBusy } → { user } · DELETE /api/v1/me/browser/sites/:site → { removed }.
import { $, $$, on, api, withBusy } from './core.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';

function initShareBusy() {
  const box = $('[data-share-busy]');
  const sw = $('[data-share-busy-switch]', box || document);
  if (!box || !sw) return;
  const state = $('[data-share-busy-state]', box);
  sw.addEventListener('change', async () => {
    const on_ = sw.checked;
    box.dataset.pending = '';
    sw.disabled = true;
    state.className = 'mt-1 text-xs font-medium text-ink-3';
    state.textContent = on_ ? 'Turning on…' : 'Turning off…';
    try {
      const r = await api('/api/v1/me/profile', { method: 'POST', body: { shareBusy: on_ } });
      sw.checked = !!r.user?.shareBusy;
      state.className = 'mt-1 text-xs font-medium text-ok';
      state.textContent = sw.checked ? 'On. Your household can see when you’re busy, nothing more.' : 'Off. I won’t count your busy times for anyone else.';
    } catch (err) {
      sw.checked = !on_;
      state.className = 'mt-1 text-xs font-medium text-bad';
      state.textContent = `Not changed: ${err.message}`;
      toast.error(err.message, { title: 'Couldn’t change busy sharing' });
    } finally {
      delete box.dataset.pending;
      sw.disabled = false;
    }
  });
}

function initSites() {
  const list = $('[data-sites]');
  if (!list) return;
  on(list, 'click', '[data-site-forget]', async (e, btn) => {
    const site = btn.dataset.siteForget;
    const row = btn.closest('[data-site]');
    if (!(await confirmDialog({ title: `Sign me out of ${site}?`, body: 'I’ll forget its cookies and saved data. Next time a task needs it, you’ll sign in again.', confirmLabel: 'Sign out', danger: true }))) return;
    row.dataset.pending = '';
    await withBusy(btn, async () => {
      try {
        const r = await api(`/api/v1/me/browser/sites/${encodeURIComponent(site)}`, { method: 'DELETE' });
        row.animate?.([{ opacity: 1 }, { opacity: 0, transform: 'translateX(8px)' }], { duration: 180 }).finished.then(() => {
          row.remove();
          const left = $$('[data-site]', list).length;
          $('[data-sites-empty]', list).hidden = left > 0;
          const count = $('[data-sites-count]');
          if (count) count.textContent = left ? `${left} ${left === 1 ? 'site' : 'sites'}` : '';
        });
        toast.success(`Signed out of ${site}${r.removed ? ` (${r.removed} saved ${r.removed === 1 ? 'item' : 'items'} removed)` : ''}.`);
      } catch (err) {
        delete row.dataset.pending;
        toast.error(err.message, { title: `Couldn’t sign out of ${site}`, action: { label: 'Try again', onClick: () => btn.click() } });
      }
    }, 'Signing out…');
  });
}

export function initYou() {
  initShareBusy();
  initSites();
}
