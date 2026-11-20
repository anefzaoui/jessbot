// DEV: run the server and restart it when source files change — by CONTENT (mtime), not by access.
// Why not `node --watch`: on Windows/NTFS, merely reading a file can update its last-access time, which
// fs.watch reports as a change — so rendering a template restarted the server mid-request (decision #46).
//   npm run dev   → http://127.0.0.1:3738 with its own data in data/dev, so development never touches the data of an
//                   install you use day to day on :3737 (decision #57)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const WATCH = ['src', 'server.js'].map(p => path.join(ROOT, p));

let child = null;
let restarting = false;
function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'inherit',
    env: { PORT: '3738', JESSBOT_HOME: path.join('data', 'dev'), ...process.env } });
  child.on('exit', code => {
    if (restarting) { restarting = false; start(); return; }
    if (code) console.log(`[dev] server exited (${code}) — waiting for a change…`);
    child = null;
  });
}

function restart(file) {
  console.log(`[dev] ${path.relative(ROOT, file)} changed — restarting`);
  if (!child) return start();
  restarting = true;
  child.kill();
}

// Remember each file's mtime; only a different mtime (or a new / deleted file) counts as a change.
const mtimes = new Map();
function prime(p) {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) for (const n of fs.readdirSync(p)) prime(path.join(p, n));
  else mtimes.set(p, st.mtimeMs);
}
WATCH.forEach(prime);

let timer = null, pending = null;
for (const target of WATCH) {
  const isDir = fs.statSync(target).isDirectory();
  fs.watch(target, { recursive: isDir }, (event, name) => {
    const file = isDir ? path.join(target, String(name || '')) : target;
    // One stat, tolerant of files that vanish in between (editors' temp files).
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st?.isDirectory()) return;
    if (!st && !mtimes.has(file)) return; // a temp file came and went
    const now = st ? st.mtimeMs : null;
    if (mtimes.get(file) === now) return; // access-time only (or no real change)
    if (now === null) mtimes.delete(file); else mtimes.set(file, now);
    pending = file;
    clearTimeout(timer);
    timer = setTimeout(() => restart(pending), 120);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child?.kill(sig); process.exit(0); });
start();
