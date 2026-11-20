// Alarms & timers in the browser: the ringing dock (with an in-house WebAudio chime), Stop / Snooze synced across
// every device, live countdowns, and live refresh of Upcoming (page + panel) from server-rendered fragments.
import { $, $$, on, api, h, withBusy } from './core.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';

// ---- Sound: a soft two-note chime, repeated while anything rings ----------------------------------------
let audio = null, loop = null;
const unlock = () => {
  try { audio ||= new AudioContext(); if (audio.state === 'suspended') audio.resume(); } catch { /* no audio */ }
  if (loop === 'pending') startTone();
};
['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, unlock, { capture: true, passive: true }));

function chime() {
  const t = audio.currentTime;
  for (const [f, at] of [[880, 0], [1318.5, 0.18], [880, 0.6], [1318.5, 0.78]]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + at);
    g.gain.exponentialRampToValueAtTime(0.25, t + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.45);
    o.connect(g).connect(audio.destination);
    o.start(t + at); o.stop(t + at + 0.5);
  }
  navigator.vibrate?.([300, 150, 300]);
}

function startTone() {
  if (!audio || audio.state !== 'running') {
    loop = 'pending'; // browsers only allow sound after a tap: offer one
    $$('[data-alarm-unmute]').forEach(b => { b.hidden = false; });
    return;
  }
  if (typeof loop === 'number') return;
  $$('[data-alarm-unmute]').forEach(b => { b.hidden = true; });
  chime();
  loop = setInterval(chime, 1800);
}
function stopTone() { if (typeof loop === 'number') clearInterval(loop); loop = null; }
const syncTone = () => ($('[data-alarm-dock] [data-alarm-ring]') ? startTone() : stopTone());

// ---- Ringing dock ----------------------------------------------------------------------------------------
async function ring(alarm) {
  const dock = $('[data-alarm-dock]');
  if (!dock || dock.querySelector(`[data-alarm-ring="${alarm.id}"]`)) return;
  try {
    const { html } = await api(`/alarms/${alarm.id}/ring`);
    if (html && !dock.querySelector(`[data-alarm-ring="${alarm.id}"]`)) dock.append(h(html));
  } catch { /* it may already have been stopped elsewhere */ }
  syncTone();
}

function unring(id) {
  $(`[data-alarm-dock] [data-alarm-ring="${id}"]`)?.remove();
  syncTone();
}

// ---- Live refresh of Upcoming (page body + every panel copy) ---------------------------------------------
let refreshTimer = null;
function refreshUpcoming() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!$('[data-upcoming-body], [data-upcoming-panel]')) return;
    try {
      const { body, panel } = await api('/upcoming/fragments');
      $$('[data-upcoming-body]').forEach(el => { el.innerHTML = body; });
      $$('[data-upcoming-panel]').forEach(el => { el.innerHTML = panel; });
      tickCountdowns();
    } catch { /* next change will retry */ }
  }, 150);
}

// ---- Countdowns ("7:42 left") ------------------------------------------------------------------------------
function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}
function tickCountdowns() {
  for (const el of $$('[data-countdown]')) el.textContent = fmt(new Date(el.dataset.countdown) - Date.now());
}

export function initAlarms() {
  document.addEventListener('jb:ws:alarm.ring', e => ring(e.detail.data.alarm));
  document.addEventListener('jb:ws:alarm.updated', e => {
    const { alarm } = e.detail.data;
    if (alarm.status !== 'ringing') unring(alarm.id);
    else ring(alarm);
    refreshUpcoming();
  });
  document.addEventListener('jb:ws:run.done', refreshUpcoming); // a task may have scheduled something

  on(document, 'click', '[data-alarm-unmute]', () => { unlock(); syncTone(); });
  on(document, 'click', '[data-alarm-action]', async (e, btn) => {
    const card = btn.closest('[data-alarm-id]'); // data-noun: Alarm / Reminder / Timer
    const id = card.dataset.alarmId;
    const action = btn.dataset.alarmAction;
    // Removing something from Upcoming is final — ask first (owner request).
    if (action === 'cancel' && !(await confirmDialog({ title: `Delete this ${(card.dataset.noun || 'item').toLowerCase()}?`,
      body: card.dataset.label ? `“${card.dataset.label}” won't ring or remind you.` : 'It won’t ring or remind you.', confirmLabel: 'Delete', danger: true }))) return;
    await withBusy(btn, async () => {
      try {
        await api(`/api/v1/alarms/${id}/${action}`, { method: 'POST' });
        if (action !== 'cancel') unring(id);
        if (action === 'snooze') toast('Snoozed for 9 minutes.');
        refreshUpcoming();
      } catch (err) { toast.error(err.message, { title: 'That didn’t work' }); }
    });
  });

  on(document, 'click', '[data-job-action]', async (e, btn) => {
    const id = btn.closest('[data-job-id]').dataset.jobId;
    const action = btn.dataset.jobAction;
    if (action === 'delete' && !(await confirmDialog({ title: `Delete “${btn.dataset.title || 'this task'}”?`,
      body: 'It stops for good. Past results stay in your chat.', confirmLabel: 'Delete', danger: true }))) return;
    // Run it now: the card says "Running now" at once (every copy: page and panel); a failure puts back what it said.
    const cards = action === 'run' ? [...document.querySelectorAll(`[data-job-id="${id}"]`)] : [];
    const before = cards.map(c => c.dataset.status);
    for (const c of cards) c.dataset.status = 'running';
    await withBusy(btn, async () => {
      try {
        const res = await api(`/api/v1/schedules/${id}/${action}`, { method: 'POST' });
        if (action === 'delete') toast.success('Deleted.');
        if (action === 'run') toast('Started. The result will appear in chat.', { action: { label: 'Open chat', onClick: () => location.assign(`/chat/${res.threadId}`) } });
        refreshUpcoming();
      } catch (err) {
        cards.forEach((c, i) => { c.dataset.status = before[i]; });
        toast.error(err.message, { title: 'That didn’t work' });
      }
    });
  });

  // Settings that save as soon as they change (e.g. check-ins).
  on(document, 'change', 'form[data-autosubmit]', (e, form) => form.requestSubmit());

  tickCountdowns();
  setInterval(tickCountdowns, 1000);
  syncTone();
}
