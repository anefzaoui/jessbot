// Email files ↔ the Library (Phase 22 part E, decision #157).
//  In:  a message's attachments become Library items, typed from their own bytes and read like uploads (services/uploads.js
//       sniff, then storeFile: the same allow-list, so a renamed program or an archive is never kept), labelled "From email:
//       “<subject>”" (library.js origin 'email'). Their content is outside content: library_read fences it like any download.
//  Out: Library items the person owns go out with email_send, capped, listed on the approval card, and never carrying one
//       of this install's secrets (lib/dlp.js).
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { detectMimeType } from 'nodemailer/lib/mime-funcs';
import { get } from '../db/index.js';
import { sniff, storeFile } from './uploads.js';
import { itemForUser, itemView, readBytes, readText, sizeLabel, DOWNLOADED_FROM, FROM_EMAIL } from './library.js';
import { secretsIn, shapeFlags } from '../lib/dlp.js';
import { oneLine } from '../lib/untrusted.js';
import { audit } from './audit.js';

export const ATTACHMENT_SAVE_MAX_BYTES = 15 * 1048576;  // per file saved from an email
export const SEND_MAX_FILES = 5;
export const SEND_MAX_BYTES = 20 * 1048576;             // all files on one email (most providers refuse ~25 MB after encoding)
const SAVE_MAX_FILES = 20;                              // per call
const bad = msg => Object.assign(new Error(msg), { status: 400 });

// Programs and archives by name and declared type (used when the bytes themselves say nothing file-type knows).
const PROGRAM = /\.(exe|msi|bat|cmd|com|scr|pif|ps1|psm1|vbs|vbe|js|jse|mjs|wsf|wsh|hta|jar|apk|app|dmg|pkg|deb|rpm|sh|bash|run|bin|dll|sys|lnk|reg|iso|img|xlsm|docm|pptm)$/i;
const ARCHIVE = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|cab|arj|lz|lzh|zst)$/i;
const PROGRAM_TYPE = /(x-msdownload|x-dosexec|x-executable|x-elf|x-mach-binary|x-msi|x-ms-installer|javascript|x-sh|java-archive|vnd\.android|macroenabled|x-ms-shortcut)/i;
const ARCHIVE_TYPE = /(zip|compressed|x-rar|x-7z|x-tar|gzip|x-bzip|x-xz|zstd|vnd\.ms-cab)/i;
/** Why a file the allow-list refused is left behind: from what its bytes are (file-type), else its name and declared type. */
async function skipReason(a) {
  const found = await fileTypeFromBuffer(a.content).catch(() => null);
  const renamed = found && path.extname(a.filename).slice(1).toLowerCase() !== found.ext ? ` (named “${oneLine(a.filename, 60)}”, but it is really a .${found.ext} file)` : '';
  if (PROGRAM_TYPE.test(found?.mime || '') || (!found && (PROGRAM.test(a.filename) || PROGRAM_TYPE.test(a.contentType || '')))) {
    return `a program or a file with macros${renamed}: never kept`;
  }
  if (ARCHIVE_TYPE.test(found?.mime || '') || (!found && (ARCHIVE.test(a.filename) || ARCHIVE_TYPE.test(a.contentType || '')))) {
    return `an archive (.zip and similar)${renamed}: not opened or kept`;
  }
  return `a kind of file I can’t keep${renamed} (I take PDFs, images, Word / Excel / PowerPoint files and plain text)`;
}

/** "From email: “Invoice 12”": where these files came from (library originOf reads it as 'email': an outside file like a download). */
export const emailSourceLabel = subject => `${FROM_EMAIL}“${oneLine(subject || 'no subject', 60)}”`.slice(0, 80);
// The label email files had before the email origin (decision #157): still recognised, so saving them again finds them.
const legacyEmailLabel = subject => `${DOWNLOADED_FROM}an email: “${oneLine(subject || 'no subject', 50)}”`.slice(0, 80);
const titleOf = name => path.basename(String(name || 'file'), path.extname(String(name || ''))).replace(/[_]+/g, ' ').trim().slice(0, 120) || 'Email attachment';


