// npm run secrets:rotate — give the install a new key and seal everything again with it (#10, docs/SECURITY.md → Secrets
// and data): mail and calendar passwords, two-step sign-in seeds, the model and push keys, browser sign-ins.
//   npm run secrets:rotate                 the key in .env (JESSBOT_SECRET): a new one is made and written there
//   npm run secrets:rotate -- --reseal     the key comes from JESSBOT_SECRET_FILE: put the old key in
//                                           JESSBOT_SECRET_PREVIOUS and the new one in the file first, then run this
// Refuses while Jessbot is running. Every value is opened before anything changes (one that won't open stops it). The
// old key is written to .env as JESSBOT_SECRET_PREVIOUS before the new one replaces it, so a run that stops halfway leaves
// every value openable; it is removed at the end. The .env as it was is kept as .env.before-rotate-<time> (mode 600):
// backups made before the rotation need that old key, so keep it with them, or delete it to make the old key useless.
import fs from 'node:fs';
import net from 'node:net';
import { config, ENV_FILE } from '../src/config/index.js';
import { openDb, closeDb, tx } from '../src/db/index.js';
import { keySource, resealWith, newKeyB64, resetKeyCache, unsealData } from '../src/lib/secrets.js';
import { setEnvVar, removeEnvVar } from '../src/lib/envfile.js';
import { sealedValues } from '../src/services/sealed-inventory.js';

const die = msg => { console.error(`\n[rotate] ${msg}\n`); process.exit(1); };
const reseal = process.argv.includes('--reseal');

const busy = await new Promise(resolve => {
  const s = net.connect({ host: '127.0.0.1', port: config.port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
if (busy) die(`Something is listening on port ${config.port}: stop Jessbot first (or set PORT if it isn’t Jessbot).`);

const src = keySource();
if (src.source === 'file' && !reseal) {
  die(`The key comes from JESSBOT_SECRET_FILE (${src.path}), which this script doesn’t write. Put the current key in `
    + 'JESSBOT_SECRET_PREVIOUS, a new one in that file (node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"), '
    + 'then run npm run secrets:rotate -- --reseal.');
}
if (!src.valid) die(src.source === 'none' ? 'There is no key yet (nothing has been sealed).' : 'The current key isn’t valid (32 bytes, base64).');

await openDb();
const values = sealedValues();
const counts = {};
for (const v of values) {
  try { unsealData(v.read()); } catch { die(`A sealed value (${v.kind}) doesn’t open with the current key${process.env.JESSBOT_SECRET_PREVIOUS ? ' or JESSBOT_SECRET_PREVIOUS' : ''}. Nothing was changed.`); }
  counts[v.kind] = (counts[v.kind] || 0) + 1;
}

let newKey, keptEnv = null;
if (reseal) {
  newKey = Buffer.from(fs.readFileSync(src.path, 'utf8').trim(), 'base64');
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  keptEnv = `${ENV_FILE}.before-rotate-${stamp}`;
  fs.copyFileSync(ENV_FILE, keptEnv);
  fs.chmodSync(keptEnv, 0o600);
  const b64 = newKeyB64();
  setEnvVar('JESSBOT_SECRET_PREVIOUS', process.env.JESSBOT_SECRET); // first: from here on both keys open everything
  setEnvVar('JESSBOT_SECRET', b64);
  resetKeyCache();
  newKey = Buffer.from(b64, 'base64');
}

// The database in one transaction, then the browser profiles one file at a time (each written whole).
const dbValues = values.filter(v => v.kind !== 'browser sign-ins');
const fileValues = values.filter(v => v.kind === 'browser sign-ins');
tx(() => { for (const v of dbValues) v.write(resealWith(v.read(), newKey)); });
for (const v of fileValues) v.write(resealWith(v.read(), newKey));
closeDb();

if (!reseal) removeEnvVar('JESSBOT_SECRET_PREVIOUS');
const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing was sealed yet';
console.log(`[rotate] Sealed again with the new key: ${summary}.`);
if (keptEnv) {
  console.log(`[rotate] The new key is in ${ENV_FILE}. The old .env is kept as ${keptEnv}: backups made before now need its key`
    + ' (set it as JESSBOT_SECRET_PREVIOUS to restore one). Delete it once you no longer need those backups.');
} else {
  console.log('[rotate] Now remove JESSBOT_SECRET_PREVIOUS (backups made before now need it to be restored).');
}
