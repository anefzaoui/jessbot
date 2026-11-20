// Hand-over (decision #61): take over Jess's browser tab from the chat — see it live, click, scroll and type in it (sign in,
// solve a check, a step only you should do), then hand it back and she continues. In-house. The tab plays as live video (an
// MJPEG stream of Chromium's screencast, decision #115) — polled JPEGs only if the stream can't start — and a sidebar
// mirrors the chat card's live timeline (the same steps, headline, elapsed time and Stop), so you see what she's doing.
// Server contract (routes/api/v1/browser.js): GET /api/v1/threads/:id/browser/frame.jpg · POST …/browser/input
//   { kind: click {x,y fractions} | wheel {dy} | type {text} | key {key} | back | reload } → { url, title } · POST …/browser/done
import { $, on, api, h, icon, escapeHtml } from './core.js';
import { scrollToEnd } from './composer.js';
import { toast } from './toast.js';

let dlg, img, urlEl, siteEl, warnEl, textEl, threadId, timer = null, loading = false, alive = false, streaming = false, infoTimer = null, sideObs = null;
let touched = false; // did the person click/type/scroll in the tab this time (vs. just watching)

// The styleguide's simulated backend (<html data-api-base>) serves the frames too, so the viewer can be shown without a browser.
const base = () => `${document.documentElement.dataset.apiBase || ''}/api/v1/threads/${encodeURIComponent(threadId)}/browser`;

