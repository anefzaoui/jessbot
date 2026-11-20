// Secrets at rest (Phase 10): mail and calendar passwords are stored encrypted (AES-256-GCM). The key lives in the
// install's .env (JESSBOT_SECRET, made on first use), never in the database — so a copied database or a backup file alone
// doesn't reveal them. Moving to a new machine: bring .env along (the restore note in Admin → System says so).
import crypto from 'node:crypto';
import { setEnvVar } from './envfile.js';
import { registerSecret } from './dlp.js';

let key = null;
function secretKey() {
  if (key) return key;
  let b64 = process.env.JESSBOT_SECRET;
  if (!b64 || Buffer.from(b64, 'base64').length !== 32) {
    b64 = crypto.randomBytes(32).toString('base64');
    setEnvVar('JESSBOT_SECRET', b64);
  }
  key = Buffer.from(b64, 'base64');
  return key;
}

/** 'v1:iv:tag:ciphertext' (base64 parts). The value is registered with the outbound guard, like unseal() below. */
export function seal(plain) {
  registerSecret(plain, 'a saved password');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

/** The original text, or throws (wrong key / tampered). Every unsealed value is registered with the outbound guard
 *  (lib/dlp.js): from here on no tool call may carry it, and the server log redacts it. */
export function unseal(sealed) {
  const [v, iv, tag, ct] = String(sealed || '').split(':');
  if (v !== 'v1' || !iv || !tag || ct == null) throw new Error('Not a sealed secret.');
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  const plain = Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  registerSecret(plain, 'a saved password');
  return plain;
}

// Data at rest that is not one password (browser profiles: a person's cookies and site storage, decision #136). Same key and
// 'v1:…' format, but the plaintext is not registered with the outbound guard: a whole cookie jar is not a string a tool call
// could carry, and registering it would crowd real passwords out of the guard's list.
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function decrypt(sealed) {
  const [v, iv, tag, ct] = String(sealed || '').split(':');
  if (v !== 'v1' || !iv || !tag || ct == null) throw new Error('Not a sealed secret.');
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
/** Seal a data blob (not a password) → 'v1:iv:tag:ciphertext'. */
export const sealData = plain => encrypt(plain);
/** The blob sealed by sealData, or throws (wrong key / tampered / not sealed). */
export const unsealData = sealed => decrypt(sealed);
/** True when the text is in the sealed format (a file written by sealData, as opposed to an older plaintext file). */
export const isSealed = text => /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/.test(String(text || '').trim());
