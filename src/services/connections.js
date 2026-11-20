// A person's own mail and calendar accounts (Phase 10, decisions #77/#78). Each is private to its owner — tools only ever
// use the speaker's connections. Passwords are sealed (lib/secrets.js) and never leave the server: views carry a masked
// hint only. Presets fill in the servers; everything else is "custom".
import { get, all, run } from '../db/index.js';
import { seal, unseal } from '../lib/secrets.js';
import { invalid, notFound } from '../lib/errors.js';
import { resolveTarget, outboundFetch } from '../lib/outbound.js';
import { isEmail } from '../lib/text-safe.js';

// App passwords: these providers refuse the normal password for IMAP/CalDAV once two-step sign-in is on (it always should be).
export const PRESETS = {
  gmail: { label: 'Gmail', email: { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
    calendar: null, help: 'Use an app password: Google Account → Security → 2-Step Verification → App passwords. (Google Calendar needs Google sign-in, which isn’t supported yet.)' },
  icloud: { label: 'iCloud', email: { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } },
    calendar: { url: 'https://caldav.icloud.com' }, help: 'Use an app-specific password: appleid.apple.com → Sign-In and Security → App-Specific Passwords.' },
  yahoo: { label: 'Yahoo', email: { imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true } },
    calendar: { url: 'https://caldav.calendar.yahoo.com' }, help: 'Use an app password: Yahoo Account Security → Generate app password.' },
  fastmail: { label: 'Fastmail', email: { imap: { host: 'imap.fastmail.com', port: 993, secure: true }, smtp: { host: 'smtp.fastmail.com', port: 465, secure: true } },
    calendar: { url: 'https://caldav.fastmail.com/dav/' }, help: 'Use an app password: Settings → Privacy & Security → Manage app passwords.' },
  nextcloud: { label: 'Nextcloud', email: null, calendar: { url: 'https://YOUR-SERVER/remote.php/dav' }, help: 'Use an app password: Settings → Security → Devices & sessions.' },
  custom: { label: 'Other', email: { imap: { host: '', port: 993, secure: true }, smtp: { host: '', port: 465, secure: true } }, calendar: { url: '' },
    help: 'Your provider’s IMAP/SMTP (mail) or CalDAV (calendar) settings.' },
};

const parse = c => ({ ...c, config: JSON.parse(c.config || '{}') });
export const connectionsOf = (user, kind) => all('SELECT * FROM connections WHERE user_id = ? AND kind = ? ORDER BY id', user.id, kind).map(parse);
export const hasConnection = (user, kind) => !!get('SELECT 1 FROM connections WHERE user_id = ? AND kind = ?', user.id, kind);

/** One of this person's connections (someone else's → not found). */
export function connectionFor(user, id) {
  const c = get('SELECT * FROM connections WHERE id = ? AND user_id = ?', Number(id), user.id);
  if (!c) throw notFound('That account isn’t connected any more.');
  return parse(c);
}

export const passwordOf = c => (c.secret ? unseal(c.secret) : '');

const port = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : d; };
const host = v => String(v || '').trim().toLowerCase();
const HOST_RE = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/** Validate a form into { label, provider, config, password }. Keeps the stored password when none is typed (edits). */
export function readForm(kind, body, existing = null) {
  const errors = {};
  const provider = PRESETS[body.provider] ? body.provider : 'custom';
  const username = String(body.username || '').trim();
  if (!username) errors.username = kind === 'email' ? 'Your email address or login.' : 'Your login.';
  const password = String(body.password || '');
  if (!password && !existing?.secret) errors.password = 'The (app) password for this account.';
  let config;
  if (kind === 'email') {
    const preset = PRESETS[provider].email || PRESETS.custom.email;
    const imapHost = host(body.imapHost || preset.imap.host), smtpHost = host(body.smtpHost || preset.smtp.host);
    if (!HOST_RE.test(imapHost)) errors.imapHost = 'The incoming (IMAP) server, e.g. imap.example.com.';
    if (!HOST_RE.test(smtpHost)) errors.smtpHost = 'The outgoing (SMTP) server, e.g. smtp.example.com.';
    const address = String(body.address || username).trim();
    if (!isEmail(address)) errors.address = 'The address your mail is sent from.';
    config = {
      address, username,
      imap: { host: imapHost, port: port(body.imapPort, preset.imap.port), secure: body.imapSecure == null ? preset.imap.secure : body.imapSecure === true || body.imapSecure === 'true' || body.imapSecure === 'on' },
      smtp: { host: smtpHost, port: port(body.smtpPort, preset.smtp.port), secure: body.smtpSecure == null ? preset.smtp.secure : body.smtpSecure === true || body.smtpSecure === 'true' || body.smtpSecure === 'on' },
      allowSelfSigned: body.allowSelfSigned === true || body.allowSelfSigned === 'on',
    };
  } else {
    const url = String(body.url || PRESETS[provider].calendar?.url || '').trim();
    try { if (!/^https?:$/.test(new URL(url).protocol) || /YOUR-SERVER/.test(url)) throw new Error(); } catch { errors.url = 'Your CalDAV address, e.g. https://cloud.example.com/remote.php/dav.'; }
    config = { url, username, allowSelfSigned: body.allowSelfSigned === true || body.allowSelfSigned === 'on', calendars: existing?.config?.calendars || null };
  }
  if (Object.keys(errors).length) throw invalid(errors);
  const label = String(body.label || '').trim().slice(0, 60) || `${PRESETS[provider].label} ${kind === 'email' ? 'mail' : 'calendar'}`;
  return { label, provider, config, password };
}

