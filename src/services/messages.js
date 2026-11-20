// Messages: stored forever; large tool output is offloaded to a content-addressed blob with a restorable stub
// (docs/CONTEXT-AND-MEMORY.md). Full-text search over the person's own conversation history.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { get, all, run, tx } from '../db/index.js';
import { paths } from '../config/index.js';
import { countTokens } from '../lib/tokens.js';
import { ftsAny } from '../lib/fts.js';
import { validTimezone, dayKey, dayLabel } from '../lib/when.js';
import { invalid } from '../lib/errors.js';
import { settleNudge } from './reply-actions.js';
import { botName } from './bot.js';
import { writeNew } from '../lib/safe-path.js';

export const OFFLOAD_OVER = Number(process.env.JESSBOT_OFFLOAD_TOKENS) || 2000;
const BLOBS = path.join(paths.data, 'blobs');

function offload(content, toolName, args) {
  fs.mkdirSync(BLOBS, { recursive: true });
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  const file = path.join(BLOBS, `${sha}.txt`);
  writeNew(file, content);
  const head = content.slice(0, 600), tail = content.length > 1200 ? content.slice(-600) : '';
  const stub = `[Stored output of ${toolName}${args ? ` ${args}` : ''} — ${content.length} chars, ref ${sha.slice(0, 16)}. `
    + `Use read_offloaded("${sha.slice(0, 16)}") for the full text.]\n${head}${tail ? `\n…\n${tail}` : ''}`;
  return { ref: sha, stub };
}

/**
 * A stored tool output, by the ref (or its first 8+ characters) shown in its stub — only one stored from this person's own
 * chats: blobs are shared by content across the install, and a ref read off a page or an email must not open someone
 * else's result. → { text, total, outside } | null. outside: the result was fenced outside content, so a part that starts
 * past its opening tag still needs saying so.
 */
