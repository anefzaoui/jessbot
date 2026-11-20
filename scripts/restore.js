// Restore a backup made by Admin → System (src/services/system.js).
//   npm run restore -- <backup name or path>        (list them: npm run restore)
// Refuses while Jessbot is running. The archive is unpacked and its database checked first; only then is the current data
// moved aside to data/backups/before-restore-<time>/ (nothing is deleted — undo by moving it back) and the backup put in
// its place. A pre-update snapshot (pre-migrate-….sqlite) restores the database only.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as tar from 'tar';
import { paths, config } from '../src/config/index.js';

const ITEMS = ['jessbot.sqlite', 'workspace', 'users', 'artifacts', 'uploads', 'blobs', 'feed', 'shots'];
const die = msg => { console.error(`\n[restore] ${msg}\n`); process.exit(1); };
const arg = process.argv[2];

const list = () => (fs.existsSync(paths.backups) ? fs.readdirSync(paths.backups)
  .filter(n => /^jessbot-(auto|manual)-.*\.tar\.gz$|^pre-migrate-.*\.sqlite$/.test(n)).sort().reverse() : []);
if (!arg) {
  const all = list();
  console.log(all.length ? `Backups in ${paths.backups} (newest first):\n${all.map(n => `  ${n}`).join('\n')}\n\nnpm run restore -- <name>` : `No backups in ${paths.backups}.`);
  process.exit(0);
}

const file = fs.existsSync(arg) ? path.resolve(arg) : path.join(paths.backups, arg);
if (!fs.existsSync(file)) die(`No such backup: ${arg}`);

// Jessbot must be stopped (the database is open while it runs).
const busy = await new Promise(resolve => {
  const s = net.connect({ host: '127.0.0.1', port: config.port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
if (busy) die(`Something is listening on port ${config.port} — stop Jessbot first (or set PORT if it isn’t Jessbot).`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const staging = path.join(paths.backups, `.restore-${stamp}`);
fs.mkdirSync(staging, { recursive: true });
try {
  if (file.endsWith('.sqlite')) fs.copyFileSync(file, path.join(staging, 'jessbot.sqlite'));
  else await tar.x({ file, cwd: staging, strict: true, preservePaths: false });
  const dbFile = path.join(staging, 'jessbot.sqlite');
  if (!fs.existsSync(dbFile)) die('That archive has no database in it.');
  const check = new DatabaseSync(dbFile, { readOnly: true });
  const ok = check.prepare('PRAGMA integrity_check').get().integrity_check;
  const users = check.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  check.close();
  if (ok !== 'ok') die(`The backup's database failed its integrity check: ${ok}`);

  const aside = path.join(paths.backups, `before-restore-${stamp}`);
  fs.mkdirSync(aside, { recursive: true });
  const restoring = ITEMS.filter(n => fs.existsSync(path.join(staging, n)));
  for (const n of [...restoring, 'jessbot.sqlite-wal', 'jessbot.sqlite-shm']) {
    const cur = path.join(paths.data, n);
    if (fs.existsSync(cur)) fs.renameSync(cur, path.join(aside, n));
  }
  for (const n of restoring) fs.renameSync(path.join(staging, n), path.join(paths.data, n));
  console.log(`\n[restore] Restored ${path.basename(file)} (${users} people; ${restoring.join(', ')}).`);
  console.log(`[restore] What was there before is in ${aside} — move it back to undo.\n[restore] Start Jessbot again.\n`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
