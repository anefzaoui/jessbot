// Lists (decision #139; screens in Phase 25, decision #174): the index (/lists) and one list (/lists/:id).
//   - Tick: the box and the strike show at once, a ring runs while the server confirms; a failure puts it back and says
//     so (Try again). Rows move to "Done" only once you pause, so ticking five things in a shop doesn't reshuffle the list.
//   - Add: an optimistic row shimmers until the server has it (it may merge into one already there: "Milk 2L" updates
//     Milk); a failed one stays with Retry / Remove. The half-typed item survives a refresh.
//   - Everything else (change, remove with Undo, clear ticked, rename, archive with Undo, restore) shows pending → done.
//   - Live: list.updated { listId } → the page re-renders its part from the server (GET …?fragment=1, one source of
//     markup), never while you are mid-change; rows someone else changed flash once.
import { $, $$, on, api, h, escapeHtml, withBusy, storage } from './core.js';
import { toast } from './toast.js';
import { promptDialog, confirmDialog } from './modal.js';

const listUrl = id => `/api/v1/lists/${encodeURIComponent(id)}`;
const ARCHIVED_KEY = 'jb-list-archived';

// ---- The index ----------------------------------------------------------------------------------------------------
function initIndex() {
  const root = $('[data-lists-page]');
  if (!root) return;
  const form = $('[data-list-new-form]');
  const toggle = $('[data-list-new]');
  const title = $('[data-list-new-title]');

  const sync = () => {
    const kind = form.elements.kind.value;
    const place = form.elements.scope?.value || 'private';
    title.placeholder = form.querySelector(`input[name="kind"][value="${kind}"]`)?.dataset.placeholder || '';
    for (const w of $$('[data-list-wisher]', form)) {
      const shown = kind === 'wish' && w.dataset.listWisher === place;
      w.hidden = !shown;
      $('select', w).disabled = !shown;
    }
  };
  const open = kind => {
    if (kind) { const r = form.querySelector(`input[name="kind"][value="${kind}"]`); if (r) r.checked = true; }
    form.hidden = false;
    toggle?.setAttribute('aria-expanded', 'true');
    sync();
    title.focus();
  };
  const close = () => { form.hidden = true; toggle?.setAttribute('aria-expanded', 'false'); toggle?.focus(); };
  toggle?.addEventListener('click', () => (form.hidden ? open() : close()));
  on(root, 'click', '[data-list-new-cancel]', close);
  on(root, 'click', '[data-list-start]', (e, b) => open(b.dataset.listStart));
  form.addEventListener('change', sync);
  form.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  // forms.js sends it (busy button, inline errors); a list of that name already there opens instead of a second one.
  form.addEventListener('ajax:success', e => {
    const { list, existed } = e.detail || {};
    if (!list) return;
    if (existed) storage.set('jb-list-note', { id: list.id, text: `You already had “${list.title}” there, so here it is.` });
    location.assign(`/lists/${list.id}`);
  });

  let timer = 0;
  const refresh = async () => {
    try {
      const r = await api('/api/v1/lists?fragment=1');
      const wasOpen = $('[data-lists-archived]')?.open;
      const body = $('[data-lists-body]');
      body.replaceWith(h(r.html));
      if (wasOpen && $('[data-lists-archived]')) $('[data-lists-archived]').open = true;
    } catch { /* the next change or visit brings it */ }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 200); };
  document.addEventListener('jb:ws:list.updated', later);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') later(); });

  on(root, 'click', '[data-list-restore]', (e, btn) => withBusy(btn, async () => {
    try {
      const r = await api(`${listUrl(btn.dataset.listRestore)}/restore`, { method: 'POST' });
      toast.success(`“${r.list.title}” is back.`, { action: { label: 'Open', onClick: () => location.assign(`/lists/${r.list.id}`) } });
      await refresh();
    } catch (err) { toast.error(err.message, { title: 'Couldn’t restore it' }); }
  }, 'Restoring…'));

  // "Archived: Undo" survives the trip back from the list.
  const done = storage.get(ARCHIVED_KEY, null);
  if (done) {
    storage.remove(ARCHIVED_KEY);
    if (Date.now() - done.at < 20000) {
      toast(`Archived “${done.title}”.`, { action: { label: 'Undo', onClick: async () => {
        try { await api(`${listUrl(done.id)}/restore`, { method: 'POST' }); await refresh(); toast.success(`“${done.title}” is back.`); }
        catch (err) { toast.error(err.message, { title: 'Couldn’t restore it' }); }
      } } });
    }
  }
}

