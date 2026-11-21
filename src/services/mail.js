// Email over IMAP/SMTP (Phase 10, decision #78): imapflow reads, mailparser parses, nodemailer sends. Every call opens a
// short connection with the person's own account and closes it (no long-lived sockets per person). Mail content is
// untrusted: tools fence it like web pages. Nothing is marked read or moved unless asked (email_organize, #157), and
// nothing is ever deleted: there is no expunge anywhere in here.
import TurndownService from 'turndown';
import { parseHTML } from 'linkedom';
import { passwordOf, markConnection, reachableTarget } from './connections.js';
import { pruneHiddenDocument } from '../lib/hidden-text.js';
import { lazy } from '../lib/lazy.js';

// The mail libraries load with the first mail action, not when the server starts (decision #256).
const imapflow = lazy(() => import('imapflow'));
const mailparser = lazy(() => import('mailparser'));
const nodemailerLib = lazy(() => import('nodemailer').then(m => m.default));

const TIMEOUT = 25000;
const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
td.remove(['style', 'script', 'head']);

// Both connect to the address that was checked, with the server's name kept for TLS (decision #221): a DNS answer that
// changes after the check can't move the connection onto this machine or the local network.
async function imapFor(c) {
  const { host, servername } = await reachableTarget(c.config.imap.host);
  const { ImapFlow } = await imapflow();
  return new ImapFlow({
    host, servername, port: c.config.imap.port, secure: c.config.imap.secure,
    auth: { user: c.config.username, pass: passwordOf(c) }, logger: false,
    tls: { rejectUnauthorized: !c.config.allowSelfSigned }, connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: 60000,
  });
}

const friendly = err => {
  const m = String(err?.responseText || err?.response || err?.message || err);
  if (err?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|auth|535|534/i.test(m)) return 'The mail server refused the username or password (many providers need an app password).';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'That mail server name doesn’t exist.';
  if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(m)) return 'Couldn’t reach the mail server (check the server and port).';
  if (/self.signed|certificate/i.test(m)) return 'The mail server’s certificate isn’t trusted.';
  return m.split('\n')[0].slice(0, 200);
};

/** Run fn(client) on a fresh IMAP session; the connection's status reflects the outcome. */
async function withImap(c, fn) {
  let client;
  try {
    client = await imapFor(c);
    client.on('error', () => {}); // surfaced through the awaited calls below
    await client.connect();
    const out = await fn(client);
    markConnection(c);
    return out;
  } catch (err) {
    if (err.code === 'EBLOCKED') throw err;
    const msg = friendly(err);
    markConnection(c, msg);
    throw Object.assign(new Error(msg), { status: 400 });
  } finally {
    await client?.logout().catch(() => client.close?.());
  }
}

/** Both directions work: IMAP login and SMTP handshake. Throws a friendly error. */
export async function testMail(c) {
  await withImap(c, async client => client.mailboxOpen('INBOX', { readOnly: true }));
  const t = await transportFor(c, 'Receiving works, but sending doesn’t: ');
  try { await t.verify(); } catch (err) { throw Object.assign(new Error(`Receiving works, but sending doesn’t: ${friendly(err)}`), { status: 400 }); } finally { t.close(); }
}

