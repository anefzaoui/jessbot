// The project soul, in the page (decision #93): accept or keep a proposed change (in the chat or under "Jess here"), try a
// question with it first, edit the soul, improve or draft it with AI, restore a version, forget a learned note.
// Server contract (routes/api/v1/projects.js): GET /api/v1/projects/:id/soul → { editable, … } · POST …/soul { fields }
// · POST …/soul/improve → { proposal } · POST …/soul/proposals/:pid { decision } → { status, cardHtml } · POST …/soul/restore/:v
// · POST …/soul/forget { note } · POST …/soul/try { question, proposalId? } → { html }. The panel re-renders on project.updated.
import { $, $$, on, api, h, withBusy, loader } from './core.js';
import { toast } from './toast.js';
import { openModal, closeModal, confirmDialog } from './modal.js';
import { selectTab } from './tabs.js';

const pageProject = () => $('[data-project-page]')?.dataset.projectPage || null;
const soulUrl = (id, rest = '') => `/api/v1/projects/${encodeURIComponent(id)}/soul${rest}`;
const LIST = ['anchors', 'askFirst', 'checkWork', 'glossary', 'learned'];

function showSoulTab() {
  for (const tab of $$('[role="tab"][id$="-tab-soul"]')) if (tab.offsetParent) selectTab(tab);
}

export function initProjectSoul() {
  // ---- A proposal: Accept / Keep as is ---------------------------------------------------------------------------------
  on(document, 'click', '[data-soul-decide]', (e, btn) => {
    const card = btn.closest('[data-soul-proposal]');
    const accept = btn.dataset.soulDecide === 'accept';
    card.setAttribute('aria-busy', 'true');
    withBusy(btn, async () => {
      try {
        const out = await api(soulUrl(card.dataset.project, `/proposals/${card.dataset.soulProposal}`), { method: 'POST', body: { decision: accept ? 'accept' : 'reject' } });
        // The same proposal may show twice (on her reply and under "Jess here"): update every copy.
        for (const copy of $$(`[data-soul-proposal="${card.dataset.soulProposal}"]`)) copy.replaceWith(h(out.cardHtml));
        toast.success(accept ? `Accepted. That’s how I’ll work here now (version ${out.version}).` : 'Kept as it was.');
      } catch (err) { card.removeAttribute('aria-busy'); toast.error(err.message); }
    }, accept ? 'Saving…' : null);
  });

  // ---- Try it: one question answered with the current soul or a proposal (nothing saved) ------------------------------------
  on(document, 'click', '[data-soul-try-open]', (e, btn) => {
    const scope = btn.closest('[data-soul-proposal]') || btn.closest('[role="tabpanel"]') || document;
    const form = $('[data-soul-try]', scope);
    if (!form) return;
    form.hidden = !form.hidden;
    if (!form.hidden) form.elements.question.focus();
  });
  on(document, 'submit', '[data-soul-try]', (e, form) => {
    e.preventDefault();
    const question = form.elements.question.value.trim();
    if (!question) { form.elements.question.focus(); return; }
    const project = form.closest('[data-soul-proposal]')?.dataset.project || pageProject();
    const out = $('[data-soul-try-out]', form);
    out.innerHTML = loader(form.dataset.proposalId ? 'Answering the way I would with this change…' : 'Answering the way I would here…', { motion: 'thinking', iconName: 'flask-conical' });
    withBusy($('button', form), async () => {
      try {
        const res = await api(soulUrl(project, '/try'), { method: 'POST', body: { question, proposalId: form.dataset.proposalId || undefined } });
        out.innerHTML = `<div class="soul-try-answer prose-jb">${res.html}</div><p class="mt-1 text-[11px] text-ink-3">A preview. Nothing was saved.</p>`;
      } catch (err) { out.innerHTML = ''; toast.error(err.message); }
    });
  });

  // ---- Edit -------------------------------------------------------------------------------------------------------------------
  const dlg = $('#soul-editor');
  const form = dlg && $('[data-soul-form]', dlg);
  on(document, 'click', '[data-soul-edit]', async (e, btn) => {
    if (!form) return;
    await withBusy(btn, async () => {
      try {
        const soul = await api(soulUrl(pageProject()));
        form.reset();
        for (const [k, v] of Object.entries(soul.editable)) if (form.elements[k]) form.elements[k].value = v;
        openModal(dlg, btn);
      } catch (err) { toast.error(err.message); }
    });
  });
  form?.addEventListener('submit', e => {
    e.preventDefault();
    const fields = {};
    for (const el of $$('input[name], textarea[name]', form)) fields[el.name] = LIST.includes(el.name) ? el.value.split('\n') : el.value;
    withBusy($('[data-soul-save]', form), async () => {
      try {
        const out = await api(soulUrl(pageProject()), { method: 'POST', body: { fields } });
        closeModal(dlg);
        showSoulTab();
        toast.success(`Saved as version ${out.version}.`);
      } catch (err) {
        const errs = err.data?.errors;
        toast.error(errs ? Object.values(errs).join(' ') : err.message, { title: 'Not saved' });
      }
    }, 'Saving…');
  });

  // ---- Improve / draft with AI → a proposal to review -------------------------------------------------------------------------
  on(document, 'click', '[data-soul-improve]', (e, btn) => withBusy(btn, async () => {
    const t = toast.pending('Reading the project and how we work together…', { title: 'Thinking about how I work here' });
    try {
      await api(soulUrl(pageProject(), '/improve'), { method: 'POST' });
      showSoulTab();
      t.done('A suggestion is ready under “Jess here”. Review the changes, try it, then accept or keep yours.');
    } catch (err) { t.fail(err.message); }
  }, 'Thinking…'));

  // ---- History: restore a version; forget a learned note ----------------------------------------------------------------------
  on(document, 'click', '[data-soul-restore]', async (e, btn) => {
    const v = btn.dataset.soulRestore;
    if (!(await confirmDialog({ title: `Restore version ${v}?`, body: 'It becomes the newest version; nothing is lost. The current one stays in the history.', confirmLabel: 'Restore' }))) return;
    withBusy(btn, async () => {
      try { const out = await api(soulUrl(pageProject(), `/restore/${v}`), { method: 'POST' }); toast.success(`Restored. Now version ${out.version}.`); }
      catch (err) { toast.error(err.message); }
    });
  });
  on(document, 'click', '[data-soul-forget]', (e, btn) => {
    const row = btn.closest('.brief-row');
    row?.setAttribute('aria-busy', 'true');
    api(soulUrl(pageProject(), '/forget'), { method: 'POST', body: { note: btn.dataset.soulForget } })
      .then(() => toast.success('Forgotten.'))
      .catch(err => { row?.removeAttribute('aria-busy'); toast.error(err.message); });
  });
}
