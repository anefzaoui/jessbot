// Admin → System (Phase 9): backups and the health check ("doctor").
//
// A backup is one .tar.gz in data/backups: a consistent snapshot of the database (VACUUM INTO, safe while running) named
// jessbot.sqlite, plus the files people made or saved — workspace (SOUL/AGENTS/MEMORY), users, library artifacts,
// uploads, blobs, feed covers/images, chat screenshots. Left out on purpose: browser profiles (sign-in cookies — a backup
// file must not carry them), caches (favicons), logs, the dev instance and older backups. Restore: `npm run restore`.
// Automatic: one a day (kept 7); pre-migration snapshots (made by db/index.js) are kept 10.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { inside } from '../lib/safe-path.js';
import { exec, get, all, migrationStatus } from '../db/index.js';
import { paths, config } from '../config/index.js';
import { llmSettings } from './llm.js';
import { browserStatus, recentBrowsing, browserSettings } from '../browser/index.js';
import { schedulerHealth } from '../agent/proactive.js';
import { errorCountSince } from '../lib/log.js';
import { skillsNeedingReview, brokenSkills, riskyActiveSkills } from './skills.js';
import { getTool, displayNameOf } from '../agent/tools/registry.js';
import { keySource, unsealData } from '../lib/secrets.js';
import { sealedValues } from './sealed-inventory.js';
import { officeRenderStatus } from './office-render.js';
import { spendSpike, balanceView } from './spend-watch.js';
import { botName } from './bot.js';

// What a backup holds; scripts/restore.js puts back the same list (keep them together). assistant: the admin's pictures (#7).
const INCLUDE = ['workspace', 'users', 'artifacts', 'uploads', 'blobs', 'feed', 'shots', 'voice', 'assistant'];
const KEEP = { auto: 7, manual: 20, 'pre-migrate': 10 };
const NAME = /^jessbot-(auto|manual)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.tar\.gz$/;
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const human = n => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

let running = null;
/** Make a full backup now. kind: manual | auto. Resolves to the backup's view. One at a time. */
export function createBackup(kind = 'manual') {
  if (running) return running;
  running = (async () => {
    fs.mkdirSync(paths.backups, { recursive: true });
    const stamp = stampNow();
    const snapshot = path.join(paths.backups, `.snapshot-${stamp}.sqlite`);
    const file = path.join(paths.backups, `jessbot-${kind}-${stamp}.tar.gz`);
    const tmp = `${file}.part`;
    try {
      exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      const entries = INCLUDE.filter(d => fs.existsSync(path.join(paths.data, d)));
      await tar.c({
        gzip: true, file: tmp, cwd: paths.data, portable: true,
        onWriteEntry(entry) { if (entry.path.endsWith(path.basename(snapshot))) entry.path = 'jessbot.sqlite'; },
      }, [path.relative(paths.data, snapshot).split(path.sep).join('/'), ...entries]);
      fs.renameSync(tmp, file); // only complete archives ever carry the real name
      pruneBackups();
      return backupView(path.basename(file));
    } finally {
      fs.rmSync(snapshot, { force: true });
      fs.rmSync(tmp, { force: true });
      running = null;
    }
  })();
  return running;
}

function backupView(name) {
  const full = path.join(paths.backups, name);
  const st = fs.statSync(full);
  const m = NAME.exec(name);
  const kind = m ? m[1] : name.startsWith('pre-migrate-') ? 'pre-migrate' : 'other';
  return { name, kind, size: st.size, sizeLabel: human(st.size), at: st.mtime.toISOString(), full: kind === 'auto' || kind === 'manual',
    kindLabel: { auto: 'Daily', manual: 'Made by hand', 'pre-migrate': 'Before an update (database only)' }[kind] || 'Other' };
}

export function listBackups() {
  if (!fs.existsSync(paths.backups)) return [];
  return fs.readdirSync(paths.backups).filter(n => NAME.test(n) || /^pre-migrate-.*\.sqlite$/.test(n))
    .map(backupView).sort((a, b) => b.at.localeCompare(a.at));
}