function build() {
  const bot = escapeHtml(document.documentElement.dataset.botName || 'Jess');
  dlg = document.createElement('dialog');
  dlg.className = 'handover';
  dlg.setAttribute('aria-label', `${document.documentElement.dataset.botName || 'Jess'}’s browser`);
  dlg.innerHTML = `
    <header class="handover-bar">
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-ho="back" aria-label="Back">${icon('arrow-left', 'size-4')}</button>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-ho="reload" aria-label="Reload">${icon('rotate-cw', 'size-4')}</button>
      <div class="handover-where">
        <p class="handover-site" data-ho-site>Loading…</p>
        <p class="handover-url" data-ho-url></p>
      </div>
      <button type="button" class="btn btn-primary btn-sm" data-ho-done>${icon('hand', 'size-4')} Hand back</button>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-ho-close aria-label="Close, just watching" data-tooltip="Close">${icon('x', 'size-4')}</button>
    </header>
    <div class="handover-warn" role="alert" data-ho-warn hidden></div>
    <div class="handover-main">
      <div class="handover-stage" data-ho-stage>
        <img alt="Jess’s browser tab" draggable="false" data-ho-img>
        <span class="handover-live" data-ho-live hidden><span class="live-dot"></span> Live</span>
      </div>
      <details class="handover-side" data-ho-side open>
        <summary class="handover-side-h">${icon('list-checks', 'size-4')}<span class="flex-1">What ${bot} is doing</span><span class="handover-side-count" data-ho-side-count></span></summary>
        <div class="handover-side-body" data-ho-side-body></div>
      </details>
    </div>
    <form class="handover-keys" data-ho-type>
      <input class="input h-9 flex-1 text-sm" placeholder="Type into the page (then Send or Enter)" autocomplete="off" autocapitalize="off" spellcheck="false" data-ho-text>
      <button class="btn btn-secondary btn-sm">Send</button>
      <button type="button" class="btn btn-ghost btn-sm" data-ho-key="Enter">Enter</button>
      <button type="button" class="btn btn-ghost btn-sm" data-ho-key="Tab">Tab</button>
      <button type="button" class="btn btn-ghost btn-sm" data-ho-key="Backspace" aria-label="Backspace">${icon('delete', 'size-4')}</button>
    </form>
    <p class="handover-note">You're using ${bot}'s own browser. What you type goes to the page only: ${bot} doesn't see passwords.</p>`;
  document.body.append(dlg);
  img = $('[data-ho-img]', dlg);
  urlEl = $('[data-ho-url]', dlg);
  siteEl = $('[data-ho-site]', dlg);
  warnEl = $('[data-ho-warn]', dlg);
  textEl = $('[data-ho-text]', dlg);

  img.addEventListener('click', e => {
    const r = img.getBoundingClientRect();
    send({ kind: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  });
  img.addEventListener('wheel', e => { e.preventDefault(); send({ kind: 'wheel', dy: e.deltaY }); }, { passive: false });
  let touchY = null;
  img.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
  img.addEventListener('touchend', e => {
    if (touchY == null) return;
    const dy = touchY - e.changedTouches[0].clientY;
    touchY = null;
    if (Math.abs(dy) > 30) send({ kind: 'wheel', dy: dy * 2 });
  });
  on(dlg, 'click', '[data-ho]', (e, b) => send({ kind: b.dataset.ho }));
  on(dlg, 'click', '[data-ho-key]', (e, b) => send({ kind: 'key', key: b.dataset.hoKey }));
  $('[data-ho-type]', dlg).addEventListener('submit', async e => {
    e.preventDefault();
    const text = textEl.value;
    if (!text) return send({ kind: 'key', key: 'Enter' });
    textEl.value = '';
    await send({ kind: 'type', text });
  });
  $('[data-ho-done]', dlg).addEventListener('click', handBack);
  $('[data-ho-close]', dlg).addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => {
    stop();
    // Closed without "Hand back" (✕ or Esc): nothing is sent to the chat. If they did use the tab, Jess still learns it
    // on her next look at the page (and a sign-in is kept) — quietly.
    if (touched && !handingBack) api(`${base()}/done`, { method: 'POST', body: { quiet: true } }).catch(() => {});
    touched = false;
  });
}

async function send(ev) {
  touched = true;
  try {
    const res = await api(`${base()}/input`, { method: 'POST', body: ev });
    if (res?.url) showWhere({ url: res.url, title: res.title });
    if (!streaming) refresh();
  } catch (err) { toast.error(err.message, { title: 'The browser didn’t take that' }); }
}

// Live video: the <img> plays the MJPEG stream itself. If it can't (an error before or during the stream), frames are
// polled instead — the next one asked as soon as the last arrived.
function startStream() {
  streaming = true;
  const live = $('[data-ho-live]', dlg);
  img.onload = () => { live.hidden = false; };
  img.onerror = () => {
    if (!alive || !streaming) return;
    streaming = false;
    live.hidden = true;
    img.onload = img.onerror = null;
    refresh();
  };
  img.src = `${base()}/stream.mjpg?t=${Date.now()}`;
}

// Which site the tab is on, large, before anyone types into it (Phase 25, #196): the registrable domain the server worked out
// (`site`), the page title and address under it, and anything that looks wrong about the site (`warnings`: a look-alike name,
// a password over http…) as a line above the page. Without a site from the server, the address's own host stands in.
function showWhere({ url, title, site, warnings }) {
  let host = site;
  if (!host) { try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = url; } }
  siteEl.textContent = host;
  urlEl.textContent = title ? `${title} · ${url}` : url;
  urlEl.title = url;
  if (Array.isArray(warnings)) {
    warnEl.hidden = !warnings.length;
    warnEl.innerHTML = warnings.length ? `${icon('shield-alert', 'size-4 shrink-0')}<div><p class="font-medium">Check this is the site you meant before you type anything</p>`
      + `<ul role="list">${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>` : '';
    dlg.classList.toggle('has-warning', warnings.length > 0);
  }
}

// Title and address of the tab, kept current while the viewer is open (the stream carries only pixels).
async function syncInfo() {
  if (!alive) return;
  const info = await api(base()).catch(() => null);
  if (info?.open && info.url) showWhere(info);
  else if (info && !info.open) { toast.error('Jess’s browser tab is closed.', { title: 'Nothing to take over' }); dlg.close(); return; }
  infoTimer = setTimeout(syncInfo, 2000);
}

