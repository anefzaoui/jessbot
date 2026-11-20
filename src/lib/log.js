// Server log (Phase 9): everything the server prints — console.log/info/warn/error from any module — is kept in a ring
// buffer for Admin → System → Logs and appended to data/logs/jessbot-YYYY-MM-DD.log (kept LOG_DAYS days). Secrets that
// might slip into a message or stack (API keys, bearer tokens, session cookies, passwords in URLs) are redacted first.
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { redactSecrets } from './dlp.js';

const MAX_LINES = 2000;
const LOG_DAYS = 14;
const ring = [];
let dir = null, seq = 0;

const REDACT = [
  [/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-…redacted'],
  [/\bcb_[A-Za-z0-9_-]{8,}/g, 'cb_…redacted'],
  [/\b(Bearer|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 …redacted'],
  [/\b(jb_sid|jb_session|sid)=[^;\s]+/gi, '$1=…redacted'],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1…redacted@'],
  [/("?(?:password|passphrase|api_?key|secret|token)"?\s*[:=]\s*)"[^"]*"/gi, '$1"…redacted"'],
];
// …and the exact values this install must never let out (the model key, the password key, the push key, every saved
// password once sealed or unsealed: lib/dlp.js), whatever shape they are in.
export const redact = s => redactSecrets(REDACT.reduce((t, [re, to]) => t.replace(re, to), String(s)));

const today = () => new Date().toISOString().slice(0, 10);
const fileFor = day => path.join(dir, `jessbot-${day}.log`);

function write(level, args) {
  const text = redact(args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, breakLength: 140 }))).join(' '));
  const entry = { seq: ++seq, at: new Date().toISOString(), level, text };
  ring.push(entry);
  if (ring.length > MAX_LINES) ring.splice(0, ring.length - MAX_LINES);
  if (dir) {
    try { fs.appendFileSync(fileFor(entry.at.slice(0, 10)), `${entry.at} ${level.toUpperCase().padEnd(5)} ${text}\n`); }
    catch { /* a full disk must not take the server down with it */ }
  }
  return entry;
}

function prune() {
  if (!dir) return;
  const cutoff = new Date(Date.now() - LOG_DAYS * 864e5).toISOString().slice(0, 10);
  for (const f of fs.readdirSync(dir)) {
    const m = /^jessbot-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
    if (m && m[1] < cutoff) fs.rmSync(path.join(dir, f), { force: true });
  }
}

/** Route console.* through the log; call once at boot, before anything else prints. */
export function installLog(logDir) {
  dir = logDir;
  fs.mkdirSync(dir, { recursive: true });
  prune();
  setInterval(prune, 864e5).unref();
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error'], ['debug', 'debug']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => { write(level, args); original(...args); };
  }
  // A forgotten await somewhere shouldn't take everyone's chats down: record it and keep serving.
  process.on('unhandledRejection', err => console.error('[process] unhandled rejection:', err));
  process.on('uncaughtException', err => { console.error('[process] uncaught exception — exiting:', err); process.exitCode = 1; setTimeout(() => process.exit(1), 200); });
}

/** Recent lines, newest last. level: minimum (info < warn < error); q: text filter; after: only lines after this seq. */
export function recentLog({ level = 'info', q = '', after = 0, limit = 500 } = {}) {
  const rank = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = rank[level] ?? 1;
  const needle = String(q || '').toLowerCase();
  return ring.filter(e => e.seq > after && rank[e.level] >= min && (!needle || e.text.toLowerCase().includes(needle))).slice(-limit);
}

export const logFiles = () => (dir ? fs.readdirSync(dir).filter(f => /^jessbot-.*\.log$/.test(f)).sort().reverse()
  .map(f => ({ name: f, size: fs.statSync(path.join(dir, f)).size })) : []);
export const logFilePath = name => (dir && /^jessbot-\d{4}-\d{2}-\d{2}\.log$/.test(name) ? path.join(dir, name) : null);
export const errorCountSince = sinceIso => ring.filter(e => e.level === 'error' && e.at >= sinceIso).length;
export { today as logDay };
