// Two-step sign-in (decision #230, issue #6): optional, per person, with any authenticator app (TOTP, RFC 6238: SHA-1,
// 6 digits, 30 s — what every app understands). The secret is sealed like a mail password (lib/secrets.js); a code is
// accepted once (the step it belongs to is remembered), one step early or late for clock drift. Ten recovery codes are
// shown once and stored as SHA-256 hashes (60 random bits each). Turning it on or off signs out every other device.
import crypto from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import { renderSVG } from 'uqr';
import { get, all, run } from '../db/index.js';
import { seal, unseal } from '../lib/secrets.js';
import { audit } from './audit.js';
import { revokeAllSessions } from './sessions.js';
import { invalid } from '../lib/errors.js';

const ISSUER = 'Jessbot';
const STEP = 30;
const RECOVERY_COUNT = 10;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const totpFor = (secret, label) => new TOTP({ issuer: ISSUER, label, algorithm: 'SHA1', digits: 6, period: STEP, secret: Secret.fromBase32(secret) });

/** Is two-step sign-in on for this person (by id)? */
export const twoFactorOn = userId => !!get('SELECT totp_enabled_at FROM users WHERE id = ?', userId)?.totp_enabled_at;

/** What the You page shows: { on, since, codesLeft }. */
export function twoFactorState(userId) {
  const u = get('SELECT totp_enabled_at FROM users WHERE id = ?', userId);
  const left = get('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', userId).n;
  return { on: !!u?.totp_enabled_at, since: u?.totp_enabled_at || null, codesLeft: left };
}

/** Start turning it on: a new secret, kept pending until a code from it is confirmed. → { secret, uri, qrSvg }. */
export function beginSetup(user) {
  const secret = new Secret({ size: 20 }).base32;
  run('UPDATE users SET totp_pending = ? WHERE id = ?', seal(secret), user.id);
  const uri = totpFor(secret, user.email).toString();
  return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qrSvg: renderSVG(uri, { border: 2 }) };
}

/** The step a 6-digit code belongs to (within ±1 step of now), or null. */
function matchStep(secret, label, code, now = Date.now()) {
  const token = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return null;
  const delta = totpFor(secret, label).validate({ token, timestamp: now, window: 1 });
  return delta === null ? null : Math.floor(now / 1000 / STEP) + delta;
}

function newRecoveryCodes(userId) {
  run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
  const codes = [];
  for (let i = 0; i < RECOVERY_COUNT; i++) {
    const raw = crypto.randomBytes(8).readBigUInt64BE() >> 4n; // 60 bits
    const code = raw.toString(32).padStart(12, '0').replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3');
    codes.push(code);
    run('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', userId, sha256(code));
  }
  return codes;
}

/** Finish turning it on with a code from the app. → { codes } (recovery codes, shown once). Signs out other devices. */
export function confirmSetup(user, code, { keepSessionId = 0, ip = null } = {}) {
  const row = get('SELECT email, totp_pending FROM users WHERE id = ?', user.id);
  if (!row?.totp_pending) throw invalid({ code: 'Start again: press “Turn on” to get a new code.' });
  const secret = unseal(row.totp_pending);
  const step = matchStep(secret, row.email, code);
  if (step === null) throw invalid({ code: 'That code doesn’t match. Check the time on your phone and try the newest code.' });
  run(`UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ?, totp_enabled_at = datetime('now') WHERE id = ?`, step, user.id);
  const codes = newRecoveryCodes(user.id);
  revokeAllSessions(user.id, keepSessionId);
  audit('auth.2fa_on', { actorId: user.id, ip });
  return { codes };
}

/**
 * Check a second-step code at sign-in: a 6-digit app code (once per step) or an unused recovery code.
 * → { ok: true, via: 'app' | 'recovery', codesLeft } or { ok: false }.
 */
export function verifySecondStep(userId, code) {
  const row = get('SELECT email, totp_secret, totp_last_step FROM users WHERE id = ? AND totp_enabled_at IS NOT NULL', userId);
  if (!row?.totp_secret) return { ok: false };
  const input = String(code || '').trim();
  const step = matchStep(unseal(row.totp_secret), row.email, input);
  if (step !== null) {
    // Atomic: only one request can move the step forward, so the same code can't sign in twice.
    const moved = run('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', step, userId, step).changes;
    return moved ? { ok: true, via: 'app' } : { ok: false, reused: true };
  }
  const normal = input.toLowerCase().replace(/[^0-9a-v]/g, '');
  if (normal.length === 12) {
    const formatted = normal.replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3');
    const used = run(`UPDATE recovery_codes SET used_at = datetime('now') WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`, userId, sha256(formatted)).changes;
    if (used) return { ok: true, via: 'recovery', codesLeft: twoFactorState(userId).codesLeft };
  }
  return { ok: false };
}

/** New recovery codes (the old ones stop working). → codes, shown once. */
export function regenerateRecoveryCodes(user, { ip = null } = {}) {
  if (!twoFactorOn(user.id)) throw invalid({ code: 'Two-step sign-in is off.' });
  const codes = newRecoveryCodes(user.id);
  audit('auth.2fa_recovery_codes', { actorId: user.id, ip });
  return codes;
}

/** Turn it off (the caller checked the password and a code, or an admin is helping someone who lost their phone). */
export function disableTwoFactor(userId, { actorId = userId, keepSessionId = 0, ip = null } = {}) {
  run('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, totp_enabled_at = NULL WHERE id = ?', userId);
  run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
  revokeAllSessions(userId, actorId === userId ? keepSessionId : 0);
  audit('auth.2fa_off', { actorId, targetType: 'user', targetId: userId, ip, detail: actorId === userId ? undefined : { byAdmin: true } });
}

// ---- The pending second step of a sign-in ------------------------------------------------------------------------------
const CHALLENGE_MS = 10 * 60e3;
const iso = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** The password was right and two-step sign-in is on: a token for the code page (10 minutes). */
export function createChallenge(userId, next = null) {
  run(`DELETE FROM login_challenges WHERE expires_at <= datetime('now')`);
  const token = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO login_challenges (token_hash, user_id, next, expires_at) VALUES (?, ?, ?, ?)', sha256(token), userId, next, iso(Date.now() + CHALLENGE_MS));
  return token;
}

/** { userId, next } for a live challenge token, or null. */
export function readChallenge(token) {
  if (!token || String(token).length > 100) return null;
  const row = get(`SELECT user_id, next FROM login_challenges WHERE token_hash = ? AND expires_at > datetime('now')`, sha256(String(token)));
  return row ? { userId: row.user_id, next: row.next } : null;
}

export const endChallenge = token => run('DELETE FROM login_challenges WHERE token_hash = ?', sha256(String(token || '')));

/** Tests: every recovery code row (hashes only). */
export const recoveryRows = userId => all('SELECT code_hash, used_at FROM recovery_codes WHERE user_id = ?', userId);
