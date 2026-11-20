// Voice notes in the chat (docs/VOICE.md) — in-house, no libraries:
//   - the player (partials/chat/voice-player.hbs): one plays at a time, the waveform fills and seeks; hers start at the
//     admin's speaking speed (pitch kept), then 1.5× → 2× → 1×;
//   - Listen on her replies (POST /api/v1/messages/:id/speak), and live voice.ready / voice.failed frames;
//   - the composer's recorder: Web Audio → 16 kHz mono WAV, live waveform, timer, discard/send, stops itself at 5:00;
//     sent like a message (optimistic bubble, Retry on failure), transcribed and answered — her reply comes back spoken.
import { $, on, api, h, escapeHtml, icon } from './core.js';
import { toast } from './toast.js';
import { scrollToEnd } from './composer.js';
import { announce } from './shell.js';

const MAX_MS = 5 * 60_000;
const RATE = 16_000;
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---- Player ---------------------------------------------------------------------------------------------------------
let current = null; // the player that is playing
// Speed: starts at the clip's rate (hers: the admin's speaking speed), then steps through the rest.
const speedsFor = el => [...new Set([Number(el.dataset.rate) || 1, 1.5, 2, 1])];
const speedOf = el => el._speed || Number(el.dataset.rate) || 1;

function durationOf(el, audio) {
  return Number.isFinite(audio?.duration) && audio.duration > 0 ? audio.duration : Number(el.dataset.durationMs || 0) / 1000;
}

function paint(el) {
  const audio = el._audio;
  const d = durationOf(el, audio), t = audio?.currentTime || 0;
  const bars = el.querySelectorAll('.vp-wave > span');
  const k = d ? Math.round((t / d) * bars.length) : 0;
  bars.forEach((b, i) => b.classList.toggle('is-played', i < k));
  const time = el.querySelector('[data-vp-time]');
  if (time) time.textContent = t > 0.05 && d ? `${fmt(t)} / ${fmt(d)}` : fmt(d);
  const wave = el.querySelector('[data-vp-wave]');
  if (wave) { wave.setAttribute('aria-valuenow', String(Math.round(t * 1000))); wave.setAttribute('aria-valuetext', `${fmt(t)} of ${fmt(d)}`); }
}

function audioOf(el) {
  if (el._audio) return el._audio;
  const a = new Audio(el.dataset.src);
  a.preload = 'auto';
  a.playbackRate = speedOf(el);
  a.preservesPitch = true; // faster, same voice
  let raf = 0;
  const loop = () => { paint(el); raf = requestAnimationFrame(loop); };
  a.addEventListener('playing', () => { el.dataset.state = 'playing'; cancelAnimationFrame(raf); loop(); });
  a.addEventListener('waiting', () => { el.dataset.state = 'loading'; });
  a.addEventListener('pause', () => { cancelAnimationFrame(raf); if (el.dataset.state !== 'loading' || a.paused) el.dataset.state = 'idle'; paint(el); });
  a.addEventListener('ended', () => { cancelAnimationFrame(raf); el.dataset.state = 'idle'; a.currentTime = 0; paint(el); if (current === el) current = null; });
  a.addEventListener('error', () => { cancelAnimationFrame(raf); el.dataset.state = 'idle'; toast.error('That voice note couldn’t be played.', { title: 'Voice note' }); });
  el._audio = a;
  return a;
}

export function play(el) {
  if (current && current !== el && current._audio && !current._audio.paused) current._audio.pause();
  current = el;
  const a = audioOf(el);
  el.dataset.state = 'loading';
  a.play().catch(err => { el.dataset.state = 'idle'; if (err.name !== 'AbortError') toast.error('Press play to listen. The browser blocked autoplay.', { title: 'Voice note' }); });
}
const toggle = el => { const a = el._audio; if (a && !a.paused) a.pause(); else play(el); };

function seekTo(el, ratio) {
  const a = audioOf(el);
  const d = durationOf(el, a);
  if (!d) return;
  a.currentTime = Math.min(d - 0.05, Math.max(0, ratio * d));
  paint(el);
}

