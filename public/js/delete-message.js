// Deleting a message (decision #50): preview → confirm (optionally forget what Jess learned from it) → the bubbles
// disappear at once with an Undo; the real DELETE is sent when the Undo window closes, or immediately if the page is
// left. Other open pages remove the bubbles on `messages.deleted`.
import { $, $$, on, api } from './core.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';

const UNDO_MS = 6000;
const pending = new Map(); // messageId → { timer, body, els }

const bubblesOf = plan => [
  ...plan.messageIds.map(id => $(`[data-db-id="${id}"]`)),
  ...plan.runIds.map(id => $(`[data-run-owner="${id}"]`)),
].filter(Boolean).map(el => el.closest('article') || el);

function send(id) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  // keepalive: still delivered when the page is being closed or navigated away.
  fetch(`/api/v1/messages/${id}`, { method: 'DELETE', keepalive: true, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'jessbot' }, body: JSON.stringify(p.body) })
    .then(r => { if (!r.ok) throw new Error(); p.els.forEach(el => el.remove()); })
    .catch(() => { p.els.forEach(el => { el.hidden = false; }); toast.error('That message couldn’t be deleted. It’s back.'); });
}

export function initDeleteMessage() {
  if (!$('[data-chat]')) return;
  const bot = $('[data-bot-name]')?.dataset.botName || 'Jess';

  on(document, 'click', '[data-message-delete]', async (e, btn) => {
    const id = btn.closest('[data-db-id]')?.dataset.dbId;
    if (!id) return;
    let plan;
    try { plan = await api(`/api/v1/messages/${id}/deletion`); } catch (err) { return toast.error(err.message, { title: 'Can’t delete that yet' }); }
    const choice = await confirmDialog({
      title: plan.role === 'user' ? 'Delete this message?' : 'Delete this reply?',
      body: `${plan.replies ? `${bot}’s reply goes with it. ` : ''}It’s removed for good: from the chat, search, and what ${bot} keeps in mind about this conversation.`,
      confirmLabel: 'Delete', danger: true,
      checkbox: plan.memories.length ? { label: `Also forget what ${bot} learned from it`, items: plan.memories.map(m => m.text), checked: true } : null,
    });
    const ok = typeof choice === 'object' ? choice.ok : choice;
    if (!ok) return;
    const els = bubblesOf(plan);
    els.forEach(el => { el.hidden = true; });
    pending.set(id, { els, body: { forgetMemories: typeof choice === 'object' && choice.checked }, timer: setTimeout(() => send(id), UNDO_MS) });
    toast('Deleted.', { duration: UNDO_MS, action: { label: 'Undo', onClick: () => {
      const p = pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(id);
      p.els.forEach(el => { el.hidden = false; });
    } } });
  });

  // Leaving the page commits what's pending (the person asked for it; Undo was the exception).
  addEventListener('pagehide', () => { for (const id of [...pending.keys()]) send(id); });

  // Deleted on another device or tab.
  document.addEventListener('jb:ws:messages.deleted', e => {
    const { messageIds = [], runIds = [] } = e.detail.data;
    bubblesOf({ messageIds, runIds }).forEach(el => el.remove());
  });
}