/**
 * Which of a message's files to save. pick: { names?: [filename], indexes?: [number] } (either or both); none given → every
 * file that isn't a picture inside the message body (logos, signature images). → { chosen, unknown: [asked-for not found] }.
 */
export function chooseAttachments(list, { names = null, indexes = null } = {}) {
  const wantNames = (names || []).map(n => String(n).trim().toLowerCase()).filter(Boolean);
  const wantIdx = (indexes || []).map(Number).filter(Number.isInteger);
  if (!wantNames.length && !wantIdx.length) return { chosen: list.filter(a => !a.inline), unknown: [] };
  const chosen = list.filter(a => wantIdx.includes(a.index) || wantNames.includes(a.filename.toLowerCase()));
  const unknown = [...wantNames.filter(n => !list.some(a => a.filename.toLowerCase() === n)), ...wantIdx.filter(i => !list.some(a => a.index === i)).map(i => `#${i}`)];
  return { chosen, unknown };
}

/**
 * Save a message's files into this person's Library. msg: services/mail.js mailAttachments(). Each allowed file ≤ 15 MB
 * becomes an item (the same file from the same email saved again is found, not copied). → { saved: [{ index, filename,
 * item: itemView, again }], skipped: [{ index, filename, why }], unknown }.
 */
export async function saveMailAttachments(user, msg, { names = null, indexes = null, threadId = null, runId = null } = {}) {
  const { chosen, unknown } = chooseAttachments(msg.attachments, { names, indexes });
  if (chosen.length > SAVE_MAX_FILES) throw bad(`That message has ${chosen.length} files; save at most ${SAVE_MAX_FILES} at a time (pick them by name or number).`);
  const sourceLabel = emailSourceLabel(msg.subject);
  const saved = [], skipped = [];
  for (const a of chosen) {
    const buffer = a.content;
    if (!buffer?.length) { skipped.push({ index: a.index, filename: a.filename, why: 'empty' }); continue; }
    if (buffer.length > ATTACHMENT_SAVE_MAX_BYTES) {
      skipped.push({ index: a.index, filename: a.filename, why: `${sizeLabel(buffer.length)}: over the ${sizeLabel(ATTACHMENT_SAVE_MAX_BYTES)} limit for email files` });
      continue;
    }
    const kind = await sniff(buffer, a.filename);
    if (!kind) { skipped.push({ index: a.index, filename: a.filename, why: await skipReason(a) }); continue; }
    const title = titleOf(a.filename);
    const again = get(`SELECT * FROM library_items WHERE owner_id = ? AND source_label IN (?, ?) AND title = ? AND size_bytes = ? AND ext = ? AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`, user.id, sourceLabel, legacyEmailLabel(msg.subject), title, buffer.length, kind.ext);
    if (again) { saved.push({ index: a.index, filename: a.filename, item: itemView(again), again: true }); continue; }
    const item = await storeFile(user, { buffer, name: a.filename, title }, { threadId, runId, sourceLabel, kind });
    saved.push({ index: a.index, filename: a.filename, item, again: false });
  }
  return { saved, skipped, unknown };
}

