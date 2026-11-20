// Secrets Jessbot keeps for itself (#10): the model provider's key and the Web Push private key, sealed with the install's
// key (lib/secrets.js) in the database, instead of in plain text in .env next to that key. A key the operator sets in the
// real environment (Docker's `environment`, systemd's `Environment=`) is theirs: it is used as it is and never stored.
// migrateEnvSecrets() moves the ones written into .env (by setup, Admin → Model, or by hand) into the database at start.
import path from 'node:path';
import { settings } from '../db/index.js';
import { ENV_FILE, ROOT, paths } from '../config/index.js';
import { seal, unseal } from '../lib/secrets.js';
import { readEnvFile, removeEnvVar } from '../lib/envfile.js';

const KEY = 'sealedSecrets';
const LABELS = { 'llm.apiKey': 'the model key', 'push.vapidPrivate': 'the push key' };
const cache = new Map(); // sealed text → plain (unsealing on every model call would be wasted work)

/** { name: 'v1:…' } as stored. */
export const sealedSecrets = () => ({ ...(settings.get(KEY, {}) || {}) });

/** The plain value, '' when none is stored. Throws when the install's key doesn't open it (Admin → System says so). */
export function getSecret(name) {
  const s = sealedSecrets()[name];
  if (!s) return '';
  if (!cache.has(s)) cache.set(s, unseal(s, LABELS[name] || 'a saved password'));
  return cache.get(s);
}

/** getSecret, or '' (and a log line) when it can't be opened: callers then behave as if no key were set. */
export function readSecret(name) {
  try { return getSecret(name); } catch (err) {
    console.warn(`[secrets] ${name} can’t be opened with this install’s key (${err.message}); see Admin → System`);
    return '';
  }
}

/** Store (sealed) or, with an empty value, remove. */
export function setSecret(name, value) {
  const all = sealedSecrets();
  const v = String(value ?? '').trim();
  if (v) all[name] = seal(v, LABELS[name] || 'a saved password'); else delete all[name];
  settings.set(KEY, all);
}

// .env lines moved into the database. OPENROUTER_KEY wins over LLM_API_KEY, as in llmSettings().
const MOVE = [['OPENROUTER_KEY', 'llm.apiKey'], ['LLM_API_KEY', 'llm.apiKey'], ['JESSBOT_VAPID_PRIVATE', 'push.vapidPrivate']];

/**
 * At start: secrets written in this install's .env move into the database, sealed, and their lines leave .env. Only for
 * the install's own .env (the default one, or one inside the data folder as in the Docker image): a JESSBOT_ENV_FILE
 * somewhere else may be shared by several copies, which would each take the key away from the others.
 * → the names moved, e.g. ['OPENROUTER_KEY'].
 */
export function migrateEnvSecrets() {
  const own = path.resolve(ENV_FILE) === path.resolve(ROOT, '.env') || path.resolve(ENV_FILE).startsWith(path.resolve(paths.data) + path.sep);
  if (!own) return [];
  const file = readEnvFile();
  const moved = [];
  const taken = new Set();
  for (const [env, name] of MOVE) {
    const v = (file[env] || '').trim();
    if (!(env in file)) continue;
    if (v && !taken.has(name)) { setSecret(name, v); taken.add(name); }
    removeEnvVar(env);
    if (process.env[env] === file[env]) delete process.env[env];
    moved.push(env);
  }
  // The public half isn't a secret: it moves along so the pair stays together.
  if ('JESSBOT_VAPID_PUBLIC' in file) {
    if (file.JESSBOT_VAPID_PUBLIC) settings.set('push', { ...(settings.get('push', {}) || {}), publicKey: file.JESSBOT_VAPID_PUBLIC.trim() });
    removeEnvVar('JESSBOT_VAPID_PUBLIC');
    if (process.env.JESSBOT_VAPID_PUBLIC === file.JESSBOT_VAPID_PUBLIC) delete process.env.JESSBOT_VAPID_PUBLIC;
  }
  if (moved.length) console.log(`[secrets] moved ${moved.join(', ')} from .env into the database, sealed with the install’s key`);
  return moved;
}
