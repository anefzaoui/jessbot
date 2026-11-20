// Live runs in the chat: steps, streamed text, questions, final render, Stop / Retry, feedback.
// Everything arrives over the socket (ws.js); the server's final HTML always replaces the live bubble.
// Every frame carries its run at the top level ({ t, seq, threadId, runId, data }) — always read frame.runId.
import { $, $$, on, api, h, escapeHtml, icon, withBusy } from './core.js';
import { toast } from './toast.js';
import { setActivity } from './status.js';
import { presenceMoment } from './presence.js';
import { mountDock } from './ask.js';
import { scrollToEnd } from './composer.js';
import { renderMarkdownLite } from './markdown-lite.js';

const bubble = runId => document.querySelector(`[data-run-owner="${runId}"]`);
const chat = () => $('[data-chat]');
const nearBottom = () => { const s = $('[data-message-scroller]'); return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 160; };
const follow = fn => { const stick = nearBottom(); fn(); if (stick) scrollToEnd(false); };

// Runs still active in this thread (for the composer's Stop button).
const activeRuns = new Set();
const replaced = new Set(); // runs a Retry replaced (their late frames are ignored)
function syncRunning() {
  document.dispatchEvent(new CustomEvent('run:state', { detail: { active: activeRuns.size > 0 } }));
}

// Mirrors partials/chat/step-image.hbs.
const stepImage = s => (s.href && !String(s.image).startsWith('/shots/')
  ? `<a href="${escapeHtml(s.href)}" class="step-shot" aria-label="Open ${escapeHtml(s.label)}"><img src="${escapeHtml(s.image)}" alt="" loading="lazy" width="320" height="200"></a>`
  : `<a href="${escapeHtml(s.image)}" target="_blank" rel="noopener" class="step-shot" data-lightbox="${escapeHtml(s.image)}" aria-label="View the screenshot larger"><img src="${escapeHtml(s.image)}" alt="Screenshot: ${escapeHtml(s.detail || '')}" loading="lazy" width="320" height="200"></a>`);

// Mirrors partials/chat/run-step.hbs.
function stepLi(s) {
  return h(`<li class="tl-step" data-step-id="${escapeHtml(s.id)}" data-step-status="${escapeHtml(s.status)}">
    <span class="tl-node" aria-hidden="true">${s.favicon ? `<img src="${escapeHtml(s.favicon)}" alt="" class="step-favicon" loading="lazy" width="14" height="14">` : icon(s.iconName || 'circle-check', 'size-3')}</span>
    <span class="tl-body"><span class="tl-label">${escapeHtml(s.label)}</span>
    ${s.detail ? (s.href ? `<a href="${escapeHtml(s.href)}" class="tl-detail tl-link">${escapeHtml(s.detail)}</a>` : `<span class="tl-detail">${escapeHtml(s.detail)}</span>`) : ''}
    ${s.image ? stepImage(s) : ''}${s.handover ? `<button type="button" class="btn btn-soft btn-sm mt-1.5" data-handover>${icon('hand', 'size-3.5')} Take over the browser</button>` : ''}</span>
    ${s.durationLabel ? `<span class="tl-dur tabular">${escapeHtml(s.durationLabel)}</span>` : ''}</li>`);
}

// ---- The live card's head: headline, glyph, step count, sites (mirrors partials/chat/run-steps.hbs) ---------------
function setHeadline(live, text, { activity, iconName } = {}) {
  const now = live.querySelector('[data-run-current]');
  if (now && now.textContent.trim() !== text) {
    now.textContent = text;
    now.classList.remove('is-swapping');
    void now.offsetWidth; // restart the animation
    now.classList.add('is-swapping');
  }
  const glyph = live.querySelector('[data-run-glyph]');
  if (glyph && activity && glyph.dataset.motion !== activity) {
    glyph.dataset.motion = activity;
    glyph.innerHTML = icon(iconName || 'sparkles', 'size-[18px]');
  }
}

