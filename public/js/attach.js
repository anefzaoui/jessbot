// Composer attachments (Phase 10, decision #76): paperclip, drag & drop and pasted images → uploaded right away
// (with progress) to POST /api/v1/uploads → Library items; the message then carries their ids. The tray survives a
// refresh (per thread), removing a file before sending deletes its Library item, and sending waits for uploads.
// Server contract: POST /api/v1/uploads (multipart: file[], threadId) → 201 { files: [libraryItemView], errors: [{ name, error }] }
import { $, h, escapeHtml, icon, storage } from './core.js';
import { toast } from './toast.js';

const MAX_FILES = 6;
const MAX_BYTES = 25 * 1048576;
const OK_TYPE = /^(image\/(png|jpeg|webp|gif)|application\/pdf|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|text\/.*|application\/json)$/;
const OK_EXT = /\.(pdf|png|jpe?g|webp|gif|docx|xlsx|pptx|txt|md|markdown|csv|tsv|json|log|xml|ya?ml|ics)$/i;

/** Mirrors partials/chat/attachments.hbs (optimistic bubble). */
export function attachmentsHtml(files) {
  if (!files?.length) return '';
  return `<div class="msg-files" data-attachments>${files.map(f => (f.isImage
    ? `<a href="${escapeHtml(f.rawUrl)}" class="file-shot" data-lightbox="${escapeHtml(f.rawUrl)}" aria-label="View ${escapeHtml(f.title)}"><img src="${escapeHtml(f.preview || f.rawUrl)}" alt="${escapeHtml(f.title)}"></a>`
    : `<a href="${escapeHtml(f.href)}" class="file-chip" data-file-type="${escapeHtml(f.type)}"><span class="file-chip-icon">${icon(f.type === 'pdf' ? 'file-text' : f.type === 'sheet' ? 'sheet' : f.type === 'doc' ? 'file-type' : 'file', 'size-4')}</span>`
      + `<span class="min-w-0"><span class="block truncate font-medium">${escapeHtml(f.title)}</span><span class="block truncate text-[11px] opacity-70">${escapeHtml(f.kindLabel || '')} · ${escapeHtml(f.sizeLabel || '')}</span></span></a>`)).join('')}</div>`;
}

