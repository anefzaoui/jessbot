// Setup wizard behaviour: timezone default, model connection test, live identity preview, invites & groups.
import { $, $$, on, api, withBusy, escapeHtml, icon, h } from './core.js';
import { toast } from './toast.js';
import { initModelTest } from './model-test.js';


// ---- Brain: test the connection (shared with Admin → Model) -----------------------------
initModelTest();

// ---- Identity: live preview ------------------------------------------------------------
const idForm = $('[data-identity-form]');
if (idForm) {
  const f = idForm.elements;
  const set = (sel, text) => { for (const el of $$(sel)) el.textContent = text; };
  const sync = () => {
    const name = f.name.value.trim() || 'Jess';
    set('[data-preview-name]', name);
    set('[data-preview-lineage]', name.toLowerCase() === 'jess' ? '' : ', originally Jess');
    set('[data-preview-pronouns]', f.pronouns.value.trim() || $('input[name="variant"]:checked', idForm)?.dataset.pronouns || '');
    set('[data-preview-description]', f.description.value.trim() || 'Your personal agent, always working in the background.');
  };
  let lastDefault = $('input[name="variant"]:checked', idForm)?.dataset.pronouns;
  idForm.addEventListener('input', sync);
  idForm.addEventListener('change', e => {
    if (e.target.name === 'variant') {
      // Pronouns follow the look unless the owner typed their own.
      if (!f.pronouns.value.trim() || f.pronouns.value.trim() === lastDefault) f.pronouns.value = e.target.dataset.pronouns;
      lastDefault = e.target.dataset.pronouns;
      // The preview smiles back with the chosen face (falls back to that variant's neutral frame).
      const img = $('[data-preview-portrait]', idForm);
      if (img) {
        const v = e.target.value;
        img.onerror = () => { img.onerror = null; img.src = `/img/avatars/${v}/neutral-256.webp`; };
        img.src = `/img/avatars/${v}/happy-256.webp`;
      }
      // The living presence (setup hero) becomes the chosen character.
      document.dispatchEvent(new CustomEvent('jb:variant', { detail: { variant: e.target.value } }));
    }
    sync();
  });
  sync();
}

// ---- People: groups & invites ----------------------------------------------------------
document.addEventListener('ajax:success', e => {
  const form = e.target;
  if (form.matches('[data-group-form]') && e.detail?.group) {
    const g = e.detail.group;
    $('[data-group-list]')?.append(h(`<span class="chip cursor-default animate-rise">${icon('users', 'size-3.5')} ${escapeHtml(g.name)}</span>`));
    $('[data-group-select]')?.append(new Option(g.name, g.id));
    toast.success(`Group “${g.name}” added.`);
  }
  if (form.matches('[data-invite-form]') && e.detail?.link) {
    const { link, name } = e.detail;
    $('[data-invite-links]')?.prepend(h(`
      <div class="rounded-xl border border-ok/30 bg-ok-soft px-4 py-3 animate-rise">
        <p class="text-sm font-semibold">Invite for ${escapeHtml(name)} is ready</p>
        <p class="text-xs text-ink-2">Send this link to them. It works once and expires in 7 days. Copy it now; it won't be shown again.</p>
        <div class="mt-2 flex gap-2">
          <input class="input h-9 flex-1 font-mono text-xs" value="${escapeHtml(link)}" readonly aria-label="Invite link" data-select-on-focus>
          <button type="button" class="btn btn-secondary btn-sm h-9" data-copy="${escapeHtml(link)}">${icon('copy')} Copy</button>
        </div>
      </div>`));
    form.reset();
  }
});