const addr = a => (a?.value || a || []).map?.(x => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ') || '';
const envAddr = list => (list || []).map(x => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ');

/** Folders with their special use (\Inbox, \Sent, \Drafts, \Trash, \Junk). */
export const listFolders = c => withImap(c, async client => (await client.list()).map(f => ({ path: f.path, name: f.name, use: f.specialUse || null })));

/**
 * Recent messages, newest first. q: { folder, unread, from, subject, text, since (ISO), limit }.
 * Each: { uid, folder, from, to, subject, date, unread, flagged, hasAttachments }.
 */
export function listMail(c, q = {}) {
  const folder = q.folder || 'INBOX';
  const limit = Math.max(1, Math.min(30, Number(q.limit) || 12));
  return withImap(c, async client => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const criteria = {};
      if (q.unread) criteria.seen = false;
      if (q.from) criteria.from = String(q.from);
      if (q.subject) criteria.subject = String(q.subject);
      if (q.text) criteria.body = String(q.text);
      if (q.since) { const d = new Date(q.since); if (!Number.isNaN(d.getTime())) criteria.since = d; }
      const uids = (await client.search(Object.keys(criteria).length ? criteria : { all: true }, { uid: true })) || [];
      const pick = uids.sort((a, b) => b - a).slice(0, limit);
      if (!pick.length) return [];
      const out = [];
      for await (const m of client.fetch(pick, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true }, { uid: true })) {
        const hasAttachments = JSON.stringify(m.bodyStructure || {}).includes('"disposition":"attachment"');
        out.push({ uid: m.uid, folder, from: envAddr(m.envelope?.from), to: envAddr(m.envelope?.to), subject: m.envelope?.subject || '(no subject)',
          date: (m.envelope?.date || m.internalDate)?.toISOString?.() || null, unread: !m.flags?.has('\\Seen'), flagged: m.flags?.has('\\Flagged') || false,
          hasAttachments, messageId: m.envelope?.messageId || null });
      }
      return out.sort((a, b) => b.uid - a.uid);
    } finally { lock.release(); }
  });
}

// ---- What the reader actually sees (decision #118) --------------------------------------------------------------------
// Mail clients show the HTML part. Text hidden in it (display:none, font-size 0, white on white, mso-hide:all, zero-height
// boxes) is removed before it becomes markdown; the plain-text part is used only while it says the same thing — when it
// carries words the reader never sees (a classic place for instructions aimed at an AI), the visible HTML text wins.
const WORD = /[\p{L}\p{N}]{3,}/gu;
const wordsOf = s => (String(s || '').toLowerCase().match(WORD) || []);
const PLAIN_EXTRA_WORDS = 12, PLAIN_EXTRA_SHARE = 0.25;

/**
 * { text, html } of a message → { text, hidden: { removed, chars, sample } | null, note: string | null }. hidden.sample
 * also carries the plain-text lines the reader can't see, so the injection check reads them.
 */
