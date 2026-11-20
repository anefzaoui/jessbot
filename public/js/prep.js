// Overnight prep, the screens (Phase 25 #212): the person's switch on You → Notifications (waits for the server, says what
// changed and what would stop it, goes back when it failed) and the admin's nightly cap on Admin → Usage (a data-ajax form; this
// only says what the saved value means). The Ideas page's "Ready for you" cards use ideas.js (start) and plain links.
// Server contract: PUT /api/v1/me/prep { prep: off|ideas } → { prep, view: { stopped, … } } · PUT /api/v1/admin/prep
// { dailyCap } → { prep: { dailyCap } } (422 { errors: { dailyCap } } under the field, forms.js).
import { $, api } from './core.js';
import { toast } from './toast.js';

function initSwitch() {
  const box = $('[data-prep]');
  const sw = $('[data-prep-switch]', box || document);
  if (!box || !sw) return;
  const state = $('[data-prep-state]', box);
  const stopped = $('[data-prep-stopped]', box);
  const say = (tone, text) => { state.className = `mt-1 text-xs font-medium ${tone}`; state.textContent = text; };
  sw.addEventListener('change', async () => {
    const on_ = sw.checked;
    box.dataset.pending = '';
    sw.disabled = true;
    say('text-ink-3', on_ ? 'Turning on…' : 'Turning off…');
    try {
      const r = await api('/api/v1/me/prep', { method: 'PUT', body: { prep: on_ ? 'ideas' : 'off' } });
      sw.checked = r.prep === 'ideas';
      box.dataset.value = r.prep;
      if (stopped) { stopped.hidden = !r.view?.stopped; stopped.querySelector('span').textContent = r.view?.stopped || ''; }
      if (!sw.checked) say('text-ok', 'Off. I won’t prepare anything overnight.');
      else if (r.view?.stopped) say('text-warn-text', 'On, but it can’t run yet: see above.');
      else say('text-ok', 'On. Tonight, in your quiet hours, I’ll look for an idea worth preparing.');
    } catch (err) {
      sw.checked = !on_;
      say('text-bad', `Not changed: ${err.message}`);
      toast.error(err.message, { title: 'Couldn’t change overnight prep' });
    } finally {
      delete box.dataset.pending;
      sw.disabled = false;
    }
  });
}

function initCap() {
  const form = $('[data-prep-cap]');
  if (!form) return;
  const state = $('[data-prep-cap-state]', form);
  form.addEventListener('ajax:success', e => {
    const cap = Number(e.detail?.prep?.dailyCap);
    form.elements.dailyCap.value = cap;
    state.className = `mt-1 text-xs font-medium ${cap > 0 ? 'text-ok' : 'text-warn-text'}`;
    state.textContent = cap > 0 ? `Saved: up to $${cap.toFixed(cap < 0.01 ? 3 : 2)} a night per person.` : 'Saved: off for everyone.';
  });
  form.addEventListener('ajax:error', () => { state.textContent = ''; });
}

export function initPrep() {
  initSwitch();
  initCap();
}
