// Threads: one main ("god") thread per person + side chats. Access: the owner, or an admin (audited, #36).
import { get, all, run, tx } from '../db/index.js';
import { forbidden, notFound, invalid } from '../lib/errors.js';
import { audit } from './audit.js';

export function mainThread(userId) {
  return tx(() => {
    const t = get(`SELECT * FROM threads WHERE user_id = ? AND kind = 'main' AND deleted_at IS NULL`, userId);
    if (t) return t;
    const { lastInsertRowid } = run(`INSERT INTO threads (user_id, kind, title) VALUES (?, 'main', 'Main')`, userId);
    return get('SELECT * FROM threads WHERE id = ?', Number(lastInsertRowid));
  });
}

export function createSideThread(userId, title = 'New side chat') {
  const { lastInsertRowid } = run(`INSERT INTO threads (user_id, kind, title) VALUES (?, 'side', ?)`, userId, String(title).slice(0, 80));
  return get('SELECT * FROM threads WHERE id = ?', Number(lastInsertRowid));
}

// Resolve a thread for a viewer; admins may open others' threads (read-only in the UI, audited once per open).
export function threadForViewer(threadId, viewer, { write = false, ip = null } = {}) {
  const t = get('SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL', Number(threadId));
  if (!t) throw notFound('That chat no longer exists.');
  if (t.user_id === viewer.id) return { thread: t, asAdmin: false };
  if (viewer.role !== 'admin') throw notFound('That chat no longer exists.'); // don't reveal existence
  if (write) throw forbidden("You can read this person's chat, but not write in it.");
  audit('thread.view_as_admin', { actorId: viewer.id, targetType: 'thread', targetId: t.id, ip });
  return { thread: t, asAdmin: true };
}

// background: a side chat a background task works in (delegate, #197) or where overnight prep made a draft (#199), for the
// sidebar's marker (Phase 25).
export const sideThreads = userId =>
  all(`SELECT t.id, t.title, t.last_activity_at,
         EXISTS (SELECT 1 FROM runs r WHERE r.thread_id = t.id AND r.status IN ('queued','running','waiting')) AS running,
         (SELECT r.origin FROM runs r WHERE r.thread_id = t.id AND r.origin IN ('delegate', 'prep') ORDER BY r.id DESC LIMIT 1) AS background
       FROM threads t WHERE t.user_id = ? AND t.kind = 'side' AND t.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.thread_id = t.id) -- project chats are listed under Projects
       ORDER BY t.last_activity_at DESC LIMIT 30`, userId)
    .map(t => ({ ...t, running: !!t.running, background: t.background || null }));

export function renameThread(thread, title) {
  const tt = String(title || '').trim();
  if (!tt) throw invalid({ title: 'Give it a name.' });
  run(`UPDATE threads SET title = ?, updated_at = datetime('now') WHERE id = ?`, tt.slice(0, 80), thread.id);
}

export function deleteThread(thread) {
  if (thread.kind === 'main') throw forbidden("The main chat can't be deleted.");
  run(`UPDATE threads SET deleted_at = datetime('now') WHERE id = ?`, thread.id);
}

/** Off the record (decision #123): while on, nothing from this chat becomes a memory (no extraction, no compaction flush,
 *  `remember` only on an explicit ask in that message). Turning it back on marks where the off-record stretch ended, so
 *  those messages are never extracted later either. Side chats only: the main chat is where memory lives. */
export function setOffRecord(thread, on) {
  if (thread.kind === 'main') throw invalid({ offRecord: 'The main chat always remembers; start a side chat for something off the record.' });
  const was = !!thread.no_memory;
  if (on && !was) run(`UPDATE threads SET no_memory = 1, updated_at = datetime('now') WHERE id = ?`, thread.id);
  else if (!on && was) {
    run(`UPDATE threads SET no_memory = 0, updated_at = datetime('now'),
         no_memory_upto = COALESCE((SELECT MAX(id) FROM messages WHERE thread_id = threads.id), no_memory_upto) WHERE id = ?`, thread.id);
  }
  return get('SELECT * FROM threads WHERE id = ?', thread.id);
}