/** Keep the newest KEEP[kind] of each kind; stray temp files from a crash go too. */
export function pruneBackups() {
  if (!fs.existsSync(paths.backups)) return;
  for (const n of fs.readdirSync(paths.backups)) {
    if (/^(?:\.snapshot-.*|.*\.part)$/.test(n) && Date.now() - fs.statSync(path.join(paths.backups, n)).mtimeMs > 3600000) fs.rmSync(path.join(paths.backups, n), { force: true });
  }
  const byKind = {};
  for (const b of listBackups()) (byKind[b.kind] ||= []).push(b);
  for (const [kind, list] of Object.entries(byKind)) for (const b of list.slice(KEEP[kind] ?? 20)) fs.rmSync(path.join(paths.backups, b.name), { force: true });
}

/** A backup's file path, only for names we made (no path tricks). */
export function backupPath(name) {
  if (!(NAME.test(name) || /^pre-migrate-[\dT-]+\.sqlite$/.test(name))) return null;
  const file = inside(paths.backups, name);
  return file && fs.existsSync(file) ? file : null;
}

/** A daily backup when the last full one is a day old (checked at boot and hourly). */
export function startAutoBackup() {
  const check = () => {
    const last = listBackups().find(b => b.full);
    if (last && Date.now() - new Date(last.at).getTime() < 864e5) return;
    createBackup('auto').then(b => console.log(`[backup] daily backup ${b.name} (${b.sizeLabel})`))
      .catch(err => console.error('[backup] daily backup failed:', err.message));
  };
  setTimeout(check, 60000).unref(); // not during boot
  setInterval(check, 3600000).unref();
}

// ---- Health check ------------------------------------------------------------------------------------------------
const check = (id, label, status, detail, fix = null, href = null) => ({ id, label, status, detail, fix, href });

function dirSize(dir) {
  let n = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size; } catch { /* gone */ }
  return n;
}

/** Everything that must be true for Jessbot to work, each with what to do when it isn't. Never throws: a check that
 *  can't run says so (on a database whose updates aren't applied yet, the database check reports that). */
