// npm run db:status — show applied / pending migrations without changing anything.
// npm run db:backup — write a snapshot to data/backups/.
import { ensureDirs } from '../src/config/index.js';
import { openDb, migrationStatus, backupDb, closeDb } from '../src/db/index.js';

ensureDirs();
await openDb(undefined, { migrate: false });

if (process.argv.includes('--backup')) {
  console.log(`backup written: ${backupDb('manual')}`);
} else {
  const s = migrationStatus();
  for (const r of s.applied) console.log(`  applied   ${r.name}  (${r.applied_at})`);
  for (const m of s.pending) console.log(`  PENDING   ${m.name}`);
  for (const n of s.unknown) console.log(`  UNKNOWN   ${n}  ← applied by a newer version`);
  for (const n of s.modified) console.log(`  MODIFIED  ${n}  ← edited after being applied`);
  console.log(`\n${s.applied.length} applied, ${s.pending.length} pending`
    + (s.unknown.length || s.modified.length ? ' — boot will refuse until resolved' : ''));
}
closeDb();
