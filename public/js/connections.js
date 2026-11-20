// You → Connections (decisions #78/#79): add a mailbox or calendar (checked against the real server before it's saved),
// test one, remove one. After a change the panel is re-rendered from the server (the page itself is the source).
// Server contract: POST /api/v1/connections/:kind (form) → 201 · POST /api/v1/connections/:id/test · DELETE /api/v1/connections/:id
import { $, $$, on, api, withBusy } from './core.js';
import { toast } from './toast.js';
import { openModal, closeModal, confirmDialog } from './modal.js';

async function refreshPanel() {
  const doc = new DOMParser().parseFromString(await (await fetch(location.pathname, { credentials: 'same-origin' })).text(), 'text/html');
  const fresh = doc.querySelector('[data-connections]');
  if (fresh) $('[data-connections]').replaceWith(fresh);
}

function showFields(form) {
  const kind = form.elements.kind.value;
  const opt = form.elements.provider.selectedOptions[0];
  for (const el of $$('[data-conn-only]', form)) el.hidden = el.dataset.connOnly !== kind;
  $('[data-conn-help]', form).textContent = opt?.dataset.help || '';
  if (kind === 'calendar' && opt?.dataset.url && !form.elements.url.dataset.touched) form.elements.url.value = opt.dataset.url;
  const custom = opt?.value === 'custom';
  $('[data-conn-servers]', form).open = custom; // presets fill the servers in; custom shows them
}

export function initConnections() {
  const panel = $('[data-connections]');
  const dlg = $('#connection-dialog');
  if (!panel || !dlg) return;
  const form = $('[data-connection-form]', dlg);

  on(document, 'click', '[data-connection-add]', (e, btn) => {
    const kind = btn.dataset.connectionAdd;
    form.reset();
    form.elements.kind.value = kind;
    delete form.elements.url.dataset.touched;
    // Providers that don't offer this kind are hidden (Gmail has no password-based calendar).
    for (const o of form.elements.provider.options) o.hidden = o.dataset[kind] !== 'true';
    form.elements.provider.value = [...form.elements.provider.options].find(o => !o.hidden)?.value || 'custom';
    $('[data-conn-title]', dlg).textContent = kind === 'email' ? 'Add a mailbox' : 'Add a calendar';
    showFields(form);
    openModal(dlg, btn);
    form.elements.username.focus();
  });
  form.elements.provider.addEventListener('change', () => showFields(form));
  form.elements.url.addEventListener('input', () => { form.elements.url.dataset.touched = '1'; });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    body.allowSelfSigned = form.elements.allowSelfSigned.checked;
    for (const el of $$('[aria-invalid]', form)) el.removeAttribute('aria-invalid');
    withBusy($('[data-conn-submit]', form), async () => {
      try {
        const res = await api(`/api/v1/connections/${body.kind}`, { method: 'POST', body });
        closeModal(dlg);
        await refreshPanel();
        toast.success(body.kind === 'email' ? `Connected ${res.connection.address}. Ask me about your mail.`
          : `Connected ${res.connection.label}${res.calendars ? ` (${res.calendars.length} calendar${res.calendars.length === 1 ? '' : 's'})` : ''}.`);
      } catch (err) {
        const fields = err.data?.errors;
        if (fields) for (const name of Object.keys(fields)) form.elements[name]?.setAttribute('aria-invalid', 'true');
        toast.error(fields ? Object.values(fields).join(' ') : err.message, { title: 'Not connected' });
      }
    }, 'Checking with the server…');
  });

  on(document, 'click', '[data-connection-test]', (e, btn) => withBusy(btn, async () => {
    try { await api(`/api/v1/connections/${btn.dataset.connectionTest}/test`, { method: 'POST' }); toast.success('Works.'); }
    catch (err) { toast.error(err.message, { title: 'That account isn’t working' }); }
    await refreshPanel().catch(() => {});
  }, 'Testing…'));

  on(document, 'click', '[data-connection-remove]', async (e, btn) => {
    if (!(await confirmDialog({ title: `Remove ${btn.dataset.label}?`, body: 'I stop reading it and forget its password. Nothing in the account itself changes.', confirmLabel: 'Remove', danger: true }))) return;
    try { await api(`/api/v1/connections/${btn.dataset.connectionRemove}`, { method: 'DELETE' }); await refreshPanel(); toast('Removed.'); }
    catch (err) { toast.error(err.message); }
  });
}