/** Is this thread off the record right now (read fresh: a caller's thread row may be older than the toggle)? */
export const isOffRecord = threadId => !!get('SELECT no_memory FROM threads WHERE id = ?', threadId)?.no_memory;

// Does this message explicitly ask Jess to remember something? (In an off-the-record chat, `remember` saves only then.)
// Imperatives and polite asks in the household's languages; questions like "do you remember…?" don't count.
const ASK_TO_REMEMBER = [
  /(?:^|[.!?\n,;:]\s*|\b(?:please|pls|and|also|so|but|oh|ok|okay)\s+)remember\b(?!\s+(?:when|how|if|whether|what|who|where)\b)/i,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:remember|memori[sz]e|note|save|keep)\b/i,
  /\b(?:i\s+want|i['’]d\s+like|i\s+need)\s+you\s+to\s+(?:remember|memori[sz]e|know\s+(?:this|that))\b/i,
  /\bmemori[sz]e\s+(?:this|that|it)\b|\bkeep\s+(?:this|that|it)\s+in\s+mind\b|\bkeep\s+in\s+mind\b|\b(?:don['’]t|do\s+not|never)\s+forget\b/i,
  /\bmake\s+a\s+note\b|\bnote\s+(?:this|that|it)(?:\s+down)?\b|\bwrite\s+(?:this|that|it)\s+down\b|\b(?:save|add|put|store)\s+(?:this|that|it)\s+(?:to|in|into)\s+(?:your\s+)?memory\b/i,
  /\b(?:souviens[- ]toi|rappelle[- ]toi|retiens\s+(?:ça|cela|que|bien)|n['’]oublie\s+pas|note\s+(?:ça|cela|bien)|garde\s+(?:ça|cela)\s+en\s+(?:tête|mémoire)|mémorise)/i,
  /\b(?:recuerda\s+(?:que|esto|eso)|acuérdate|no\s+olvides|apunta\s+(?:esto|eso|que)|memoriza|guarda\s+(?:esto|eso)\s+en\s+(?:tu\s+)?memoria)/i,
  /\b(?:merk\s+dir|merke\s+dir|vergiss\s+(?:das\s+)?nicht|notier(?:e)?\s+(?:dir\s+)?(?:das|dies)|speicher(?:e)?\s+(?:das|dies))/i,
  /تذكر|تذكّر|تذكري|احفظ|لا\s*تنس|سجّل\s+(?:هذا|هذه|ذلك)|سجل\s+(?:هذا|هذه|ذلك)|خليك\s+فاكر|افتكر/,
  /یادت\s+باشه|یادت\s+بمونه|به\s+خاطر\s+بسپار|یادداشت\s+کن|فراموش\s+نکن|حفظ\s+کن/,
];
export const asksToRemember = text => ASK_TO_REMEMBER.some(re => re.test(String(text || '')));

export const threadsOfUser = userId =>
  all(`SELECT t.id, t.kind, t.title, t.last_activity_at, t.no_memory, p.public_id AS project_id, p.status AS project_status FROM threads t
       LEFT JOIN projects p ON p.thread_id = t.id AND p.deleted_at IS NULL
       WHERE t.user_id = ? AND t.deleted_at IS NULL AND (p.status IS NULL OR p.status != 'draft')
       ORDER BY t.kind = 'main' DESC, t.last_activity_at DESC`, userId);

// Context meter for a thread (tokens of the last model call vs the hard cap, cache hit rate).
export function contextStats(thread, hard = Number(process.env.JESSBOT_CONTEXT_HARD) || 200_000) {
  const used = thread.last_prompt_tokens || 0;
  const fmt = n => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
  return {
    used, usedLabel: fmt(used), hardLabel: fmt(hard), pct: Math.min(100, Math.round((used / hard) * 100)),
    cachePct: used ? Math.round(((thread.last_cached_tokens || 0) / used) * 100) : null,
    summarized: !!thread.active_summary_id,
  };
}

export const touchThread = id => run(`UPDATE threads SET last_activity_at = datetime('now') WHERE id = ?`, id);