export function doctor({ cli = false } = {}) {
  const out = [];
  // Database
  let integrity = 'ok';
  try { integrity = get('PRAGMA quick_check').quick_check; } catch (err) { integrity = err.message; }
  const mig = migrationStatus();
  out.push(integrity === 'ok' && !mig.pending.length && !mig.modified.length
    ? check('db', 'Database', 'ok', `Healthy · ${mig.applied.length} migrations · ${human(fs.statSync(paths.db).size)}`)
    : check('db', 'Database', 'bad', integrity !== 'ok' ? `Integrity check: ${integrity}` : mig.pending.length ? `${mig.pending.length} update(s) not applied` : `Changed after applying: ${mig.modified.join(', ')}`,
      integrity !== 'ok' ? 'Restore the latest backup: npm run restore (with Jessbot stopped).' : mig.pending.length ? 'Start (or restart) Jessbot — it applies updates on start, after a backup.' : 'Put the edited update file back as it was; changes go in a new numbered migration.'));
  // Disk
  try {
    const s = fs.statfsSync(paths.data);
    const free = s.bavail * s.bsize;
    out.push(check('disk', 'Disk space', free < 500 * 1048576 ? 'bad' : free < 2 * 1073741824 ? 'warn' : 'ok',
      `${human(free)} free · data uses ${human(dirSize(paths.data))}`, free < 2 * 1073741824 ? 'Free up space on this drive, or move data/ to a bigger one (JESSBOT_HOME).' : null));
  } catch { out.push(check('disk', 'Disk space', 'warn', 'Couldn’t read free space on this system.')); }
  // Model
  const llm = llmSettings();
  out.push(llm.apiKey ? check('model', 'AI model', 'ok', `${llm.model}${llm.fallbacks.length ? ` · falls back to ${llm.fallbacks.join(', ')}` : ''}`, null, '/admin/model')
    : check('model', 'AI model', 'bad', `No API key — ${botName()} can’t think.`, 'Add an OpenRouter key in Admin → Model.', '/admin/model'));
  // The OpenRouter balance (decision #179), as last read by the spend watch (refreshed every few hours and from Admin → Usage).
  const bal = llm.apiKey ? balanceCheck() : null;
  if (bal) out.push(bal);
  // Browser
  const b = browserStatus();
  const recent = recentBrowsing().slice(0, 20);
  const failed = recent.filter(r => r.ok === false).length;
  out.push(!b.installed ? check('browser', 'Web browser', 'bad', 'Not installed — no web search, reading or feed.', 'Install it in Admin → Browser.', '/admin/browser')
    : recent.length >= 5 && failed / recent.length > 0.5 ? check('browser', 'Web browser', 'warn', `${failed} of the last ${recent.length} page loads failed`, 'Check the internet connection; see Admin → Browser for which sites.', '/admin/browser')
      : check('browser', 'Web browser', 'ok', `${b.engine.label} ${b.version || ''}${b.running ? ' · running' : ' · idle'}`, null, '/admin/browser'));
  // Office previews (decision #162): LibreOffice is optional, so its absence is information, never a problem.
  const office = officeRenderStatus();
  out.push(check('office', 'Office previews', 'ok', office.available
    ? `${office.detail}: Word, Excel and PowerPoint files get real page previews`
    : `${office.detail} (optional): Word, Excel and PowerPoint files are previewed from their content`));
  // Scheduler (wakes at least every minute) — only the running server can tell (not `npm run doctor`).
  if (!cli) {
  const { lastTickAt } = schedulerHealth();
  const since = lastTickAt ? Date.now() - new Date(lastTickAt).getTime() : Infinity;
  out.push(since < 5 * 60000 ? check('scheduler', 'Scheduler', 'ok', 'Alarms, reminders and scheduled tasks are on time')
    : check('scheduler', 'Scheduler', 'bad', lastTickAt ? `Last woke ${Math.round(since / 60000)} min ago` : 'Hasn’t started', 'Restart Jessbot; if it happens again, send the logs.'));
  }
  // Stuck work
  let stuck = 0;
  try { stuck = get(`SELECT COUNT(*) AS n FROM runs WHERE status = 'running' AND started_at < datetime('now', '-30 minutes')`).n; } catch { /* see the database check */ }
  out.push(stuck ? check('runs', 'Running tasks', 'warn', `${stuck} task(s) running for over 30 minutes`, 'Open them from Activity and press Stop if they’re stuck.')
    : check('runs', 'Running tasks', 'ok', 'Nothing stuck'));
  // Feed sources failing
  let badSources = 0, sources = 0;
  try {
    badSources = all(`SELECT url FROM feed_sources WHERE error_count >= 3`).length;
    sources = get('SELECT COUNT(*) AS n FROM feed_sources').n;
  } catch { /* see the database check */ }
  out.push(badSources ? check('feed', 'Feed sources', 'warn', `${badSources} of ${sources} source(s) keep failing`,
    'They back off on their own. Review or remove them in Admin → Feed sources.', '/admin/feed-sources')
    : check('feed', 'Feed sources', 'ok', sources ? `All ${sources} source${sources === 1 ? '' : 's'} answering` : 'No sources yet', null, '/admin/feed-sources'));
  // Errors (the running server's log)
  const errors = cli ? 0 : errorCountSince(new Date(Date.now() - 864e5).toISOString());
  if (!cli) out.push(errors ? check('errors', 'Errors (24 h)', errors > 20 ? 'bad' : 'warn', `${errors} server error(s) logged`, 'See the log below for what failed.', '#logs')
    : check('errors', 'Errors (24 h)', 'ok', 'None'));
  // Backups
  const last = listBackups().find(x => x.full);
  const age = last ? Date.now() - new Date(last.at).getTime() : Infinity;
  out.push(age < 2 * 864e5 ? check('backup', 'Backups', 'ok', `Last full backup ${age < 3600000 ? `${Math.max(1, Math.round(age / 60000))} min` : `${Math.round(age / 3600000)} h`} ago`, null, '#backups')
    : check('backup', 'Backups', 'warn', last ? `Last full backup ${Math.round(age / 864e5)} days ago` : 'No full backup yet', 'Press “Back up now”; daily backups start automatically.', '#backups'));
  // Skills changed on disk (an update) wait for the admin before Jess uses them again; broken ones can't be used at all.
  let review = 0, broken = [];
  try { review = skillsNeedingReview(); broken = brokenSkills(); } catch { /* reported by the database check (updates not applied yet) */ }
  if (review || broken.length) {
    out.push(check('skills', 'Skills', 'warn', [review ? `${review} skill${review === 1 ? '' : 's'} waiting for your review` : '',
      broken.length ? `broken: ${broken.map(b => `${b.name} (${b.problems[0]})`).join('; ')}` : ''].filter(Boolean).join(' · '),
    broken.length ? 'Fix the broken skill files (the reason is shown next to each in Admin → Skills).' : 'Read and approve them in Admin → Skills.', '/admin/skills'));
  }
  out.push(...securityChecks());
  // Exposure
  const exposed = !['127.0.0.1', 'localhost', '::1'].includes(config.host);
  out.push(exposed && !config.isProd ? check('exposure', 'Network', 'warn', `Listening on ${config.host} in development mode`, 'Use NODE_ENV=production behind HTTPS when reachable from other devices.')
    : check('exposure', 'Network', 'ok', exposed ? `Listening on ${config.host}` : 'Only this computer can reach it'));
  // Runtime
  const major = Number(process.versions.node.split('.')[0]);
  out.push(check('node', 'Runtime', major >= 24 ? 'ok' : 'bad', `Node ${process.versions.node} · ${os.platform()} ${os.arch()}`, major >= 24 ? null : 'Install Node 24 or newer.'));
  const worst = out.some(c => c.status === 'bad') ? 'bad' : out.some(c => c.status === 'warn') ? 'warn' : 'ok';
  return { status: worst, checks: out, checkedAt: new Date().toISOString(),
    summary: { ok: 'Everything looks healthy', warn: 'Working, with things to look at', bad: 'Something needs fixing' }[worst] };
}

