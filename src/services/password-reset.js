// Password reset (decision #230, issue #6): Jessbot sends no mail of its own, so a reset is a one-time link an admin makes
// for someone (Admin → People → the person) and hands over like an invite, or that the owner makes on the server with
// `npm run reset-link -- <email>` when they are the one locked out. Only the link's SHA-256 is stored; it works once, for
// 24 hours, and a newer link replaces an older one. Setting the new password signs that person out everywhere.
// Two-step sign-in stays on: a reset link replaces the password, not the phone (an admin can turn that off separately).
import crypto from 'node:crypto';
import { get, run } from '../db/index.js';
import { config } from '../config/index.js';
import { setPassword } from './users.js';
import { revokeAllSessions } from './sessions.js';
import { audit } from './audit.js';
import { checkPasswordStrength } from './passwords.js';
import { invalid } from '../lib/errors.js';

const TTL_MS = 24 * 3600e3;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** A new link for userId (older unused ones stop working). → { token, url, expiresAt }. base: the site's address. */
export function createResetLink(userId, { createdBy = null, base = config.publicUrl } = {}) {
  run(`UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`, userId);
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = iso(Date.now() + TTL_MS);
  run('INSERT INTO password_resets (user_id, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?)', userId, sha256(token), createdBy, expiresAt);
  audit('auth.reset_link', { actorId: createdBy, targetType: 'user', targetId: userId });
  return { token, url: `${String(base).replace(/\/+$/, '')}/reset/${token}`, expiresAt };
}

/** The live reset for a token: { id, userId } or null (unknown, used or expired). */
export function findReset(token) {
  if (!token || String(token).length > 100) return null;
  const row = get(`SELECT r.id, r.user_id FROM password_resets r JOIN users u ON u.id = r.user_id
                   WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > datetime('now') AND u.status = 'active'`, sha256(String(token)));
  return row ? { id: row.id, userId: row.user_id } : null;
}

/** Set the new password with a live link (once). Throws on a bad password; returns the user id, or null for a dead link. */
export async function useReset(token, password, { ip = null } = {}) {
  const reset = findReset(token);
  if (!reset) return null;
  const weak = checkPasswordStrength(password);
  if (weak) throw invalid({ password: weak });
  // Claimed atomically before anything changes: two submits of the same link can't both set a password.
  if (!run(`UPDATE password_resets SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`, reset.id).changes) return null;
  await setPassword(reset.userId, password);
  revokeAllSessions(reset.userId);
  audit('auth.password_reset', { actorId: reset.userId, ip });
  return reset.userId;
}