// ---- One list -----------------------------------------------------------------------------------------------------
function initList() {
  const page = $('[data-list-page]');
  if (!page) return;
  const id = page.dataset.listPage;
  const body = $('[data-list-body]', page);
  const form = $('[data-list-add]', page);
  const input = $('[data-list-add-input]', page);
  const draftKey = `jb-list-draft:${id}`;
  const mine = new Map(); // item id → when I changed it (my own changes don't flash)
  let inflight = 0, stale = false, editing = null, timer = 0;

  const note = storage.get('jb-list-note', null);
  if (note && String(note.id) === id) { storage.remove('jb-list-note'); toast(note.text); }

  // Draft of the add field.
  input.value = storage.get(draftKey, '') || '';
  input.addEventListener('input', () => storage.set(draftKey, input.value));

  const setTitle = t => {
    page.dataset.title = t;
    $('[data-list-title]', page).textContent = t;
    document.title = document.title.replace(/^[^·]*?(?= · |$)/, t);
  };
  const markMine = itemId => mine.set(String(itemId), Date.now());
  const isMine = itemId => Date.now() - (mine.get(String(itemId)) || 0) < 8000;

  const gone = () => {
    body.hidden = true;
    form.hidden = true;
    $('[data-list-gone]', page).hidden = false;
  };

  // Rows still waiting (or failed) are the browser's own: kept across a refresh.
  const pendingList = () => {
    let ul = $('[data-pending-list]', body);
    if (!ul) {
      ul = h('<ul class="li-list mb-6" role="list" data-pending-list></ul>');
      const host = $('[data-list-items]', body) || body;
      const summary = $('.li-summary', host);
      if (summary) summary.after(ul); else host.prepend(ul);
      body.querySelector('.li-empty')?.remove();
    }
    return ul;
  };

  const refresh = async () => {
    if (inflight || editing) { stale = true; return; }
    stale = false;
    let r;
    try { r = await api(`${listUrl(id)}?fragment=1`); } catch (err) {
      if (err.status === 404) gone(); else stale = true;
      return;
    }
    if (inflight || editing) { stale = true; return; } // a change started while this was on its way
    const before = new Map($$('[data-item-id]', body).map(li => [li.dataset.itemId, li.dataset.done]));
    const focusId = document.activeElement?.closest?.('[data-item-id]')?.dataset.itemId;
    const kept = $$('[data-client-row].is-failed', body);
    body.innerHTML = r.html;
    if (kept.length) { const ul = pendingList(); for (const li of kept) ul.append(li); }
    for (const li of $$('[data-item-id]', body)) {
      const was = before.get(li.dataset.itemId);
      if (was !== li.dataset.done && !isMine(li.dataset.itemId)) li.classList.add('just-changed');
    }
    if (focusId) $(`[data-item-id="${CSS.escape(focusId)}"] [data-list-tick]`, body)?.focus({ preventScroll: true });
    if (r.list?.title && r.list.title !== page.dataset.title) setTitle(r.list.title);
  };
  // Remote changes land quickly; after my own ticks the list waits until I pause before rows move.
  const later = (ms = 150) => { stale = true; clearTimeout(timer); timer = setTimeout(refresh, ms); };
  const settle = ms => { if (!inflight && !editing && stale) later(ms); };

  let lastLocal = 0;
  const isRecentLocal = () => Date.now() - lastLocal < 1500;
  document.addEventListener('jb:ws:list.updated', e => { if (String(e.detail?.data?.listId) === id) later(isRecentLocal() ? 700 : 150); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') later(); });

  // ---- Tick / untick
  on(body, 'change', '[data-list-tick]', async (e, box) => {
    const li = box.closest('[data-item-id]');
    if (!li) { box.checked = false; return; }
    const done = box.checked;
    li.dataset.done = String(done);
    li.dataset.pending = '';
    markMine(li.dataset.itemId);
    lastLocal = Date.now();
    inflight++;
    try {
      const r = await api(`${listUrl(id)}/items/${li.dataset.itemId}`, { method: 'PATCH', body: { done } });
      // Someone else got there first (their tick stands): show the server's state.
      if (r.item && r.item.done !== done) { box.checked = r.item.done; li.dataset.done = String(r.item.done); }
    } catch (err) {
      box.checked = !done;
      li.dataset.done = String(!done);
      toast.error(err.message, { title: done ? 'Couldn’t tick that' : 'Couldn’t untick that', action: { label: 'Try again', onClick: () => {
        const again = $(`[data-item-id="${CSS.escape(li.dataset.itemId)}"] [data-list-tick]`, body);
        if (again) { again.checked = done; again.dispatchEvent(new Event('change', { bubbles: true })); }
      } } });
    } finally {
      delete li.dataset.pending;
      inflight--;
      stale = true;
      settle(700);
    }
  });

  // ---- Add
  const placeholder = text => h(`<li class="li-row is-new" data-client-row data-text="${escapeHtml(text)}">
    <label class="li-main"><input type="checkbox" class="li-check" disabled aria-label="${escapeHtml(text)}, being added">
      <span class="min-w-0 flex-1"><span class="li-text"><span class="li-words" dir="auto">${escapeHtml(text)}</span></span>
      <span class="li-meta" data-row-status><span class="inline-flex items-center gap-1.5"><span class="spinner size-3" aria-hidden="true"></span>Adding</span></span></span></label></li>`);

  async function addRow(row) {
    const text = row.dataset.text;
    row.classList.remove('is-failed');
    row.classList.add('is-new');
    $('[data-row-status]', row).innerHTML = '<span class="inline-flex items-center gap-1.5"><span class="spinner size-3" aria-hidden="true"></span>Adding</span>';
    lastLocal = Date.now();
    inflight++;
    try {
      const r = await api(`${listUrl(id)}/items`, { method: 'POST', body: { text } });
      for (const it of [...r.added, ...r.updated]) markMine(it.id);
      if (!r.added.length && r.updated[0]) toast(`“${r.updated[0].text}” was already on the list${r.updated[0].qty ? `: now ${r.updated[0].qty}` : ', updated'}.`);
      else if (!r.added.length && r.already[0]) toast(`“${r.already[0].text}” is already on the list.`);
      row.remove(); // the refresh brings the real row
      if (!$('[data-pending-list] li', body)) $('[data-pending-list]', body)?.remove();
    } catch (err) {
      row.classList.replace('is-new', 'is-failed');
      $('[data-row-status]', row).innerHTML = `<span class="font-medium text-bad">Not added: ${escapeHtml(err.message)}</span>
        <button type="button" class="btn btn-secondary btn-sm h-6 px-2 text-[11px]" data-row-retry>Retry</button>
        <button type="button" class="btn btn-ghost btn-sm h-6 px-2 text-[11px]" data-row-drop>Remove</button>`;
    } finally {
      inflight--;
      stale = true;
      settle(200);
    }
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    input.value = '';
    storage.remove(draftKey);
    const row = placeholder(text);
    pendingList().append(row);
    addRow(row);
    input.focus();
  });
  on(body, 'click', '[data-row-retry]', (e, b) => { e.preventDefault(); addRow(b.closest('[data-client-row]')); });
  on(body, 'click', '[data-row-drop]', (e, b) => {
    e.preventDefault();
    b.closest('[data-client-row]').remove();
    if (!$('[data-pending-list] li', body)) $('[data-pending-list]', body)?.remove();
    settle(0);
  });

  // ---- Change one (the form comes from the page's <template>, so the pickers are the server's)
  const template = $('template[data-list-editor]', page);
  const localInput = iso => { const d = new Date(iso); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const closeEditor = () => {
    const f = $('[data-list-editor-form]', body);
    if (f) { const btn = $('[data-list-edit]', f.closest('[data-item-id]')); btn?.setAttribute('aria-expanded', 'false'); f.remove(); btn?.focus(); }
    editing = null;
    settle(0);
  };
  on(body, 'click', '[data-list-edit]', (e, btn) => {
    const li = btn.closest('[data-item-id]');
    const open = editing === li.dataset.itemId;
    if (editing) closeEditor();
    if (open) return;
    const f = template.content.firstElementChild.cloneNode(true);
    const el = f.elements;
    for (const field of $$('input, select', f)) { // ids so each label points at its field
      field.id = `li-${li.dataset.itemId}-${field.name}`;
      field.closest('[data-field]')?.querySelector('label')?.setAttribute('for', field.id);
    }
    el.text.value = li.dataset.text;
    if (el.qty) el.qty.value = li.dataset.qty || '';
    if (el.category) el.category.value = li.dataset.category || '';
    if (el.assigneeId) el.assigneeId.value = li.dataset.assignee || '';
    if (el.due) el.due.value = li.dataset.due ? localInput(li.dataset.due) : '';
    li.append(f);
    btn.setAttribute('aria-expanded', 'true');
    editing = li.dataset.itemId;
    el.text.focus();
    el.text.select();
  });
  on(body, 'click', '[data-list-edit-cancel]', closeEditor);
  on(body, 'keydown', '[data-list-editor-form]', e => { if (e.key === 'Escape') { e.preventDefault(); closeEditor(); } });
  on(body, 'submit', '[data-list-editor-form]', async (e, f) => {
    e.preventDefault();
    const li = f.closest('[data-item-id]');
    const el = f.elements;
    const patch = { text: el.text.value };
    if (el.qty) patch.qty = el.qty.value;
    if (el.category) patch.category = el.category.value;
    if (el.assigneeId) patch.assigneeId = el.assigneeId.value ? Number(el.assigneeId.value) : null;
    if (el.due) patch.due = el.due.value ? new Date(el.due.value).toISOString() : null; // the browser's own time zone
    for (const p of $$('[data-field-error]', f)) p.remove();
    await withBusy(f.querySelector('button:not([type])'), async () => {
      try {
        await api(`${listUrl(id)}/items/${li.dataset.itemId}`, { method: 'PATCH', body: patch });
        mine.delete(li.dataset.itemId); // flash the saved row once it's re-rendered: that's the "saved"
        f.remove();
        editing = null;
        later(0);
      } catch (err) {
        const errors = err.data?.errors;
        if (errors) {
          for (const [name, msg] of Object.entries(errors)) {
            const field = el[name === 'assignee' ? 'assigneeId' : name] || el.text;
            field.closest('[data-field]').append(h(`<p class="field-error" data-field-error>${escapeHtml(msg)}</p>`));
          }
        } else toast.error(err.message, { title: 'Not saved' });
      }
    }, 'Saving…');
  });

  // ---- Remove one (Undo puts it back)
  on(body, 'click', '[data-list-delete]', async (e, btn) => {
    const li = btn.closest('[data-item-id]');
    const d = li.dataset;
    const back = { text: d.text, qty: d.qty || undefined, category: d.category || undefined, assigneeId: d.assignee ? Number(d.assignee) : undefined, due: d.due || undefined };
    editing = null;
    li.hidden = true;
    inflight++;
    try {
      await api(`${listUrl(id)}/items/${d.itemId}`, { method: 'DELETE' });
      li.remove();
      toast(`Removed “${d.text}”.`, { action: { label: 'Undo', onClick: async () => {
        try { const r = await api(`${listUrl(id)}/items`, { method: 'POST', body: back }); for (const it of r.added) markMine(it.id); later(0); }
        catch (err) { toast.error(err.message, { title: 'Couldn’t put it back' }); }
      } } });
    } catch (err) {
      li.hidden = false;
      toast.error(err.message, { title: 'Couldn’t remove it' });
    } finally { inflight--; stale = true; settle(0); }
  });

  // ---- Clear the ticked ones
  on(body, 'click', '[data-list-clear-done]', async (e, btn) => {
    const n = Number($('[data-list-items]', body)?.dataset.doneCount || 0);
    const shared = page.dataset.shared === 'true';
    if (!(await confirmDialog({ title: `Clear ${n === 1 ? 'the ticked item' : `${n} ticked items`}?`,
      body: shared ? 'They come off the list for everyone who shares it.' : 'They come off the list.', confirmLabel: 'Clear' }))) return;
    await withBusy(btn, async () => {
      inflight++;
      try { const r = await api(`${listUrl(id)}/clear-done`, { method: 'POST' }); toast.success(`Cleared ${r.removed === 1 ? '1 item' : `${r.removed} items`}.`); }
      catch (err) { toast.error(err.message, { title: 'Couldn’t clear them' }); }
      finally { inflight--; stale = true; settle(0); }
    }, 'Clearing…');
  });

  // ---- Rename, archive
  on(page, 'click', '[data-list-rename]', async () => {
    const title = await promptDialog({ title: 'Rename this list', label: 'Name', value: page.dataset.title, maxLength: 60 });
    if (!title || title === page.dataset.title) return;
    const t = toast.pending('Renaming…');
    try { const r = await api(listUrl(id), { method: 'PATCH', body: { title } }); setTitle(r.list.title); t.done(`Renamed to “${r.list.title}”.`); }
    catch (err) { t.fail(err.data?.errors?.title || err.message); }
  });
  on(page, 'click', '[data-list-archive]', async () => {
    const title = page.dataset.title;
    const shared = page.dataset.shared === 'true';
    if (!(await confirmDialog({ title: `Archive “${title}”?`, body: `${shared ? 'It goes away for everyone who shares it. ' : ''}You can restore it from Lists.`, confirmLabel: 'Archive' }))) return;
    const t = toast.pending('Archiving…');
    try {
      await api(listUrl(id), { method: 'DELETE' });
      storage.set(ARCHIVED_KEY, { id, title, at: Date.now() });
      location.assign('/lists');
    } catch (err) { t.fail(err.message); }
  });
}

export function initLists() {
  initIndex();
  initList();
}
