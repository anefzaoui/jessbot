// Thin wrapper over the built-in node:sqlite driver (no native dependency).
// Kept small on purpose so it could be swapped for better-sqlite3 if needed.
//
// Safe schema upgrades (see docs/DATABASE.md):
//  - migrations live in src/db/migrations as NNN_name.sql or NNN_name.js (export async function up(db))
//  - before applying anything pending, the database is snapshotted to data/backups/
//  - each migration runs in its own transaction; on failure it rolls back and boot stops
//  - applied migrations are checksummed; editing one afterwards stops boot
//  - a database that has migrations this code doesn't know (downgrade) stops boot
//  - "-- jessbot:foreign_keys=off" (SQL) / `export const foreignKeys = false` (JS) disables FK
//    enforcement around a table-rebuild migration, then verifies with PRAGMA foreign_key_check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { paths } from '../config/index.js';

let db;
const stmtCache = new Map();

export class MigrationError extends Error {}

export async function openDb(file = paths.db, { migrate = true } = {}) {
  if (db) return db;
  db = new DatabaseSync(file, { timeout: 5000, enableForeignKeyConstraints: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  ensureMigrationTable();
  if (migrate) await runMigrations();
  return db;
}

export function closeDb() {
  stmtCache.clear();
  db?.close();
  db = undefined;
}

function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}

export const all = (sql, ...params) => stmt(sql).all(...params);
export const get = (sql, ...params) => stmt(sql).get(...params);
export const run = (sql, ...params) => stmt(sql).run(...params);
export const exec = sql => db.exec(sql);

// Run fn inside a transaction; nested calls join the outer transaction.
export function tx(fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- Migrations ------------------------------------------------------------
const MIGRATION_FILE = /^(\d{3,})_[\w-]+\.(sql|js)$/;
const sha256 = text => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

function ensureMigrationTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  // Early dev databases lacked the checksum column.
  const cols = db.prepare('PRAGMA table_info(_migrations)').all().map(c => c.name);
  if (!cols.includes('checksum')) db.exec('ALTER TABLE _migrations ADD COLUMN checksum TEXT');
}

function readMigrations() {
  return fs.readdirSync(paths.migrations).filter(f => MIGRATION_FILE.test(f)).sort().map(name => {
    const file = path.join(paths.migrations, name);
    const source = fs.readFileSync(file, 'utf8');
    return { name, file, source, kind: path.extname(name).slice(1), checksum: sha256(source) };
  });
}

/** Whether this database was ever set up (its first migration made the settings table). The command-line tools refuse
 *  one that wasn't, with a message instead of the first query's "no such table" (scripts/lib/instance.js, #82). */
export const isSetUp = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();

export function migrationStatus() {
  const files = readMigrations();
  const applied = db.prepare('SELECT name, checksum, applied_at FROM _migrations ORDER BY name').all();
  const byName = new Map(applied.map(r => [r.name, r]));
  const known = new Set(files.map(f => f.name));
  return {
    applied,
    pending: files.filter(f => !byName.has(f.name)),
    unknown: applied.filter(r => !known.has(r.name)).map(r => r.name),
    modified: files.filter(f => byName.get(f.name)?.checksum && byName.get(f.name).checksum !== f.checksum).map(f => f.name),
    missingChecksum: files.filter(f => byName.has(f.name) && !byName.get(f.name).checksum),
  };
}

export function backupDb(label) {
  fs.mkdirSync(paths.backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(paths.backups, `${label}-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  return dest;
}

async function runMigrations() {
  const status = migrationStatus();

  if (status.unknown.length) {
    throw new MigrationError(`This database was upgraded by a newer Jessbot (unknown migrations: ${status.unknown.join(', ')}). `
      + 'Run the newer version, or restore a backup from data/backups/. Refusing to start to protect your data.');
  }
  if (status.modified.length) {
    throw new MigrationError(`Already-applied migrations were edited: ${status.modified.join(', ')}. `
      + 'Revert those edits and put schema changes in a new numbered migration instead.');
  }
  // Adopt checksums for migrations applied before checksums existed.
  for (const m of status.missingChecksum) db.prepare('UPDATE _migrations SET checksum = ? WHERE name = ?').run(m.checksum, m.name);

  if (!status.pending.length) return;
  const backup = status.applied.length ? backupDb('pre-migrate') : null;
  if (backup) console.log(`[db] backup before migrating: ${backup}`);

  for (const m of status.pending) {
    const mod = m.kind === 'js' ? await import(pathToFileURL(m.file).href) : null;
    const fkOff = m.kind === 'js' ? mod.foreignKeys === false : /--\s*jessbot:foreign_keys=off/i.test(m.source);
    if (fkOff) db.exec('PRAGMA foreign_keys = OFF'); // must be set outside the transaction
    try {
      db.exec('BEGIN IMMEDIATE');
      if (m.kind === 'sql') db.exec(m.source);
      else await mod.up({ db, all, get, run, exec });
      if (fkOff) {
        const problems = db.prepare('PRAGMA foreign_key_check').all();
        if (problems.length) throw new Error(`foreign key check failed: ${JSON.stringify(problems.slice(0, 5))}`);
      }
      db.prepare('INSERT INTO _migrations (name, checksum) VALUES (?, ?)').run(m.name, m.checksum);
      db.exec('COMMIT');
      console.log(`[db] applied migration ${m.name}`);
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      stmtCache.clear();
      throw new MigrationError(`Migration ${m.name} failed and was rolled back — the database is unchanged. `
        + `${err.message}${backup ? ` (pre-migration backup: ${backup})` : ''}`);
    } finally {
      if (fkOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
  stmtCache.clear(); // schema changed; drop cached statements
}

// ---- Settings (key/value, JSON-encoded) ------------------------------------
export const settings = {
  get(key, fallback = null) {
    const row = get('SELECT value FROM settings WHERE key = ?', key);
    return row ? JSON.parse(row.value) : fallback;
  },
  set(key, value) {
    run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, JSON.stringify(value));
  },
};
