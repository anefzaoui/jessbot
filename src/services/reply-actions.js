// Things a person can do with one of Jess's replies (Phase 25, decision #196): "Simpler" (explain it again, plainly) and the
// follow-up questions a reply may end with (lib/follow-ups.js), which the main chat keeps to at most one a day.
import { get, run } from '../db/index.js';
import { splitFollowUps } from '../lib/follow-ups.js';

// "Simpler": the person's visible turn is this sentence; the instruction below rides along as a hidden system note in the
// same chat, right before it (the prompt passes a chat's system rows to the model in order, like a scheduled task's).
export const SIMPLER_TEXT = 'Explain that again more simply, with the bit of context I’m missing.';
export const SIMPLER_NOTE = '[Simpler, pressed on your last reply] Explain your last reply again for someone new to the topic: plain '
  + 'everyday words, short sentences, no jargon (or explain a term in a few words the first time you need it), one concrete example, '
  + 'and the piece of background they are probably missing. Same facts, nothing new invented, shorter than before. Reply in the '
  + 'same language as your last reply.';

/** Add the hidden note for a "Simpler" turn to this chat (call right before the person's message is added). */
export function addSimplerNote(threadId, addMessage) {
  return addMessage({ threadId, role: 'system', content: SIMPLER_NOTE });
}

// ---- Follow-up nudges: at most one a day in the main chat, enforced here ------------------------------------------------------
export const NUDGE_GAP_MS = 24 * 3600e3;
const sqlUtc = v => new Date(`${String(v).replace(' ', 'T')}Z`).getTime();

/** May a reply in this chat end with follow-up questions now? Side chats and projects always may; the main chat once a day. */
export function nudgeAllowed(threadId, now = Date.now()) {
  const t = get('SELECT kind, last_nudge_at FROM threads WHERE id = ?', threadId);
  if (!t || t.kind !== 'main' || !t.last_nudge_at) return true;
  return now - sqlUtc(t.last_nudge_at) >= NUDGE_GAP_MS;
}

/** When a reply in this chat last ended with follow-ups (ISO) or null. */
export function lastNudgeAt(threadId) {
  const v = get('SELECT last_nudge_at FROM threads WHERE id = ?', threadId)?.last_nudge_at;
  return v ? new Date(sqlUtc(v)).toISOString() : null;
}

/**
 * A final reply is about to be stored: if it ends with follow-up questions, record the time — or, in the main chat within a
 * day of the last ones, take them out (the reply keeps its body). → the text to store.
 */
export function settleNudge(threadId, content, now = Date.now()) {
  const { body, items } = splitFollowUps(content);
  if (!items.length || !threadId) return content;
  if (!nudgeAllowed(threadId, now)) return body;
  run('UPDATE threads SET last_nudge_at = ? WHERE id = ?', new Date(now).toISOString().replace('T', ' ').slice(0, 19), threadId);
  return content;
}
