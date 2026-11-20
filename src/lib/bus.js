// Realtime event hub (decisions #19, #31). Every event is appended to the `events` table first (the durable,
// ordered log), then pushed to that person's live sockets. A reconnecting client sends its last seq and gets
// everything after it from SQLite — refresh/reconnect never loses or duplicates anything.
import { run, all } from '../db/index.js';

const sockets = new Map(); // userId → Set<send(frame)>

export function subscribe(userId, send) {
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(send);
  return () => {
    const set = sockets.get(userId);
    set?.delete(send);
    if (set && !set.size) sockets.delete(userId);
  };
}

export const isOnline = userId => (sockets.get(userId)?.size || 0) > 0;

// Durable + live. Returns the event's seq.
export function publish(userId, type, data = {}, { threadId = null, runId = null, persist = true } = {}) {
  let seq = null;
  if (persist) {
    seq = Number(run('INSERT INTO events (user_id, thread_id, run_id, type, data) VALUES (?, ?, ?, ?, ?)',
      userId, threadId, runId, type, JSON.stringify(data)).lastInsertRowid);
  }
  const frame = JSON.stringify({ t: type, seq, threadId, runId, data });
  for (const send of sockets.get(userId) || []) send(frame);
  return seq;
}

// Events after a seq for one person (bounded; a client that fell far behind just reloads).
export function replay(userId, afterSeq, limit = 2000) {
  return all('SELECT id, thread_id, run_id, type, data FROM events WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?',
    userId, afterSeq, limit)
    .map(e => ({ t: e.type, seq: e.id, threadId: e.thread_id, runId: e.run_id, data: JSON.parse(e.data) }));
}

export const latestSeq = userId =>
  all('SELECT MAX(id) AS s FROM events WHERE user_id = ?', userId)[0]?.s || 0;

// Housekeeping: keep a few days of events (runs keep their own state; this is only the replay log).
export const pruneEvents = (days = 3) => run(`DELETE FROM events WHERE at < datetime('now', ?)`, `-${days} days`).changes;
