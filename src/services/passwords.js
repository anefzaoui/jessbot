// Password hashing with Node's built-in argon2id (stable in Node 24.19; no native dependency).
// Encoded like the PHC string format so parameters can be raised later without breaking old hashes:
//   argon2id$v=19$m=19456,t=2,p=1$<salt b64>$<hash b64>
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const argon2 = promisify(crypto.argon2);
// RFC 9106's second recommended option (64 MiB, 3 passes, 4 lanes; decision #225): about 50 ms on a desktop, a few hundred
// on a small board, and sign-in is rate-limited. It was the OWASP minimum (19 MiB, 2 passes, 1 lane); a hash made with
// weaker parameters is redone at the next successful sign-in (needsRehash).
const PARAMS = { memory: 65536, passes: 3, parallelism: 4, tagLength: 32 };

/** True when a stored hash was made with weaker parameters than today's (or isn't argon2id). */
export function needsRehash(encoded) {
  const [algo, , params] = String(encoded || '').split('$');
  if (algo !== 'argon2id' || !params) return true;
  const p = Object.fromEntries(params.split(',').map(kv => kv.split('=')));
  return Number(p.m) < PARAMS.memory || Number(p.t) < PARAMS.passes || Number(p.p) < PARAMS.parallelism;
}

export const MIN_PASSWORD = 10;

export async function hashPassword(password) {
  const nonce = crypto.randomBytes(16);
  const hash = await argon2('argon2id', { message: password, nonce, ...PARAMS });
  return `argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${nonce.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, encoded) {
  if (!encoded) return false;
  const [algo, , params, saltB64, hashB64] = encoded.split('$');
  if (algo !== 'argon2id') return false;
  const p = Object.fromEntries(params.split(',').map(kv => kv.split('=')));
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await argon2('argon2id', {
    message: password, nonce: Buffer.from(saltB64, 'base64'),
    memory: Number(p.m), passes: Number(p.t), parallelism: Number(p.p), tagLength: expected.length,
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Constant-ish work when the user doesn't exist, so response time doesn't reveal valid emails.
const DUMMY = await hashPassword(crypto.randomBytes(16).toString('hex'));
export const burnVerify = password => verifyPassword(password, DUMMY).catch(() => false);

export function checkPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 256) return 'That password is too long.';
  if (/^(.)\1+$/.test(password)) return 'Pick something less repetitive.';
  return null;
}