// ---- Security checks (Phase 18, decision #121): standing risks an admin may have forgotten. Each one cites its evidence
// (the setting, the grants with who holds them, the skills and lines, the counts) and never throws.
const safely = (id, label, fn) => { try { return fn(); } catch (err) { return check(id, label, 'warn', `Couldn’t check: ${err.message}`); } };
const money = n => `$${n.toFixed(2)}`;

// Chromium's sandbox (#37): known only once the browser has started on this system.
function browserSandboxCheck() {
  const s = browserStatus().sandbox;
  if (s.on === true) return check('browser-sandbox', 'Browser sandbox', 'ok', 'On: pages run in Chromium’s sandbox', null, '/admin/browser');
  if (s.on === null) return check('browser-sandbox', 'Browser sandbox', 'ok', s.mode === 'off' ? 'Off (JESSBOT_BROWSER_SANDBOX=off); the browser hasn’t started yet' : 'Checked when the browser first starts', null, '/admin/browser');
  return check('browser-sandbox', 'Browser sandbox', 'warn', `Off: ${s.reason}`,
    s.mode === 'off' ? 'Remove JESSBOT_BROWSER_SANDBOX=off unless this system can’t run it.' : 'See docs/SECURITY-MODEL.md → Browser sandbox for what this system needs.', '/admin/browser');
}