export function readOffloaded(refPrefix, { start = 0, length = 20000, userId = null } = {}) {
  if (!/^[a-f0-9]{8,64}$/.test(String(refPrefix)) || userId == null) return null;
  const row = get(`SELECT m.offloaded_ref AS ref FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.user_id = ? AND m.offloaded_ref LIKE ? LIMIT 1`, Number(userId), `${refPrefix}%`);
  const file = row && /^[a-f0-9]{64}$/.test(row.ref) ? path.join(BLOBS, `${row.ref}.txt`) : null;
  if (!file || !fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  return { text: text.slice(start, start + length), total: text.length, outside: / fence="[0-9a-f]{12}">/.test(text) };
}

export function addMessage({ threadId, runId = null, role, content = '', toolCalls = null, toolCallId = null, toolName = null,
  toolArgs = null, clientId = null, model, attachments = null }) {
  // A final reply ending with follow-up questions: noted for the chat, or taken out in the main chat within a day of the last
  // ones (#196, services/reply-actions.js).
  const text = role === 'assistant' && !toolCalls ? settleNudge(threadId, String(content ?? '')) : String(content ?? '');
  // Attached files count toward the context too (their text / an image ≈ 1,000 tokens); prompt.js decides how much goes in.
  let tokens = countTokens(text, model) + (attachments?.length || 0) * 1000, stub = null, ref = null;
  if (role === 'tool' && tokens > OFFLOAD_OVER) {
    ({ ref, stub } = offload(text, toolName, toolArgs));
    tokens = countTokens(stub, model);
  }
  const { lastInsertRowid } = run(
    `INSERT INTO messages (thread_id, run_id, role, content, tool_calls, tool_call_id, tool_name, token_count, stub, offloaded_ref, client_id, attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    threadId, runId, role, text, toolCalls ? JSON.stringify(toolCalls) : null, toolCallId, toolName, tokens, stub, ref, clientId,
    attachments?.length ? JSON.stringify(attachments) : null);
  return getMessage(Number(lastInsertRowid));
}

export const getMessage = id => get('SELECT * FROM messages WHERE id = ?', id) || null;
export const findByClientId = (threadId, clientId) => clientId ? get('SELECT * FROM messages WHERE thread_id = ? AND client_id = ?', threadId, clientId) : null;

export function updateMessage(id, { content }) {
  run('UPDATE messages SET content = ?, token_count = ? WHERE id = ?', content, countTokens(content), id);
}

// Visible chat history (user + assistant), newest page first; `before` = message id cursor.
export function history(threadId, { before = null, limit = 60 } = {}) {
  const rows = all(`SELECT * FROM messages WHERE thread_id = ? AND role IN ('user', 'assistant') ${before ? 'AND id < ?' : ''}
    ORDER BY id DESC LIMIT ?`, ...(before ? [threadId, before, limit] : [threadId, limit]));
  return rows.reverse();
}

// Model-facing turns after an anchor (compaction boundary), tool results as stubs when offloaded.
export const turnsAfter = (threadId, afterId = 0) =>
  all('SELECT * FROM messages WHERE thread_id = ? AND id > ? AND compacted_into IS NULL ORDER BY id', threadId, afterId);

// ---- Searching their history (decision #155) ------------------------------------------------------------
// search_history: BM25 over this person's own threads only (scope enforced here, never by the model), optionally within
// dates in their timezone; or, with dates and no words, a day-by-day digest. Only what they and Jess said (the index holds
// user and assistant messages, never tool output).
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const sqlTime = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
// How far `tz` is ahead of UTC at the instant `ms` (DST-aware), in ms.
function offsetAt(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) - ms;
}
// Local midnight of YYYY-MM-DD in tz → UTC ms (twice round, so a day that starts a DST change lands right).
function localMidnight(ymd, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) t = Date.UTC(y, m - 1, d) - offsetAt(t, tz);
  return t;
}
/** Their local dates from–to (inclusive) → UTC bounds in the messages table's format { lo, hi } (hi exclusive). Throws. */
export function dayRange(from, to, tz) {
  const zone = validTimezone(tz) ? tz : 'UTC';
  let a = String(from || to || '').trim(), b = String(to || from || '').trim();
  const ok = x => YMD.test(x) && !Number.isNaN(Date.parse(`${x}T00:00:00Z`)) && new Date(`${x}T00:00:00Z`).toISOString().startsWith(x);
  if (!ok(a) || !ok(b)) throw invalid({ from: 'Dates look like 2026-09-22.' });
  if (a > b) [a, b] = [b, a];
  const next = new Date(`${b}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  return { lo: sqlTime(localMidnight(a, zone)), hi: sqlTime(localMidnight(next.toISOString().slice(0, 10), zone)), from: a, to: b };
}

const clip = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x; };
const neighbour = (threadId, id, dir) => get(`SELECT role, content FROM messages WHERE thread_id = ? AND id ${dir === 'before' ? '<' : '>'} ?
  AND role IN ('user', 'assistant') AND tool_calls IS NULL AND trim(content) != '' ORDER BY id ${dir === 'before' ? 'DESC' : 'ASC'} LIMIT 1`, threadId, id);

/**
 * Matches for `query` in their own chats (any of the words, prefix terms), best first; within their local dates
 * `from`–`to` when given. With `context`, each hit carries the message just before and after it (clipped).
 * `opts` may be a number (the limit), as before.
 */
export function searchHistory(userId, query, opts = {}) {
  const { limit = 5, from = null, to = null, tz = 'UTC', context = false } = typeof opts === 'number' ? { limit: opts } : opts;
  const q = ftsAny(query);
  if (!q) return [];
  const range = from || to ? dayRange(from, to, tz) : null;
  const rows = all(`SELECT m.id, m.thread_id, m.role, m.created_at, snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet,
              COALESCE(t.title, CASE t.kind WHEN 'main' THEN 'Main chat' ELSE 'a chat' END) AS thread_title
              FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN threads t ON t.id = m.thread_id
              WHERE messages_fts MATCH ? AND t.user_id = ? AND t.deleted_at IS NULL ${range ? 'AND m.created_at >= ? AND m.created_at < ?' : ''}
              ORDER BY bm25(messages_fts) LIMIT ?`, q, userId, ...(range ? [range.lo, range.hi] : []), limit);
  if (!context) return rows;
  return rows.map(r => {
    const b = neighbour(r.thread_id, r.id, 'before'), a = neighbour(r.thread_id, r.id, 'after');
    return { ...r, before: b ? { role: b.role, text: clip(b.content, 200) } : null, after: a ? { role: a.role, text: clip(a.content, 200) } : null };
  });
}

/**
 * "What did we talk about last Tuesday?": their local days from–to, each with what happened (message count, which chats,
 * what Jess did from the activity log, the day's episode notes) and the start (~100 characters) of their messages. At most
 * `maxLines` lines in all; later days are left out with a note when the range is too long. → { lines, days }
 */
export function dayDigest(userId, { from, to, tz = 'UTC', maxLines = 40 } = {}) {
  const zone = validTimezone(tz) ? tz : 'UTC';
  const range = dayRange(from, to, zone);
  const msgs = all(`SELECT m.id, m.role, m.content, m.created_at, m.thread_id,
      COALESCE(t.title, CASE t.kind WHEN 'main' THEN 'Main chat' ELSE 'a chat' END) AS thread_title
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE t.user_id = ? AND t.deleted_at IS NULL AND m.role IN ('user', 'assistant') AND m.tool_calls IS NULL AND trim(m.content) != ''
      AND m.created_at >= ? AND m.created_at < ? ORDER BY m.id LIMIT 3000`, userId, range.lo, range.hi);
  const acts = all(`SELECT title, at FROM activity_log WHERE user_id = ? AND at >= ? AND at < ? ORDER BY id`, userId, range.lo, range.hi);
  const eps = all(`SELECT e.text, e.ref_date, e.observed_at FROM episodes e JOIN scopes s ON s.id = e.scope_id AND s.kind = 'user' AND s.ref_id = ?
    WHERE (e.ref_date BETWEEN ? AND ?) AND (e.thread_id IS NULL OR e.thread_id IN (SELECT id FROM threads WHERE deleted_at IS NULL)) ORDER BY e.id`,
  userId, range.from, range.to);
  const iso = s => `${String(s).replace(' ', 'T')}Z`;
  const days = new Map();
  const day = k => { if (!days.has(k)) days.set(k, { day: k, messages: [], threads: new Set(), activity: [], notes: [] }); return days.get(k); };
  for (const m of msgs) { const d = day(dayKey(iso(m.created_at), zone)); d.messages.push(m); d.threads.add(m.thread_title); }
  for (const a of acts) day(dayKey(iso(a.at), zone)).activity.push(a.title);
  for (const e of eps) day(e.ref_date).notes.push(e.text);
  const list = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const lines = [];
  const time = s => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso(s)));
  const perDay = Math.max(1, Math.floor((maxLines - list.length) / Math.max(1, list.length)));
  let shown = 0;
  for (const d of list) {
    if (lines.length >= maxLines) break;
    shown++;
    const label = dayLabel(`${d.day}T12:00:00Z`, 'UTC', new Date(`${dayKey(new Date(), zone)}T12:00:00Z`));
    const acts = [...new Set(d.activity)];
    lines.push(`${d.day} (${label}): ${d.messages.length} message${d.messages.length === 1 ? '' : 's'}`
      + `${d.threads.size ? ` in ${[...d.threads].slice(0, 3).map(t => `“${clip(t, 40)}”`).join(', ')}${d.threads.size > 3 ? ` and ${d.threads.size - 3} more` : ''}` : ''}`
      + `${acts.length ? `; ${botName()}: ${acts.slice(0, 3).map(a => clip(a, 60)).join(', ')}${acts.length > 3 ? ` (+${acts.length - 3})` : ''}` : ''}`);
    const detail = [...d.notes.map(n => `  Noted: ${clip(n, 200)}`),
      // Their own words say best what the day was about; Jess's replies only when they said nothing (a briefing day).
      ...(d.messages.some(m => m.role === 'user') ? d.messages.filter(m => m.role === 'user') : d.messages)
        .map(m => `  - ${time(m.created_at)} ${m.role === 'user' ? 'Them' : botName()}: ${clip(m.content, 100)}`)];
    for (const l of detail.slice(0, perDay)) { if (lines.length >= maxLines) break; lines.push(l); }
  }
  if (shown < list.length) lines.push(`(${list.length - shown} more day${list.length - shown === 1 ? '' : 's'} not shown: ask for fewer days)`);
  return { lines, days: list.map(d => ({ day: d.day, messages: d.messages.length, threads: [...d.threads], activity: d.activity.length, notes: d.notes })) };
}

