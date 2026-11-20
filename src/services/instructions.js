// "How Jessbot should respond to …" — admin-authored instructions for everyone, a group, or one person.
// Append-only: every save is a new version, so the admin can see history and diffs.
import { get, all, run } from '../db/index.js';

const MAX = 4000; // characters per subject (keeps the prompt budget predictable; see CONTEXT-AND-MEMORY.md)

export function currentInstructions(subjectType, subjectId = null) {
  return get(`SELECT i.*, u.name AS author_name FROM instructions i LEFT JOIN users u ON u.id = i.author_id
              WHERE subject_type = ? AND subject_id IS ? ORDER BY i.id DESC LIMIT 1`, subjectType, subjectId) || null;
}

export function instructionHistory(subjectType, subjectId = null, limit = 20) {
  return all(`SELECT i.id, i.body, i.created_at, u.name AS author_name FROM instructions i
              LEFT JOIN users u ON u.id = i.author_id
              WHERE subject_type = ? AND subject_id IS ? ORDER BY i.id DESC LIMIT ?`, subjectType, subjectId, limit);
}

export function saveInstructions(subjectType, subjectId, body, authorId) {
  const text = String(body ?? '').trim().slice(0, MAX);
  if (currentInstructions(subjectType, subjectId)?.body === text) return false; // unchanged: no new version
  run(`INSERT INTO instructions (subject_type, subject_id, body, author_id) VALUES (?, ?, ?, ?)`,
    subjectType, subjectId, text, authorId);
  return true;
}

export const INSTRUCTIONS_MAX = MAX;