const sizeLabel = n => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function initAttachments(form, { onChange }) {
  const tray = $('[data-composer-tray]', form);
  const picker = $('[data-composer-file]', form);
  const attachBtn = $('[data-composer-attach]', form);
  if (!tray || !picker) return null;
  const key = `jb-attach:${form.dataset.threadId}`;
  const items = []; // { el, state: uploading|done|error, view?, xhr? }

  // Previews are blob: URLs that die with the page — the saved tray keeps only what the server returned.
  const save = () => storage.set(key, items.filter(i => i.state === 'done').map(({ view: { preview, ...v } }) => v));
  const changed = () => { save(); onChange?.(); };

  function chip(label, { preview = null } = {}) {
    const el = h(`<div class="tray-file" data-state="uploading">
      ${preview ? `<img src="${escapeHtml(preview)}" alt="">` : `<span class="file-chip-icon">${icon('file', 'size-4')}</span>`}
      <span class="min-w-0"><span class="block truncate font-medium">${escapeHtml(label)}</span><span class="block truncate text-[11px] text-ink-3" data-tray-note>Uploading…</span></span>
      <button type="button" class="tray-remove" aria-label="Remove ${escapeHtml(label)}">${icon('x', 'size-3.5')}</button>
      <span class="tray-progress" style="width: 0%"></span></div>`);
    tray.append(el);
    return el;
  }

  function markDone(item, view) {
    item.state = 'done';
    item.view = view;
    item.el.dataset.state = 'done';
    item.el.dataset.id = view.id;
    $('[data-tray-note]', item.el).textContent = `${view.kindLabel} · ${view.sizeLabel}`;
    $('.tray-progress', item.el).remove();
    if (view.type !== 'image') { const i = $('.file-chip-icon', item.el); i.parentElement.dataset.fileType = view.type; i.innerHTML = icon(view.type === 'pdf' ? 'file-text' : view.type === 'sheet' ? 'sheet' : view.type === 'doc' ? 'file-type' : 'file', 'size-4'); }
  }

  function upload(file) {
    const isImage = /^image\//.test(file.type);
    const preview = isImage ? URL.createObjectURL(file) : null;
    const item = { el: chip(file.name || 'Pasted image', { preview }), state: 'uploading', preview };
    items.push(item);
    onChange?.();
    const fd = new FormData();
    fd.append('file', file, file.name || `pasted-${Date.now()}.png`);
    fd.append('threadId', form.dataset.threadId);
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open('POST', '/api/v1/uploads');
    xhr.setRequestHeader('X-Requested-With', 'jessbot');
    xhr.upload.onprogress = e => { if (e.lengthComputable) { const bar = $('.tray-progress', item.el); if (bar) bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`; } };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 201 && body?.files?.[0]) { markDone(item, { ...body.files[0], preview }); changed(); return; }
      fail(item, body?.errors?.file || body?.error || 'Upload failed');
    };
    xhr.onerror = () => fail(item, 'Connection lost. Remove it and try again');
    xhr.send(fd);
  }

  function fail(item, message) {
    item.state = 'error';
    item.el.dataset.state = 'error';
    $('[data-tray-note]', item.el).textContent = message;
    $('.tray-progress', item.el)?.remove();
    toast.error(message, { title: 'Couldn’t attach that file' });
    changed();
  }

  function add(fileList) {
    for (const file of fileList) {
      if (items.filter(i => i.state !== 'error').length >= MAX_FILES) { toast.error(`Up to ${MAX_FILES} files per message.`); break; }
      if (file.size > MAX_BYTES) { toast.error(`“${file.name}” is ${sizeLabel(file.size)}. The limit is 25 MB.`); continue; }
      if (!OK_TYPE.test(file.type) && !OK_EXT.test(file.name || '')) { toast.error(`I can’t read “${file.name}” yet. Send a PDF, an image, a Word / Excel / PowerPoint file or plain text.`); continue; }
      upload(file);
    }
  }

  // Remove: cancel an upload, or delete the Library item it already became (it was never sent).
  tray.addEventListener('click', async e => {
    const btn = e.target.closest('.tray-remove');
    if (!btn) return;
    const item = items.find(i => i.el.contains(btn));
    if (!item) return;
    items.splice(items.indexOf(item), 1);
    item.el.remove();
    item.xhr?.abort();
    if (item.state === 'done') fetch(`/api/v1/library/${encodeURIComponent(item.view.id)}`, { method: 'DELETE', headers: { 'X-Requested-With': 'jessbot' } }).catch(() => {});
    changed();
  });

  attachBtn?.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => { add([...picker.files]); picker.value = ''; });
  $('[data-composer-input]', form)?.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); add(files); }
  });
  let depth = 0;
  form.addEventListener('dragenter', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { depth++; form.classList.add('is-dragging'); } });
  form.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; form.classList.remove('is-dragging'); } });
  form.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  form.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0;
    form.classList.remove('is-dragging');
    add([...e.dataTransfer.files]);
  });

  // Files attached before a refresh are still here.
  for (const view of storage.get(key, []) || []) {
    const item = { el: chip(view.title, { preview: view.type === 'image' ? view.rawUrl : null }), state: 'uploading' };
    items.push(item);
    markDone(item, view);
  }

  return {
    busy: () => items.some(i => i.state === 'uploading'),
    views: () => items.filter(i => i.state === 'done').map(i => i.view),
    clear: () => { for (const i of items) i.el.remove(); items.length = 0; storage.set(key, []); onChange?.(); },
  };
}

