// Everything sealed with the install's key (#10): the health check opens one of each kind, and the key rotation
// (scripts/rotate-secret.js) seals every one again with the new key. A new kind of sealed value is added here, or the
// rotation would leave it behind (tests/secrets-at-rest.test.js lists the columns that must be covered).
import fs from 'node:fs';
import path from 'node:path';
import { all, run, settings } from '../db/index.js';
import { paths } from '../config/index.js';
import { isSealed } from '../lib/secrets.js';

const COLUMNS = [
  { kind: 'mail and calendar passwords', table: 'connections', column: 'secret' },
  { kind: 'two-step sign-in', table: 'users', column: 'totp_secret' },
  { kind: 'two-step sign-in (being set up)', table: 'users', column: 'totp_pending' },
];
export const SEALED_COLUMNS = COLUMNS.map(c => `${c.table}.${c.column}`);
const profilesDir = () => paths.browserProfiles;

/** [{ kind, read(): sealed text, write(newSealed) }] for every sealed value in the database and the data folder. */
export function sealedValues() {
  const out = [];
  for (const c of COLUMNS) {
    for (const r of all(`SELECT id, ${c.column} AS v FROM ${c.table} WHERE ${c.column} IS NOT NULL AND ${c.column} != ''`)) {
      out.push({ kind: c.kind, read: () => r.v, write: v => run(`UPDATE ${c.table} SET ${c.column} = ? WHERE id = ?`, v, r.id) });
    }
  }
  const stored = settings.get('sealedSecrets', {}) || {};
  for (const name of Object.keys(stored)) {
    out.push({ kind: name === 'llm.apiKey' ? 'the model key' : name === 'push.vapidPrivate' ? 'the push key' : name,
      read: () => stored[name],
      write: v => { const cur = settings.get('sealedSecrets', {}) || {}; settings.set('sealedSecrets', { ...cur, [name]: v }); } });
  }
  let files = [];
  try { files = fs.readdirSync(profilesDir()).filter(f => f.endsWith('.json')); } catch { /* no profiles yet */ }
  for (const f of files) {
    const file = path.join(profilesDir(), f);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8').trim(); } catch { continue; }
    if (!isSealed(text)) continue; // an old plaintext profile: sealed the next time it is saved
    out.push({ kind: 'browser sign-ins', read: () => text,
      write: v => { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, v, { mode: 0o600 }); fs.renameSync(tmp, file); } });
  }
  return out;
}
