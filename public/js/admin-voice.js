// Admin → Models → her voice (docs/VOICE.md): save the voice settings, "Hear her" with the choices on screen (saved or
// not), and a sample of any single voice. Samples come back as a WAV (base64) and play in the page's own player.
import { $, on, api, withBusy, escapeHtml, icon } from './core.js';
import { toast } from './toast.js';
import { play } from './voice.js';

const fmt = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function initAdminVoice() {
  const form = $('[data-voice-form]');
  if (!form) return;
  const result = $('[data-voice-result]', form);
  const values = () => Object.fromEntries(new FormData(form));
  let lastUrl = null;

  // One sample → a player card under the form (and it plays).
  async function sample(voice) {
    const v = values();
    const r = await api('/api/v1/admin/voice/preview', { method: 'POST', body: { voice: voice ?? v.voice, direction: v.direction } });
    const bytes = Uint8Array.from(atob(r.audio), c => c.charCodeAt(0));
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const bars = Array.from({ length: 40 }, (_, i) => 30 + Math.round(55 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6))));
    result.innerHTML = `<div class="mt-1 rounded-xl border border-line bg-surface-2/60 p-3 animate-rise">
      <div class="vp" data-voice-player="sample" data-src="${lastUrl}" data-duration-ms="${r.durationMs}" data-rate="${values().speed || 1}" data-state="idle">
        <button type="button" class="vp-play" data-vp-toggle aria-label="Play the sample"><span class="vp-i-play">${icon('play', 'size-4')}</span><span class="vp-i-pause">${icon('pause', 'size-4')}</span></button>
        <span class="vp-wave" data-vp-wave role="slider" tabindex="0" aria-label="Position in the sample" aria-valuemin="0" aria-valuemax="${r.durationMs}" aria-valuenow="0">${bars.map(b => `<span style="--h:${b}%"></span>`).join('')}</span>
        <span class="vp-time tabular" data-vp-time>${fmt(r.durationMs)}</span>
        <button type="button" class="vp-speed" data-vp-speed aria-label="Playback speed">${values().speed || 1}×</button></div>
      <p class="mt-2 text-xs text-ink-3">${escapeHtml(r.voice)} · ${escapeHtml(r.model)} · made in ${(r.ms / 1000).toFixed(1)}s${r.attempts > 1 ? ` (${r.attempts} tries; the first drifted from the script)` : ''}</p>
      <p class="mt-1 text-[13px] text-ink-2">“${escapeHtml(r.transcript)}”</p></div>`;
    play($('[data-voice-player]', result));
  }

  on(document, 'click', '[data-voice-hear]', (e, btn) => withBusy(btn, () => sample().catch(err => toast.error(err.message, { title: 'No sample' })), 'Recording a sample…'));
  on(form, 'click', '[data-voice-sample]', async (e, btn) => {
    e.preventDefault();
    if (btn.dataset.state === 'loading') return;
    btn.dataset.state = 'loading';
    btn.setAttribute('aria-busy', 'true');
    try { await sample(btn.dataset.voiceSample); } catch (err) { toast.error(err.message, { title: 'No sample' }); }
    finally { delete btn.dataset.state; btn.removeAttribute('aria-busy'); }
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    withBusy($('[data-voice-save]', form), async () => {
      try {
        const r = await api(form.getAttribute('action'), { method: 'POST', body: values() });
        const s = r.settings;
        const speaking = s.voice || $('input[name="voice"][value=""]', form).closest('label').querySelector('.badge').textContent.toLowerCase();
        $('[data-tile-voice]')?.replaceChildren(`${s.model} · ${speaking}`);
        $('[data-tile-stt]')?.replaceChildren(s.sttModel);
        toast.success(`Saved. She speaks with ${speaking}.`);
      } catch (err) { toast.error(err.message, { title: 'Not saved' }); }
    }, 'Saving…');
  });
}
