// Projects (docs/PROJECTS.md, decision #91): the New project card, starting a project, editing one, its brief, and
// keeping the rail and the open project panel current. Every action shows pending → result.
// Server contract (routes/api/v1/projects.js, routes/web/app.js):
//   POST /api/v1/projects/:id/create | dismiss → { cardHtml, href? } · POST /api/v1/projects/:id/edit → { project, cardHtml? }
//   GET /api/v1/projects/:id → { project, … } · DELETE /api/v1/projects/:id → { redirect }
//   POST /api/v1/projects/:id/brief { kind, text } · POST /api/v1/projects/:id/brief/:itemId { text?, state? } · DELETE …/brief/:itemId
//   POST /api/v1/threads/:id/make-project { name } → { redirect } · GET /projects/rail → { html } · GET /projects/:id/panel → { aside, sheet }
import { $, $$, on, api, h, withBusy, icon, botName } from './core.js';
import { toast } from './toast.js';
import { openModal, closeModal, confirmDialog, promptDialog } from './modal.js';
import { selectTab } from './tabs.js';

const pid = () => $('[data-project-page]')?.dataset.projectPage || null;

// ---- Live: the rail's list and the open project's panel follow what happens (other tabs, Jess's own updates) ------
async function refreshRail() {
  const slot = $('[data-rail-projects-slot]');
  if (!slot) return;
  try {
    const { html } = await api(`/projects/rail?thread=${$('[data-chat]')?.dataset.threadId || ''}`);
    slot.innerHTML = html;
  } catch { /* the next page load shows it */ }
}

let panelTimer = null;
function refreshPanel() {
  const id = pid();
  if (!id) return;
  clearTimeout(panelTimer);
  panelTimer = setTimeout(async () => {
    try {
      const out = await api(`/projects/${encodeURIComponent(id)}/panel`);
      for (const slot of $$('[data-project-panel-slot]')) {
        const inSheet = !!slot.closest('dialog');
        const chosen = $('[role="tab"][aria-selected="true"]', slot)?.id.replace(/^[^-]+-tab-/, '');
        slot.innerHTML = inSheet ? out.sheet : out.aside;
        const tab = chosen && $(`[role="tab"][id$="-tab-${chosen}"]`, slot);
        if (tab) selectTab(tab, { remember: false });
      }
    } catch { /* keep what's shown */ }
  }, 150);
}

// ---- Starting a project: the interview happens in the main chat, with Jess ------------------------------------------
async function startProject(btn) {
  await withBusy(btn, async () => {
    try {
      await api('/api/v1/threads/main/messages', { method: 'POST', body: { text: 'I’d like to start a new project.', clientId: `proj-${Date.now()}` } });
      location.href = '/chat';
    } catch (err) { toast.error(err.message); }
  });
}

// ---- The edit dialog (a draft's "Edit first", or a project's Edit) ---------------------------------------------------
function fillEditor(form, p, { draft }) {
  form.reset();
  form.elements.name.value = p.name || '';
  form.elements.about.value = p.about || '';
  form.elements.field.value = p.field || 'general';
  const statusField = $('[data-project-status-field]', form);
  statusField.hidden = draft;
  if (!draft) form.elements.status.value = p.status || 'active';
  const hue = Number(p.hue) || 250;
  const hues = $$('input[name="hue"]', form);
  const nearest = hues.reduce((best, r) => (Math.abs(Number(r.value) - hue) < Math.abs(Number(best.value) - hue) ? r : best), hues[0]);
  nearest.checked = true;
  const iconOpt = $(`input[name="icon"][value="${CSS.escape(p.icon || 'folder')}"]`, form) || $('input[name="icon"]', form);
  iconOpt.checked = true;
  previewTile(form);
}
function previewTile(form) {
  const tile = $('[data-project-form-tile] .proj-tile', form);
  if (!tile) return;
  const hue = form.elements.hue.value || 250;
  const name = form.elements.icon.value || 'folder';
  tile.style.setProperty('--hue', hue);
  tile.innerHTML = icon(name, 'proj-tile-icon');
}