function initPlayer() {
  on(document, 'click', '[data-vp-toggle]', (e, btn) => toggle(btn.closest('[data-voice-player]')));
  on(document, 'click', '[data-vp-wave]', (e, wave) => {
    const r = wave.getBoundingClientRect();
    const el = wave.closest('[data-voice-player]');
    seekTo(el, (e.clientX - r.left) / r.width);
    if (el._audio?.paused) play(el);
  });
  on(document, 'keydown', '[data-vp-wave]', (e, wave) => {
    const el = wave.closest('[data-voice-player]');
    const a = audioOf(el), d = durationOf(el, a);
    const step = { ArrowRight: 5, ArrowLeft: -5, ArrowUp: 5, ArrowDown: -5 }[e.key];
    if (step !== undefined) { e.preventDefault(); seekTo(el, ((a.currentTime || 0) + step) / d); }
    else if (e.key === 'Home') { e.preventDefault(); seekTo(el, 0); }
    else if (e.key === 'End') { e.preventDefault(); seekTo(el, 1); }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(el); }
  });
  on(document, 'click', '[data-vp-speed]', (e, btn) => {
    const el = btn.closest('[data-voice-player]');
    const list = speedsFor(el);
    el._speed = list[(list.indexOf(speedOf(el)) + 1) % list.length];
    if (el._audio) el._audio.playbackRate = el._speed;
    btn.textContent = `${el._speed}×`;
    btn.setAttribute('aria-label', `Playback speed: ${el._speed === 1 ? 'normal' : `${el._speed} times`}`);
  });
}

// Mirrors partials/chat/voice-player.hbs.
const pendingHtml = () => `<div class="vp vp-pending" data-voice-pending role="status" aria-live="polite">
  <span class="vp-play vp-rec" aria-hidden="true">${icon('audio-lines', 'size-4')}</span>
  <span class="vp-wave" aria-hidden="true">${Array.from({ length: 28 }, (_, i) => `<span style="--i:${i}"></span>`).join('')}</span>
  <span class="vp-time">Recording…</span></div>`;
function playerHtml({ id, src, direction, durationMs, peaks }) {
  const d = fmt(durationMs / 1000);
  return `<div class="vp ${direction === 'in' ? 'vp-in' : ''}" data-voice-player="${escapeHtml(id)}" data-src="${escapeHtml(src)}" data-duration-ms="${durationMs}" data-state="idle">
    <button type="button" class="vp-play" data-vp-toggle aria-label="Play your voice note (${d})"><span class="vp-i-play">${icon('play', 'size-4')}</span><span class="vp-i-pause">${icon('pause', 'size-4')}</span></button>
    <span class="vp-wave" data-vp-wave role="slider" tabindex="0" aria-label="Position in the voice note" aria-valuemin="0" aria-valuemax="${durationMs}" aria-valuenow="0" aria-valuetext="0:00 of ${d}">${peaks.map(p => `<span style="--h:${p}%"></span>`).join('')}</span>
    <span class="vp-time tabular" data-vp-time>${d}</span>
    <button type="button" class="vp-speed" data-vp-speed aria-label="Playback speed: normal">1×</button></div>`;
}

// ---- Her replies: Listen, voice.ready, voice.failed -----------------------------------------------------------------
const slotOf = messageId => document.querySelector(`[data-db-id="${CSS.escape(String(messageId))}"] [data-voice-slot]`);
const autoplay = new Set(); // message ids / run ids whose voice note should play the moment it's ready (asked for here)

function place(slot, html, { play: start = false } = {}) {
  if (!slot) return;
  slot.innerHTML = html;
  slot.hidden = false;
  const el = slot.querySelector('[data-voice-player]');
  if (el && start) play(el);
}
function failed(slot, messageId, error) {
  place(slot, `<div class="vp-failed" role="alert">${icon('circle-alert', 'size-4 text-bad shrink-0')}<span class="min-w-0 flex-1">${escapeHtml(error || 'The voice note didn’t come out.')}</span>
    <button type="button" class="btn btn-secondary btn-sm" data-listen="${escapeHtml(String(messageId))}">${icon('rotate-ccw', 'size-3.5')} Try again</button></div>`);
}

async function listen(messageId, btn) {
  const slot = slotOf(messageId);
  if (!slot) return;
  const ready = slot.querySelector('[data-voice-player]');
  if (ready) { toggle(ready); return; }
  if (slot.querySelector('[data-voice-pending]')) { autoplay.add(String(messageId)); return; }
  autoplay.add(String(messageId));
  place(slot, pendingHtml());
  btn?.setAttribute('aria-busy', 'true');
  try {
    const r = await api(`/api/v1/messages/${encodeURIComponent(messageId)}/speak`, { method: 'POST' });
    // The live frame may have placed it already (and started it).
    if (!slot.querySelector('[data-voice-player]')) place(slot, r.html, { play: autoplay.delete(String(messageId)) });
  } catch (err) {
    autoplay.delete(String(messageId));
    failed(slot, messageId, err.message);
  } finally { btn?.removeAttribute('aria-busy'); }
}

