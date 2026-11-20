// Opaque session tokens. The raw token goes to the client (HttpOnly cookie on web, Bearer on Android);
// only its SHA-256 is stored, so a leaked database can't be used to sign in.
import crypto from 'node:crypto';
import { get, all, run } from '../db/index.js';

const DAY = 864e5;
const TTL = { web: 30 * DAY, app: 180 * DAY };
const TOUCH_EVERY = 5 * 60e3; // don't write last_seen on every request

const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19); // SQLite datetime format

export function createSession(userId, { kind = 'web', device = null, ip = null } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  run(`INSERT INTO sessions (user_id, token_hash, kind, device, ip, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    userId, sha256(token), kind, device, ip, iso(Date.now() + TTL[kind]));
  return token;
}

// Returns { session, user } for a valid token, else null. Slides the expiry for active sessions.
export function resolveSession(token) {
  if (!token || token.length > 200) return null;
  const row = get(`SELECT s.id AS sid, s.kind, s.last_seen_at AS s_seen, s.expires_at, u.*
                   FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now')`, sha256(token));
  if (!row || row.status !== 'active') return null;
  if (Date.now() - new Date(row.s_seen.replace(' ', 'T') + 'Z') > TOUCH_EVERY) {
    run(`UPDATE sessions SET last_seen_at = datetime('now'), expires_at = ? WHERE id = ?`, iso(Date.now() + TTL[row.kind]), row.sid);
    run(`UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`, row.id);
  }
  return { sessionId: row.sid, kind: row.kind, user: row };
}

export const revokeSession = (id, userId) =>
  run(`UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, id, userId).changes > 0;

export const revokeAllSessions = (userId, exceptId = 0) =>
  run(`UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND id != ? AND revoked_at IS NULL`, userId, exceptId);

export const listSessions = (userId, currentId) =>
  all(`SELECT id, kind, device, ip, created_at, last_seen_at FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now') ORDER BY last_seen_at DESC`, userId)
    .map(s => ({ id: s.id, device: s.device || (s.kind === 'app' ? 'Android app' : 'Browser'), kind: s.kind,
      where: s.ip, lastSeen: s.last_seen_at, createdAt: s.created_at, current: s.id === currentId }));

// Human device label from a User-Agent header.
export function deviceLabel(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
