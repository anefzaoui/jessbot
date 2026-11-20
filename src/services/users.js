// Users: the owner/admin and the people they invite (family, company).
import { get, all, run } from '../db/index.js';
import { hashPassword, checkPasswordStrength } from './passwords.js';
import { invalid, notFound } from '../lib/errors.js';
import { audit } from './audit.js';

const PUBLIC_COLS = `id, email, name, call_me, name_say, share_busy, checkins, prep, role, status, hue, timezone, about, created_at, updated_at, last_seen_at`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Stable, pleasant avatar hue per user.
const HUES = [250, 285, 20, 155, 45, 200, 330, 110];

export const toPublic = u => u && ({
  id: u.id, email: u.email, name: u.name, firstName: u.name?.split(/\s+/)[0], callMe: u.call_me,
  nameSay: u.name_say ?? null, shareBusy: !!u.share_busy, checkins: u.checkins || 'normal', prep: u.prep || 'off', role: u.role, status: u.status, hue: u.hue, timezone: u.timezone, about: u.about,
  createdAt: u.created_at, lastSeenAt: u.last_seen_at,
});

export const countUsers = () => get('SELECT COUNT(*) AS n FROM users').n;
export const getUser = id => toPublic(get(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`, id));
export const getUserWithHash = email => get('SELECT * FROM users WHERE email = ?', String(email || '').trim());
export const listUsers = () => all(`SELECT ${PUBLIC_COLS} FROM users ORDER BY role = 'admin' DESC, name`).map(toPublic);

export function validateAccount({ name, email, password }, { requirePassword = true } = {}) {
  const errors = {};
  if (!String(name || '').trim()) errors.name = 'What should I call you?';
  if (!EMAIL_RE.test(String(email || '').trim())) errors.email = "That doesn't look like an email address.";
  else if (getUserWithHash(email)) errors.email = 'Someone already uses that email.';
  if (requirePassword) {
    const weak = checkPasswordStrength(password);
    if (weak) errors.password = weak;
  }
  return errors;
}

export async function createUser({ name, email, password, role = 'member', timezone = null }) {
  const errors = validateAccount({ name, email, password });
  if (Object.keys(errors).length) throw invalid(errors);
  const hue = HUES[countUsers() % HUES.length];
  const { lastInsertRowid } = run(
    `INSERT INTO users (email, name, role, password_hash, hue, timezone) VALUES (?, ?, ?, ?, ?, ?)`,
    String(email).trim(), String(name).trim(), role, await hashPassword(password), hue, timezone);
  return getUser(Number(lastInsertRowid));
}

export function updateProfile(id, { name, callMe, email, timezone, about, nameSay, shareBusy }) {
  const user = getUser(id);
  if (!user) throw notFound();
  const errors = {};
  if (name !== undefined && !String(name).trim()) errors.name = 'Name can’t be empty.';
  if (email !== undefined && email !== user.email) {
    if (!EMAIL_RE.test(String(email).trim())) errors.email = "That doesn't look like an email address.";
    else if (getUserWithHash(email)) errors.email = 'Someone already uses that email.';
  }
  let say;
  if (nameSay !== undefined) { try { say = cleanNameSay(nameSay); } catch (err) { Object.assign(errors, err.errors); } }
  if (Object.keys(errors).length) throw invalid(errors);
  if (nameSay !== undefined) run('UPDATE users SET name_say = ? WHERE id = ?', say, id);
  if (shareBusy !== undefined && onOff(shareBusy) !== user.shareBusy) setShareBusy(id, shareBusy);
  // A field left out stays as it is (an app may send only what changed); an empty string clears it.
  const opt = v => [v === undefined ? 1 : 0, v === undefined ? null : String(v ?? '').trim() || null];
  run(`UPDATE users SET name = COALESCE(?, name), call_me = CASE WHEN ? THEN call_me ELSE ? END, email = COALESCE(?, email),
       timezone = CASE WHEN ? THEN timezone ELSE ? END, about = CASE WHEN ? THEN about ELSE ? END, updated_at = datetime('now') WHERE id = ?`,
  name?.trim() ?? null, ...opt(callMe), email?.trim() ?? null, ...opt(timezone), ...opt(about), id);
  return getUser(id);
}

// How to say my name (decision #143): a phonetic spelling her voice says instead of the written name ("Shi-vawn", "Nour
// as in noor"). Letters, marks (Arabic/Hebrew vowel signs the person chose), spaces, hyphens, apostrophes and dots; '' clears.
const SAY_RE = /^[\p{L}\p{M}][\p{L}\p{M} '’.-]*$/u;
export function cleanNameSay(v) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length > 60) throw invalid({ nameSay: 'Keep it under 60 characters: just how the name sounds.' });
  if (!SAY_RE.test(t)) throw invalid({ nameSay: 'Use letters only (spaces, hyphens and apostrophes are fine), e.g. “Shi-vawn”.' });
  return t;
}
export function setNameSay(id, v) {
  const say = cleanNameSay(v);
  run(`UPDATE users SET name_say = ?, updated_at = datetime('now') WHERE id = ?`, say, id);
  return getUser(id);
}

// Household busy sharing (decision #159): "Share when I'm busy with my household". Off by default; when on, people who share
// a group with this person may have their busy TIMES (never titles) counted when Jess looks for a time that suits everyone
// (services/calendar.js sharedBusyBlocks). Accepts true/false (also "true"/"false"/1/0 from a form); each change is audited.
const onOff = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
export function setShareBusy(id, on) {
  const v = onOff(on);
  run(`UPDATE users SET share_busy = ?, updated_at = datetime('now') WHERE id = ?`, v ? 1 : 0, id);
  audit('calendar.share_busy', { actorId: id, targetType: 'user', targetId: id, detail: { on: v } });
  return getUser(id);
}

export async function setPassword(id, password) {
  const weak = checkPasswordStrength(password);
  if (weak) throw invalid({ password: weak });
  run(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`, await hashPassword(password), id);
}

export function setStatus(id, status) {
  run(`UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`, status, id);
}

export const touchUser = id => run(`UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`, id);
