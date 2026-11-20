// Secrets at rest (Phase 10, #10): saved passwords (mail, calendar), two-step sign-in seeds, the model provider's key and
// the Web Push key are stored encrypted (AES-256-GCM, 'v1:iv:tag:ciphertext'), and so are browser profiles. One key per
// install, never in the database or the data folder's files, so a copied database or a backup alone reveals nothing.
// Where the key comes from (docs/SECURITY.md → Secrets and data):
//   JESSBOT_SECRET_FILE — a file holding it (Docker or systemd secrets: the key stays outside the data volume);
//   JESSBOT_SECRET      — in .env or the environment; made and written to .env on first use when neither is set.
// JESSBOT_SECRET_PREVIOUS: an older key that still opens what it sealed (during a rotation, or to restore a backup made
// before one); new values are always sealed with the current key. `npm run secrets:rotate` changes the key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { setEnvVar } from './envfile.js';
import { registerSecret } from './dlp.js';

const decode = b64 => { const k = Buffer.from(String(b64 || '').trim(), 'base64'); return k.length === 32 ? k : null; };

/** Where the key comes from: { source: 'file'|'env'|'none', path?, valid, error? } (no key material). */
export function keySource() {
  const file = (process.env.JESSBOT_SECRET_FILE || '').trim();
  if (file) {
    try { return { source: 'file', path: file, valid: !!decode(fs.readFileSync(file, 'utf8')) }; }
    catch (err) { return { source: 'file', path: file, valid: false, error: err.code === 'ENOENT' ? 'the file doesn’t exist' : err.message }; }
  }
  if (process.env.JESSBOT_SECRET) return { source: 'env', valid: !!decode(process.env.JESSBOT_SECRET) };
  return { source: 'none', valid: false };
}

let key = null, previous;
function secretKey() {
  if (key) return key;
  const file = (process.env.JESSBOT_SECRET_FILE || '').trim();
  if (file) {
    // A key file that can't be read is an error, never a reason to make a new key (it would orphan everything sealed).
    const b64 = fs.readFileSync(file, 'utf8').trim();
    key = decode(b64);
    if (!key) throw new Error(`JESSBOT_SECRET_FILE (${file}) doesn’t hold a valid key (32 bytes, base64).`);
    registerSecret(b64, 'the password key'); // not in process.env, so the outbound guard learns it here
    return key;
  }
  let b64 = process.env.JESSBOT_SECRET;
  if (!decode(b64)) {
    b64 = crypto.randomBytes(32).toString('base64');
    setEnvVar('JESSBOT_SECRET', b64);
  }
  key = decode(b64);
  return key;
}
const previousKey = () => (previous === undefined ? (previous = decode(process.env.JESSBOT_SECRET_PREVIOUS)) : previous);

/** Forget the keys read so far (after a rotation, and in tests). */
export function resetKeyCache() { key = null; previous = undefined; }

function encrypt(plain, k = secretKey()) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function open(sealed, k) {
  const [v, iv, tag, ct] = String(sealed || '').split(':');
  if (v !== 'v1' || !iv || !tag || ct == null) throw new Error('Not a sealed secret.');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
function decrypt(sealed) {
  try { return open(sealed, secretKey()); } catch (err) {
    const prev = previousKey();
    if (!prev || err.message === 'Not a sealed secret.') throw err;
    return open(sealed, prev); // sealed before the last rotation
  }
}

/** 'v1:iv:tag:ciphertext' (base64 parts). The value is registered with the outbound guard, like unseal() below. */
export function seal(plain, what = 'a saved password') {
  registerSecret(plain, what);
  return encrypt(plain);
}

/** The original text, or throws (wrong key / tampered). Every unsealed value is registered with the outbound guard
 *  (lib/dlp.js): from here on no tool call may carry it, and the server log redacts it. */
export function unseal(sealed, what = 'a saved password') {
  const plain = decrypt(sealed);
  registerSecret(plain, what);
  return plain;
}

// Data at rest that is not one password (browser profiles: a person's cookies and site storage, decision #136). Same key and
// 'v1:…' format, but the plaintext is not registered with the outbound guard: a whole cookie jar is not a string a tool call
// could carry, and registering it would crowd real passwords out of the guard's list.
/** Seal a data blob (not a password) → 'v1:iv:tag:ciphertext'. */
export const sealData = plain => encrypt(plain);
/** The blob sealed by sealData, or throws (wrong key / tampered / not sealed). */
export const unsealData = sealed => decrypt(sealed);
/** True when the text is in the sealed format (a file written by sealData, as opposed to an older plaintext file). */
export const isSealed = text => /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/.test(String(text || '').trim());

/** For the rotation script: open with the old keys, seal again with `newKey` (a 32-byte Buffer). */
export const resealWith = (sealed, newKey) => encrypt(decrypt(sealed), newKey);
/** A new random key, base64. */
export const newKeyB64 = () => crypto.randomBytes(32).toString('base64');