function initReplies() {
  on(document, 'click', '[data-listen]', (e, btn) => listen(btn.dataset.listen, btn));
  document.addEventListener('jb:ws:voice.ready', e => {
    const { data, runId } = e.detail;
    const slot = slotOf(data.messageId);
    if (!slot || slot.querySelector('[data-voice-player]') || !data.html) return;
    const start = autoplay.delete(String(data.messageId)) || autoplay.delete(`run:${runId}`);
    place(slot, data.html, { play: start });
    if (!start) announce('Voice note ready.');
  });
  document.addEventListener('jb:ws:voice.failed', e => {
    const { data } = e.detail;
    autoplay.delete(String(data.messageId));
    const slot = slotOf(data.messageId);
    if (slot && !slot.querySelector('[data-voice-player]')) failed(slot, data.messageId, data.error);
  });
}

// ---- Recorder -------------------------------------------------------------------------------------------------------
// Float32 blocks at the device rate → 16 kHz mono PCM16 WAV (box-filter downsampling is plenty for speech).
function toWav(blocks, rate) {
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const b of blocks) { all.set(b, o); o += b.length; }
  const ratio = rate / RATE;
  const n = Math.floor(total / ratio);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), z = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < z && j < total; j++) s += all[j];
    const v = Math.max(-1, Math.min(1, s / (z - a)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength), dv = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, RATE, true);
  dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  // 48 loudness bars for the bubble's waveform (same scale as the server's).
  const per = Math.max(1, Math.floor(n / 48)), peaks = [];
  for (let i = 0; i < 48; i++) {
    let s = 0, c = 0;
    for (let j = i * per; j < Math.min(n, (i + 1) * per); j++) { s += (pcm[j] / 32768) ** 2; c++; }
    peaks.push(c ? Math.sqrt(s / c) : 0);
  }
  const max = Math.max(...peaks, 1e-6);
  return { blob: new Blob([buf], { type: 'audio/wav' }), durationMs: Math.round((n / RATE) * 1000), peaks: peaks.map(p => Math.max(8, Math.round((p / max) * 100))) };
}

function optimisticNote(clientId, url, note) {
  return h(`<article class="msg msg-user group flex flex-col items-end animate-rise" data-client-id="${clientId}" data-delivery="sending">
    <div class="msg-voice msg-user-bubble max-w-[92%] rounded-2xl rounded-br-md bg-accent p-2 text-accent-ink shadow-sm sm:max-w-[26rem]">
      ${playerHtml({ id: clientId, src: url, direction: 'in', durationMs: note.durationMs, peaks: note.peaks })}</div>
    <div class="mt-1 flex h-5 items-center gap-2 px-1 text-[11px] text-ink-3"><span data-delivery-label><span class="spinner size-2.5"></span> Listening to your note…</span></div>
  </article>`);
}

