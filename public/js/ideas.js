// Ideas: category filter, start / snooze / dismiss (optimistic + Undo), "Think of more" with skeletons.
// Server contract: POST /api/v1/ideas/:id/(start|snooze|dismiss|restore) → { redirect?, state? }; dismiss takes { reason?:
//                  not_for_me | already_doing | not_now (snoozes), note? } (#196)
//                  POST /api/v1/ideas/generate → { added, itemsHtml, message? } · live: 'ideas.updated' { added }
import { $, $$, on, api, withBusy, h } from './core.js';
import { toast } from './toast.js';

const url = (id, action) => `/api/v1/ideas/${encodeURIComponent(id)}/${action}`;

export function initIdeas() {
  const grid = $('[data-idea-grid]');

  on(document, 'click', '[data-idea-filter]', (e, chip) => {
    for (const c of $$('[data-idea-filter]')) c.setAttribute('aria-pressed', String(c === chip));
    const cat = chip.dataset.ideaFilter;
    for (const card of $$('[data-idea-grid] [data-idea-id]')) card.hidden = cat !== 'all' && card.dataset.category !== cat;
  });

  on(document, 'click', '[data-idea-action]', async (e, btn) => {
    const card = btn.closest('[data-idea-id]');
    const id = card.dataset.ideaId;
    const action = btn.dataset.ideaAction;

    if (action === 'start') {
      await withBusy(btn, async () => {
        try {
          const res = await api(url(id, 'start'), { method: 'POST' });
          location.assign(res?.redirect || '/chat');
        } catch (err) { toast.error(err.message, { title: "Couldn't start that" }); }
      }, 'Starting…');
      return;
    }

    // ✕ asks why first (#196): the reasons as chips in the card, from the page's <template>. Starter cards (no template on a
    // page without it) dismiss straight away, as before.
    const why = $('[data-idea-why-template]');
    if (action === 'dismiss' && why) {
      if (card.querySelector('[data-idea-why]')) return card.querySelector('[data-idea-why]').remove();
      card.append(why.content.firstElementChild.cloneNode(true));
      card.querySelector('[data-idea-reason]')?.focus();
      return;
    }
    await leave(card, id, action, {});
  });

  // A reason picked (or "Just dismiss it"): "Not now" snoozes (it comes back later), the others dismiss for good.
  on(document, 'click', '[data-idea-reason]', async (e, chip) => {
    const card = chip.closest('[data-idea-id]');
    const panel = chip.closest('[data-idea-why]');
    const reason = chip.dataset.ideaReason || null;
    for (const b of panel.querySelectorAll('button')) b.disabled = true;
    chip.setAttribute('aria-pressed', 'true');
    const ok = await leave(card, card.dataset.ideaId, 'dismiss', { reason, note: panel.querySelector('[data-idea-note]').value.trim() || null }, panel);
    if (!ok) { for (const b of panel.querySelectorAll('button')) b.disabled = false; chip.setAttribute('aria-pressed', 'false'); }
  });
  on(document, 'click', '[data-idea-why-cancel]', (e, b) => b.closest('[data-idea-why]').remove());

  // snooze / dismiss: remove now, offer Undo, roll back on failure (the reason panel says what went wrong).
  async function leave(card, id, action, body, panel = null) {
    const parent = card.parentElement, next = card.nextSibling;
    card.style.transition = 'opacity .2s, transform .2s';
    card.style.opacity = '0';
    card.style.transform = 'scale(.97)';
    setTimeout(() => card.remove(), 200);
    const putBack = () => { card.style.opacity = ''; card.style.transform = ''; parent.insertBefore(card, next); };
    try {
      const res = await api(url(id, action), { method: 'POST', body });
      const snoozed = action === 'snooze' || res?.state === 'snoozed';
      panel?.remove();
      toast(snoozed ? "Okay, I'll bring it back later." : body.reason === 'already_doing' ? "Good to know. I won't suggest it again."
        : "Got it. I won't suggest that again.", {
        action: { label: 'Undo', onClick: async () => {
          putBack();
          try { await api(url(id, 'restore'), { method: 'POST' }); } catch (err) { toast.error(err.message); }
        } },
      });
      return true;
    } catch (err) {
      setTimeout(putBack, 220);
      if (panel) {
        const el = panel.querySelector('[data-idea-why-error]');
        el.textContent = err.message;
        el.hidden = false;
      } else toast.error(err.message, { title: 'Not saved' });
      return false;
    }
  }

  // Ideas found in the background (daily reflection) while this page is open.
  let generating = false;
  document.addEventListener('jb:ws:ideas.updated', e => {
    if (generating || !$('[data-ideas-page]')) return; // our own "Think of more" already shows them
    const n = e.detail.data.added;
    toast(`I thought of ${n} new idea${n > 1 ? 's' : ''} for you.`, { action: { label: 'Show', onClick: () => location.reload() } });
  });

  on(document, 'click', '[data-ideas-refresh]', async (e, btn) => {
    const skeletons = grid ? Array.from({ length: 3 }, () => h(`
      <div class="card p-4" aria-hidden="true"><div class="flex gap-3"><div class="skeleton size-10 rounded-xl"></div>
      <div class="flex-1 space-y-2"><div class="skeleton h-3 w-16"></div><div class="skeleton h-4 w-3/4"></div></div></div>
      <div class="mt-4 space-y-2"><div class="skeleton h-3"></div><div class="skeleton h-3 w-5/6"></div></div></div>`)) : [];
    generating = true;
    await withBusy(btn, async () => {
      grid?.prepend(...skeletons);
      try {
        const res = await api('/api/v1/ideas/generate', { method: 'POST' });
        skeletons.forEach(s => s.remove());
        if (!res?.added) return toast(res?.message || 'No new ideas right now.');
        if (!grid) return location.reload(); // first ideas: the page needs its filters and grid
        grid.prepend(...h(`<div>${res.itemsHtml}</div>`).children);
        toast.success(`${res.added} fresh idea${res.added > 1 ? 's' : ''} added.`);
      } catch (err) {
        skeletons.forEach(s => s.remove());
        toast.error(err.message, { title: "Couldn't think of new ideas" });
      } finally { setTimeout(() => { generating = false; }, 3000); } // its own frame may arrive just after the response
    }, 'Thinking…');
  });
}