function syncHead(live) {
  const steps = [...live.querySelectorAll('.run-tl > .tl-step')];
  const count = live.querySelector('[data-run-count]');
  if (count && steps.length) count.textContent = `Step ${steps.length}`;
  // Between steps she is deciding what to do next.
  if (!steps.some(li => li.dataset.stepStatus === 'run')) setHeadline(live, 'Thinking…', { activity: 'thinking', iconName: 'sparkles' });
  const stack = live.querySelector('[data-run-sites]');
  if (!stack) return;
  const have = new Set([...stack.querySelectorAll('img')].map(i => i.getAttribute('src')));
  for (const img of live.querySelectorAll('.tl-node img')) {
    const src = img.getAttribute('src');
    if (have.has(src) || have.size >= 5) continue;
    have.add(src);
    stack.append(h(`<img src="${escapeHtml(src)}" alt="" width="16" height="16" class="is-new">`));
  }
  stack.hidden = !have.size;
}

// ---- Her browser tab, live, while she is on a website (the hand-over frame; polled only when it can be seen) --------
const BROWSER_ACTS = new Set(['browsing', 'looking', 'clicking', 'filling', 'choosing', 'scrolling', 'loading', 'capturing']);
const screens = new Map(); // runId → { timer, live }
function watchScreen(runId, live) {
  if (screens.has(runId) || !chat()?.dataset.threadId) return;
  const box = live.querySelector('[data-run-screen]');
  if (!box) return;
  const img = box.querySelector('[data-run-screen-img]');
  const base = `/api/v1/threads/${encodeURIComponent(chat().dataset.threadId)}/browser/frame.jpg`;
  const state = { timer: null, misses: 0 };
  screens.set(runId, state);
  const tick = async () => {
    if (!live.isConnected) return stopScreen(runId);
    const visible = document.visibilityState === 'visible' && live.getBoundingClientRect().bottom > 0;
    if (visible) {
      try {
        const res = await fetch(`${base}?t=${Date.now()}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'jessbot' } });
        if (!res.ok) throw new Error(String(res.status));
        const url = URL.createObjectURL(await res.blob());
        const old = img.src;
        img.onload = () => { if (old.startsWith('blob:')) URL.revokeObjectURL(old); };
        img.src = url;
        const page = decodeURI(res.headers.get('X-Page-Url') || '');
        box.querySelector('[data-run-screen-url]').textContent = page.replace(/^https?:\/\/(www\.)?/, '');
        state.misses = 0;
        if (box.hidden) follow(() => { box.hidden = false; });
      } catch { if (++state.misses >= 3) box.hidden = true; }
    }
    state.timer = setTimeout(tick, 2000);
  };
  tick();
}
function stopScreen(runId) {
  const s = screens.get(runId);
  if (!s) return;
  clearTimeout(s.timer);
  screens.delete(runId);
}

function onStep({ data, runId }) {
  const b = bubble(runId);
  const live = b?.querySelector('.run-live');
  if (!live) return;
  // She said something, then started using tools: that text belongs ABOVE the steps (same as the final render).
  const body = b.querySelector('[data-message-body]'), lead = b.querySelector('[data-message-lead]');
  const said = body ? (raw.has(body) ? raw.get(body) : (body.hidden ? '' : body.dataset.raw || '')) : '';
  if (data.step.status === 'run' && body && lead && said.trim()) {
    lead.insertAdjacentHTML('beforeend', renderMarkdownLite(said));
    lead.hidden = false;
    raw.set(body, '');
    delete body.dataset.raw;
    body.innerHTML = '';
    body.hidden = true;
    body.classList.remove('is-streaming');
  }
  follow(() => {
    const ol = live.querySelector('[data-run-steps]');
    if (!ol) return;
    ol.hidden = false;
    const li = stepLi(data.step);
    const existing = ol.querySelector(`[data-step-id="${CSS.escape(data.step.id)}"]`);
    if (existing) existing.replaceWith(li); else { li.classList.add('is-new'); ol.append(li); }
    if (data.step.status === 'run') setHeadline(live, data.step.label, { activity: data.step.activity || 'thinking', iconName: data.step.iconName });
    syncHead(live);
  });
  if (BROWSER_ACTS.has(data.step.activity)) watchScreen(runId, live);
}

// Streaming text is kept raw per bubble and re-rendered as markdown at most once per frame. A page opened mid-reply
// starts from the saved draft (data-raw), so formatting survives a refresh too.
const raw = new WeakMap();
const pending = new Set();
function onDelta({ data, runId }) {
  const body = bubble(runId)?.querySelector('[data-message-body]');
  if (!body) return;
  if (!raw.has(body)) raw.set(body, body.hidden ? '' : (body.dataset.raw || ''));
  const live = bubble(runId)?.querySelector('.run-live');
  if (live && !live.querySelector('.tl-step[data-step-status="run"]')) setHeadline(live, 'Writing the reply…', { activity: 'writing', iconName: 'pen-line' });
  raw.set(body, raw.get(body) + data.text);
  if (pending.has(body)) return;
  pending.add(body);
  requestAnimationFrame(() => {
    pending.delete(body);
    follow(() => {
      body.hidden = false;
      body.classList.add('is-streaming');
      body.innerHTML = renderMarkdownLite(raw.get(body));
    });
  });
}

function replaceBubble(runId, html) {
  const b = bubble(runId);
  if (!b || !html) return;
  follow(() => { const next = h(html); b.replaceWith(next); next.classList.add('animate-rise'); });
}

// Runs Jess starts on her own (scheduled task, check-in, reminder) have no bubble yet: add it to the open chat.
function appendRunBubble(frame, html) {
  const list = $('[data-message-list]');
  if (!list || !html || bubble(frame.runId) || String(frame.threadId) !== chat()?.dataset.threadId) return;
  follow(() => { const b = h(html); list.append(b); b.classList.add('animate-rise'); });
  presenceMoment('greeting', 2200);
}

function onDone(frame) {
  const { data, runId } = frame;
  stopScreen(runId);
  activeRuns.delete(runId);
  syncRunning();
  if (replaced.has(runId)) return; // retried: a late frame for the old run must not bring its bubble back
  if (data.hidden) {
    // Retried: the new reply takes the failed one's place (on every open page). Otherwise a check-in with nothing to say.
    const next = data.replacedBy;
    if (next) replaced.add(runId);
    if (next && !bubble(next.runId) && bubble(runId)) { replaceBubble(runId, next.html); activeRuns.add(next.runId); syncRunning(); }
    else bubble(runId)?.remove();
    return;
  }
  if (!bubble(runId)) return appendRunBubble(frame, data.html);
  replaceBubble(runId, data.html);
  if (data.status === 'error') toast.error('Press Retry on the message and I’ll pick it up again.', { title: 'That didn’t work' });
}

function onStatus({ data, runId }) {
  if (['queued', 'running', 'waiting'].includes(data.status)) activeRuns.add(runId); else activeRuns.delete(runId);
  syncRunning();
}

function onQuestion({ data, runId }) {
  replaceBubble(runId, data.html);
  if (!data.dock) return;
  const area = $('[data-dock-area]');
  if (!area) return;
  area.querySelector('[data-ask-dock]')?.remove();
  area.querySelector('[data-ask-pill]')?.remove();
  const frag = h(`<div>${data.dock}</div>`);
  const composer = area.querySelector('[data-composer]');
  for (const node of [...frag.children]) area.insertBefore(node, composer);
  const dock = area.querySelector('[data-ask-dock]');
  if (dock) mountDock(dock);
  presenceMoment('clarifying', 2500);
  scrollToEnd();
}

export function initRuns() {
  // Runs already active when the page rendered.
  for (const el of $$('[data-run-status]')) if (['queued', 'running', 'waiting'].includes(el.dataset.runStatus)) activeRuns.add(Number(el.dataset.runId));
  // A page opened while she's on a website: show her tab again.
  for (const g of $$('.run-live [data-run-glyph]')) if (BROWSER_ACTS.has(g.dataset.motion)) watchScreen(Number(g.closest('[data-run-id]').dataset.runId), g.closest('.run-live'));
  syncRunning();

  document.addEventListener('jb:ws:run.step', e => onStep(e.detail));
  document.addEventListener('jb:ws:run.delta', e => onDelta(e.detail));
  document.addEventListener('jb:ws:run.status', e => onStatus(e.detail));
  document.addEventListener('jb:ws:run.done', e => onDone(e.detail));
  document.addEventListener('jb:ws:run.refresh', e => replaceBubble(e.detail.runId, e.detail.data.html)); // resumed after a question / OK
  document.addEventListener('jb:ws:run.started', e => {
    if (String(e.detail.threadId) !== chat()?.dataset.threadId) return;
    appendRunBubble(e.detail, e.detail.data.html);
    activeRuns.add(e.detail.runId);
    syncRunning();
  });
  document.addEventListener('jb:ws:question.created', e => onQuestion(e.detail));
  // They sent a new message instead of answering: the question expired, so its dock (and pill) go away.
  document.addEventListener('jb:ws:question.expired', e => {
    const id = String(e.detail.data.id);
    for (const el of document.querySelectorAll(`[data-ask-dock="${CSS.escape(id)}"], [data-ask-pill="${CSS.escape(id)}"]`)) el.remove();
  });
  document.addEventListener('jb:ws:agent.state', e => setActivity(e.detail.data));
  document.addEventListener('jb:ws:agent.moment', e => presenceMoment(e.detail.data.kind));
  document.addEventListener('jb:ws:memory.updated', e => toast(`I saved ${e.detail.data.count} new thing${e.detail.data.count > 1 ? 's' : ''} to memory.`, {
    action: { label: 'View', onClick: () => location.assign('/me/memory') } }));
  // Automatic compaction tells you once; a "Compact now" you started already shows its own progress toast.
  let compactingHere = false;
  document.addEventListener('jb:ws:thread.compacted', () => { if (!compactingHere) toast('I summarized older parts of this chat to keep things fast. Nothing was deleted.'); });

  // A run the composer just started.
  document.addEventListener('chat:sent', e => { if (e.detail?.runId) { activeRuns.add(e.detail.runId); syncRunning(); } });

  // Stop / Retry
  const cancel = async id => { try { await api(`/api/v1/runs/${id}/cancel`, { method: 'POST' }); } catch (err) { toast.error(err.message, { title: "Couldn't stop it" }); } };
  on(document, 'click', '[data-run-cancel]', (e, btn) => cancel(btn.closest('[data-run-id]').dataset.runId));
  document.addEventListener('run:cancel-request', () => activeRuns.forEach(cancel));
  on(document, 'click', '[data-run-retry]', async (e, btn) => {
    const id = btn.closest('[data-run-id]').dataset.runId;
    btn.disabled = true;
    try {
      const res = await api(`/api/v1/runs/${id}/retry`, { method: 'POST' });
      replaced.add(Number(id));
      if (!bubble(res.runId)) replaceBubble(Number(id), res.runHtml); // the live event may have swapped it in already
      activeRuns.add(res.runId);
      syncRunning();
    } catch (err) { btn.disabled = false; toast.error(err.message, { title: "Couldn't retry" }); }
  });

  // A scheduled task's note (missed, or failed): run the task now (#196). Its new run arrives in the chat like any other;
  // the button says it started and stays done (the note is history).
  on(document, 'click', '[data-schedule-run]', (e, btn) => withBusy(btn, async () => {
    try {
      await api(`/api/v1/schedules/${encodeURIComponent(btn.dataset.scheduleRun)}/run`, { method: 'POST' });
      btn.outerHTML = `<span class="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-ok">${icon('circle-check', 'size-3.5')} Started below</span>`;
    } catch (err) { toast.error(err.message, { title: 'Couldn’t start it' }); }
  }, 'Starting…'));

  // A task paused after 3 failures in a row (#178): Resume from its note (#212); the note then says it runs again.
  on(document, 'click', '[data-schedule-resume]', (e, btn) => withBusy(btn, async () => {
    try {
      await api(`/api/v1/schedules/${encodeURIComponent(btn.dataset.scheduleResume)}/resume`, { method: 'POST' });
      btn.closest('[data-schedule-paused]').innerHTML = `<span class="run-stopped-icon">${icon('circle-check', 'size-4')}</span>`
        + '<p class="min-w-0 flex-1 text-ink-2">Resumed. It runs on its schedule again.</p>';
    } catch (err) { toast.error(err.message, { title: 'Couldn’t resume it' }); }
  }, 'Resuming…'));

  // "Simpler" and follow-up chips (#196): each sends a turn through the composer (optimistic bubble, Retry). The button or chip
  // shows it went (pressed) until the reply starts; a failure is on the bubble, as for a typed message.
  const sendTurn = (btn, text, extra) => {
    btn.setAttribute('aria-pressed', 'true');
    const done = () => { btn.removeAttribute('aria-pressed'); document.removeEventListener('chat:sent', done); };
    document.addEventListener('chat:sent', done);
    setTimeout(done, 15000);
    document.dispatchEvent(new CustomEvent('composer:send', { detail: { text, extra } }));
  };
  on(document, 'click', '[data-message-simpler]', (e, btn) => sendTurn(btn, btn.dataset.messageSimpler, { simpler: true }));
  on(document, 'click', '[data-follow-up]', (e, chip) => sendTurn(chip, chip.dataset.followUp, {}));

  initFeedback();

  // Side chat rename / delete (thread menu).
  const threadId = chat()?.dataset.threadId;
  on(document, 'click', '[data-thread-rename]', async () => {
    const { promptDialog } = await import('./modal.js');
    const title = await promptDialog({ title: 'Rename this chat', value: document.querySelector('[data-chat] h1')?.textContent.trim() || '' });
    if (!title) return;
    try { await api(`/api/v1/threads/${threadId}/rename`, { method: 'POST', body: { title } }); location.reload(); }
    catch (err) { toast.error(err.message); }
  });
  // Off the record (decision #123): the header button waits for the server, then the chip and a line say what changed;
  // a failure puts it back. The main chat always remembers (the server refuses, and the button isn't there).
  // The header button (aria-pressed) and the menu item (aria-checked) are one switch.
  const offToggles = () => $$('[data-offrecord-toggle]');
  const setOff = v => {
    for (const t of offToggles()) {
      t.setAttribute(t.hasAttribute('aria-checked') ? 'aria-checked' : 'aria-pressed', String(v));
      if (t.dataset.tooltip !== undefined) t.dataset.tooltip = v ? 'Off the record: nothing here becomes a memory. Press to remember again' : 'Go off the record: nothing said here becomes a memory';
    }
  };
  on(document, 'click', '[data-offrecord-toggle]', async (e, btn) => {
    if (offToggles().some(t => t.getAttribute('aria-busy') === 'true')) return;
    btn.closest('[popover]')?.hidePopover?.();
    const on_ = (btn.getAttribute('aria-pressed') ?? btn.getAttribute('aria-checked')) !== 'true';
    for (const t of offToggles()) t.setAttribute('aria-busy', 'true');
    setOff(on_);
    try {
      const r = await api(`/api/v1/threads/${threadId}/off-record`, { method: 'POST', body: { on: on_ } });
      setOff(r.offRecord);
      for (const chip of $$('[data-offrecord-chip]')) chip.hidden = !r.offRecord; // the title row (wide) and the status row (phone)
      for (const badge of $$('[data-sidechat-badge]')) badge.hidden = r.offRecord;
      toast.success(r.offRecord ? 'Off the record. Nothing said here from now on becomes a memory, unless you ask me to remember something.'
        : 'Back on the record. I’ll remember what matters from here on; the off-the-record part stays forgotten.');
    } catch (err) {
      setOff(!on_);
      toast.error(err.data?.errors?.offRecord || err.message, { title: 'Couldn’t change that' });
    } finally { for (const t of offToggles()) t.removeAttribute('aria-busy'); }
  });
  on(document, 'click', '[data-thread-compact]', async (e, item) => {
    if (compactingHere) return;
    item.closest('[popover]')?.hidePopover?.();
    compactingHere = true;
    item.setAttribute('aria-disabled', 'true');
    const t = toast.pending('Summarizing older parts of this chat… (this can take half a minute)');
    try { const r = await api(`/api/v1/threads/${threadId}/compact`, { method: 'POST' }); (r.compacted ? t.done : t.info)(r.message); }
    catch (err) { t.fail(`Couldn't compact: ${err.message}`); }
    finally { item.removeAttribute('aria-disabled'); setTimeout(() => { compactingHere = false; }, 3000); } // its WS frame may arrive just after
  });
  on(document, 'click', '[data-thread-delete]', async () => {
    const { confirmDialog } = await import('./modal.js');
    if (!(await confirmDialog({ title: 'Delete this side chat?', body: 'It disappears from your list. Memories it created stay.', confirmLabel: 'Delete', danger: true }))) return;
    try { const r = await api(`/api/v1/threads/${threadId}/delete`, { method: 'POST' }); location.assign(r.redirect || '/chat'); }
    catch (err) { toast.error(err.message); }
  });
}

// ---- Reply feedback (#211) ------------------------------------------------------------------------------------------------
// Thumbs up / down are optimistic. A thumbs-down is saved at once ({ noteFirst }) and asks "What was off?" under the reply
// (the chat page's <template>); Send or Skip runs the post-mortem, and its "Noted: …" chip (server-rendered) takes the form's
// place with Keep / No, or a thank-you line when there was nothing general to learn. Taking the thumbs-down back (or a thumbs-
// up) removes the form and a guess they never kept (the server withdrew it). Server contract: POST /api/v1/messages/:id/feedback
// { feedback: up|down|null, note?, noteFirst? } → { lesson, chip, html, waiting? } · POST /api/v1/me/lessons/:id/keep ·
// DELETE /api/v1/me/lessons/:id { reject } (reject: a guess; the same one isn't made again).
function initFeedback() {
  const url = art => `/api/v1/messages/${art.dataset.dbId}/feedback`;
  const slotOf = art => art.querySelector('[data-noted-slot]');
  const setSlot = (art, node) => {
    const slot = slotOf(art);
    if (!slot) return null;
    slot.replaceChildren(...(node ? [node] : []));
    slot.hidden = !node;
    return node;
  };
  const clearGuess = art => {
    const form = art.querySelector('[data-fb-note]');
    const chip = art.querySelector('[data-noted]');
    if (form || chip?.dataset.state === 'proposed' || chip?.dataset.state === 'rejected' || chip?.dataset.state === 'removed') setSlot(art, null);
  };

  function openNote(art) {
    const tpl = $('template[data-fb-note-template]');
    const chip = art.querySelector('[data-noted]');
    if (!tpl || !slotOf(art) || art.querySelector('[data-fb-note]') || ['active', 'kept'].includes(chip?.dataset.state)) return; // told us already
    const form = setSlot(art, tpl.content.firstElementChild.cloneNode(true));
    const text = form.querySelector('[data-fb-note-text]');
    text.focus({ preventScroll: true });
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function sendNote(form, note) {
    const art = form.closest('[data-db-id]');
    if (!art || form.dataset.state === 'thinking') return;
    const err = form.querySelector('[data-fb-note-error]');
    err.hidden = true;
    form.dataset.state = 'thinking';
    try {
      const r = await api(url(art), { method: 'POST', body: { feedback: 'down', ...(note ? { note } : {}) } });
      if (!form.isConnected) return; // taken back meanwhile
      if (r.html) {
        const chip = setSlot(art, h(r.html));
        chip.classList.add('just-changed');
      } else {
        form.dataset.state = 'thanks';
        setTimeout(() => { if (form.isConnected && form.dataset.state === 'thanks') setSlot(art, null); }, 6000);
      }
    } catch (e) {
      if (!form.isConnected) return;
      form.dataset.state = 'asking';
      err.textContent = `${e.message} Your thumbs-down is saved; try again or skip.`;
      err.hidden = false;
    }
  }

  on(document, 'click', '[data-message-feedback]', async (e, btn) => {
    const art = btn.closest('[data-db-id]');
    if (!art) return;
    const on_ = btn.getAttribute('aria-pressed') !== 'true';
    const kind = btn.dataset.messageFeedback;
    const group = art.querySelectorAll('[data-message-feedback]');
    const before = [...group].map(b => b.getAttribute('aria-pressed'));
    group.forEach(b => b.setAttribute('aria-pressed', String(b === btn && on_)));
    const down = on_ && kind === 'down';
    if (down) openNote(art); else clearGuess(art);
    try { await api(url(art), { method: 'POST', body: { feedback: on_ ? kind : null, ...(down ? { noteFirst: true } : {}) } }); }
    catch (err) {
      group.forEach((b, i) => b.setAttribute('aria-pressed', before[i]));
      if (down && art.querySelector('[data-fb-note]')) setSlot(art, null);
      toast.error(err.message, { title: 'Not saved' });
    }
  });

  on(document, 'submit', '[data-fb-note]', (e, form) => {
    e.preventDefault();
    const note = form.querySelector('[data-fb-note-text]').value.trim();
    sendNote(form, note);
  });
  on(document, 'click', '[data-fb-note-skip]', (e, btn) => sendNote(btn.closest('[data-fb-note]'), ''));
  on(document, 'keydown', '[data-fb-note-text]', (e, ta) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.form.requestSubmit(); }
    else if (e.key === 'Escape') { e.preventDefault(); sendNote(ta.form, ''); }
  });

  // The chip: Keep (a guess becomes one of their rules), No (a guess, never guessed again), Remove (one their words made).
  const decide = async (btn, state, call) => {
    const chip = btn.closest('[data-noted]');
    if (chip.hasAttribute('data-pending')) return;
    chip.setAttribute('data-pending', '');
    await withBusy(btn, async () => {
      try {
        await call(chip.dataset.noted);
        chip.dataset.state = state;
        chip.classList.remove('just-changed');
        void chip.offsetWidth;
        chip.classList.add('just-changed');
      } catch (err) {
        if (err.status === 404) { chip.dataset.state = 'removed'; return; } // gone already (another tab, You → Memory)
        toast.error(err.message, { title: 'Couldn’t change that', action: { label: 'Try again', onClick: () => btn.click() } });
      } finally { chip.removeAttribute('data-pending'); }
    });
  };
  on(document, 'click', '[data-noted-keep]', (e, btn) => decide(btn, 'kept',
    id => api(`/api/v1/me/lessons/${encodeURIComponent(id)}/keep`, { method: 'POST' })));
  on(document, 'click', '[data-noted-no]', (e, btn) => {
    const reject = btn.dataset.notedNo === 'reject';
    decide(btn, reject ? 'rejected' : 'removed', id => api(`/api/v1/me/lessons/${encodeURIComponent(id)}`, { method: 'DELETE', body: { reject } }));
  });
}

// ---- /chat/<thread>#run-<id> (#212): evidence links (the self-review), a background task's "started from" link ----------
// Scroll that reply into view and mark it once, instead of jumping to the end. A run older than what the page shows says so.
export function focusRunAnchor({ smooth = false } = {}) {
  const m = /^#run-(\d+)$/.exec(location.hash);
  if (!m || !chat()) return false;
  const el = document.getElementById(`run-${m[1]}`);
  if (!el) {
    toast('That task is further back than this page shows, so I opened the latest part of the chat.', { title: 'Not on this page' });
    return false;
  }
  el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'instant' });
  el.classList.remove('is-target');
  void el.offsetWidth;
  el.classList.add('is-target');
  return true;
}
addEventListener('hashchange', () => focusRunAnchor({ smooth: true }));