export function initProjects() {
  on(document, 'click', '[data-project-new]', (e, btn) => { e.preventDefault(); startProject(btn); });
  document.addEventListener('jb:ws:projects.changed', refreshRail);
  document.addEventListener('jb:ws:project.updated', e => { if (e.detail?.data?.id === pid()) refreshPanel(); });

  const dlg = $('#project-editor');
  const form = dlg && $('[data-project-form]', dlg);
  let editing = null; // { id, draft, card? }
  if (form) {
    form.addEventListener('change', e => { if (['hue', 'icon'].includes(e.target.name)) previewTile(form); });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!editing) return;
      const body = { name: form.elements.name.value.trim(), about: form.elements.about.value.trim(), field: form.elements.field.value,
        hue: Number(form.elements.hue.value), icon: form.elements.icon.value, ...(editing.draft ? {} : { status: form.elements.status.value }) };
      for (const el of $$('[aria-invalid]', form)) el.removeAttribute('aria-invalid');
      withBusy($('[data-project-save]', form), async () => {
        try {
          const out = await api(`/api/v1/projects/${encodeURIComponent(editing.id)}/edit`, { method: 'POST', body });
          closeModal(dlg);
          if (editing.draft && out.cardHtml && editing.card?.isConnected) { editing.card.replaceWith(h(out.cardHtml)); toast.success('Updated. Press Create when it looks right.'); }
          else location.reload(); // name, colour and status show in the header, rail and panel
        } catch (err) {
          const fields = err.data?.errors;
          if (fields) for (const n of Object.keys(fields)) form.elements[n]?.setAttribute?.('aria-invalid', 'true');
          toast.error(fields ? Object.values(fields).join(' ') : err.message, { title: 'Not saved' });
        }
      }, 'Saving…');
    });
  }

  // ---- The New project card -------------------------------------------------------------------------------------------
  on(document, 'click', '[data-proposal-create]', (e, btn) => {
    const card = btn.closest('[data-proposal]');
    card.setAttribute('aria-busy', 'true');
    withBusy(btn, async () => {
      try {
        const out = await api(`/api/v1/projects/${encodeURIComponent(card.dataset.proposal)}/create`, { method: 'POST' });
        if (out.cardHtml) card.replaceWith(h(out.cardHtml));
        toast.success(`“${out.project.name}” is ready. ${botName()} is opening it now.`,
          { action: { label: 'Open', onClick: () => { location.href = out.href; } } });
        refreshRail();
      } catch (err) { card.removeAttribute('aria-busy'); toast.error(err.message, { title: 'Not created' }); }
    }, 'Creating…');
  });
  on(document, 'click', '[data-proposal-dismiss]', (e, btn) => {
    const card = btn.closest('[data-proposal]');
    withBusy(btn, async () => {
      try {
        const out = await api(`/api/v1/projects/${encodeURIComponent(card.dataset.proposal)}/dismiss`, { method: 'POST' });
        if (out.cardHtml) card.replaceWith(h(out.cardHtml));
      } catch (err) { toast.error(err.message); }
    });
  });
  on(document, 'click', '[data-proposal-edit]', (e, btn) => {
    const card = btn.closest('[data-proposal]');
    if (!form) return;
    editing = { id: card.dataset.proposal, draft: true, card };
    fillEditor(form, { name: card.dataset.name, about: card.dataset.about, icon: card.dataset.icon, hue: card.dataset.hue, field: card.dataset.field }, { draft: true });
    $('#project-editor-title').textContent = 'Before you create it';
    openModal(dlg, btn);
  });

  // ---- A project's page -----------------------------------------------------------------------------------------------
  on(document, 'click', '[data-project-edit]', async (e, btn) => {
    if (!form) return;
    try {
      const { project } = await api(`/api/v1/projects/${encodeURIComponent(btn.dataset.projectEdit)}`);
      editing = { id: project.id, draft: false };
      fillEditor(form, project, { draft: false });
      $('#project-editor-title').textContent = 'Edit project';
      openModal(dlg, btn);
    } catch (err) { toast.error(err.message); }
  });
  on(document, 'click', '[data-project-delete]', async (e, btn) => {
    const ok = await confirmDialog({ title: `Delete “${btn.dataset.name}”?`, danger: true, confirmLabel: 'Delete project',
      body: 'Its chat and brief go. Its files stay in your Library. Archive it instead (Edit project → Status) to keep everything out of the way.' });
    if (!ok) return;
    try {
      const out = await api(`/api/v1/projects/${encodeURIComponent(btn.dataset.projectDelete)}`, { method: 'DELETE' });
      location.href = out.redirect;
    } catch (err) { toast.error(err.message); }
  });
  on(document, 'click', '[data-make-project]', async () => {
    const chat = $('[data-chat]');
    const name = await promptDialog({ title: 'Make this chat a project', label: 'Project name', value: $('.chat-switch .truncate')?.textContent.trim() || '',
      confirmLabel: 'Make it a project', maxLength: 48 });
    if (!name) return;
    try {
      const out = await api(`/api/v1/threads/${chat.dataset.threadId}/make-project`, { method: 'POST', body: { name } });
      location.href = out.redirect;
    } catch (err) { toast.error(err.message, { title: 'Not changed' }); }
  });

  // Save one of her replies into the project's files.
  on(document, 'click', '[data-save-to-project]', (e, btn) => withBusy(btn, async () => {
    try {
      const { item } = await api(`/api/v1/projects/${encodeURIComponent(pid())}/save-message`, { method: 'POST', body: { messageId: Number(btn.dataset.saveToProject) } });
      toast.success(`Saved to the project’s files as “${item.title}”.`, { action: { label: 'Open', onClick: () => { location.href = item.href; } } });
    } catch (err) { toast.error(err.message, { title: 'Not saved' }); }
  }));

  // ---- The brief ----------------------------------------------------------------------------------------------------
  const briefUrl = (rowId = '') => `/api/v1/projects/${encodeURIComponent(pid())}/brief${rowId ? `/${rowId}` : ''}`;
  on(document, 'submit', '[data-brief-add]', (e, f) => {
    e.preventDefault();
    const text = f.elements.text.value.trim();
    if (!text) { f.elements.text.focus(); return; }
    withBusy($('button', f), async () => {
      try {
        await api(briefUrl(), { method: 'POST', body: { kind: f.elements.kind.value, text } });
        f.elements.text.value = '';
        refreshPanel();
      } catch (err) { toast.error(err.message); }
    });
  });
  const rowAction = (sel, fn) => on(document, 'click', sel, async (e, btn) => {
    const row = btn.closest('[data-brief-row]');
    row.setAttribute('aria-busy', 'true');
    try { await fn(row); refreshPanel(); } catch (err) { toast.error(err.message); } finally { row.removeAttribute('aria-busy'); }
  });
  rowAction('[data-brief-done]', row => api(briefUrl(row.dataset.briefRow), { method: 'POST', body: { state: 'done' } }));
  rowAction('[data-brief-reopen]', row => api(briefUrl(row.dataset.briefRow), { method: 'POST', body: { state: 'open' } }));
  rowAction('[data-brief-delete]', row => api(briefUrl(row.dataset.briefRow), { method: 'DELETE' }));
  on(document, 'click', '[data-brief-edit]', async (e, btn) => {
    const row = btn.closest('[data-brief-row]');
    const text = await promptDialog({ title: 'Edit', label: 'Text', value: row.dataset.text, maxLength: 300 });
    if (!text || text === row.dataset.text) return;
    row.setAttribute('aria-busy', 'true');
    try { await api(briefUrl(row.dataset.briefRow), { method: 'POST', body: { text } }); refreshPanel(); toast.success('Saved. This line is yours now; I won’t change it.'); }
    catch (err) { toast.error(err.message); row.removeAttribute('aria-busy'); }
  });
}
