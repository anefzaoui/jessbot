// Invites: the admin creates a single-use link; the invitee picks their own password.
import crypto from 'node:crypto';
import { get, all, run, tx } from '../db/index.js';
import { createUser } from './users.js';
import { invalid, notFound } from '../lib/errors.js';

const TTL_DAYS = 7;
const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');

export function createInvite({ name, email, role = 'member', groupId = null, invitedBy }) {
  const errors = {};
  if (!String(name || '').trim()) errors.name = 'Who is this invite for?';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "That doesn't look like an email address.";
  if (!['admin', 'member'].includes(role)) errors.role = 'Pick a role.';
  if (Object.keys(errors).length) throw invalid(errors);
  const token = crypto.randomBytes(24).toString('base64url');
  const { lastInsertRowid } = run(
    `INSERT INTO invites (token_hash, email, name, role, group_id, invited_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+${TTL_DAYS} days'))`,
    sha256(token), email?.trim() || null, name.trim(), role, groupId, invitedBy);
  return { id: Number(lastInsertRowid), token };
}

export function findInvite(token) {
  if (!token) return null;
  return get(`SELECT * FROM invites WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL
              AND expires_at > datetime('now')`, sha256(token)) || null;
}

export async function acceptInvite(token, { name, email, password }) {
  const invite = findInvite(token);
  if (!invite) throw notFound('This invite link has expired or was already used. Ask for a new one.');
  const user = await createUser({ name: name || invite.name, email: email || invite.email, password, role: invite.role });
  tx(() => {
    run(`UPDATE invites SET accepted_at = datetime('now'), accepted_user_id = ? WHERE id = ?`, user.id, invite.id);
    if (invite.group_id) run(`INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)`, invite.group_id, user.id);
  });
  return user;
}

export const listPendingInvites = () =>
  all(`SELECT i.id, i.email, i.name, i.role, i.created_at, i.expires_at, g.name AS group_name
       FROM invites i LEFT JOIN groups g ON g.id = i.group_id
       WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > datetime('now') ORDER BY i.id DESC`);

export const revokeInvite = id => run(`UPDATE invites SET revoked_at = datetime('now') WHERE id = ? AND accepted_at IS NULL`, id).changes > 0;
