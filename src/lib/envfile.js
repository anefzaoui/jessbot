// Safe .env edits (setup wizard / admin model page). Writes a temp file then renames it into place,
// so a crash can never leave a half-written .env. Values are single-line; newlines are rejected.
import fs from 'node:fs';
import { ENV_FILE } from '../config/index.js';
import { trimEndChars } from './text-safe.js';

// The same file config reads (JESSBOT_ENV_FILE when it is set).
const ENV = ENV_FILE;

export function setEnvVar(key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Bad env key: ${key}`);
  const v = String(value ?? '');
  if (/[\r\n]/.test(v)) throw new Error('Env values must be a single line.');
  const lines = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8').split(/\r?\n/) : [];
  const line = `${key}=${v}`;
  const i = lines.findIndex(l => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = line; else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, line);
  const tmp = `${ENV}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${trimEndChars(lines.join('\n'), '\n')}\n`, { mode: 0o600 });
  fs.renameSync(tmp, ENV);
  process.env[key] = v;
}