// ---- Deleting messages (decision #50) --------------------------------------------------------------------
// Deleting is real: the exchange leaves the screen, the database, search, the event log, the activity feed and the
// model's context; summaries that included it are dropped (rebuilt later without it); memories learned from it are
// forgotten when the person asks. Owners only — admins can read (oversight) but never rewrite someone's history.

/** What deleting message `id` would remove: a user message takes its replies along; a reply goes alone. */
export function deletionPlan(user, id) {
  const m = get(`SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id
                 WHERE m.id = ? AND t.user_id = ? AND m.role IN ('user', 'assistant')`, Number(id), user.id);
  if (!m) return null;
  let runIds;
  if (m.role === 'user') runIds = all('SELECT id FROM runs WHERE trigger_message_id = ?', m.id).map(r => r.id);
  else runIds = m.run_id ? [m.run_id] : [];
  const byRuns = runIds.length ? all(`SELECT id FROM messages WHERE run_id IN (${runIds.map(() => '?').join(',')})`, ...runIds).map(r => r.id) : [];
  // Replies Jess started on her own hang off a hidden system message: it goes with them.
  const hiddenTriggers = m.role === 'assistant' && runIds.length
    ? all(`SELECT m.id FROM runs r JOIN messages m ON m.id = r.trigger_message_id WHERE r.id = ? AND m.role = 'system'`, runIds[0]).map(r => r.id) : [];
  const messageIds = [...new Set([m.id, ...byRuns, ...hiddenTriggers])];
  const memories = all(`SELECT id, text FROM memories WHERE status = 'active' AND source_message_id IN (${messageIds.map(() => '?').join(',')})`, ...messageIds);
  return { message: m, threadId: m.thread_id, messageIds, runIds, memories, replies: m.role === 'user' ? runIds.length : 0 };
}