export function saveConnection(user, kind, { label, provider, config, password }, existing = null) {
  if (existing) {
    run(`UPDATE connections SET label = ?, provider = ?, config = ?, secret = COALESCE(?, secret), status = 'ok', last_error = NULL,
      last_ok_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, label, provider, JSON.stringify(config), password ? seal(password) : null, existing.id);
    return connectionFor(user, existing.id);
  }
  const { lastInsertRowid } = run(`INSERT INTO connections (user_id, kind, label, provider, config, secret, last_ok_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    user.id, kind, label, provider, JSON.stringify(config), seal(password));
  return connectionFor(user, Number(lastInsertRowid));
}

export const deleteConnection = (user, id) => run('DELETE FROM connections WHERE id = ? AND user_id = ?', Number(id), user.id).changes > 0;

export function markConnection(c, error = null) {
  run(`UPDATE connections SET status = ?, last_error = ?, last_ok_at = CASE WHEN ? THEN datetime('now') ELSE last_ok_at END WHERE id = ?`,
    error ? 'error' : 'ok', error ? String(error).slice(0, 300) : null, error ? 0 : 1, c.id);
}

/** For pages: never the password. */
export function connectionView(c) {
  return {
    id: c.id, kind: c.kind, label: c.label, provider: c.provider, providerLabel: PRESETS[c.provider]?.label || 'Other',
    status: c.status, error: c.last_error, lastOkAt: c.last_ok_at,
    address: c.config.address || null, username: c.config.username, url: c.config.url || null,
    imapHost: c.config.imap?.host, imapPort: c.config.imap?.port, imapSecure: c.config.imap?.secure,
    smtpHost: c.config.smtp?.host, smtpPort: c.config.smtp?.port, smtpSecure: c.config.smtp?.secure,
    allowSelfSigned: !!c.config.allowSelfSigned, calendars: c.config.calendars || null,
  };
}

/**
 * Mail/calendar servers must be on the public internet unless the admin allowed the local network (Admin → Browser —
 * the same switch the browser uses): someone's own settings must not become a way to probe this machine or the LAN.
 * Enforced where the connection is made (lib/outbound.js, decision #221): the host is resolved once, every answer is
 * checked, and the connection goes to that checked address (no second lookup for a changing DNS answer to slip into).
 * → { host: the checked address to connect to, servername: the name, for TLS }.
 */
export async function reachableTarget(host) {
  try { return await resolveTarget(host); } catch (err) { throw blockedServer(err); }
}

const blockedServer = err => (err?.code === 'EBLOCKED'
  ? Object.assign(new Error('That server is on this computer or the local network — only public servers are allowed (the admin can allow the local network in Admin → Browser).'), { status: 400, code: 'EBLOCKED' })
  : err);

/** fetch for a calendar server (tsdav): the same rule, every request and redirect. */
export const serverFetch = ({ allowSelfSigned = false } = {}) => async (input, init) => {
  try { return await outboundFetch(input, init, { rejectUnauthorized: !allowSelfSigned }); } catch (err) { throw blockedServer(err); }
};
