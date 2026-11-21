// The command-line tools that work on an existing Jessbot (links:check, doctor, db:status and db:backup, reset-link,
// secrets:rotate) open its database here (issue #82). A data folder that was never set up (no database in it, or one
// whose first migration never ran) gets a clear message and exit code 1 instead of a stack trace from the first query
// ("no such table: settings"), and nothing is created in it: no folders, no database file.
import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDirs } from '../../src/config/index.js';
import { openDb, closeDb, isSetUp } from '../../src/db/index.js';

// How the person ran it: `npm run links:check` sets npm_lifecycle_event to links:check and npm_lifecycle_script to this
// script's command; `node scripts/links-check.js`, or another npm script that starts this one, doesn't match.
function command() {
  const file = path.basename(process.argv[1] || '');
  const { npm_lifecycle_event: event, npm_lifecycle_script: script = '' } = process.env;
  return event && file && script.includes(file) ? `npm run ${event}` : `node scripts/${file}`;
}

/** The message for a data folder that has no Jessbot set up in it. why: what was found there. */
export function notSetUpMessage(why) {
  return [
    `✗ No Jessbot is set up in ${paths.data} yet (${why}).`,
    `  Meant another one? Set JESSBOT_HOME to its data folder (in the environment or in .env) and run ${command()} again.`,
    '  Setting this one up? Start Jessbot (npm start) and finish the setup page.',
  ].join('\n');
}

const stop = message => { console.error(`\n${message}\n`); process.exit(1); };

/**
 * Open the instance's database, or stop with exit code 1 if there is none. migrate: apply pending migrations (what
 * openDb() does by default); without it the database is only read, as links:check and the doctor do.
 */
export async function openInstance({ migrate = false } = {}) {
  if (!fs.existsSync(paths.db)) stop(notSetUpMessage('no database there'));
  try {
    await openDb(undefined, { migrate: false });
    if (!isSetUp()) { closeDb(); stop(notSetUpMessage('its database was never set up')); }
    ensureDirs();
    if (migrate) { closeDb(); await openDb(); }
  } catch (err) {
    stop(`✗ Database: ${err.message}`);
  }
}