// ---- Out: files on email_send ----------------------------------------------------------------------------------------------
const bare = id => String(id || '').trim().replace(/^\/?library\//, '').replace(/[/?#].*$/, '');
const fileName = item => {
  const base = String(item.title).normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'file';
  return base.toLowerCase().endsWith(`.${item.ext}`) ? base : `${base}.${item.ext}`;
};
// The type mail apps expect for the file's extension (a .txt is text/plain), else the Library's own (a .md, a .srt).
const contentTypeOf = item => {
  const byName = detectMimeType(fileName(item));
  return byName && byName !== 'application/octet-stream' ? byName : String(item.mime || 'application/octet-stream').split(';')[0].trim();
};
const KIND = { pdf: 'PDF', image: 'Image', doc: 'Word document', sheet: 'Spreadsheet', slides: 'Slides', md: 'Document', html: 'Web page', audio: 'Audio' };

/**
 * The files for one email, checked: at most 5, 20 MB together, each the person's own Library item (another person's, a
 * removed one or an unknown id is refused, admins included), none carrying a registered secret (audited like a blocked
 * call, metadata only). → [{ id, title, filename, contentType, size, content: Buffer }]. Throws a 400 saying which.
 */
export function filesForEmail(user, ids, { runId = null } = {}) {
  const list = [...new Set((ids || []).map(bare).filter(Boolean))];
  if (!list.length) return [];
  if (list.length > SEND_MAX_FILES) throw bad(`At most ${SEND_MAX_FILES} files on one email (${list.length} given): send the rest in another.`);
  const files = list.map(id => {
    let item;
    try { item = itemForUser(user, id, { write: true }); } catch { throw bad(`“${id}” isn’t a file in ${user.firstName || 'their'}’s Library, so it can’t be attached.`); }
    return { item, content: readBytes(item) };
  });
  const total = files.reduce((n, f) => n + f.content.length, 0);
  if (total > SEND_MAX_BYTES) throw bad(`Those files come to ${sizeLabel(total)}; one email can carry at most ${sizeLabel(SEND_MAX_BYTES)}. Send fewer, or share a link.`);
  for (const { item } of files) {
    const leaked = secretsIn(`${item.title}\n${readText(item)}`);
    if (leaked.length) {
      audit('secret_blocked', { actorId: user.id, targetType: 'run', targetId: runId, detail: { tool: 'email_send', secret: leaked.join(', '), file: item.public_id } });
      throw bad(`Blocked: “${item.title}” contains ${leaked.join(' and ')}, which must never leave this app. Nothing was sent.`);
    }
  }
  return files.map(({ item, content }) => ({ id: item.public_id, title: item.title, filename: fileName(item), contentType: contentTypeOf(item), size: content.length, content }));
}

/**
 * The approval card's lines for the files (decision #127: the card is what they approve): title, kind and size of each, and
 * anything secret-looking inside (a card number, a password line), masked by the card itself. Unknown or removed ids say so.
 * The approval preview has no person attached, so ownership is checked when it runs (filesForEmail) — see decision #157.
 */
export function filesPreview(ids) {
  const list = [...new Set((ids || []).map(bare).filter(Boolean))];
  if (!list.length) return '';
  let total = 0;
  const lines = list.map(id => {
    const item = get('SELECT * FROM library_items WHERE public_id = ?', id);
    if (!item || item.deleted_at) return `- ${id}: not in the Library (the email won’t be sent)`;
    total += item.size_bytes || 0;
    const flags = shapeFlags(readText(item)).map(f => `${f.label} ${f.masked}`);
    return `- “${oneLine(item.title, 100)}” · ${KIND[item.type] || item.ext} (.${item.ext}) · ${sizeLabel(item.size_bytes || 0)}${flags.length ? `\n  Contains ${flags.join(', ')}` : ''}`;
  });
  const over = list.length > SEND_MAX_FILES ? ` (over the limit of ${SEND_MAX_FILES}: it won’t be sent)` : total > SEND_MAX_BYTES ? ` (over ${sizeLabel(SEND_MAX_BYTES)}: it won’t be sent)` : '';
  return `Attached: ${list.length} file${list.length === 1 ? '' : 's'}, ${sizeLabel(total)}${over}\n${lines.join('\n')}`;
}

/**
 * The same files as the approval card's "Attached" fact (decision #194): [{ title, meta, href }], one per id. Only the
 * requester's own items are named and linked (someone else's, or a removed one, says it won't be sent: filesForEmail refuses
 * it when the call runs).
 */
export function filesFacts(ids, user = null) {
  const list = [...new Set((ids || []).map(bare).filter(Boolean))];
  return list.map(id => {
    const item = get('SELECT * FROM library_items WHERE public_id = ?', id);
    if (!item || item.deleted_at) return { title: `${id}: not in the Library`, meta: 'the email won’t be sent' };
    if (user && item.owner_id !== user.id) return { title: 'A file that isn’t yours', meta: 'the email won’t be sent' };
    return { title: oneLine(item.title, 100), meta: `${KIND[item.type] || item.ext} · ${sizeLabel(item.size_bytes || 0)}`, href: `/library/${item.public_id}` };
  });
}
