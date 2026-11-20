// Library: kind filter (kept in the address as ?type=, counts per kind), search (titles at once, then GET /api/v1/library?query=
// ranks by what's inside the files too, #212) + grid/list view (remembered), live updates when Jess makes or changes
// something, and the item viewer's title and description / delete (with undo) / restore-version actions.
import { $, $$, on, api, h, storage, withBusy, escapeHtml } from './core.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';

function initGrid() {
  const grid = $('[data-library-grid]');
  if (!grid) return;
  const search = $('[data-library-search]');
  const empty = $('[data-library-empty]');
  const state = $('[data-library-search-state]');
  const chips = () => $$('[data-library-filter]');
  let types = ($('[data-library-filter][aria-pressed="true"]')?.dataset.libraryFilter || 'all').split(' ');
  // The server's ranking for the current words (#212): id → place, best first; null while there are no words.
  let ranked = null;

  const apply = () => {
    const q = (search?.value || '').trim().toLowerCase();
    let shown = 0;
    for (const card of $$('[data-library-id]', grid)) {
      const rank = ranked?.get(card.dataset.libraryId);
      const ok = (types.includes('all') || types.includes(card.dataset.type))
        && (!q || rank !== undefined || card.dataset.title.toLowerCase().includes(q));
      card.hidden = !ok;
      card.style.order = q && rank !== undefined ? String(rank - 10000) : '';
      shown += ok;
    }
    if (empty) empty.hidden = shown > 0;
    return shown;
  };

  // Search: titles filter at once; then the Library search (the same one the tools use) ranks by what's inside the files too.
  let seq = 0, timer = null;
  const say = (text, tone = '') => { if (!state) return; state.textContent = text; state.dataset.tone = tone; state.hidden = !text; };
  const find = async q => {
    const mine = ++seq;
    say('Looking inside your files too…', 'busy');
    try {
      const r = await api(`/api/v1/library?query=${encodeURIComponent(q)}`);
      if (mine !== seq) return;
      ranked = new Map(r.items.map((it, i) => [it.id, i]));
      const n = apply();
      say(n ? `${n} ${n === 1 ? 'match' : 'matches'}, best first, in titles and inside the files` : '');
    } catch (err) {
      if (mine !== seq) return;
      say(`Only titles searched: ${err.message}`, 'bad');
    }
  };
  search?.addEventListener('input', () => {
    ranked = null;
    clearTimeout(timer);
    const q = search.value.trim();
    apply();
    if (q.length < 2) { seq++; say(''); return; }
    timer = setTimeout(() => find(q), 280);
  });

  const setView = view => {
    grid.classList.toggle('is-list', view === 'list');
    for (const b of $$('[data-library-view]')) {
      const on = b.dataset.libraryView === view;
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-selected', String(on));
    }
    storage.set('jb-library-view', view);
  };
  setView(storage.get('jb-library-view', 'grid'));

  // The filter lives in the address (?type=), so a refresh or a shared link opens the same view.
  on(document, 'click', '[data-library-filter]', (e, chip) => {
    for (const c of chips()) c.setAttribute('aria-pressed', String(c === chip));
    types = chip.dataset.libraryFilter.split(' ');
    const url = new URL(location.href);
    if (chip.dataset.filterKey && chip.dataset.filterKey !== 'all') url.searchParams.set('type', chip.dataset.filterKey); else url.searchParams.delete('type');
    history.replaceState(history.state, '', url);
    apply();
  });
  on(document, 'click', '[data-library-view]', (e, b) => setView(b.dataset.libraryView));

  // "Add files": the same upload as the composer's; the cards arrive over the socket (library.created).
  on(document, 'change', '[data-library-upload]', async (e, input) => {
    const chosen = [...input.files];
    input.value = '';
    if (!chosen.length) return;
    const t = toast.pending(`Adding ${chosen.length === 1 ? `“${chosen[0].name}”` : `${chosen.length} files`}…`);
    const fd = new FormData();
    for (const f of chosen.slice(0, 6)) fd.append('file', f, f.name);
    try {
      const res = await fetch('/api/v1/uploads', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-Requested-With': 'jessbot' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.errors?.file || body.error || 'Upload failed');
      const refused = body.errors?.length ? ` ${body.errors.map(x => x.error).join(' ')}` : '';
      (refused ? t.info : t.done)(`Added ${body.files.length} ${body.files.length === 1 ? 'file' : 'files'} to your Library.${refused}`);
    } catch (err) { t.fail(err.message); }
  });

  // Live: a new or changed item appears in place.
  const upsert = ({ item, html }) => {
    if (!html) return;
    const card = h(html);
    const existing = grid.querySelector(`[data-library-id="${CSS.escape(item.id)}"]`);
    if (existing) existing.replaceWith(card);
    else { grid.prepend(card); card.classList.add('animate-rise'); }
    $('[data-library-has-items]')?.removeAttribute('hidden');
    $('[data-library-none]')?.remove();
    recount();
    apply();
  };
  // Each chip counts its kind; a kind with nothing in it hides (unless it's the one chosen), and shows once something arrives.
  const recount = () => {
    const cards = [...grid.querySelectorAll('[data-library-id]')];
    for (const chip of chips()) {
      const kinds = chip.dataset.libraryFilter.split(' ');
      const n = kinds.includes('all') ? cards.length : cards.filter(c => kinds.includes(c.dataset.type)).length;
      const out = chip.querySelector('[data-filter-count]');
      if (out) out.textContent = n;
      chip.hidden = !kinds.includes('all') && !n && chip.getAttribute('aria-pressed') !== 'true';
    }
  };
  document.addEventListener('jb:ws:library.created', e => upsert(e.detail.data));
  document.addEventListener('jb:ws:library.updated', e => upsert(e.detail.data));
  document.addEventListener('jb:ws:library.deleted', e => { grid.querySelector(`[data-library-id="${CSS.escape(e.detail.data.id)}"]`)?.remove(); recount(); apply(); });
}

function initItem() {
  const root = $('[data-library-item]');
  if (!root) return;
  const id = root.dataset.libraryItem;
  const url = `/api/v1/library/${encodeURIComponent(id)}`;

  // Title and description, edited in place under the header (PATCH { title, description }); Esc or Cancel puts it back.
  const about = $('[data-library-about]');
  const aboutView = $('[data-library-about-view]');
  const template = $('template[data-library-details-template]');
  const descOf = () => { const p = $('[data-library-description]'); return p && !p.hidden ? p.textContent.trim() : ''; };
  const showItem = item => {
    $('[data-library-title]').textContent = item.title;
    document.title = document.title.replace(/^.*?(?= · [^·]*$)/, item.title);
    const p = $('[data-library-description]');
    if (p) { p.textContent = item.description || ''; p.hidden = !item.description; }
  };
  // The strip shows only when it has something to say: a description, where it came from, or a notice.
  const closeDetails = () => {
    $('[data-library-details]', about)?.remove();
    aboutView.parentElement.hidden = false;
    about.hidden = !descOf() && !aboutView.querySelector('p:not([data-library-description])') && !about.querySelector('.lib-notice');
  };
  on(document, 'click', '[data-library-details-open]', () => {
    if (!template || $('[data-library-details]', about)) return;
    $('#item-menu')?.hidePopover?.();
    about.hidden = false;
    const form = template.content.firstElementChild.cloneNode(true);
    form.elements.title.value = $('[data-library-title]').textContent.trim();
    form.elements.description.value = descOf();
    aboutView.parentElement.hidden = true;
    about.prepend(form);
    form.elements.title.focus();
    form.elements.title.select();
  });
  on(document, 'click', '[data-library-details-cancel]', closeDetails);
  on(document, 'keydown', '[data-library-details]', e => { if (e.key === 'Escape') { e.preventDefault(); closeDetails(); } });
  on(document, 'submit', '[data-library-details]', async (e, form) => {
    e.preventDefault();
    for (const p of form.querySelectorAll('[data-field-error]')) p.remove();
    await withBusy(form.querySelector('button:not([type])'), async () => {
      try {
        const res = await api(url, { method: 'PATCH', body: { title: form.elements.title.value, description: form.elements.description.value } });
        showItem(res.item);
        closeDetails();
        toast.success('Saved.');
      } catch (err) {
        const errors = err.data?.errors;
        if (errors) {
          for (const [name, msg] of Object.entries(errors)) {
            (form.elements[name] || form.elements.title).closest('[data-field]').append(h(`<p class="field-error" data-field-error>${escapeHtml(msg)}</p>`));
          }
        } else toast.error(err.message, { title: 'Not saved' });
      }
    }, 'Saving…');
  });

  on(document, 'click', '[data-library-delete]', async () => {
    if (!(await confirmDialog({ title: 'Delete this item?', body: 'You can undo this for a few seconds.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      const res = await api(url, { method: 'DELETE' });
      storage.set('jb-library-undo', { id, undo: res.undo, at: Date.now() });
      location.assign('/library');
    } catch (err) { toast.error(err.message, { title: 'Couldn’t delete' }); }
  });

  on(document, 'click', '[data-library-restore-version]', async (e, btn) => {
    const v = btn.dataset.libraryRestoreVersion;
    try {
      await api(`${url}/versions/${v}/restore`, { method: 'POST' });
      toast.success(`Restored version ${v} as the newest version.`);
      location.reload();
    } catch (err) { toast.error(err.message, { title: 'Couldn’t restore' }); }
  });

  initScan(id, url);
  initListen(id, url);

  // Jess changed this item while it's open: reload the preview in place.
  document.addEventListener('jb:ws:library.updated', e => {
    const { item } = e.detail.data;
    if (item.id !== id || String(item.version) === root.dataset.version) {
      if (item.id === id && !$('[data-library-details]')) showItem(item);
      return;
    }
    root.dataset.version = item.version;
    $('[data-library-title]').textContent = item.title;
    const frame = $('[data-library-frame]');
    if (frame) frame.src = `${item.rawUrl}?v=${item.version}`;
    else location.reload();
    toast(`Updated to version ${item.version}.`);
  });
}

// ---- Read this scan (#196): the estimate first (pages, cost, what's left this week), then the reading; a refresh while it
// reads comes back to "Reading 12 pages" (the server remembers it) and the page reloads with the text when it's done.
const clock = since => { const s = Math.max(0, Math.round((Date.now() - since) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function initScan(id, url) {
  const box = $('[data-library-ocr-box]');
  if (!box) return;
  let timer = null;
  const set = state => { box.dataset.state = state; box.hidden = false; };
  const reading = (since, pages) => {
    set('reading');
    if (pages) $('[data-ocr-reading-pages]', box).textContent = `${pages} page${pages === 1 ? '' : 's'}`;
    clearInterval(timer);
    const tick = () => { $('[data-ocr-elapsed]', box).textContent = clock(since); };
    tick();
    timer = setInterval(tick, 1000);
  };
  const failed = msg => { clearInterval(timer); set('error'); $('[data-ocr-error]', box).textContent = msg; };

  on(document, 'click', '[data-library-ocr]', async () => {
    $('#item-menu')?.hidePopover?.();
    set('checking');
    try {
      const { estimate: e } = await api(`${url}/ocr`, { method: 'POST', body: {} });
      set('estimate');
      $('[data-ocr-pages]', box).textContent = `Read ${e.pages.length} page${e.pages.length === 1 ? '' : 's'}${e.count > e.pages.length ? ` of ${e.count}` : ''}`;
      const left = e.budget?.left != null ? ` · $${e.budget.left.toFixed(2)} left this week` : '';
      $('[data-ocr-cost]', box).textContent = `${e.costLabel ? `about ${e.costLabel}` : 'the cost isn’t known for this model'}${left}${e.capped?.length ? ` · the rest after that (at most 20 at a time)` : ''}`;
      box.dataset.pages = e.pages.join(',');
    } catch (err) { failed(err.message); }
  });
  on(document, 'click', '[data-library-ocr-cancel]', () => { set('offer'); box.hidden = box.dataset.initial === 'hidden'; });
  on(document, 'click', '[data-library-ocr-confirm]', async () => {
    const pages = box.dataset.pages;
    reading(Date.now(), pages ? pages.split(',').length : 0);
    try {
      const res = await api(`${url}/ocr`, { method: 'POST', body: { confirm: true, pages } });
      clearInterval(timer);
      if (!res.read?.length) return failed(res.error || 'Nothing readable came back from those pages.');
      try { sessionStorage.setItem('jb-library-toast', `Read ${res.read.length} page${res.read.length === 1 ? '' : 's'}${res.costLabel ? ` · cost ${res.costLabel}` : ''}.`); } catch { /* storage blocked */ }
      location.reload();
    } catch (err) { failed(err.message); }
  });
  box.dataset.initial = box.hidden ? 'hidden' : 'shown';
  if (box.dataset.state === 'reading') {
    reading(Date.parse(box.dataset.started) || Date.now());
    // Reloaded mid-reading: ask until it's done (the socket's library.updated also says so), then show the text.
    const poll = async () => {
      try { const { reading: r } = await api(`${url}/ocr`); if (!r) return location.reload(); } catch { /* offline: try again */ }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  }
}

// ---- Listen (#196): how long it would be, then recording part by part (over the socket), then the new audio -----------------
function initListen(id, url) {
  const box = $('[data-library-listen-box]');
  if (!box) return;
  const set = state => { box.dataset.state = state; box.hidden = false; };
  const progress = job => {
    set('recording');
    $('[data-listen-part]', box).textContent = Math.max(1, job.part || 0);
    $('[data-listen-parts]', box).textContent = job.parts || '?';
    $('[data-listen-bar]', box).style.width = `${Math.max(4, Math.round(((job.part || 0) / (job.parts || 1)) * 100))}%`;
  };
  const show = job => {
    if (!job) return;
    if (job.status === 'recording') return progress(job);
    if (job.status === 'done') {
      set('done');
      for (const a of $$('[data-listen-link], [data-listen-play]', box)) a.href = job.audio.href;
      $('[data-listen-link]', box).textContent = `${job.audio.title}, ${job.audio.length}`;
      $('[data-listen-partial]', box).hidden = !job.partial;
      return;
    }
    set('failed');
    $('[data-listen-error]', box).textContent = `Not recorded: ${job.error}`;
  };
  on(document, 'click', '[data-library-listen]', async () => {
    if (['recording', 'checking'].includes(box.dataset.state) && !box.hidden) return box.scrollIntoView({ block: 'nearest' });
    set('checking');
    try {
      const { estimate: e } = await api(`${url}/listen`, { method: 'POST', body: {} });
      if (e.tooLong || e.overBudget) {
        set('refused');
        $('[data-listen-refused]', box).textContent = e.tooLong ? `It’s ${e.minutesLabel} of listening, over the ${e.limit}-minute limit. Ask me in the chat to read one part of it.`
          : 'This week’s budget is used up, so I can’t record it now. It resets on Monday.';
        return;
      }
      set('estimate');
      $('[data-listen-length]', box).textContent = `${e.minutesLabel[0].toUpperCase()}${e.minutesLabel.slice(1)} of listening,`;
    } catch (err) { set('failed'); $('[data-listen-error]', box).textContent = err.message; }
  });
  on(document, 'click', '[data-library-listen-confirm]', async (e, btn) => {
    await withBusy(btn, async () => {
      try { progress((await api(`${url}/listen`, { method: 'POST', body: { confirm: true } })).job); }
      catch (err) { set('failed'); $('[data-listen-error]', box).textContent = err.message; }
    }, 'Starting…');
  });
  on(document, 'click', '[data-library-listen-close]', () => { box.hidden = true; box.dataset.state = 'idle'; });
  document.addEventListener('jb:ws:library.listen', e => { if (e.detail.data.id === id) show(e.detail.data.job); });
  // Reloaded while it records: follow it (the socket brings each part; this catches one missed while reconnecting).
  if (box.dataset.state === 'recording') {
    progress({ part: Number(box.dataset.part), parts: Number(box.dataset.parts) });
    const poll = async () => {
      try { const { job } = await api(`${url}/listen`); show(job); if (job?.status !== 'recording') return; } catch { /* offline */ }
      setTimeout(poll, 4000);
    };
    setTimeout(poll, 4000);
  }
}

// ---- Audio cards play in place (#196): one plays at a time; the thin bar and the time follow it ---------------------------
function initAudioCards() {
  let current = null;
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  on(document, 'click', '[data-audio-play]', (e, btn) => {
    e.preventDefault();
    const card = btn.closest('[data-library-id]');
    if (current?.btn === btn) { current.audio.paused ? current.audio.play() : current.audio.pause(); return; }
    if (current) { current.audio.pause(); current.card.dataset.playing = 'false'; }
    const audio = new Audio(btn.dataset.audioPlay);
    const bar = card.querySelector('[data-audio-bar]'), time = card.querySelector('[data-audio-time]');
    current = { btn, card, audio };
    card.dataset.playing = 'loading';
    btn.setAttribute('aria-label', `Pause ${card.dataset.title}`);
    audio.addEventListener('playing', () => { card.dataset.playing = 'true'; });
    audio.addEventListener('pause', () => { card.dataset.playing = 'false'; btn.setAttribute('aria-label', `Play ${card.dataset.title}`); });
    audio.addEventListener('timeupdate', () => {
      if (bar && audio.duration) bar.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
      if (time) time.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration || 0)}`;
    });
    audio.addEventListener('ended', () => { card.dataset.playing = 'false'; if (bar) bar.style.width = '0%'; current = null; });
    audio.addEventListener('error', () => { card.dataset.playing = 'false'; toast.error('That audio couldn’t be played here. Open it to try again.'); current = null; });
    audio.play().catch(() => { card.dataset.playing = 'false'; });
  });
}

// "Deleted — Undo" survives the navigation back to the grid.
function offerUndo() {
  const pending = storage.get('jb-library-undo', null);
  if (!pending) return;
  storage.remove('jb-library-undo');
  if (Date.now() - pending.at > 15000) return;
  toast('Deleted from your library.', {
    action: { label: 'Undo', onClick: async () => {
      try { await api(pending.undo, { method: 'POST' }); location.reload(); } catch (err) { toast.error(err.message, { title: 'Couldn’t undo' }); }
    } },
  });
}

export function initLibrary() {
  initGrid();
  initItem();
  initAudioCards();
  try { const m = sessionStorage.getItem('jb-library-toast'); if (m) { sessionStorage.removeItem('jb-library-toast'); toast.success(m); } } catch { /* storage blocked */ }
  if ($('[data-library-grid]') || location.pathname === '/library') offerUndo();
}
