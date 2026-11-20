// The card under a reminder's note in the chat (Phase 25, decision #205; partials/chat/reminder-card.hbs).
//  - Done: the button works while the server closes the reminder, then every card of that reminder says "Done at 6:02 PM.
//    I've stopped reminding you."; a failure says why on the card, and the button is back.
//  - It stays true across devices and later nudges: every alarm.updated frame repaints the reminder's cards (the nudge line,
//    closed, which note is the newest; older nudges fold to one line).
//  - A consent request (may I tell you when they miss a reminder?): Yes / No, and "Change to …" afterwards; the
//    reminder.consent frame repaints it when they answered in words or on another device.
// Server contract: POST /api/v1/alarms/:id/done → { alarm } · POST /api/v1/alarms/consents/:id { allow } → { consent }.
import { $, $$, on, api, withBusy } from './core.js';
import { toast } from './toast.js';

const clock = iso => new Date(iso).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });

// Paint one reminder card from an alarm view (the server's words; only the state and a few values change here).
function paint(card, alarm) {
  const f = alarm.followUp;
  if (!f) return;
  card.dataset.state = f.awaiting ? 'waiting' : f.closed ? 'closed' : 'idle';
  card.dataset.done = String(!!f.closed?.done);
  if (f.lastPostId != null) card.dataset.latest = String(String(f.lastPostId) === card.dataset.post);
  if (f.line) $('[data-rem-line]', card).textContent = f.line;
  if (f.closed) {
    $('[data-rem-closed-at]', card).textContent = f.closed.at ? ` at ${clock(f.closed.at)}` : '';
    $('.rem-closed-stop', card).hidden = f.closed.how !== 'stop';
    $('.rem-closed-missed', card).hidden = f.closed.how !== 'unconfirmed';
    $('[data-rem-mark]', card).hidden = !f.closed.canMarkDone;
  }
}
const cardsOf = id => $$(`[data-reminder-card][data-alarm-id="${CSS.escape(String(id))}"]`);

export function initReminderCards() {
  on(document, 'click', '[data-reminder-done]', async (e, btn) => {
    const card = btn.closest('[data-reminder-card]');
    const err = $('[data-rem-error]', card);
    err.hidden = true;
    card.setAttribute('data-pending', '');
    await withBusy(btn, async () => {
      try {
        const r = await api(`/api/v1/alarms/${encodeURIComponent(card.dataset.alarmId)}/done`, { method: 'POST' });
        for (const c of cardsOf(card.dataset.alarmId)) paint(c, r.alarm);
        if (card.dataset.state === 'closed' || card.dataset.state === 'idle') card.classList.add('just-changed');
        toast.success('Marked done. No more nudges.');
      } catch (e2) {
        err.textContent = `Not marked done: ${e2.message}`;
        err.hidden = false;
      } finally {
        card.removeAttribute('data-pending');
      }
    }, 'Marking done…');
  });
  document.addEventListener('jb:ws:alarm.updated', e => {
    const alarm = e.detail?.data?.alarm;
    if (alarm) for (const c of cardsOf(alarm.id)) if (!c.hasAttribute('data-pending')) paint(c, alarm);
  });

  on(document, 'click', '[data-consent-answer]', async (e, btn) => {
    const card = btn.closest('[data-consent-card]');
    const allow = btn.dataset.consentAnswer === 'yes';
    const err = $('[data-rem-error]', card);
    err.hidden = true;
    card.setAttribute('data-pending', '');
    await withBusy(btn, async () => {
      try {
        const r = await api(`/api/v1/alarms/consents/${encodeURIComponent(card.dataset.consentId)}`, { method: 'POST', body: { allow } });
        card.dataset.status = r.consent?.status || (allow ? 'granted' : 'declined');
        card.classList.add('just-changed');
        toast.success(allow ? 'Thanks. I’ll only tell you when a reminder goes unconfirmed.' : 'Understood. I won’t tell you.');
      } catch (e2) {
        err.textContent = `Not saved: ${e2.message}`;
        err.hidden = false;
      } finally {
        card.removeAttribute('data-pending');
      }
    }, 'Saving…');
  });
  document.addEventListener('jb:ws:reminder.consent', e => {
    const c = e.detail?.data?.consent;
    if (!c) return;
    for (const card of $$(`[data-consent-card][data-consent-id="${CSS.escape(String(c.id))}"]`)) if (!card.hasAttribute('data-pending')) card.dataset.status = c.status;
  });
}
