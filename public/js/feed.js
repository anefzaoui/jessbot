// Feed (Discover-style): reading sheet, like/less/save/share, not-interested (+Undo), topic filter,
// pull-to-refresh on touch, live status. Server contract (Phase 7c, routes/api/v1/feed.js):
//   POST /api/v1/feed/posts/:id/feedback { feedback: up|down|null } · /save { saved } · /hide { what, undo? }
//   POST /api/v1/feed/prompt { prompt } · POST /api/v1/feed/refresh → 202 { ok, state: 'working' } — the work runs on the
//   server; 'feed.progress' { state, note } drives the status line and 'feed.updated' { added } offers the new stories.
//   GET /api/v1/feed/page?<filters>&before=<cursor> → { html, next } (older stories) ·
//   GET /api/v1/feed/posts/:id/article → { status: ok|failed|null, html?, url, source } (reader mode, saved offline)
import { $, $$, on, api, h, escapeHtml, loader } from './core.js';
import { toast } from './toast.js';
import { openModal, closeModal } from './modal.js';

const postUrl = (id, action) => `/api/v1/feed/posts/${encodeURIComponent(id)}/${action}`;

// ---- Reading sheet: Jess's take, then the full article (reader mode), then the original ---------------------------
let readerSeq = 0;
function openReader(card) {
  const dlg = $('#feed-reader');
  if (!dlg) return;
  const seq = ++readerSeq;
  const title = card.querySelector('h2, h3')?.textContent.trim() || '';
  const source = card.dataset.source || card.querySelector('.truncate.font-medium')?.textContent || '';
  $('[data-reader-title]', dlg).textContent = title;
  $('[data-reader-source]', dlg).textContent = source;
  $('[data-reader-body]', dlg).innerHTML = card.querySelector('template[data-post-body]')?.innerHTML || '';
  const cover = $('[data-reader-cover]', dlg);
  const art = card.querySelector('.feed-cover img, .feed-thumb img, .feed-art');
  cover.innerHTML = '';
  cover.hidden = !art;
  if (art) { const c = art.cloneNode(true); c.style.setProperty('--h', getComputedStyle(card).getPropertyValue('--h')); cover.append(c); }
  $('[data-reader-ask]', dlg).href = `/chat?draft=${encodeURIComponent(`About “${title}”: `)}`;
  const original = $('[data-reader-original]', dlg);
  original.hidden = !card.dataset.url;
  if (card.dataset.url) { original.href = card.dataset.url; original.querySelector('span').textContent = `Open the original at ${source}`; }
  const full = $('[data-reader-full]', dlg);
  const box = $('[data-reader-article]', dlg);
  full.hidden = !card.dataset.url || !card.dataset.postId || card.classList.contains('feed-brief');
  $('[data-reader-source-line]', dlg).textContent = source ? `· ${source}` : '';
  box.className = 'mt-3';
  box.innerHTML = loader('Getting the full article…', { motion: 'reading', iconName: 'book-open' });
  openModal(dlg, card);
  dlg.querySelector('.overflow-y-auto')?.scrollTo(0, 0);
  if (card.dataset.postId && !card.classList.contains('feed-brief')) {
    signal(card.dataset.postId, 'open');
    startReading(card.dataset.postId, dlg);
  }
  // Not written yet: Jess reads it and writes her take now (the article loads alongside).
  const body = $('[data-reader-body]', dlg);
  if (card.dataset.postId && !card.hasAttribute('data-written') && !card.classList.contains('feed-brief')) {
    body.innerHTML = loader('Reading it and writing my take…', { motion: 'writing', iconName: 'pen-line' });
    api(`/api/v1/feed/posts/${encodeURIComponent(card.dataset.postId)}/take`, { method: 'POST' }).then(t => {
      if (seq !== readerSeq) return;
      body.innerHTML = t.html || '<p class="reader-loading">I couldn’t write this one up. The full article is below.</p>';
      if (t.title) $('[data-reader-title]', dlg).textContent = t.title;
      if (t.written) { // the card keeps it (no second call next time)
        card.setAttribute('data-written', '');
        const tpl = card.querySelector('template[data-post-body]');
        if (tpl) tpl.innerHTML = t.html;
      }
    }).catch(err => { if (seq === readerSeq) body.innerHTML = `<p class="reader-loading">${escapeHtml(err.message)}</p>`; });
  }
  if (full.hidden) return;
  api(`/api/v1/feed/posts/${encodeURIComponent(card.dataset.postId)}/article`).then(a => {
    if (seq !== readerSeq) return; // another story was opened meanwhile
    if (a.status === 'ok' && a.html) { box.className = 'prose-jb reader-article mt-3'; box.innerHTML = a.html; }
    else box.innerHTML = `<p class="reader-loading">I couldn't save a readable copy of this one (paywall or not an article). Open it at ${escapeHtml(a.source)} below.</p>`;
  }).catch(err => {
    if (seq === readerSeq) box.innerHTML = `<p class="reader-loading">Couldn't load the article: ${escapeHtml(err.message)}</p>`;
  });
}