export function securityChecks() {
  return [
    safely('local-network', 'Local network', () => (browserSettings().allowPrivate
      ? check('local-network', 'Local network', 'warn', 'Allowed: web pages, the browser, mail, calendar and push can reach devices on this network (Admin → Browser → Local network is on)',
        'Turn it off unless a service you use lives on your own network.', '/admin/browser')
      : check('local-network', 'Local network', 'ok', `Blocked: nothing ${botName()} opens can reach devices on this network`, null, '/admin/browser'))),
    safely('browser-sandbox', 'Browser sandbox', browserSandboxCheck),
    safely('grants', 'Always-allowed actions', alwaysAllowCheck),
    safely('secret-key', 'Password key', secretKeyCheck),
    safely('skill-lint', 'Skill warnings', () => {
      const risky = riskyActiveSkills();
      return risky.length
        ? check('skill-lint', 'Skill warnings', 'warn', risky.map(r => `${r.name}: ${r.bad.length} serious (line ${r.bad[0].line}${r.bad[0].file ? ` of ${r.bad[0].file}` : ''}: ${r.bad[0].message})`).join('; '),
          'Read them in Admin → Skills; turn off any you don’t trust.', '/admin/skills')
        : check('skill-lint', 'Skill warnings', 'ok', 'No active skill has a serious warning', null, '/admin/skills');
    }),
    safely('injection', 'Hidden instructions', () => {
      const rows = all(`SELECT detail FROM audit_log WHERE action = 'injection_suspected' AND at >= datetime('now', '-7 days') ORDER BY id DESC`);
      if (!rows.length) return check('injection', 'Hidden instructions', 'ok', 'None found in pages or email in the last 7 days');
      const bySource = {};
      let latest = null;
      for (const r of rows) {
        let d = {};
        try { d = JSON.parse(r.detail || '{}') || {}; } catch { /* metadata only */ }
        bySource[d.source || 'other'] = (bySource[d.source || 'other'] || 0) + 1;
        latest ||= d.host || d.sender || null;
      }
      return check('injection', 'Hidden instructions', 'warn',
        `${rows.length} suspected in the last 7 days (${Object.entries(bySource).map(([k, n]) => `${k} ${n}`).join(', ')})${latest ? `; latest from ${latest}` : ''}`,
        `${botName()} treated them as information, not instructions. If one keeps coming from the same sender or site, stop using it; the audit log has each one.`);
    }),
    safely('spend', 'Spending', () => spendSpikeCheck()),
  ];
}

// Person-wide "always allow" grants on tools that reach other people or spend money: an old yes that still stands.
// The risk comes from the approval that created the grant (what was asked), else from the tool's fixed risk.
function alwaysAllowCheck() {
  const rows = all(`SELECT g.id, g.user_id, g.tool, u.name AS person, c.name AS by_name,
      (SELECT a.risk FROM approvals a WHERE a.user_id = g.user_id AND a.tool = g.tool AND a.scope = 'always' AND a.status = 'approved' ORDER BY a.id DESC LIMIT 1) AS risk
    FROM approval_grants g JOIN users u ON u.id = g.user_id LEFT JOIN users c ON c.id = g.created_by
    WHERE g.run_id IS NULL ORDER BY g.id`);
  const fixedRisk = name => (typeof getTool(name)?.risk === 'string' ? getTool(name).risk : null);
  const risky = rows.map(r => ({ ...r, risk: r.risk || fixedRisk(r.tool) })).filter(r => r.risk === 'external' || r.risk === 'spend');
  if (!risky.length) {
    return check('grants', 'Always-allowed actions', 'ok', rows.length ? `${rows.length} standing permission${rows.length === 1 ? '' : 's'}, none that send or spend` : 'Nothing that sends or spends runs without asking');
  }
  const who = r => `${r.person}: always allow “${displayNameOf(r.tool)}”${r.by_name && r.by_name !== r.person ? ` (granted by ${r.by_name})` : ''}`;
  return check('grants', 'Always-allowed actions', 'warn', risky.map(who).join('; '),
    `${risky.some(r => r.risk === 'spend') ? 'These can spend money or reach' : 'These reach'} other people or sites without asking first. Revoke any you don’t need on the person’s page in Admin → People.`,
    `/admin/people/${risky[0].user_id}`);
}

