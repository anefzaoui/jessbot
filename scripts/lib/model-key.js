// The model key for scripts that need the real model (test:chat, test:e2e, eval:agent, generate-avatars), now that the app
// keeps it sealed in its database rather than in .env (#10). First match wins:
//   1. OPENROUTER_KEY / LLM_API_KEY in the environment;
//   2. the same in the repository's .env (an install that hasn't started since, or a key added by hand);
//   3. the key the app sealed in a local install's database (data/dev, then data), opened with the JESSBOT_SECRET (or
//      JESSBOT_SECRET_PREVIOUS) in .env.
// Scripts hand it to their throwaway servers as an environment variable, which the app uses and never stores.
// Never printed. Returns '' when there is none.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function open(sealed, b64) {
  const k = Buffer.from(String(b64 || ''), 'base64');
  if (k.length !== 32) return null;
  const [v, iv, tag, ct] = String(sealed).split(':');
  if (v !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

export function devModelKey() {
  const fromEnv = process.env.OPENROUTER_KEY || process.env.LLM_API_KEY;
  if (fromEnv) return fromEnv;
  let env = {};
  try { env = parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')); } catch { /* no .env */ }
  if (env.OPENROUTER_KEY || env.LLM_API_KEY) return env.OPENROUTER_KEY || env.LLM_API_KEY;
  const home = env.JESSBOT_HOME ? path.resolve(ROOT, env.JESSBOT_HOME) : null;
  for (const db of [home, path.join(ROOT, 'data', 'dev'), path.join(ROOT, 'data')].filter(Boolean).map(d => path.join(d, 'jessbot.sqlite'))) {
    if (!fs.existsSync(db)) continue;
    let row;
    try {
      const conn = new DatabaseSync(db, { readOnly: true });
      row = conn.prepare("SELECT value FROM settings WHERE key = 'sealedSecrets'").get();
      conn.close();
    } catch { continue; }
    const sealed = row ? JSON.parse(row.value)?.['llm.apiKey'] : null;
    if (!sealed) continue;
    const plain = open(sealed, env.JESSBOT_SECRET) || open(sealed, env.JESSBOT_SECRET_PREVIOUS);
    if (plain) return plain;
  }
  return '';
}