let observeCards = null; // set by initFeed (impressions for cards loaded later)
const isControl = el => el.closest('button, a, [popover], input, textarea, select, [data-stop-open]');

// ---- Signals (decision #63): what was seen, opened and read — batched, sent even when the page goes away ------------
const queue = [];
let flushTimer = null;
function signal(id, kind, value = 0) {
  if (!id) return;
  queue.push({ id, kind, value });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 4000);
}
function flush() {
  if (!queue.length) return;
  const events = queue.splice(0, 100);
  // keepalive: survives navigating away; same headers as api() (the server checks them).
  fetch('/api/v1/feed/events', { method: 'POST', keepalive: true, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'jessbot' }, body: JSON.stringify({ events }) }).catch(() => {});
}
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

// Reading time: seconds the reader was open and visible, and how far it was scrolled → "read" (≥ 30 s or 60 %) or "bounce".
let reading = null;
function startReading(id, dlg) {
  const scroller = dlg.querySelector('.overflow-y-auto');
  reading = { id, since: Date.now(), total: 0, depth: 0 };
  const onScroll = () => {
    if (!reading || !scroller) return;
    reading.depth = Math.max(reading.depth, (scroller.scrollTop + scroller.clientHeight) / Math.max(1, scroller.scrollHeight));
  };
  scroller?.addEventListener('scroll', onScroll, { passive: true });
  dlg.addEventListener('close', () => {
    scroller?.removeEventListener('scroll', onScroll);
    if (!reading) return;
    const secs = (reading.total + (document.visibilityState === 'visible' ? Date.now() - reading.since : 0)) / 1000;
    signal(reading.id, secs >= 30 || reading.depth >= 0.6 ? 'read' : secs < 10 ? 'bounce' : 'open', Math.round(secs));
    reading = null;
  }, { once: true });
}
document.addEventListener('visibilitychange', () => { // pause the clock while the tab is hidden
  if (!reading) return;
  if (document.visibilityState === 'hidden') { reading.total += Date.now() - reading.since; } else reading.since = Date.now();
});

// Seen: at least half the card visible for a second (once per page view).
function watchImpressions(root) {
  if (!('IntersectionObserver' in window)) return;
  const timers = new Map(), done = new Set();
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const id = e.target.dataset.postId;
      if (!id || done.has(id)) continue;
      if (e.isIntersecting) timers.set(id, setTimeout(() => { done.add(id); signal(id, 'impression'); io.unobserve(e.target); }, 1000));
      else { clearTimeout(timers.get(id)); timers.delete(id); }
    }
  }, { threshold: 0.5 });
  const observe = scope => scope.querySelectorAll('.feed-card[data-post-id]:not(.feed-brief)').forEach(c => io.observe(c));
  observe(root);
  return observe;
}

// ---- Toggles (optimistic, revert on failure) ---------------------------------------------------
async function toggle(btn, url, body, successMsg) {
  const card = btn.closest('[data-post-id]');
  const group = btn.dataset.postFeedback ? card.querySelectorAll('[data-post-feedback]') : [btn];
  const before = [...group].map(b => b.getAttribute('aria-pressed'));
  const turningOn = btn.getAttribute('aria-pressed') !== 'true';
  group.forEach(b => b.setAttribute('aria-pressed', String(b === btn && turningOn)));
  try {
    await api(url, { method: 'POST', body: body(turningOn) });
    if (btn.dataset.postSave !== undefined) card.toggleAttribute('data-saved', turningOn);
    if (turningOn && successMsg) toast(successMsg);
  } catch (err) {
    group.forEach((b, i) => b.setAttribute('aria-pressed', before[i]));
    toast.error(err.message, { title: 'Not saved' });
  }
}