// Everything sealed (mail and calendar passwords, two-step seeds, the model and push keys, browser sign-ins:
// services/sealed-inventory.js) needs the install's key (lib/secrets.js, #10). Without it (an install moved without its
// .env or key file) nothing sealed opens, and the next save would quietly make a new key. One of each kind is opened.
function secretKeyCheck() {
  const src = keySource();
  const values = sealedValues();
  const n = values.length;
  const where = src.source === 'file' ? `JESSBOT_SECRET_FILE (${src.path})` : 'JESSBOT_SECRET in .env';
  const fix = 'Put back the key from the install that sealed them (its .env or key file; JESSBOT_SECRET_PREVIOUS also works). '
    + 'Otherwise reconnect the mail and calendar accounts and enter the model key again.';
  if (src.source === 'none' && !n) return check('secret-key', 'Password key', 'ok', 'Nothing sealed yet; the key is made in .env with the first secret');
  if (!src.valid) {
    return check('secret-key', 'Password key', 'bad', src.source === 'none'
      ? `JESSBOT_SECRET is missing from .env, but ${n} saved secret${n === 1 ? ' is' : 's are'} sealed with it`
      : `${where} isn’t a valid key (it must be 32 bytes, base64)${src.error ? `: ${src.error}` : ''}`, fix);
  }
  const kinds = [...new Set(values.map(v => v.kind))];
  const failed = kinds.filter(kind => { try { unsealData(values.find(v => v.kind === kind).read()); return false; } catch { return true; } });
  if (failed.length) return check('secret-key', 'Password key', 'bad', `The key (${where}) doesn’t open: ${failed.join(', ')}`, fix);
  return check('secret-key', 'Password key', 'ok', n ? `Opens the ${n} sealed value${n === 1 ? '' : 's'} (${kinds.join(', ')}); key from ${where}` : `Set (${where})`);
}

// A day that cost more than 3× the median of the 14 days before it, and over $0.25: something looping, or a new habit.
// Checked for today and yesterday (UTC days, like usage_events); needs a week of history first. The same measure pushes the
// admins at over $0.50 (services/spend-watch.js).
export function spendSpikeCheck(now = new Date()) {
  for (const [offset, label] of [[0, 'Today'], [1, 'Yesterday']]) {
    const s = spendSpike(now, { offset, floor: 0.25 });
    if (s) {
      return check('spend', 'Spending', 'warn', `${label}: ${money(s.spent)}, ${s.median > 0 ? `${(s.spent / s.median).toFixed(1)}× ` : 'far above '}the 14-day median (${money(s.median)} a day)`,
        'See Admin → Usage for which person and task it was.', '/admin/usage');
    }
  }
  const today = get(`SELECT COALESCE(SUM(cost), 0) AS c FROM usage_events WHERE date(at) = ?`, now.toISOString().slice(0, 10)).c;
  return check('spend', 'Spending', 'ok', `Today ${money(today)} · no unusual day`, null, '/admin/usage');
}

// "Balance $23.67 ≈ 12 days": a warning under a week, or when the provider counts clearly more than was recorded here.
function balanceCheck() {
  const b = balanceView();
  if (!b?.label) return null;
  if (b.warn) return check('balance', 'Model credits', 'warn', `${b.label} at the recent pace`, 'Top up the OpenRouter account before it runs out.', '/admin/usage');
  if (b.gap) return check('balance', 'Model credits', 'warn', `${b.label} · ${b.gap}`, 'Check whether another app or install uses this key; each should have its own.', '/admin/usage');
  return check('balance', 'Model credits', 'ok', b.label, null, '/admin/usage');
}

export function aboutSystem() {
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(paths.root, 'package.json'), 'utf8')).version; } catch { /* dev */ }
  let commit = null;
  try {
    const head = fs.readFileSync(path.join(paths.root, '.git'), 'utf8'); // a worktree's .git is a file pointing at its gitdir
    const gitdir = /gitdir: (.*)/.exec(head)?.[1]?.trim();
    commit = gitdir ? fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim().slice(0, 8) : null;
  } catch {
    try {
      const ref = fs.readFileSync(path.join(paths.root, '.git', 'HEAD'), 'utf8').trim();
      commit = ref.startsWith('ref: ') ? fs.readFileSync(path.join(paths.root, '.git', ref.slice(5)), 'utf8').trim().slice(0, 8) : ref.slice(0, 8);
    } catch { /* not a git checkout */ }
  }
  return { version, commit, node: process.versions.node, uptime: Math.round(process.uptime()), dataDir: paths.data, host: config.host, port: config.port };
}
