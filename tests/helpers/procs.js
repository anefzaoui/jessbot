// Helper processes the tests start (GreenMail, Radicale): started so the whole tree can be stopped, and checked gone.
// Why: on Windows `java` is often a launcher (C:\Program Files\Common Files\Oracle\Java\javapath\java.exe) that starts
// the real java.exe as its child, and a venv's python.exe does the same with the base Python. child.kill() stops only
// the launcher and the server keeps running, orphaned, holding its ports. So: kill the tree (taskkill /T on Windows, the
// process group elsewhere) and make sure nothing of it is left.
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const WIN = process.platform === 'win32';
const tracked = [];

/** spawn() for a helper server: its own process group on POSIX so the whole group can be stopped. */
export function spawnHelper(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: 'ignore', ...opts, detached: !WIN });
  tracked.push(child);
  return child;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Every process under pid (children, grandchildren…), found before anything is killed. */
function descendants(pid) {
  const all = [];
  let level = [pid];
  for (let depth = 0; level.length && depth < 6; depth++) {
    const next = [];
    for (const p of level) {
      let out = '';
      try {
        out = WIN
          ? execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${p}").ProcessId`], { encoding: 'utf8', windowsHide: true })
          : execFileSync('pgrep', ['-P', String(p)], { encoding: 'utf8' });
      } catch { /* none */ }
      next.push(...out.split(/\s+/).map(Number).filter(n => n > 0));
    }
    all.push(...next);
    level = next;
  }
  return all;
}

/** Stop one helper and everything it started; resolves with the pids that are still alive (should be none). */
export async function stopHelper(child, { waitMs = 8000 } = {}) {
  if (!child?.pid) return [];
  const pids = [child.pid, ...descendants(child.pid)];
  if (WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
  // Anything that slipped out of the tree (re-parented before taskkill saw it) is stopped by pid.
  for (const t0 = Date.now(); Date.now() - t0 < waitMs;) {
    const left = pids.filter(alive);
    if (!left.length) return [];
    for (const p of left) { try { process.kill(p, WIN ? undefined : 'SIGKILL'); } catch { /* gone */ } }
    await new Promise(r => setTimeout(r, 200));
  }
  return pids.filter(alive);
}

/** Stop every helper started with spawnHelper; throws if any process of theirs is still running. */
export async function stopAllHelpers() {
  const left = (await Promise.all(tracked.splice(0).map(c => stopHelper(c)))).flat();
  if (left.length) throw new Error(`helper processes still running after the tests: ${left.join(', ')}`);
}