export function visibleMailText({ text: plain, html }) {
  const p = String(plain || '').trim();
  if (!html) return { text: p, hidden: null, note: null };
  const { document } = parseHTML(/<html[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`);
  const pruned = pruneHiddenDocument(document, { email: true });
  const visible = td.turndown(document.body?.innerHTML || document.documentElement?.outerHTML || '').trim();
  const hidden = { removed: pruned.removed, chars: pruned.chars, sample: pruned.sample };
  if (!p) return { text: visible, hidden, note: null };
  const seen = new Set(wordsOf(visible));
  const plainWords = wordsOf(p);
  const missing = plainWords.filter(w => !seen.has(w));
  const hiddenWords = wordsOf(pruned.sample);
  const hiddenInPlain = hiddenWords.length >= 3 && hiddenWords.filter(w => plainWords.includes(w) && !seen.has(w)).length >= hiddenWords.length / 2;
  const differs = (missing.length >= PLAIN_EXTRA_WORDS && missing.length / Math.max(1, plainWords.length) > PLAIN_EXTRA_SHARE) || hiddenInPlain;
  // The plain part says the same: it is what Jess reads, so nothing was left out — but what the formatted version hid is
  // still screened (hiding text from the reader is the tell).
  if (!differs) return { text: p, hidden: { removed: 0, chars: 0, sample: pruned.sample }, note: null };
  // The plain part's own lines that the reader never sees go to the injection check as hidden text.
  const unseenLines = p.split('\n').filter(line => { const w = wordsOf(line); return w.length && w.filter(x => !seen.has(x)).length / w.length > 0.5; });
  return {
    text: visible,
    hidden: { removed: hidden.removed + (unseenLines.length ? 1 : 0), chars: hidden.chars, sample: [hidden.sample, ...unseenLines].filter(Boolean).join('\n').slice(0, 2000) },
    note: '(This email’s plain-text version says things its formatted version doesn’t show; this is the version the reader sees.)',
  };
}

/** The parsed message (mailparser) for a uid, read-only: nothing is marked read. */
function parsedMail(c, uid, folder) {
  return withImap(c, async client => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg?.source) throw Object.assign(new Error('That message isn’t there any more.'), { status: 404 });
      return (await mailparser()).simpleParser(msg.source);
    } finally { lock.release(); }
  });
}

// A message's files, numbered from 1 in the order the message carries them (email_read shows the same numbers).
// inline: a picture shown inside the message body (a logo, a signature image), not something attached to keep.
const attachmentsOf = p => (p.attachments || []).map((a, i) => ({
  index: i + 1, filename: a.filename || `attachment-${i + 1}`, contentType: a.contentType, size: a.size ?? a.content?.length ?? 0,
  inline: !!(a.related || (a.contentDisposition === 'inline' && a.cid)),
}));

/** One message in full: headers, the text a reader sees (see visibleMailText), its files (numbered). Doesn't mark it read. */
export async function readMail(c, uid, folder = 'INBOX') {
  const p = await parsedMail(c, uid, folder);
  const seen = visibleMailText({ text: p.text, html: p.html || null });
  return {
    uid: Number(uid), folder, from: addr(p.from), to: addr(p.to), cc: addr(p.cc), subject: p.subject || '(no subject)',
    date: p.date?.toISOString() || null, messageId: p.messageId || null, references: [].concat(p.references || []),
    text: seen.text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 60000), hidden: seen.hidden, textNote: seen.note,
    attachments: attachmentsOf(p),
  };
}

/**
 * A message's files with their bytes, for saving to the Library (email_save_attachments, decision #157).
 * → { uid, folder, from, subject, attachments: [{ index, filename, contentType, size, inline, content: Buffer }] }.
 */
export async function mailAttachments(c, uid, folder = 'INBOX') {
  const p = await parsedMail(c, uid, folder);
  const listed = attachmentsOf(p);
  return { uid: Number(uid), folder, from: addr(p.from), subject: p.subject || '(no subject)',
    attachments: listed.map((a, i) => ({ ...a, content: p.attachments[i].content })) };
}

/**
 * List-Unsubscribe (RFC 2369) and List-Unsubscribe-Post (RFC 8058) header values → { urls: [https…], mailto: [{ address,
 * subject, body }], oneClick }. Only web and mail addresses are kept (a javascript: or data: entry is dropped).
 */
export function parseListUnsubscribe(value, post = '') {
  const urls = [], mailto = [];
  for (const [, raw] of String(value || '').replace(/\r?\n[ \t]+/g, ' ').matchAll(/<\s*([^>\s]+)\s*>/g)) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    if (u.protocol === 'https:' || u.protocol === 'http:') urls.push(u.href);
    else if (u.protocol === 'mailto:') {
      const address = decodeURIComponent(u.pathname || '').trim();
      if (address) mailto.push({ address, subject: u.searchParams.get('subject') || null, body: u.searchParams.get('body') || null });
    }
  }
  return { urls, mailto, oneClick: /List-Unsubscribe=One-Click/i.test(String(post || '')) && urls.some(x => x.startsWith('https:')) };
}

/** How to leave a mailing list, from one message's headers: parseListUnsubscribe() + { uid, folder, from, subject }. */
export function unsubscribeInfo(c, uid, folder = 'INBOX') {
  return withImap(c, async client => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, headers: ['list-unsubscribe', 'list-unsubscribe-post'] }, { uid: true });
      if (!msg) throw Object.assign(new Error('That message isn’t there any more.'), { status: 404 });
      const h = String(msg.headers || '').replace(/\r?\n[ \t]+/g, ' ');
      const field = name => (new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(h)?.[1] || '');
      return { uid: Number(uid), folder, from: envAddr(msg.envelope?.from), subject: msg.envelope?.subject || '(no subject)',
        ...parseListUnsubscribe(field('List-Unsubscribe'), field('List-Unsubscribe-Post')) };
    } finally { lock.release(); }
  });
}

// ---- Tidying (email_organize, decision #157) -------------------------------------------------------------------------------
export const ORGANIZE_ACTIONS = ['mark_read', 'mark_unread', 'flag', 'unflag', 'archive', 'move'];
const FLAG_OF = { mark_read: ['\\Seen', true], mark_unread: ['\\Seen', false], flag: ['\\Flagged', true], unflag: ['\\Flagged', false] };
// Folder words people use for the special folders (servers that don't mark them get matched by name).
const USE_WORDS = { '\\Trash': /^(trash|bin|deleted( items| messages)?|corbeille|papierkorb|papelera|cestino|المهملات|المحذوفات)$/i,
  '\\Junk': /^(junk|spam|junk e-?mail|bulk mail|courrier indésirable|indésirables|البريد المزعج)$/i, '\\Archive': /^(archives?|archiv|archivio|الأرشيف)$/i,
  '\\Sent': /^(sent|sent items|sent messages|sent mail|envoyés)$/i, '\\Drafts': /^(drafts?|brouillons)$/i, '\\Inbox': /^inbox$/i, '\\All': /^all mail$/i };
/** A folder name that reads as the bin or spam: moving there asks first even before the server's folders are known. */
export const looksLikeBin = name => { const n = String(name || '').split(/[/.]/).pop().trim(); return USE_WORDS['\\Trash'].test(n) || USE_WORDS['\\Junk'].test(n); };

/** The server's folder for what someone typed ("Receipts", "trash", "[Gmail]/Spam") → { path, use } | null. */
function findFolder(folders, wanted) {
  const w = String(wanted || '').trim().toLowerCase();
  if (!w) return null;
  const hit = folders.find(f => f.path.toLowerCase() === w) || folders.find(f => f.name.toLowerCase() === w)
    || folders.find(f => f.specialUse && USE_WORDS[f.specialUse]?.test(w));
  return hit ? { path: hit.path, use: hit.specialUse || null } : null;
}

/** Where "archive" goes: the folder marked \Archive, Gmail's All Mail (archiving there = leaving the inbox), or "Archive". */
async function archiveFolder(client, c) {
  const folders = await client.list();
  const marked = folders.find(f => f.specialUse === '\\Archive');
  const gmailAll = folders.find(f => f.specialUse === '\\All');
  if (c.provider === 'gmail' && gmailAll) return gmailAll.path;
  if (marked) return marked.path;
  const named = folders.find(f => USE_WORDS['\\Archive'].test(f.name));
  if (named) return named.path;
  if (gmailAll) return gmailAll.path;
  await client.mailboxCreate('Archive').catch(() => {});
  return 'Archive';
}

/** The special use of the folder a move would go to ('\\Trash', '\\Junk', …, or null) — for the approval gate. */
export const folderUse = (c, wanted) => withImap(c, async client => findFolder(await client.list(), wanted)?.use || null);

/**
 * Mark, flag, archive or move messages (uids in `folder`). Never deletes: there is no expunge here. → { action, done: [uid],
 * missing: [uid], destination?, destinationUse?, moved?: [{ from, to }] (new uids in the destination, when the server says) }.
 */
export function organizeMail(c, { uids, folder = 'INBOX', action, toFolder = null }) {
  if (!ORGANIZE_ACTIONS.includes(action)) throw Object.assign(new Error(`Unknown action “${action}”.`), { status: 400 });
  const wanted = [...new Set((uids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!wanted.length) throw Object.assign(new Error('Which messages? Give their uids from email_list.'), { status: 400 });
  return withImap(c, async client => {
    let destination = null, destinationUse = null;
    if (action === 'move') {
      const folders = await client.list();
      const hit = findFolder(folders, toFolder);
      if (!hit) {
        const names = folders.map(f => f.path).slice(0, 40).join(', ');
        throw Object.assign(new Error(`There’s no folder called “${toFolder}”. Folders: ${names}.`), { status: 400 });
      }
      ({ path: destination, use: destinationUse } = hit);
    } else if (action === 'archive') { destination = await archiveFolder(client, c); destinationUse = '\\Archive'; }
    if (destination && destination.toLowerCase() === String(folder).toLowerCase()) {
      throw Object.assign(new Error(`Those messages are already in ${destination}.`), { status: 400 });
    }
    const lock = await client.getMailboxLock(folder);
    try {
      const present = (await client.search({ uid: wanted.join(',') }, { uid: true })) || [];
      const done = wanted.filter(u => present.includes(u));
      const missing = wanted.filter(u => !present.includes(u));
      const out = { action, done, missing, folder };
      if (!done.length) return out;
      const range = done.join(',');
      if (FLAG_OF[action]) {
        const [flag, on] = FLAG_OF[action];
        await (on ? client.messageFlagsAdd(range, [flag], { uid: true }) : client.messageFlagsRemove(range, [flag], { uid: true }));
        return out;
      }
      const res = await client.messageMove(range, destination, { uid: true });
      const moved = res?.uidMap ? [...res.uidMap].map(([from, to]) => ({ from: Number(from), to: Number(to) })) : [];
      return { ...out, destination, destinationUse, moved };
    } finally { lock.release(); }
  });
}

async function transportFor(c, prefix = '') {
  let target;
  try { target = await reachableTarget(c.config.smtp.host); } catch (err) {
    if (err.code === 'EBLOCKED') throw err;
    throw Object.assign(new Error(`${prefix}${friendly(err)}`), { status: 400 });
  }
  const nodemailer = await nodemailerLib();
  return nodemailer.createTransport({
    host: target.host, servername: target.servername, port: c.config.smtp.port, secure: c.config.smtp.secure,
    auth: { user: c.config.username, pass: passwordOf(c) }, tls: { rejectUnauthorized: !c.config.allowSelfSigned },
    connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: 60000,
  });
}

/**
 * Send (after the person approved it). m: { to, cc?, bcc?, subject, text, inReplyTo?, references?, attachments?: [{ filename,
 * content: Buffer, contentType }] } from their address with their name. A copy (files included) goes to their Sent folder
 * (Gmail files its own).
 */
export async function sendMail(c, m, { fromName }) {
  const t = await transportFor(c, 'Couldn’t send: ');
  const mail = { from: { name: fromName, address: c.config.address }, to: m.to, cc: m.cc || undefined, bcc: m.bcc || undefined,
    subject: m.subject, text: m.text, inReplyTo: m.inReplyTo || undefined, references: m.references || undefined,
    attachments: m.attachments?.length ? m.attachments.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType })) : undefined };
  let info;
  try { info = await t.sendMail(mail); } catch (err) {
    const msg = friendly(err);
    markConnection(c, msg);
    throw Object.assign(new Error(`Couldn’t send: ${msg}`), { status: 400 });
  } finally { t.close(); }
  markConnection(c);
  if (c.provider !== 'gmail') {
    try {
      const nodemailer = await nodemailerLib();
      const raw = await new Promise((resolve, reject) => nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
        .sendMail({ ...mail, messageId: info.messageId, date: new Date() }, (e, r) => (e ? reject(e) : resolve(r.message))));
      await withImap(c, async client => {
        const folders = await client.list();
        let sent = folders.find(f => f.specialUse === '\\Sent')?.path || folders.find(f => /^(sent|sent items|sent messages|sent mail)$/i.test(f.name))?.path;
        if (!sent) { sent = 'Sent'; await client.mailboxCreate(sent).catch(() => {}); }
        await client.append(sent, raw, ['\\Seen']);
      });
    } catch (err) { console.warn('[mail] saved to Sent failed:', err.message); }
  }
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}
