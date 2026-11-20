// Secrets at rest (#10): keys entered in the app are sealed in the database, never written to .env; an install's .env
// secrets move into the database at start (an operator's own environment and a shared .env are left alone); the key can
// come from a file; JESSBOT_SECRET_PREVIOUS opens what an older key sealed; `npm run secrets:rotate` seals everything
// again. Each case runs in its own process with its own data folder. Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_KEY = `sk-or-v1-${'a1b2c3d4'.repeat(8)}`;
const MAIL_PASSWORD = 'correct-horse-mail-password';
const key = () => crypto.randomBytes(32).toString('base64');

function home(envText = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-secrets-'));
  fs.writeFileSync(path.join(dir, '.env'), envText);
  return dir;
}
// The child's environment: this data folder, none of this machine's secrets (removed, not blanked: a variable that is set,
// even empty, is never overwritten by .env, which is what the migration relies on), then the test's own.
const SECRET_VARS = ['OPENROUTER_KEY', 'LLM_API_KEY', 'JESSBOT_SECRET', 'JESSBOT_SECRET_FILE', 'JESSBOT_SECRET_PREVIOUS', 'JESSBOT_VAPID_PUBLIC', 'JESSBOT_VAPID_PRIVATE'];
function childEnv(dir, extra = {}) {
  const env = { ...process.env, JESSBOT_HOME: dir, JESSBOT_ENV_FILE: path.join(dir, '.env') };
  for (const k of SECRET_VARS) delete env[k];
  return { ...env, ...extra };
}
// Run a module body in a child with this data folder; prints JSON on the last line.
function run(dir, body, env = {}) {
  const script = `
    process.env.JESSBOT_EMBED_OFF = '1';
    const r = p => import(new URL(p, ${JSON.stringify(`file:///${ROOT.replace(/\\/g, '/')}/`)}).href);
    const { openDb, closeDb, settings, all, run } = await r('src/db/index.js');
    const { ensureDirs, paths } = await r('src/config/index.js');
    ensureDirs(); await openDb();
    const out = await (async () => { ${body} })();
    closeDb();
    console.log(JSON.stringify(out ?? null));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: ROOT, env: childEnv(dir, env) });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split('\n').at(-1));
}
const rotate = (dir, args = [], env = {}) => spawnSync(process.execPath, ['scripts/rotate-secret.js', ...args], { encoding: 'utf8', cwd: ROOT,
  env: childEnv(dir, { PORT: '3999', ...env }) });
const envFile = dir => fs.readFileSync(path.join(dir, '.env'), 'utf8');
const envVar = (dir, k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(envFile(dir)) || [])[1];
// Every byte the database keeps on disk (the file and its write-ahead log).
const dbBytes = dir => Buffer.concat(['jessbot.sqlite', 'jessbot.sqlite-wal'].map(f => { try { return fs.readFileSync(path.join(dir, f)); } catch { return Buffer.alloc(0); } }));

