// Groups (e.g. Family, Company): shared instructions, shared memory scope (Phase 3), invite target.
import { get, all, run } from '../db/index.js';
import { invalid } from '../lib/errors.js';

export const listGroups = () =>
  all(`SELECT g.id, g.name, g.description, COUNT(m.user_id) AS members
       FROM groups g LEFT JOIN group_members m ON m.group_id = g.id GROUP BY g.id ORDER BY g.name`);

export const getGroup = id => get('SELECT * FROM groups WHERE id = ?', id) || null;

export function createGroup({ name, description = null }) {
  const n = String(name || '').trim();
  if (!n) throw invalid({ name: 'Give the group a name.' });
  if (n.length > 40) throw invalid({ name: 'Keep it under 40 characters.' });
  if (get('SELECT 1 FROM groups WHERE name = ?', n)) throw invalid({ name: 'That group already exists.' });
  const { lastInsertRowid } = run('INSERT INTO groups (name, description) VALUES (?, ?)', n, description?.trim() || null);
  return getGroup(Number(lastInsertRowid));
}

export const groupsOfUser = userId =>
  all(`SELECT g.id, g.name FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.name`, userId);

export const addMember = (groupId, userId) => run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', groupId, userId);
export const removeMember = (groupId, userId) => run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId);