export function deleteMessages(plan) {
  const { threadId, messageIds, runIds } = plan;
  const q = ids => ids.map(() => '?').join(',');
  const lo = Math.min(...messageIds), hi = Math.max(...messageIds);
  const blobs = all(`SELECT DISTINCT offloaded_ref FROM messages WHERE id IN (${q(messageIds)}) AND offloaded_ref IS NOT NULL`, ...messageIds).map(r => r.offloaded_ref);
  // Voice notes of these messages (theirs and her spoken replies) go with them — rows and WAV files.
  const clips = all(`SELECT id, user_id, public_id FROM voice_clips WHERE message_id IN (${q(messageIds)})`, ...messageIds);
  tx(() => {
    // Summaries that covered any of these messages: gone, their messages un-compacted (re-summarised later without it).
    const sums = all('SELECT id FROM thread_summaries WHERE thread_id = ? AND from_msg_id <= ? AND to_msg_id >= ?', threadId, hi, lo).map(r => r.id);
    if (sums.length) {
      run(`UPDATE messages SET compacted_into = NULL WHERE compacted_into IN (${q(sums)})`, ...sums);
      run(`UPDATE threads SET active_summary_id = NULL WHERE id = ? AND active_summary_id IN (${q(sums)})`, threadId, ...sums);
      run(`DELETE FROM thread_summaries WHERE id IN (${q(sums)})`, ...sums);
    }
    if (clips.length) run(`DELETE FROM voice_clips WHERE id IN (${q(clips)})`, ...clips.map(c => c.id));
    // Episodes that covered any of these messages go too (their vectors cascade); the next extraction pass writes afresh.
    run('DELETE FROM episodes WHERE thread_id = ? AND from_msg_id <= ? AND to_msg_id >= ?', threadId, hi, lo);
    run(`DELETE FROM messages WHERE id IN (${q(messageIds)})`, ...messageIds); // FTS rows go via trigger
    if (runIds.length) {
      run(`DELETE FROM events WHERE run_id IN (${q(runIds)})`, ...runIds);
      run(`DELETE FROM activity_log WHERE run_id IN (${q(runIds)})`, ...runIds);
      run(`DELETE FROM runs WHERE id IN (${q(runIds)})`, ...runIds); // questions + approvals cascade
    }
  });
  for (const c of clips) fs.rmSync(path.join(paths.voice, String(c.user_id), `${c.public_id}.wav`), { force: true });
  for (const ref of blobs) {
    if (!get('SELECT 1 FROM messages WHERE offloaded_ref = ?', ref)) fs.rmSync(path.join(BLOBS, `${ref}.txt`), { force: true });
  }
}
