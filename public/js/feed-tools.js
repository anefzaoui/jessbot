// The Feed's extras (Phase 25, decision #204): OPML import on /feed/sources, muted words, and the monthly reading diet card.
//  - OPML: choose a file (read here, sent as text) or paste the list; Import shows a loader while the server reads it, then
//    its summary (added where, skipped and why) and the topic cards re-render from the server. Errors show under the field.
//  - Muted words: Mute adds the word at once as a pending chip; the server's re-rendered card replaces it (or the chip goes
//    and the reason shows under the field). Unmute dims the chip, then the card re-renders, with Undo.
//  - The reading diet card (Feed home) stays hidden until we know it wasn't dismissed this month; Hide keeps it hidden
//    until next month (per browser: it's a convenience, the same card comes back on a new device).
// Server contract: POST /api/v1/feed/opml?fragment=1 { opml, topic? } → { added, skipped, topics, message, html } ·
//   GET /api/v1/feed/sources?fragment=1 → { html, counts } · POST / DELETE /api/v1/feed/mutes?fragment=1 { kind, value } →
//   { hidden, mutes, html }.
import { $, $$, on, api, withBusy, loader, h, escapeHtml, storage } from './core.js';
import { toast } from './toast.js';
import { showErrors, clearErrors } from './forms.js';

const OPML_MAX = 900_000;

function initOpml() {
  const box = $('[data-opml]');
  if (!box) return;
  const form = $('[data-opml-form]', box), file = $('[data-opml-file]', box), text = $('[data-opml-text]', box);
  const paste = $('[data-opml-paste]', box), pasteBtn = $('[data-opml-paste-open]', box), name = $('[data-opml-filename]', box);
  const submit = $('[data-opml-import]', box), slot = $('[data-opml-result-slot]', box);
  let fromFile = '';
  const ready = () => { submit.disabled = !(fromFile || text.value.trim()); };

  pasteBtn.addEventListener('click', () => {
    const open = paste.hidden;
    paste.hidden = !open;
    pasteBtn.setAttribute('aria-expanded', String(open));
    if (open) text.focus();
  });
  text.addEventListener('input', () => { if (text.value.trim()) { fromFile = ''; file.value = ''; name.hidden = true; } ready(); });
  file.addEventListener('change', async () => {
    clearErrors(form);
    const f = file.files[0];
    fromFile = '';
    name.hidden = !f;
    if (!f) return ready();
    name.textContent = f.name;
    if (f.size > OPML_MAX) { showErrors(form, { file: 'That file is too big for a feed list.' }); return ready(); }
    fromFile = await f.text();
    text.value = '';
    ready();
  });

  const refreshTopics = async () => {
    const r = await api('/api/v1/feed/sources?fragment=1');
    const list = $('[data-topic-list]');
    if (list) list.innerHTML = r.html;
    $('[data-sources-empty]')?.remove(); // the empty state, when there were no topics before
    for (const [k, v] of Object.entries(r.counts || {})) { const el = $(`[data-src-summary] [data-count="${k}"]`); if (el) el.textContent = v; }
  };

  form.addEventListener('submit', async e => {
    e.preventDefault();
    clearErrors(form);
    const opml = fromFile || text.value;
    if (!opml.trim()) return showErrors(form, { file: 'Choose the .opml file your feed reader exported, or paste it.' });
    slot.innerHTML = loader('Reading your list…', { motion: 'reading', iconName: 'file-text', lines: 2 });
    await withBusy(submit, async () => {
      try {
        const r = await api('/api/v1/feed/opml?fragment=1', { method: 'POST', body: { opml, topic: form.elements.topic.value.trim() || undefined } });
        slot.innerHTML = r.html;
        if (r.added?.length) {
          await refreshTopics().catch(() => toast('Reload the page to see the new feeds.'));
          form.reset(); fromFile = ''; name.hidden = true; ready();
        }
        toast.success(r.message);
      } catch (err) {
        slot.innerHTML = '';
        const errors = err.data?.errors;
        const { opml: why, ...rest } = errors || {};
        if (errors) showErrors(form, why ? { [fromFile ? 'file' : 'opml']: why, ...rest } : rest);
        else toast.error(err.message, { title: 'Couldn’t import the list' });
      }
    }, 'Importing…');
  });
}

function initMutes() {
  const slot = $('[data-mutes-slot]');
  if (!slot) return;
  const send = (method, kind, value) => api('/api/v1/feed/mutes?fragment=1', { method, body: { kind, value } });

  on(slot, 'submit', '[data-mute-form]', async (e, form) => {
    e.preventDefault();
    clearErrors(form);
    const input = $('[data-mute-input]', form);
    const value = input.value.replace(/\s+/g, ' ').trim();
    if (!value) return showErrors(form, { value: 'Which word should I hide stories about?' });
    if ($$('[data-mute][data-kind="word"]', slot).some(c => c.dataset.mute.toLowerCase() === value.toLowerCase())) {
      return showErrors(form, { value: 'That word is muted already.' });
    }
    const chips = $('[data-mute-words]', slot);
    const pending = h(`<li class="mute-chip is-pending" data-kind="word"><span dir="auto">${escapeHtml(value)}</span></li>`);
    chips.prepend(pending);
    $('[data-mute-empty]', slot)?.setAttribute('hidden', '');
    await withBusy($('[data-mute-add]', form), async () => {
      try {
        const r = await send('POST', 'word', value);
        slot.innerHTML = r.html;
        $(`[data-mute="${CSS.escape(value)}"]`, slot)?.classList.add('just-changed');
        $('[data-mute-input]', slot)?.focus();
        toast.success(`Muted “${value}”. Stories with it stay out of your Feed.`);
      } catch (err) {
        pending.remove();
        $('[data-mute-empty]', slot)?.removeAttribute('hidden');
        if (err.data?.errors) showErrors(form, { value: Object.values(err.data.errors).join(' ') });
        else toast.error(err.message, { title: 'Couldn’t mute it' });
      }
    }, 'Muting…');
  });

  on(slot, 'click', '[data-unmute]', async (e, btn) => {
    const chip = btn.closest('[data-mute]');
    if (chip.hasAttribute('data-pending')) return;
    const { kind, mute: value } = chip.dataset;
    chip.setAttribute('data-pending', '');
    try {
      const r = await send('DELETE', kind, value);
      slot.innerHTML = r.html;
      toast.success(`Unmuted “${value}”.`, { action: { label: 'Undo', onClick: async () => {
        try { slot.innerHTML = (await send('POST', kind, value)).html; } catch (err) { toast.error(err.message, { title: 'Couldn’t mute it again' }); }
      } } });
    } catch (err) {
      chip.removeAttribute('data-pending');
      toast.error(err.message, { title: 'Couldn’t unmute it', action: { label: 'Try again', onClick: () => btn.click() } });
    }
  });
}

function initDiet() {
  const card = $('[data-diet]');
  if (!card) return;
  const key = 'jb-diet-hidden';
  if (storage.get(key) === card.dataset.month) return card.remove();
  card.hidden = false;
  on(card, 'click', '[data-diet-dismiss]', () => {
    storage.set(key, card.dataset.month);
    const gone = () => card.remove();
    const anim = card.animate?.([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 180 });
    anim ? anim.finished.then(gone) : gone();
    toast('Hidden until next month.');
  });
}

export function initFeedTools() {
  initOpml();
  initMutes();
  initDiet();
}
