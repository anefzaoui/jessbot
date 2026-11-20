// Reaching a person outside the chat they're looking at (decision #32): every open page gets a `notify` frame
// (toast in-app, system notification when the tab is hidden). Registered devices get a push (services/push.js, #85) when
// no Jessbot page is open for them — and always for alarms, timers and reminders, which can't wait for them to look.
import { all, run, get } from '../db/index.js';
import { publish, isOnline } from '../lib/bus.js';
import { pushTo } from './push.js';

/** kind: message | reminder | alarm | timer | schedule | feed — title, body (short), href (where tapping goes), tag (dedupe). */
const URGENT = new Set(['alarm', 'timer', 'reminder']);

export function notify(userId, { kind = 'message', title, body = '', href = '/chat', tag = null }) {
  const msg = { kind, title: String(title).slice(0, 120), body: String(body).slice(0, 240), href, tag };
  publish(userId, 'notify', msg);
  if (!URGENT.has(kind) && isOnline(userId)) return; // they're looking: the in-app toast is enough
  for (const d of devicesOf(userId)) pushTo(d, msg).catch(() => {});
}

export const devicesOf = userId => all('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC', userId);

export function registerDevice({ userId, sessionId = null, platform, name = null, pushKind = null, pushToken = null }) {
  const p = ['android', 'ios', 'web', 'other'].includes(platform) ? platform : 'other';
  const kind = ['webpush', 'unifiedpush', 'ntfy'].includes(pushKind) ? pushKind : null;
  if (pushToken) {
    const existing = get('SELECT id FROM devices WHERE user_id = ? AND push_token = ?', userId, pushToken);
    if (existing) {
      run(`UPDATE devices SET platform = ?, name = ?, push_kind = ?, session_id = ?, last_seen_at = datetime('now') WHERE id = ?`,
        p, name, kind, sessionId, existing.id);
      return get('SELECT * FROM devices WHERE id = ?', existing.id);
    }
  }
  const { lastInsertRowid } = run('INSERT INTO devices (user_id, session_id, platform, name, push_kind, push_token) VALUES (?, ?, ?, ?, ?, ?)',
    userId, sessionId, p, name ? String(name).slice(0, 80) : null, kind, pushToken ? String(pushToken).slice(0, 4096) : null);
  return get('SELECT * FROM devices WHERE id = ?', Number(lastInsertRowid));
}

export const removeDevice = (userId, id) => run('DELETE FROM devices WHERE user_id = ? AND id = ?', userId, id).changes > 0;
export const deviceView = d => ({ id: d.id, platform: d.platform, name: d.name, pushKind: d.push_kind, hasPush: !!d.push_token, lastSeenAt: d.last_seen_at });
