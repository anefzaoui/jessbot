// A local SearXNG for Jessbot (decision #138): installed into tools/searxng (gitignored, never committed), bound to
// 127.0.0.1, JSON format on, limiter off, its own secret key made here. Runs natively on Windows, macOS and Linux with
// Python 3.10+: the official repository's archive at a pinned commit, a Python virtual environment, SearXNG's own
// requirements and its production server (granian).
//   npm run searxng:install            install (or update to the pinned commit); keeps an existing settings.yml
//   npm run searxng:start              run in this terminal (Ctrl+C stops it)
//   npm run searxng:start -- --background   run detached (log: tools/searxng/searxng.log, pid: tools/searxng/searxng.pid)
//   node scripts/searxng.js stop | status
// Then put the printed address in Admin → Browser → SearXNG address.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve(ROOT, process.env.JESSBOT_TOOLS || 'tools', 'searxng');
const SRC = path.join(DIR, 'src');
const VENV = path.join(DIR, 'venv');
const COMPAT = path.join(DIR, 'compat');
const SETTINGS = path.join(DIR, 'settings.yml');
const LOG = path.join(DIR, 'searxng.log');
const PID = path.join(DIR, 'searxng.pid');
// Pinned: searxng/searxng master of 2026-09-25. Change it deliberately (and re-run install), never float.
const PINNED = '12f8b6515ca77c3c3bc1498584950ef5daca1433';
const WIN = process.platform === 'win32';
const venvPython = path.join(VENV, WIN ? 'Scripts/python.exe' : 'bin/python');
const granian = path.join(VENV, WIN ? 'Scripts/granian.exe' : 'bin/granian');

const say = m => console.log(`[searxng] ${m}`);
function fail(m) { console.error(`[searxng] ${m}`); process.exit(1); }
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8', ...opts });
  if (r.error || r.status !== 0) {
    if (opts.optional) return null;
    fail(`${cmd} ${args.join(' ')} failed${r.stderr ? `:\n${r.stderr.slice(-2000)}` : ''}`);
  }
  return r;
}

/** A Python 3.10+ to build the environment with: python, python3 or the Windows launcher. */
function findPython() {
  for (const [cmd, pre] of [['python', []], ['python3', []], ...(WIN ? [['py', ['-3']]] : [])]) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    const v = (r.stdout || '').trim();
    if (r.status === 0 && /^\d+\.\d+$/.test(v)) {
      const [maj, min] = v.split('.').map(Number);
      if (maj === 3 && min >= 10) return { cmd, pre, version: v };
    }
  }
  return null;
}

const freePort = (preferred = 8888) => new Promise(resolve => {
  const tryPort = (port, next) => {
    const srv = net.createServer();
    srv.once('error', () => next());
    srv.listen(port, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  };
  tryPort(preferred, () => tryPort(0, () => resolve(0)));
});

const readSettings = () => { try { return fs.readFileSync(SETTINGS, 'utf8'); } catch { return null; } };
const portOf = text => Number(/^\s*port:\s*(\d+)/m.exec(text || '')?.[1]) || null;

function settingsYml(port, secret) {
  return `# Written by \`npm run searxng:install\` for Jessbot (decision #138). Local only: bound to 127.0.0.1.
# Jessbot asks for JSON (search.formats), and the rate limiter is off because the only client is this computer.
use_default_settings: true
general:
  instance_name: "Jessbot search"
  enable_metrics: false
server:
  bind_address: "127.0.0.1"
  port: ${port}
  secret_key: "${secret}"
  limiter: false
  public_instance: false
  image_proxy: false
search:
  formats:
    - html
    - json
valkey:
  url: false
`;
}

// SearXNG imports the Unix-only "pwd" module (only to name the user in an error message when a Valkey database is
// unreachable — Jessbot's instance has none). On Windows this shim, on the instance's own module path, stands in for it.
const PWD_SHIM = `# Windows stand-in for the Unix-only "pwd" module (written by Jessbot's scripts/searxng.js). SearXNG only uses it to
# name the current user in a log line; nothing else on this path depends on it.
import collections, os
struct_passwd = collections.namedtuple('struct_passwd', 'pw_name pw_passwd pw_uid pw_gid pw_gecos pw_dir pw_shell')
def getpwuid(uid):
    return struct_passwd(os.environ.get('USERNAME', 'user'), 'x', uid, 0, '', os.path.expanduser('~'), '')
`;

async function install() {
  const py = findPython();
  if (!py) fail('Python 3.10 or newer is needed (python.org, or your package manager), then run this again.');
  say(`Python ${py.version}, installing into ${path.relative(ROOT, DIR)}`);
  fs.mkdirSync(DIR, { recursive: true });

  // 1. The source at the pinned commit: GitHub's archive of exactly that commit, unpacked here. A few Linux service
  //    templates have ":" in their names, which Windows can't store; they aren't needed to run SearXNG and are skipped.
  const stamp = path.join(SRC, '.jessbot-commit');
  if ((fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim()) === PINNED) say('source already at the pinned commit');
  else {
    say(`downloading SearXNG ${PINNED.slice(0, 10)}…`);
    const res = await fetch(`https://codeload.github.com/searxng/searxng/tar.gz/${PINNED}`);
    if (!res.ok) fail(`download failed: HTTP ${res.status}`);
    fs.rmSync(SRC, { recursive: true, force: true });
    fs.mkdirSync(SRC, { recursive: true });
    let skipped = 0;
    await pipeline(Readable.fromWeb(res.body), tar.x({ cwd: SRC, strip: 1, filter: p => { if (p.includes(':')) { skipped++; return false; } return true; } }));
    fs.writeFileSync(stamp, PINNED);
    say(`source unpacked${skipped ? ` (${skipped} Linux service template${skipped === 1 ? '' : 's'} with “:” in the name skipped)` : ''}`);
  }

  // 2. The virtual environment and SearXNG's own requirements (+ time zone data, which Windows' Python lacks).
  if (!fs.existsSync(venvPython)) { say('creating the Python environment…'); run(py.cmd, [...py.pre, '-m', 'venv', VENV]); }
  say('installing requirements (a minute or two the first time)…');
  run(venvPython, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '-r', path.join(SRC, 'requirements.txt'), '-r', path.join(SRC, 'requirements-server.txt'), 'tzdata']);

  // 3. Windows compatibility shim, kept outside the source tree.
  fs.mkdirSync(COMPAT, { recursive: true });
  if (WIN) fs.writeFileSync(path.join(COMPAT, 'pwd.py'), PWD_SHIM);

  // 4. settings.yml: kept when it exists (its secret key and port stay), else written with a free port and a new key.
  let text = readSettings();
  if (!text || process.argv.includes('--reset')) {
    const port = await freePort(8888);
    fs.writeFileSync(SETTINGS, settingsYml(port, crypto.randomBytes(32).toString('hex')), { mode: 0o600 });
    text = readSettings();
    say(`settings written: 127.0.0.1:${port}, JSON on, limiter off, new secret key`);
  } else say('settings.yml kept');
  fs.writeFileSync(path.join(DIR, 'instance.json'), JSON.stringify({ commit: PINNED, port: portOf(text), installedAt: new Date().toISOString() }, null, 2));
  say(`installed. Start it with: npm run searxng:start -- --background`);
  say(`then set Admin → Browser → SearXNG address to http://127.0.0.1:${portOf(text)}`);
}

