// The command-line tools on a data folder that was never set up (issue #82): a clear message naming the folder and
// JESSBOT_HOME, exit code 1, no stack trace, and nothing created there. On a folder that is set up they still run.
// Run: npm test  (spawns the scripts with throwaway JESSBOT_HOME folders; no server, no browser, no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-cli-'));
const FAKE_KEY = Buffer.alloc(32, 7).toString('base64'); // obviously fake: 32 bytes of 0x07
let port;

before(async () => { // a free port: secrets:rotate refuses while something listens on PORT
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  port = s.address().port;
  await new Promise(r => s.close(r));
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** Run scripts/<script> as a person would, on the data folder `home`. → { code, out, err } */
function run(script, args, home) {
  const env = { ...process.env, JESSBOT_HOME: home, JESSBOT_ENV_FILE: path.join(TMP, 'none.env'), PORT: String(port),
    JESSBOT_SECRET: FAKE_KEY, JESSBOT_EMBED_OFF: '1' };
  delete env.npm_lifecycle_event; delete env.npm_lifecycle_script; // as `node scripts/…`, even under `npm test`
  delete env.JESSBOT_SECRET_FILE;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  });
}

const COMMANDS = [
  ['links-check.js', []],
  ['doctor.js', []],
  ['db-status.js', []],
  ['db-status.js', ['--backup']],
  ['reset-link.js', ['someone@example.com']],
  ['rotate-secret.js', []],
];

test('CLI: on a data folder that doesn\'t exist, each tool says no Jessbot is set up there, exits 1 with no stack trace, creates nothing', { timeout: 180000 }, async () => {
  for (const [script, args] of COMMANDS) {
    const home = path.join(TMP, `missing-${script}-${args.length}`);
    const r = await run(script, args, home);
    const what = `${script} ${args.join(' ')}`.trim();
    assert.equal(r.code, 1, `${what}: exit code (stderr: ${r.err.trim()})`);
    assert.ok(r.err.includes(`No Jessbot is set up in ${home} yet (no database there)`), `${what}: says what is wrong: ${r.err}`);
    assert.ok(r.err.includes('JESSBOT_HOME') && r.err.includes(`node scripts/${script}`), `${what}: says how to point it at one: ${r.err}`);
    assert.doesNotMatch(r.err + r.out, /\n\s+at |no such table|ERR_SQLITE/, `${what}: no stack trace`);
    assert.equal(fs.existsSync(home), false, `${what}: the folder was not created`);
  }
});

test('CLI: an empty folder, or one with a database that was never set up, is refused the same way, and nothing is set up in it', { timeout: 120000 }, async () => {
  const empty = path.join(TMP, 'empty');
  fs.mkdirSync(empty);
  const r = await run('links-check.js', [], empty);
  assert.equal(r.code, 1);
  assert.match(r.err, /No Jessbot is set up in .* yet \(no database there\)/);
  assert.deepEqual(fs.readdirSync(empty), [], 'nothing was made in it');

  // What an older links:check left behind: a database file with nothing set up in it.
  const stub = path.join(TMP, 'stub');
  fs.mkdirSync(stub);
  const { DatabaseSync } = await import('node:sqlite');
  new DatabaseSync(path.join(stub, 'jessbot.sqlite')).close();
  for (const [script, args] of [['doctor.js', []], ['reset-link.js', ['someone@example.com']]]) {
    const s = await run(script, args, stub);
    assert.equal(s.code, 1, `${script}: ${s.err}`);
    assert.match(s.err, /yet \(its database was never set up\)/, script);
    assert.doesNotMatch(s.err + s.out, /\n\s+at |no such table|applied migration/, `${script}: no trace, and not set up by the tool`);
  }
  assert.deepEqual(fs.readdirSync(stub).filter(n => !/^jessbot\.sqlite(-wal|-shm)?$/.test(n)), [], 'no folders made in it');
});

test('CLI: on a data folder that is set up, the tools run as before', { timeout: 180000 }, async () => {
  const home = path.join(TMP, 'set-up');
  // reset-link applies the migrations itself on a set-up folder; set one up the way the server does (all migrations).
  const setup = await new Promise((resolve, reject) => {
    const env = { ...process.env, JESSBOT_HOME: home, JESSBOT_ENV_FILE: path.join(TMP, 'none.env') };
    const code = "const c = await import('./src/config/index.js'); c.ensureDirs(); const d = await import('./src/db/index.js'); await d.openDb(); d.closeDb();";
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', c => resolve({ code: c, err }));
  });
  assert.equal(setup.code, 0, setup.err);

  const status = await run('db-status.js', [], home);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /\d+ applied, 0 pending/);
  const reset = await run('reset-link.js', ['someone@example.com'], home);
  assert.equal(reset.code, 1);
  assert.match(reset.err, /No account with the email someone@example\.com/, 'it got as far as looking the account up');
  const links = await run('links-check.js', ['no-such-site'], home);
  assert.equal(links.code, 2, links.err);
  assert.match(links.err, /Unknown site\(s\): no-such-site/, 'it got as far as reading its arguments');
});
