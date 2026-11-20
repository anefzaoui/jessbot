// Safe .env edits (setup wizard / admin model page). Writes a temp file then renames it into place,
// so a crash can never leave a half-written .env. Values are single-line; newlines are rejected.
import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { ENV_FILE } from '../config/index.js';
import { trimEndChars } from './text-safe.js';

// The same file config reads (JESSBOT_ENV_FILE when it is set).
const ENV = ENV_FILE;

const readLines = () => (fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8').split(/\r?\n/) : []);
function writeLines(lines) {
  const tmp = `${ENV}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${trimEndChars(lines.join('\n'), '\n')}\n`, { mode: 0o600 });
  fs.renameSync(tmp, ENV);
}
const badKey = key => { if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Bad env key: ${key}`); };

export function setEnvVar(key, value) {
  badKey(key);
  const v = String(value ?? '');
  if (/[\r\n]/.test(v)) throw new Error('Env values must be a single line.');
  const lines = readLines();
  const line = `${key}=${v}`;
  const i = lines.findIndex(l => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = line; else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, line);
  writeLines(lines);
  process.env[key] = v;
}

/** Remove a variable's line(s) from .env (process.env is left to the caller: it may have come from elsewhere). */
export function removeEnvVar(key) {
  badKey(key);
  const lines = readLines();
  const kept = lines.filter(l => !new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l)); // key: [A-Z0-9_] only
  if (kept.length !== lines.length) writeLines(kept);
}

/** The variables written in the .env file itself (not the process environment): { KEY: value }. */
export function readEnvFile() {
  try { return parseEnv(fs.readFileSync(ENV, 'utf8')); } catch { return {}; }
}