function env() {
  return { ...process.env, SEARXNG_SETTINGS_PATH: SETTINGS, PYTHONPATH: [COMPAT, SRC].join(path.delimiter), PYTHONUNBUFFERED: '1' };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const pidOf = () => { const n = Number(fs.readFileSync(PID, 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : null; };
const savedPid = () => { try { return pidOf(); } catch { return null; } };

async function healthy(port, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function start() {
  const text = readSettings();
  if (!text || !fs.existsSync(granian)) fail('SearXNG isn’t installed yet: npm run searxng:install');
  const port = portOf(text);
  const pid = savedPid();
  if (pid && alive(pid)) { say(`already running (pid ${pid}) on http://127.0.0.1:${port}`); return; }
  const args = ['--interface', 'wsgi', '--host', '127.0.0.1', '--port', String(port), '--workers', '1', '--blocking-threads', '4', 'searx.webapp:app'];
  if (process.argv.includes('--background')) {
    const out = fs.openSync(LOG, 'a');
    const child = spawn(granian, args, { cwd: SRC, env: env(), detached: true, stdio: ['ignore', out, out], windowsHide: true });
    fs.writeFileSync(PID, String(child.pid));
    child.unref();
    say(`starting in the background (pid ${child.pid}, log ${path.relative(ROOT, LOG)})…`);
    if (await healthy(port)) say(`running: http://127.0.0.1:${port}`);
    else fail(`it didn’t answer on port ${port} within 30 s — see ${path.relative(ROOT, LOG)}`);
    return;
  }
  say(`running on http://127.0.0.1:${port} (Ctrl+C stops it)`);
  const child = spawn(granian, args, { cwd: SRC, env: env(), stdio: 'inherit' });
  fs.writeFileSync(PID, String(child.pid));
  child.on('exit', code => { fs.rmSync(PID, { force: true }); process.exit(code ?? 0); });
}

function stop() {
  const pid = savedPid();
  if (!pid || !alive(pid)) { fs.rmSync(PID, { force: true }); say('not running'); return; }
  // By its exact pid (never by name: other programs run on this machine); /T takes granian's worker with it.
  if (WIN) run('taskkill', ['/PID', String(pid), '/T', '/F'], { quiet: true, optional: true });
  else process.kill(pid, 'SIGTERM');
  fs.rmSync(PID, { force: true });
  say(`stopped (pid ${pid})`);
}

async function status() {
  const text = readSettings();
  if (!text) { say('not installed (npm run searxng:install)'); return; }
  const port = portOf(text), pid = savedPid();
  const up = await healthy(port, 1500);
  say(`${up ? 'running' : 'not answering'} on http://127.0.0.1:${port}${pid ? ` (pid ${pid}${alive(pid) ? '' : ', not alive'})` : ''}`);
}

const cmd = process.argv[2];
if (cmd === 'install') await install();
else if (cmd === 'start') await start();
else if (cmd === 'stop') stop();
else if (cmd === 'status') await status();
else fail('usage: node scripts/searxng.js install | start [--background] | stop | status');
