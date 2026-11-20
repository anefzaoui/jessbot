// Voice API (docs/VOICE.md, docs/API.md): voice notes in, Jess's spoken replies out, the audio itself, and the admin's
// "Hear her" preview. Audio is private to its owner (admins may listen, read-only, like chats).
import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import { get, settings } from '../../../db/index.js';
import { threadForViewer, mainThread } from '../../../services/threads.js';
import { findByClientId } from '../../../services/messages.js';
import { getRun } from '../../../services/runs.js';
import { assistantView, userView } from '../../../services/chatview.js';
import { startTurn } from '../../../agent/loop.js';
import { speakMessage } from '../../../agent/voice.js';
import { parseWav, peaksOf, transcribe, saveClip, linkClip, clipFor, clipFile, clipView, synthesize, saveVoiceSettings, voiceSettings,
  MAX_NOTE_BYTES, MAX_NOTE_MS } from '../../../services/voice.js';
import { forbidden, invalid, notFound, tooMany } from '../../../lib/errors.js';
import { hit } from '../../../lib/ratelimit.js';
import { audit } from '../../../services/audit.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_NOTE_BYTES, files: 1, fields: 4 } });
const receive = (req, res) => new Promise((resolve, reject) => upload.single('audio')(req, res, err => {
  if (!err) return resolve();
  reject(invalid({ audio: err.code === 'LIMIT_FILE_SIZE' ? 'That voice note is too long — keep it under 5 minutes.' : 'That voice note didn’t come through — try again.' }));
}));
const fragment = (res, partial, data) => new Promise((resolve, reject) =>
  res.render('fragment', { layout: false, partial, data, ...data }, (err, html) => (err ? reject(err) : resolve(html))));

// A voice note → transcribed → sent like a typed message (her reply comes back as a voice note too).
// Same response as POST /threads/:id/messages: { messageHtml, runHtml, runId, threadId, transcript }.
router.post('/threads/:id/voice-notes', async (req, res) => {
  const l = hit(`voice-notes:${req.user.id}`, { limit: 30, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany(`That’s a lot of voice notes — try again in ${Math.ceil(l.retryInMs / 60e3)} min.`);
  await receive(req, res);
  const { thread } = req.params.id === 'main' ? { thread: mainThread(req.user.id) } : threadForViewer(req.params.id, req.user, { write: true });
  const clientId = String(req.body?.clientId || '').slice(0, 64) || null;
  const existing = findByClientId(thread.id, clientId); // a retried upload returns the original
  if (existing) {
    const r = get('SELECT * FROM runs WHERE trigger_message_id = ? ORDER BY id DESC LIMIT 1', existing.id);
    return res.json({ messageHtml: await fragment(res, 'chat/message', userView(existing)), runHtml: r ? await fragment(res, 'chat/message', assistantView(r)) : null,
      runId: r?.id, threadId: thread.id, transcript: existing.content });
  }
  if (!req.file?.buffer?.length) throw invalid({ audio: 'Record something first.' });
  const wav = parseWav(req.file.buffer);
  if (wav.durationMs < 500) throw invalid({ audio: 'That was too short to hear — hold on a little longer.' });
  if (wav.durationMs > MAX_NOTE_MS + 10_000) throw invalid({ audio: 'That voice note is too long — keep it under 5 minutes.' });
  const transcript = await transcribe(req.file.buffer, { user: req.user });
  if (!transcript) throw invalid({ audio: 'I couldn’t make out any words — try again a little closer to the mic.' });
  const clip = saveClip({ user: req.user, threadId: thread.id, direction: 'in', wav: req.file.buffer, durationMs: wav.durationMs,
    peaks: peaksOf(wav.samples), transcript, model: voiceSettings().sttModel });
  const { msg, run: r } = startTurn({ user: req.user, thread, text: transcript, clientId, voice: 2 });
  linkClip(clip.id, msg.id);
  res.json({ messageHtml: await fragment(res, 'chat/message', userView(msg)), runHtml: await fragment(res, 'chat/message', assistantView(getRun(r.id))),
    runId: r.id, threadId: thread.id, transcript });
});

// Listen: her reply as a voice note (made once, then cached) → { clip, html }.
router.post('/messages/:id/speak', async (req, res) => {
  const l = hit(`speak:${req.user.id}`, { limit: 40, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany(`That’s a lot of listening — try again in ${Math.ceil(l.retryInMs / 60e3)} min.`);
  const clip = await speakMessage(req.user, Number(req.params.id));
  const view = clipView(clip);
  res.json({ clip: view, html: await fragment(res, 'chat/voice-player', view) });
});

// The audio (WAV; Range requests work, so players can seek).
router.get('/voice/:id', (req, res) => {
  const clip = clipFor(req.user, req.params.id);
  const file = clipFile(clip);
  if (!fs.existsSync(file)) throw notFound('That recording is missing.');
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type('audio/wav').sendFile(file);
});

// ---- Admin: voice settings and "Hear her" ---------------------------------------------------------------------------
const adminOnly = req => { if (req.user.role !== 'admin') throw forbidden('Only the admin can change her voice.'); };

router.post('/admin/voice', (req, res) => {
  adminOnly(req);
  const s = saveVoiceSettings(req.body || {});
  audit('voice.settings', { actorId: req.user.id, detail: { model: s.model, voice: s.voice || 'auto', direction: s.direction ? 'custom' : 'auto' } });
  res.json({ ok: true, settings: s });
});

// A short sample in the chosen voice and direction (unsaved choices included) → { audio (base64 WAV), transcript, … }.
router.post('/admin/voice/preview', async (req, res) => {
  adminOnly(req);
  const l = hit(`voice-preview:${req.user.id}`, { limit: 20, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany('Give it a minute before the next sample.');
  const name = settings.get('bot', {}).name || 'Jess';
  const text = String(req.body?.text || '').trim().slice(0, 300)
    || `Hi, it’s ${name}. This is how I sound when I send you a voice note — tell me if you’d like me warmer, calmer or brighter.`;
  const started = Date.now();
  const out = await synthesize(text, { user: req.user, voice: req.body?.voice || null, direction: String(req.body?.direction || '').trim().slice(0, 600) || null });
  res.json({ audio: out.wav.toString('base64'), transcript: out.transcript, model: out.model, voice: out.voice, attempts: out.attempts,
    durationMs: out.durationMs, ms: Date.now() - started });
});

export default router;