function initRecorder() {
  const form = $('[data-composer]');
  const mic = form && $('[data-composer-mic]', form);
  if (!mic) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
    mic.setAttribute('aria-disabled', 'true');
    mic.dataset.tooltip = window.isSecureContext ? 'Voice notes need a newer browser' : 'Voice notes need a secure address (https, or open Jessbot on this computer)';
    return;
  }
  const bar = $('[data-rec]', form), timeEl = $('[data-rec-time]', form), wave = $('[data-rec-wave]', form);
  const list = $('[data-message-list]');
  const url = form.dataset.sendUrl.replace(/\/messages$/, '/voice-notes');
  let rec = null;

  async function start() {
    if (rec || mic.getAttribute('aria-disabled') === 'true') return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      toast.error(err.name === 'NotAllowedError' ? 'Allow the microphone for this site (the icon in the address bar), then try again.'
        : err.name === 'NotFoundError' ? 'No microphone was found on this device.' : `The microphone didn’t start (${err.message}).`, { title: 'Can’t record' });
      return;
    }
    const ctx = new AudioContext();
    try { await ctx.audioWorklet.addModule('/js/rec-worklet.js'); } catch { stream.getTracks().forEach(t => t.stop()); ctx.close(); toast.error('The recorder didn’t load. Refresh and try again.'); return; }
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'jb-recorder');
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node); source.connect(analyser); node.connect(mute).connect(ctx.destination); // pulled, never heard
    const blocks = [];
    node.port.onmessage = e => blocks.push(e.data);
    rec = { stream, ctx, blocks, started: performance.now(), timer: 0 };
    wave.innerHTML = '';
    timeEl.textContent = '0:00';
    form.toggleAttribute('data-recording', true);
    mic.setAttribute('aria-pressed', 'true');
    announce('Recording. Press Enter or the send button to send, Escape to discard.');
    $('[data-rec-send]', form).focus();
    const data = new Float32Array(analyser.fftSize);
    rec.timer = setInterval(() => {
      const ms = performance.now() - rec.started;
      timeEl.textContent = fmt(ms / 1000);
      analyser.getFloatTimeDomainData(data);
      let s = 0;
      for (const v of data) s += v * v;
      const level = Math.min(1, Math.sqrt(s / data.length) * 5);
      const b = document.createElement('span');
      b.style.setProperty('--h', `${Math.max(8, Math.round(level * 100))}%`);
      wave.append(b);
      while (wave.childElementCount > 90) wave.firstElementChild.remove();
      if (ms >= MAX_MS) { toast('That’s 5 minutes, so I sent it.', { title: 'Voice note' }); send(); }
    }, 90);
  }

  function stop() {
    if (!rec) return null;
    const r = rec;
    rec = null;
    clearInterval(r.timer);
    r.stream.getTracks().forEach(t => t.stop());
    r.ctx.close().catch(() => {});
    form.removeAttribute('data-recording');
    mic.setAttribute('aria-pressed', 'false');
    return r;
  }

  function cancel() { if (stop()) { announce('Recording discarded.'); $('[data-composer-input]', form)?.focus(); } }

  function send() {
    const r = stop();
    if (!r) return;
    const rate = r.ctx.sampleRate;
    if (performance.now() - r.started < 600 || !r.blocks.length) { toast('Hold on a little longer. That was too short to hear.', { title: 'Voice note' }); return; }
    upload(toWav(r.blocks, rate));
  }

  async function upload(note, existing = null) {
    const clientId = existing?.dataset.clientId || crypto.randomUUID();
    const local = existing?._localUrl || URL.createObjectURL(note.blob);
    const bubble = existing || optimisticNote(clientId, local, note);
    bubble._localUrl = local;
    if (!existing) { list?.append(bubble); scrollToEnd(); }
    const label = bubble.querySelector('[data-delivery-label]');
    bubble.dataset.delivery = 'sending';
    label.innerHTML = '<span class="spinner size-2.5"></span> Listening to your note…';
    try {
      let res;
      for (let attempt = 0; ; attempt++) {
        const fd = new FormData();
        fd.append('clientId', clientId);
        fd.append('audio', note.blob, 'voice-note.wav');
        try { res = await api(url, { method: 'POST', body: fd }); break; } catch (err) {
          if (err.status !== 0 || attempt >= 3) throw err;
          await new Promise(ok => setTimeout(ok, 800 * 2 ** attempt));
        }
      }
      if (res.runId) autoplay.add(`run:${res.runId}`); // her spoken answer plays when it's ready
      bubble.replaceWith(h(res.messageHtml));
      URL.revokeObjectURL(local);
      if (res.runHtml) list?.append(h(res.runHtml));
      scrollToEnd();
      document.dispatchEvent(new CustomEvent('chat:sent', { detail: res }));
    } catch (err) {
      bubble.dataset.delivery = 'failed';
      label.innerHTML = '<span class="font-medium text-bad">Not sent</span> · <button type="button" class="font-medium text-accent-text hover:underline" data-note-resend>Retry</button>';
      label.querySelector('[data-note-resend]').addEventListener('click', () => upload(note, bubble), { once: true });
      const why = err.data?.errors?.audio || err.message;
      toast.error(why, { title: 'Voice note not sent' });
      announce(`Voice note not sent. ${why}`);
    }
  }

  mic.addEventListener('click', start);
  $('[data-rec-cancel]', form).addEventListener('click', cancel);
  $('[data-rec-send]', form).addEventListener('click', send);
  form.addEventListener('keydown', e => {
    if (!rec) return;
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter' && !e.target.closest('[data-rec-cancel]')) { e.preventDefault(); send(); }
  });
  // Leaving the page mid-recording releases the microphone.
  window.addEventListener('pagehide', () => stop());
}

export function initVoice() {
  initPlayer();
  initReplies();
  initRecorder();
}
