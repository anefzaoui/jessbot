// What's new in Jess, the person's card in the main chat (Phase 25 #213): shown once. More than four lines (two on a phone) fold behind
// "Show all"; "Got it" marks every entry on the card seen (the button says it is saving), then the card folds away. A failure
// keeps the card and offers Try again, so it never silently comes back or silently goes.
// Server contract: POST /api/v1/whats-new/:id/seen → { ok } (404: gone already, treated as seen).
import { $, on, api, withBusy } from './core.js';
import { toast } from './toast.js';

const FOLD_AT = matchMedia('(max-width: 640px)').matches ? 2 : 4; // a phone keeps the chat in view

export function initWhatsNew() {
  const card = $('[data-whats-new]');
  if (!card) return;
  const lines = [...card.querySelectorAll('[data-wn-lines] > li')];
  const more = $('[data-wn-more]', card);
  if (lines.length > FOLD_AT) {
    lines.slice(FOLD_AT).forEach(li => { li.hidden = true; });
    more.querySelector('span').textContent = `Show all ${lines.length}`;
    more.hidden = false;
  }
  on(card, 'click', '[data-wn-more]', () => {
    lines.forEach(li => { li.hidden = false; });
    more.hidden = true;
  });

  on(card, 'click', '[data-whats-new-seen]', (e, btn) => withBusy(btn, async () => {
    const ids = card.dataset.whatsNew.split(',').filter(Boolean);
    try {
      await Promise.all(ids.map(id => api(`/api/v1/whats-new/${encodeURIComponent(id)}/seen`, { method: 'POST' })
        .catch(err => { if (err.status !== 404) throw err; })));
      const gone = () => card.remove();
      const anim = card.animate?.([{ opacity: 1, height: `${card.offsetHeight}px` }, { opacity: 0, height: '0px', paddingBlock: '0px', marginBlock: '0px' }],
        { duration: 220, easing: 'ease-out' });
      anim ? anim.finished.then(gone) : gone();
    } catch (err) {
      toast.error(err.message, { title: 'Couldn’t save that', action: { label: 'Try again', onClick: () => btn.click() } });
    }
  }, 'Saving…'));
}
