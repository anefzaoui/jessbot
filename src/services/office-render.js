// Real previews of Word, Excel and PowerPoint files (Phase 22, decision #162), when LibreOffice happens to be installed:
// the file is converted to a PDF headlessly and its first pages are drawn as pictures (services/pdf-render.js) for the
// Library's thumbnail and preview, and for Jess to look at what she made. LibreOffice is an optional capability (about
// 500 MB), never required and never installed by Jessbot; without it the Library keeps its HTML previews built from the
// file's content (services/office.js).
//
// Found like CloakBrowser is: an admin setting (`office.soffice`: a path, or `office.previews: false` to switch previews
// off), the JESSBOT_SOFFICE environment variable, `soffice` on PATH, then the standard install folders. Each conversion:
//   - runs alone (one queue for the whole server), with a time limit; on timeout the whole process tree is killed;
//   - gets a fresh, throwaway LibreOffice profile (-env:UserInstallation) seeded so the document can't reach out or run
//     code: macros off (highest security level, execution disabled), links from documents blocked, linked data in
//     spreadsheets and documents never updated, every proxy pointed at a closed local port, no update check;
//   - works on a copy in a temp folder that is removed afterwards.
// There is no operating-system sandbox around LibreOffice; the profile is what keeps it offline and inert.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { settings } from '../db/index.js';

export const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx']);
export const CONVERT_TIMEOUT_MS = 90_000;
const CACHE_MS = 5 * 60_000;

// ---- Finding it ---------------------------------------------------------------------------------------------------
/** The standard install locations for this platform (env: where Program Files and the like are). */
export function standardSofficePaths(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    return [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]
      .filter(Boolean).map(dir => path.join(dir, 'LibreOffice', 'program', 'soffice.exe'));
  }
  if (platform === 'darwin') return ['/Applications/LibreOffice.app/Contents/MacOS/soffice'];
  let opt = [];
  try { opt = fs.readdirSync('/opt').filter(d => /^libreoffice/i.test(d)).map(d => `/opt/${d}/program/soffice`); } catch { /* none */ }
  return ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/lib/libreoffice/program/soffice', '/usr/local/bin/soffice', ...opt, '/snap/bin/libreoffice'];
}

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * Where LibreOffice is → { path, source: 'setting' | 'env' | 'path' | 'standard' } or null (not installed, or previews
 * switched off). env / platform / standard / config: what to look at (the process's by default; tests pass their own).
 */
export function locateSoffice({ env = process.env, platform = process.platform, standard, config } = {}) {
  const cfg = config ?? settings.get('office', {}) ?? {};
  if (cfg.previews === false) return null;
  if (cfg.soffice) return isFile(cfg.soffice) ? { path: cfg.soffice, source: 'setting' } : null; // a wrong setting isn't silently replaced
  if (env.JESSBOT_SOFFICE) return isFile(env.JESSBOT_SOFFICE) ? { path: env.JESSBOT_SOFFICE, source: 'env' } : null;
  const names = platform === 'win32' ? ['soffice.exe'] : ['soffice', 'libreoffice'];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const name of names) {
      const p = path.join(dir.replace(/^"|"$/g, ''), name);
      if (isFile(p)) return { path: p, source: 'path' };
    }
  }
  const found = (standard ?? standardSofficePaths(env, platform)).find(isFile);
  return found ? { path: found, source: 'standard' } : null;
}

let cached = null, cachedAt = 0, override = null;
/** LibreOffice for this server (looked up at most every 5 minutes; refresh: look now) → { path, source } | null. */
export function findSoffice({ refresh = false } = {}) {
  if (override) return { path: override.bin, source: 'override', pre: override.pre };
  if (refresh || !cachedAt || Date.now() - cachedAt > CACHE_MS) { cached = locateSoffice(); cachedAt = Date.now(); }
  return cached;
}
/** Use this command instead of looking (bin + leading arguments; scripts and tests). null goes back to looking. */
export function useSoffice(cmd) { override = cmd ? { bin: cmd.bin, pre: cmd.pre || [] } : null; cachedAt = 0; }

/** For the doctor and Admin → System: { available, path, source, detail }. */
export function officeRenderStatus() {
  const s = findSoffice();
  const off = settings.get('office', {})?.previews === false;
  return { available: !!s, path: s?.path || null, source: s?.source || null,
    detail: s ? `LibreOffice found at ${s.path}` : off ? 'Switched off in settings' : 'LibreOffice not installed' };
}