// The sidebar is the chat card's live timeline, mirrored: whatever run.js draws in the newest reply shows here too.
function mirrorSide() {
  const body = $('[data-ho-side-body]', dlg);
  const count = $('[data-ho-side-count]', dlg);
  // The newest reply that has a timeline (a plain reply after it — a check-in, a reminder — has none to show).
  const slot = [...document.querySelectorAll('[data-message-list] [data-run-owner] [data-run-slot]')].at(-1);
  if (!slot) {
    body.innerHTML = '<p class="handover-side-empty">Nothing running right now. Her steps appear here as she works.</p>';
    count.textContent = '';
    return;
  }
  const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  const copy = slot.cloneNode(true);
  copy.querySelectorAll('[data-run-screen], [data-handover]').forEach(el => el.remove()); // this IS the screen
  copy.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  copy.querySelectorAll('details').forEach(d => { d.open = true; }); // a finished reply: show its steps
  body.replaceChildren(...copy.childNodes);
  const steps = body.querySelectorAll('.tl-step').length;
  count.textContent = steps ? String(steps) : '';
  if (stick) body.scrollTop = body.scrollHeight;
}
let sideQueued = false;
function watchSide() {
  mirrorSide();
  const list = document.querySelector('[data-message-list]');
  if (!list) return;
  sideObs = new MutationObserver(() => {
    if (sideQueued) return;
    sideQueued = true;
    requestAnimationFrame(() => { sideQueued = false; if (alive) mirrorSide(); });
  });
  sideObs.observe(list, { subtree: true, childList: true, attributes: true, characterData: true });
}

// Fallback: poll frames without piling up.
function refresh() {
  if (!alive || loading || streaming) return;
  loading = true;
  clearTimeout(timer);
  const next = new Image();
  next.onload = () => { img.src = next.src; loading = false; timer = setTimeout(refresh, 250); };
  next.onerror = async () => {
    loading = false;
    if (!alive) return;
    // A frame can fail mid-navigation (503): keep going while the tab is still open; close only when it's gone.
    const info = await api(base()).catch(() => null);
    if (info?.open) { timer = setTimeout(refresh, 1000); return; }
    toast.error('Jess’s browser tab is closed.', { title: 'Nothing to take over' });
    dlg.close();
  };
  next.src = `${base()}/frame.jpg?t=${Date.now()}`;
}

function stop() {
  alive = false;
  streaming = false;
  clearTimeout(timer);
  clearTimeout(infoTimer);
  sideObs?.disconnect();
  sideObs = null;
  img.onload = img.onerror = null;
  img.removeAttribute('src'); // ends the stream: the server stops the screencast
  $('[data-ho-live]', dlg).hidden = true;
}

// The server decides how Jess hears about it (routes/api/v1/browser.js): one message when she's idle, nothing while she's
// still on it, or a pointer to her open question — so handing back twice never queues two replies.
let handingBack = false;
async function handBack() {
  if (handingBack) return;
  handingBack = true;
  const btn = dlg.querySelector('[data-ho-done]');
  btn?.setAttribute('aria-busy', 'true');
  try {
    const r = await api(`${base()}/done`, { method: 'POST' });
    dlg.close();
    if (r.next === 'sent') {
      const list = $('[data-message-list]');
      if (list) { list.append(h(r.messageHtml), h(r.runHtml)); document.dispatchEvent(new CustomEvent('chat:sent', { detail: { runId: r.runId } })); }
      scrollToEnd();
    } else if (r.next === 'running') toast.success('Handed back. Jess will take a fresh look at the page.');
    else toast('Handed back. Answer her question to let her continue.', { title: 'Jess is waiting for you' });
  } catch (err) {
    toast.error(err.message, { title: 'Couldn’t hand it back' });
  } finally { handingBack = false; btn?.removeAttribute('aria-busy'); }
}

export function openHandover(id) {
  if (!dlg) build();
  threadId = id;
  alive = true;
  touched = false;
  urlEl.textContent = '';
  siteEl.textContent = 'Loading…';
  warnEl.hidden = true;
  if (!dlg.open) dlg.showModal();
  startStream();
  syncInfo();
  watchSide();
  textEl.focus({ preventScroll: true });
}

export function initHandover() {
  on(document, 'click', '[data-handover]', e => {
    e.preventDefault();
    const id = $('[data-chat]')?.dataset.threadId;
    if (!id) return toast.error('Open the chat this belongs to first.');
    openHandover(id);
  });
}