test('migration: the model and push keys in .env move into the database, sealed; .env keeps only the install key', () => {
  const dir = home(`OPENROUTER_KEY=${MODEL_KEY}\nJESSBOT_VAPID_PUBLIC=BPUB\nJESSBOT_VAPID_PRIVATE=vapid-private-key-value\nPORT=3999\n`);
  const out = run(dir, `
    const { migrateEnvSecrets } = await r('src/services/stored-secrets.js');
    const { llmSettings } = await r('src/services/llm.js');
    const moved = migrateEnvSecrets();
    return { moved, apiKey: llmSettings().apiKey, env: process.env.OPENROUTER_KEY ?? null, sealed: settings.get('sealedSecrets'), push: settings.get('push') };`);
  assert.deepEqual(out.moved, ['OPENROUTER_KEY', 'JESSBOT_VAPID_PRIVATE']);
  assert.equal(out.apiKey, MODEL_KEY, 'the app still has its key');
  assert.equal(out.env, null, 'and no longer from the environment');
  assert.match(out.sealed['llm.apiKey'], /^v1:/);
  assert.match(out.sealed['push.vapidPrivate'], /^v1:/);
  assert.equal(out.push.publicKey, 'BPUB');
  const text = envFile(dir);
  assert.doesNotMatch(text, /OPENROUTER_KEY|VAPID/);
  assert.match(text, /^PORT=3999$/m, 'other lines stay');
  assert.match(text, /^JESSBOT_SECRET=.{44}$/m, 'the key it was sealed with');
  for (const plain of [MODEL_KEY, 'vapid-private-key-value']) assert.ok(!dbBytes(dir).includes(plain), 'not in the database files');
  // A second start changes nothing.
  assert.deepEqual(run(dir, `const { migrateEnvSecrets } = await r('src/services/stored-secrets.js'); return migrateEnvSecrets();`), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the operator’s own environment is never stored, and wins; a .env outside the data folder (shared) is left alone', () => {
  const dir = home('');
  const out = run(dir, `
    const { migrateEnvSecrets, sealedSecrets } = await r('src/services/stored-secrets.js');
    const { llmSettings } = await r('src/services/llm.js');
    return { moved: migrateEnvSecrets(), apiKey: llmSettings().apiKey, stored: Object.keys(sealedSecrets()) };`, { OPENROUTER_KEY: MODEL_KEY });
  assert.deepEqual(out, { moved: [], apiKey: MODEL_KEY, stored: [] });

  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-shared-env-'));
  fs.writeFileSync(path.join(shared, '.env'), `OPENROUTER_KEY=${MODEL_KEY}\n`);
  const out2 = run(dir, `const { migrateEnvSecrets } = await r('src/services/stored-secrets.js'); return migrateEnvSecrets();`,
    { JESSBOT_ENV_FILE: path.join(shared, '.env') });
  assert.deepEqual(out2, []);
  assert.match(fs.readFileSync(path.join(shared, '.env'), 'utf8'), /OPENROUTER_KEY=/, 'another copy may need it');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(shared, { recursive: true, force: true });
});

test('keys entered in setup or Admin → Model are sealed in the database, not written to .env', () => {
  const dir = home('');
  const out = run(dir, `
    const { setSecret, getSecret } = await r('src/services/stored-secrets.js');
    setSecret('llm.apiKey', ${JSON.stringify(MODEL_KEY)});
    return getSecret('llm.apiKey');`);
  assert.equal(out, MODEL_KEY);
  assert.doesNotMatch(envFile(dir), /OPENROUTER_KEY/);
  assert.ok(!dbBytes(dir).includes(MODEL_KEY));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JESSBOT_SECRET_FILE: the key comes from the file (never written to .env); a bad file is an error, not a new key', () => {
  const dir = home('');
  const keyFile = path.join(dir, 'secret.key');
  fs.writeFileSync(keyFile, `${key()}\n`);
  const out = run(dir, `
    const { seal, unseal, keySource } = await r('src/lib/secrets.js');
    return { opened: unseal(seal('pw-from-file-key')), src: keySource().source };`, { JESSBOT_SECRET_FILE: keyFile });
  assert.deepEqual(out, { opened: 'pw-from-file-key', src: 'file' });
  assert.doesNotMatch(envFile(dir), /JESSBOT_SECRET/);
  fs.writeFileSync(keyFile, 'not a key');
  const bad = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { seal } = await import(${JSON.stringify(`file:///${ROOT.replace(/\\/g, '/')}/src/lib/secrets.js`)});
    try { seal('x'); console.log('sealed'); } catch (e) { console.log('refused: ' + e.message); }`],
  { encoding: 'utf8', env: childEnv(dir, { JESSBOT_SECRET_FILE: keyFile }) });
  assert.match(bad.stdout, /refused: JESSBOT_SECRET_FILE .* doesn’t hold a valid key/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rotation: everything is sealed again with a new key; the old key no longer opens it; old backups keep theirs', () => {
  const oldKey = key();
  const dir = home(`JESSBOT_SECRET=${oldKey}\n`);
  run(dir, `
    const { seal, sealData } = await r('src/lib/secrets.js');
    const { setSecret } = await r('src/services/stored-secrets.js');
    const { createUser } = await r('src/services/users.js');
    const u = await createUser({ name: 'Alex', email: 'alex@rotate.test', password: 'correct horse battery', role: 'admin' });
    run("INSERT INTO connections (user_id, kind, label, provider, config, secret) VALUES (?, 'email', 'Mail', 'custom', '{}', ?)", u.id, seal(${JSON.stringify(MAIL_PASSWORD)}));
    run('UPDATE users SET totp_secret = ? WHERE id = ?', seal('JBSWY3DPEHPK3PXP'), u.id);
    setSecret('llm.apiKey', ${JSON.stringify(MODEL_KEY)});
    const fs = await import('node:fs');
    fs.writeFileSync(paths.browserProfiles + '/u' + u.id + '.json', sealData(JSON.stringify({ cookies: [{ name: 'sid', value: 'cookie-value' }], origins: [] })));
    return null;`, { JESSBOT_SECRET: oldKey });

  const res = rotate(dir, [], { JESSBOT_SECRET: oldKey });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /1 mail and calendar passwords, 1 two-step sign-in, 1 the model key, 1 browser sign-ins/);
  const newKey = envVar(dir, 'JESSBOT_SECRET');
  assert.ok(newKey && newKey !== oldKey);
  assert.equal(envVar(dir, 'JESSBOT_SECRET_PREVIOUS'), undefined, 'the old key is gone from .env');
  const kept = fs.readdirSync(dir).find(f => f.startsWith('.env.before-rotate-'));
  assert.ok(kept && fs.readFileSync(path.join(dir, kept), 'utf8').includes(oldKey), 'the old .env is kept for old backups');

  const check = env => run(dir, `
    const { unseal, unsealData } = await r('src/lib/secrets.js');
    const { getSecret } = await r('src/services/stored-secrets.js');
    const fs = await import('node:fs');
    const tryOpen = f => { try { return f(); } catch { return null; } };
    const c = all('SELECT secret FROM connections')[0];
    const t = all('SELECT totp_secret FROM users WHERE totp_secret IS NOT NULL')[0];
    const file = fs.readdirSync(paths.browserProfiles).find(f => f.endsWith('.json'));
    return { mail: tryOpen(() => unseal(c.secret)), totp: tryOpen(() => unseal(t.totp_secret)), model: tryOpen(() => getSecret('llm.apiKey')),
      profile: tryOpen(() => JSON.parse(unsealData(fs.readFileSync(paths.browserProfiles + '/' + file, 'utf8'))).cookies[0].value) };`, env);
  assert.deepEqual(check({ JESSBOT_SECRET: newKey }), { mail: MAIL_PASSWORD, totp: 'JBSWY3DPEHPK3PXP', model: MODEL_KEY, profile: 'cookie-value' });
  assert.deepEqual(check({ JESSBOT_SECRET: oldKey }), { mail: null, totp: null, model: null, profile: null }, 'the old key opens nothing now');
  // A backup sealed with the old key: JESSBOT_SECRET_PREVIOUS opens it.
  const fromBackup = run(dir, `
    const { unseal } = await r('src/lib/secrets.js');
    return unseal(process.env.OLD_SEALED);`, { JESSBOT_SECRET: newKey, JESSBOT_SECRET_PREVIOUS: oldKey,
    OLD_SEALED: (() => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(oldKey, 'base64'), iv);
      const ct = Buffer.concat([c.update('from-an-old-backup'), c.final()]); return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':'); })() });
  assert.equal(fromBackup, 'from-an-old-backup');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rotation refuses: while Jessbot is running, with a key file (until --reseal), and when something won’t open', async () => {
  const dir = home(`JESSBOT_SECRET=${key()}\n`);
  const net = await import('node:net');
  const busy = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => busy.once('listening', r));
  const r1 = rotate(dir, [], { PORT: String(busy.address().port), JESSBOT_SECRET: envVar(dir, 'JESSBOT_SECRET') });
  busy.close();
  assert.notEqual(r1.status, 0);
  assert.match(r1.stderr, /stop Jessbot first/);

  const keyFile = path.join(dir, 'secret.key');
  fs.writeFileSync(keyFile, key());
  const r2 = rotate(dir, [], { JESSBOT_SECRET_FILE: keyFile });
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /--reseal/);

  // Sealed with a key nobody has any more: nothing is changed.
  run(dir, `const { seal } = await r('src/lib/secrets.js'); const { setSecret } = await r('src/services/stored-secrets.js'); setSecret('llm.apiKey', 'lost-key-value'); return null;`,
    { JESSBOT_SECRET: key() });
  const before = envFile(dir);
  const r3 = rotate(dir, [], { JESSBOT_SECRET: envVar(dir, 'JESSBOT_SECRET') });
  assert.notEqual(r3.status, 0);
  assert.match(r3.stderr, /doesn’t open .* Nothing was changed/);
  assert.equal(envFile(dir), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the inventory knows every sealed column (a new one must be added there, or rotation would leave it behind)', async () => {
  const dir = home('');
  const cols = run(dir, `
    const tables = all("SELECT name FROM sqlite_master WHERE type = 'table'").map(t => t.name);
    return tables.flatMap(t => all('PRAGMA table_info(' + t + ')').map(c => t + '.' + c.name)).filter(c => /(^|[._])(secret|totp_secret|totp_pending|sealed)/.test(c.split('.')[1]));`);
  const { SEALED_COLUMNS } = await import('../src/services/sealed-inventory.js');
  assert.deepEqual(cols.sort(), [...SEALED_COLUMNS].sort());
  fs.rmSync(dir, { recursive: true, force: true });
});