// ---- Pull to refresh (touch, when scrolled to top) ---------------------------------------------
function initPull(root) {
  const scroller = $('#main');
  const ind = $('[data-pull-indicator]', root);
  if (!scroller || !ind || !matchMedia('(pointer: coarse)').matches) return;
  let startY = null, pull = 0;
  const set = px => {
    pull = Math.max(0, Math.min(px, 110));
    ind.style.setProperty('--pull', `${pull}px`);
    ind.style.setProperty('--pull-rot', `${pull * 3}deg`);
    ind.style.setProperty('--pull-o', String(Math.min(1, pull / 60)));
  };
  scroller.addEventListener('touchstart', e => { startY = scroller.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  scroller.addEventListener('touchmove', e => { if (startY != null) set((e.touches[0].clientY - startY) * 0.5); }, { passive: true });
  scroller.addEventListener('touchend', async () => {
    if (startY == null) return;
    startY = null;
    if (pull < 70) return set(0);
    root.classList.add('is-refreshing');
    await startRefresh();
    root.classList.remove('is-refreshing');
    set(0);
  });
}

// ---- Live status (the state also comes back on reload from feed_prefs) ------------------------------------------
function setStatus(state, note) {
  const el = $('[data-feed-status]');
  if (!el) return;
  el.dataset.state = state || 'idle';
  $('[data-feed-status-text]', el).textContent = note || (state === 'working' ? 'Working on your feed…' : '');
  el.hidden = state !== 'working' && !note;
  $$('[data-feed-refresh]').forEach(b => { b.disabled = state === 'working'; });
}

async function startRefresh() {
  setStatus('working', 'Checking your sources…');
  try { await api('/api/v1/feed/refresh', { method: 'POST' }); }
  catch (err) { setStatus('error', err.message); toast.error(err.message, { title: "Couldn't refresh" }); }
}

const hasStories = () => !!$('[data-feed-stream] .feed-card');
const readerOpen = () => !!$('#feed-reader')?.open;

async function loadMore(btn) {
  if (btn.getAttribute('aria-busy') === 'true') return;
  const list = $('[data-feed-list]');
  const params = new URLSearchParams(location.search);
  // Ranked and search views page by number; history pages by cursor.
  params.set(list.dataset.mode === 'history' ? 'before' : 'page', btn.dataset.next);
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    const res = await api(`/api/v1/feed/page?${params}`);
    const frag = h(`<div>${res.html}</div>`);
    const lastDay = [...list.querySelectorAll('[data-feed-day]')].at(-1)?.dataset.feedDay;
    const firstHeader = frag.querySelector('[data-feed-day]');
    if (firstHeader && firstHeader.dataset.feedDay === lastDay && firstHeader === frag.firstElementChild) firstHeader.remove();
    const added = [...frag.children];
    list.append(...added);
    observeCards?.(list); // observing a card twice is a no-op; seen ones are skipped
    if (res.next) btn.dataset.next = res.next;
    else btn.closest('div').replaceWith(h('<p class="py-6 text-center text-xs text-ink-3">That’s everything.</p>'));
  } catch (err) {
    toast.error(err.message, { title: "Couldn't load older stories" });
  } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
}

export function initFeed() {
  const root = $('[data-feed]');
  if (!root) return;

  on(root, 'click', '.feed-card', (e, card) => { if (!isControl(e.target)) openReader(card); });
  on(root, 'keydown', '.feed-card', (e, card) => { if (e.key === 'Enter' && e.target === card) openReader(card); });

  on(root, 'click', '[data-post-feedback]', (e, b) => toggle(b, postUrl(b.closest('[data-post-id]').dataset.postId, 'feedback'),
    on => ({ feedback: on ? b.dataset.postFeedback : null }), b.dataset.postFeedback === 'up' ? 'Noted. More like this.' : "Noted. I'll show less of this."));
  on(root, 'click', '[data-post-save]', (e, b) => toggle(b, postUrl(b.closest('[data-post-id]').dataset.postId, 'save'),
    on => ({ saved: on }), 'Saved. Find it under Saved.'));

  on(root, 'click', '[data-post-share]', async (e, b) => {
    const card = b.closest('[data-post-id]');
    signal(card.dataset.postId, 'share');
    // The story's own link (the feed is private to this person); Jess's briefs have none, so the feed itself.
    const data = { title: card.querySelector('h2, h3')?.textContent.trim(), url: card.dataset.url || `${location.origin}/feed` };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(data.url); toast.success('Link copied.'); }
    } catch { /* share sheet dismissed */ }
  });

  on(document, 'click', '[data-post-hide]', async (e, item) => {
    const what = item.dataset.postHide;
    const card = document.querySelector(`[data-post-id="${item.closest('[popover]').id.replace(/^pm-/, '')}"]`);
    if (!card) return;
    const matches = what === 'topic' ? $$(`.feed-card[data-topic="${CSS.escape(card.dataset.topic)}"]`, root) : [card];
    matches.forEach(c => c.classList.add('is-hiding'));
    setTimeout(() => matches.forEach(c => { c.hidden = true; }), 200);
    const undo = async () => {
      matches.forEach(c => { c.hidden = false; c.classList.remove('is-hiding'); });
      try { await api(postUrl(card.dataset.postId, 'hide'), { method: 'POST', body: { what, undo: true } }); } catch (err) { toast.error(err.message); }
    };
    try {
      await api(postUrl(card.dataset.postId, 'hide'), { method: 'POST', body: { what } });
      toast(what === 'topic' ? `Got it. Less about ${card.dataset.topic}.` : 'Got it. Fewer from this source.', { action: { label: 'Undo', onClick: undo } });
    } catch (err) {
      matches.forEach(c => { c.hidden = false; c.classList.remove('is-hiding'); });
      toast.error(err.message, { title: 'Not saved' });
    }
  });

  on(root, 'click', '[data-feed-more]', (e, btn) => loadMore(btn));
  observeCards = watchImpressions(root);

  // "More about <topic>": follow it (the ranking lifts it and keeps it from fading).
  on(document, 'click', '[data-topic-follow]', async (e, item) => {
    const topic = item.dataset.topicFollow;
    item.closest('[popover]')?.hidePopover?.();
    try {
      await api('/api/v1/feed/topics/follow', { method: 'POST', body: { topic, on: true } });
      toast.success(`Got it. More about ${topic}.`, { action: { label: 'Undo', onClick: () => api('/api/v1/feed/topics/follow', { method: 'POST', body: { topic, on: false } }).catch(() => {}) } });
    } catch (err) { toast.error(err.message, { title: 'Not saved' }); }
  });
  const more = $('[data-feed-more]', root);
  if (more && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { const b = $('[data-feed-more]', root); if (b) loadMore(b); else io.disconnect(); } },
      { rootMargin: '600px 0px' });
    io.observe(more.closest('div'));
  }

  on(root, 'click', '[data-feed-refresh]', () => startRefresh());
  // Tune: the server has started; close the dialog and let the status line narrate.
  on(document, 'ajax:success', '#tune-feed form', () => { closeModal('tune-feed'); setStatus('working', 'Reading what you asked for…'); });

  document.addEventListener('jb:ws:feed.progress', e => {
    const { state, note } = e.detail.data;
    setStatus(state, note);
    if (state === 'error') toast.error(note, { title: 'Feed' });
  });
  document.addEventListener('jb:ws:feed.topics', e => {
    // Topic chips change after a tune: simplest correct thing is a fresh render once the stories land (feed.updated),
    // or now if nothing is on screen yet.
    if (!hasStories() && !readerOpen()) location.reload();
  });
  document.addEventListener('jb:ws:feed.updated', () => {
    if (!hasStories() && !readerOpen()) return location.reload();
    $('[data-feed-new]').hidden = false;
  });
  on(document, 'click', '[data-feed-new]', () => { sessionStorage.setItem('jb-feed-top', '1'); location.reload(); });
  try { if (sessionStorage.getItem('jb-feed-top')) { sessionStorage.removeItem('jb-feed-top'); $('#main')?.scrollTo(0, 0); } } catch { /* storage blocked */ }

  initPull(root);
}

