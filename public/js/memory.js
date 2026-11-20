// You → Memory: search and filters, pin, inline edit, forget (confirm + Undo), and Import (paste or a .vcf → what I'd
// keep, ticked → save the chosen ones). The list is the server's partial (partials/me/memory-list.hbs); after an import,
// or a memory.updated frame from another tab, it is re-rendered from GET /api/v1/me/memories?fragment=1.
// Server contract: PATCH /api/v1/me/memories/:id { text } · DELETE /api/v1/me/memories/:id · POST …/:id/restore ·
//   POST …/:id/pin { pinned } · POST /api/v1/me/memories/import/preview?fragment=1 { text, filename } · POST …/import { items }
import { $, $$, on, api, h, escapeHtml, withBusy, loader, icon } from './core.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';

const url = id => `/api/v1/me/memories/${encodeURIComponent(id)}`;

export function initMemory() {
  const section = $('[data-me-panel="memory"]');
  const slot = $('[data-memory-slot]');
  if (!section || !slot) return;
  let filter = 'all';

  // ---- Search + filters
  const apply = () => {
    const q = ($('[data-memory-search]')?.value || '').trim().toLowerCase();
    let shown = 0, all = 0;
    for (const li of $$('[data-memory-id]', slot)) {
      all++;
      const d = li.dataset;
      const kind = filter === 'all' || (filter === 'dated' && d.dated !== undefined) || (filter === 'essential' && d.importance === '3')
        || (filter === 'pinned' && d.pinned !== undefined) || (filter === 'shared' && d.scope === 'shared');
      li.hidden = !kind || (q && !d.text.toLowerCase().includes(q));
      shown += !li.hidden;
    }
    const none = $('[data-memory-nomatch]');
    if (none) none.hidden = !all || shown > 0;
  };
  $('[data-memory-search]')?.addEventListener('input', apply);
  on(section, 'click', '[data-memory-filter]', (e, chip) => {
    filter = chip.dataset.memoryFilter;
    for (const c of $$('[data-memory-filter]', section)) c.setAttribute('aria-pressed', String(c === chip));
    apply();
  });

  const refresh = async () => {
    try {
      const r = await api('/api/v1/me/memories?fragment=1');
      slot.innerHTML = r.html;
      const count = $('[data-memory-count]');
      if (count) count.textContent = `${r.memories.length} ${r.memories.length === 1 ? 'memory' : 'memories'}`;
      apply();
      return r;
    } catch { return null; }
  };
  document.addEventListener('jb:ws:memory.updated', () => { if (!section.hidden) refresh(); });
  document.addEventListener('jb:memory-refresh', refresh); // this page changed memories another way (a tidy's Undo, me-lessons.js)

  // ---- Pin (always keep in mind): the button shows it at once and goes back if the server says no.
  on(slot, 'click', '[data-memory-pin]', async (e, btn) => {
    if (btn.getAttribute('aria-busy') === 'true') return;
    const li = btn.closest('[data-memory-id]');
    const pinned = btn.getAttribute('aria-pressed') !== 'true';
    const set = on_ => {
      btn.setAttribute('aria-pressed', String(on_));
      btn.setAttribute('aria-label', `${on_ ? 'Unpin' : 'Pin'}: always keep this in mind`);
      btn.dataset.tooltip = on_ ? 'Pinned: always in mind' : 'Pin: always keep in mind';
      li.toggleAttribute('data-pinned', on_);
    };
    set(pinned);
    btn.setAttribute('aria-busy', 'true');
    try {
      await api(`${url(li.dataset.memoryId)}/pin`, { method: 'POST', body: { pinned } });
      toast.success(pinned ? 'Pinned. I’ll always keep it in mind.' : 'Unpinned.');
    } catch (err) {
      set(!pinned);
      toast.error(err.message, { title: pinned ? 'Couldn’t pin it' : 'Couldn’t unpin it' });
    } finally { btn.removeAttribute('aria-busy'); apply(); }
  });

  // ---- Forget (Undo brings it back)
  on(slot, 'click', '[data-memory-forget]', async (e, btn) => {
    const li = btn.closest('[data-memory-id]');
    const ok = await confirmDialog({ title: 'Forget this?', body: li.dataset.text, confirmLabel: 'Forget', danger: true });
    if (!ok) return;
    const list = li.parentElement, next = li.nextSibling;
    li.remove();
    try {
      await api(url(li.dataset.memoryId), { method: 'DELETE' });
      toast('Forgotten.', { action: { label: 'Undo', onClick: async () => {
        list.insertBefore(li, next);
        try { await api(`${url(li.dataset.memoryId)}/restore`, { method: 'POST' }); } catch (err) { li.remove(); toast.error(err.message); }
      } } });
    } catch (err) {
      list.insertBefore(li, next);
      toast.error(err.message, { title: 'Couldn’t forget that' });
    }
  });

  // ---- Edit in place
  on(slot, 'click', '[data-memory-edit]', (e, btn) => {
    const li = btn.closest('[data-memory-id]');
    const p = $('[data-memory-text]', li);
    if (li.querySelector('form')) return;
    const form = h(`<form class="space-y-2">
      <textarea class="textarea min-h-16 text-sm" aria-label="Edit memory">${escapeHtml(li.dataset.text)}</textarea>
      <div class="flex justify-end gap-2"><button type="button" class="btn btn-ghost btn-sm" data-cancel>Cancel</button>
      <button class="btn btn-primary btn-sm">Save</button></div></form>`);
    p.hidden = true;
    p.after(form);
    const ta = $('textarea', form);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const close = () => { form.remove(); p.hidden = false; };
    $('[data-cancel]', form).addEventListener('click', close);
    form.addEventListener('keydown', ev => { if (ev.key === 'Escape') close(); });
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      await withBusy($('button:not([data-cancel])', form), async () => {
        try {
          await api(url(li.dataset.memoryId), { method: 'PATCH', body: { text } });
          li.dataset.text = text;
          p.textContent = text;
          close();
          toast.success('Memory updated.');
        } catch (err) { toast.error(err.message, { title: 'Not saved' }); }
      });
    });
  });

  initImport(refresh);
}