// ---- The throwaway profile ------------------------------------------------------------------------------------------
const prop = (p, name, value) => `<item oor:path="${p}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>`;
const SCRIPTING = '/org.openoffice.Office.Common/Security/Scripting';
const INET = '/org.openoffice.Inet/Settings';
export const PROFILE_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${[
    prop(SCRIPTING, 'MacroSecurityLevel', 3), prop(SCRIPTING, 'DisableMacrosExecution', 'true'), prop(SCRIPTING, 'BlockUntrustedRefererLinks', 'true'),
    prop(INET, 'ooInetProxyType', 2),
    ...['HTTP', 'HTTPS', 'FTP'].flatMap(k => [prop(INET, `ooInet${k}ProxyName`, '127.0.0.1'), prop(INET, `ooInet${k}ProxyPort`, 9)]),
    prop(INET, 'ooInetNoProxy', ''),
    prop('/org.openoffice.Office.Calc/Content/Update', 'Link', 1), // linked data: never update
    prop('/org.openoffice.Office.Writer/Content/Update', 'Link', 1),
    prop("/org.openoffice.Office.Jobs/Jobs/org.openoffice.Office.Jobs:Job['UpdateCheck']/Arguments", 'AutoCheckEnabled', 'false'),
    prop('/org.openoffice.Office.Recovery/AutoSave', 'Enabled', 'false'),
    prop('/org.openoffice.Office.Common/Misc', 'FirstRun', 'false'),
  ].join('\n')}
</oor:items>
`;

// ---- Converting ------------------------------------------------------------------------------------------------------
let queue = Promise.resolve();
/** Run conversions one at a time, whoever asks. */
const enqueue = job => { const p = queue.then(job, job); queue = p.catch(() => {}); return p; };

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

/**
 * An office file's bytes → the PDF LibreOffice prints of it (a Buffer). ext: docx | xlsx | pptx. Throws when LibreOffice
 * isn't there, fails, or runs past the time limit (a 504-like error with name 'TimeoutError').
 */
export function officeToPdf(buffer, ext, { signal, timeoutMs = CONVERT_TIMEOUT_MS } = {}) {
  if (!OFFICE_EXTS.has(ext)) return Promise.reject(new Error(`Not an office file: ${ext}`));
  const soffice = findSoffice();
  if (!soffice) return Promise.reject(Object.assign(new Error('LibreOffice isn’t installed.'), { status: 503 }));
  return enqueue(() => convert(soffice, buffer, ext, { signal, timeoutMs }));
}

async function convert(soffice, buffer, ext, { signal, timeoutMs }) {
  if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-soffice-'));
  try {
    const profile = path.join(dir, 'profile');
    fs.mkdirSync(path.join(profile, 'user'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'user', 'registrymodifications.xcu'), PROFILE_XCU);
    const input = path.join(dir, `document.${ext}`);
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir);
    fs.writeFileSync(input, buffer);
    const args = [...(soffice.pre || []), `-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--invisible', '--nologo', '--nodefault',
      '--nofirststartwizard', '--nolockcheck', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, input];
    const blackhole = 'http://127.0.0.1:9';
    const env = { ...process.env, HTTP_PROXY: blackhole, HTTPS_PROXY: blackhole, http_proxy: blackhole, https_proxy: blackhole, NO_PROXY: '', no_proxy: '',
      ...(process.platform === 'linux' ? { SAL_USE_VCLPLUGIN: 'svp' } : {}) };
    await new Promise((resolve, reject) => {
      const child = spawn(soffice.path, args, { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
      let stderr = '', done = false;
      const finish = err => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); err ? reject(err) : resolve(); };
      const timer = setTimeout(() => { killTree(child); finish(Object.assign(new Error(`LibreOffice took longer than ${Math.round(timeoutMs / 1000)} s.`), { name: 'TimeoutError' })); }, timeoutMs);
      const onAbort = () => { killTree(child); finish(Object.assign(new Error('cancelled'), { name: 'AbortError' })); };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stderr.on('data', d => { if (stderr.length < 2000) stderr += d; });
      child.on('error', err => finish(new Error(`LibreOffice couldn’t start (${err.code || err.message}).`)));
      child.on('exit', code => finish(code === 0 ? null : new Error(`LibreOffice stopped with code ${code}${stderr.trim() ? `: ${stderr.trim().split('\n')[0].slice(0, 160)}` : ''}.`)));
    });
    const out = path.join(outDir, 'document.pdf');
    const pdf = fs.existsSync(out) ? fs.readFileSync(out) : null;
    if (!pdf || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('LibreOffice made no PDF of it.');
    return pdf;
  } finally {
    fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, () => {});
  }
}
