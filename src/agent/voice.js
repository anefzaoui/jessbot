// Jess speaking a reply (docs/VOICE.md): after a run that should be spoken (she was asked, or they sent a voice note)
// and whenever someone presses Listen. One clip per message, made once and cached; open pages get the player live
// (voice.ready) or the reason it failed (voice.failed). runs.voice stays set until the clip is made (or fails), so a
// page opened meanwhile shows "Recording…"; recoverRuns() clears it for runs a restart interrupted.
import { get, run as sql } from '../db/index.js';
import { onRunFinished } from './loop.js';
import { getUser } from '../services/users.js';
import { projectOfThread } from '../services/projects.js';
import { synthesize, speechText, saveClip, clipForMessage, clipView, speaking, pronunciations } from '../services/voice.js';
import { renderFragment } from '../views/render.js';
import { publish } from '../lib/bus.js';
import { notFound, badRequest } from '../lib/errors.js';

/** An assistant message → its spoken clip (made now, or the cached one). Concurrent calls share one synthesis. */
export function speakMessage(user, messageId, { runId = null } = {}) {
  const m = get(`SELECT m.*, t.user_id AS owner_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?`, Number(messageId));
  if (!m || m.owner_id !== user.id || m.role !== 'assistant') return Promise.reject(notFound('That reply is gone.'));
  const cached = clipForMessage(m.id, 'out');
  if (cached) return Promise.resolve(cached);
  if (speaking.has(m.id)) return speaking.get(m.id);
  const job = (async () => {
    const script = speechText(m.content, { names: pronunciations() }); // names as their owners say them (#143)
    if (!script) throw badRequest('There’s nothing in this reply to read out — it’s all code or tables.');
    const out = await synthesize(script, { user, runId: runId || m.run_id, project: projectOfThread(m.thread_id) });
    const clip = saveClip({ user, threadId: m.thread_id, messageId: m.id, direction: 'out', wav: out.wav, durationMs: out.durationMs,
      peaks: out.peaks, transcript: out.transcript || script, model: out.model, voice: out.voice });
    const html = await renderFragment('chat/voice-player', clipView(clip), user).catch(() => null);
    publish(user.id, 'voice.ready', { messageId: m.id, html }, { threadId: m.thread_id, runId: m.run_id });
    return clip;
  })();
  speaking.set(m.id, job);
  job.catch(err => {
    console.warn('[voice] could not speak message', m.id, err.status || '', String(err.message).slice(0, 160));
    publish(user.id, 'voice.failed', { messageId: m.id, error: err.status && err.status < 500 ? err.message : 'The voice model didn’t answer — try Listen again.' },
      { threadId: m.thread_id, runId: m.run_id });
  }).finally(() => {
    speaking.delete(m.id);
    if (m.run_id) sql('UPDATE runs SET voice = 0 WHERE id = ?', m.run_id);
  });
  return job;
}

// A finished reply that should be spoken becomes a voice note.
onRunFinished(async (r, status) => {
  if (!r.voice) return;
  if (status !== 'done' || !r.reply_message_id) { sql('UPDATE runs SET voice = 0 WHERE id = ?', r.id); return; }
  const user = getUser(r.user_id);
  speakMessage(user, r.reply_message_id, { runId: r.id }).catch(() => { /* reported through voice.failed */ });
});