// ---- Import --------------------------------------------------------------------------------------------------------
function initImport(refresh) {
  const box = $('[data-import]');
  if (!box) return;
  const opener = $('[data-import-open]');
  const text = $('[data-import-text]', box);
  const fileInput = $('[data-import-file]', box);
  const fileName = $('[data-import-filename]', box);
  const slot = $('[data-import-preview-slot]', box);
  const save = $('[data-import-save]', box);
  let file = null; // { name, text } of a chosen .vcf

  const step = name => { for (const s of $$('[data-import-step]', box)) s.hidden = s.dataset.importStep !== name; };
  const open = () => { box.hidden = false; opener.setAttribute('aria-expanded', 'true'); step('input'); text.focus(); };
  const close = () => { box.hidden = true; opener.setAttribute('aria-expanded', 'false'); opener.focus(); };
  opener.addEventListener('click', () => (box.hidden ? open() : close()));
  on(box, 'click', '[data-import-close]', close);
  box.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented) close(); });

  const showFile = () => {
    fileName.classList.toggle('hidden', !file);
    fileName.classList.toggle('inline-flex', !!file);
    fileName.innerHTML = file ? `${escapeHtml(file.name)} <button type="button" class="btn btn-ghost btn-icon btn-sm size-6" data-import-unfile aria-label="Remove the file">${icon('x', 'size-3.5')}</button>` : '';
    text.disabled = !!file;
    text.placeholder = file ? 'Using the contacts file. Remove it to paste instead.' : text.dataset.placeholder;
  };
  text.dataset.placeholder = text.placeholder;
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    if (f.size > 2_000_000) { toast.error('That file is too big to import (2 MB at most).', { title: 'Import' }); return; }
    file = { name: f.name, text: await f.text() };
    showFile();
  });
  on(box, 'click', '[data-import-unfile]', () => { file = null; showFile(); text.focus(); });

  const picks = () => $$('[data-import-pick]:not(:disabled)', slot);
  const count = () => {
    const n = picks().filter(c => c.checked).length;
    const out = $('[data-import-count]', slot);
    if (out) out.textContent = n;
    save.disabled = !n;
    save.textContent = n ? `Save ${n === 1 ? '1 memory' : `${n} memories`}` : 'Save';
  };
  on(slot, 'change', '[data-import-pick]', count);
  on(slot, 'click', '[data-import-all]', () => { for (const c of picks()) c.checked = true; count(); });
  on(slot, 'click', '[data-import-none]', () => { for (const c of picks()) c.checked = false; count(); });

  // Step 1 → 2: the server reads it (nothing saved) and renders what it found.
  on(box, 'click', '[data-import-preview-btn]', async (e, btn) => {
    const body = file ? { text: file.text, filename: file.name } : { text: text.value };
    if (!body.text.trim()) { toast.error('Paste something first, or choose a .vcf file.', { title: 'Import' }); text.focus(); return; }
    step('preview');
    slot.innerHTML = loader(file ? 'Reading the contacts for birthdays and details' : 'Reading what you pasted', { motion: 'reading', iconName: 'file-search' });
    save.disabled = true;
    try {
      const r = await api('/api/v1/me/memories/import/preview?fragment=1', { method: 'POST', body });
      slot.innerHTML = r.html;
      count();
    } catch (err) {
      slot.innerHTML = `<div class="flex items-center gap-2 rounded-xl border border-bad/30 bg-bad-soft px-3 py-2 text-sm" role="alert">
        <span class="min-w-0 flex-1">${escapeHtml(err.data?.errors?.text || err.message)}</span>
        <button type="button" class="btn btn-secondary btn-sm" data-import-retry>Try again</button></div>`;
    }
  });
  on(box, 'click', '[data-import-retry]', () => $('[data-import-preview-btn]', box).click());
  on(box, 'click', '[data-import-back]', () => { step('input'); (file ? fileInput : text).focus(); });

  // Step 2 → 3: save the ticked ones; the list re-renders with them.
  save.addEventListener('click', () => withBusy(save, async () => {
    const items = picks().filter(c => c.checked).map(c => ({ text: c.dataset.text, kind: c.dataset.kind || undefined,
      date: c.dataset.date || undefined, recurs: c.dataset.recurs || undefined }));
    if (!items.length) return;
    try {
      const r = await api('/api/v1/me/memories/import', { method: 'POST', body: { items } });
      const skipped = r.skipped.length ? `<p class="mt-1 text-ink-2">Skipped ${r.skipped.length}: ${r.skipped.slice(0, 3).map(s => `“${escapeHtml(s.text)}” (${escapeHtml(s.reason)})`).join(', ')}${r.skipped.length > 3 ? '…' : ''}</p>` : '';
      $('[data-import-result]', box).innerHTML = `<p class="font-medium">Saved ${r.saved.length === 1 ? '1 memory' : `${r.saved.length} memories`}.</p>${skipped}`;
      step('done');
      text.value = '';
      file = null;
      showFile();
      await refresh();
    } catch (err) { toast.error(err.message, { title: 'Nothing was saved' }); }
  }, 'Saving…'));
  on(box, 'click', '[data-import-again]', () => { step('input'); text.focus(); });
}
