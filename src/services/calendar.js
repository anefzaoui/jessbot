// Calendars over CalDAV (Phase 10, decision #79): tsdav talks to the server, ical.js reads and writes iCalendar.
// Events from now−1 day to +60 days are kept in calendar_events (refreshed every 15 min, right after a change, and when
// an account is added), so the prompt's "coming up" and the Upcoming page never wait on a server. Recurring events are
// expanded into their occurrences (exceptions honoured); times are stored as UTC and shown in the person's time zone.
// Free time (decision #158) is computed here in plain code (freeSlotsBetween), never by the model; household members' busy
// times are shared only with their consent, as times only (#159).
import crypto from 'node:crypto';
import { DAVClient } from 'tsdav';
import ICAL from 'ical.js';
import { get, all, run, tx } from '../db/index.js';
import { passwordOf, markConnection, connectionsOf, assertReachable } from './connections.js';
import { audit } from './audit.js';
import { tzOf } from '../lib/when.js';
import { oneLine } from '../lib/untrusted.js';

const EVENT_FIELD_MAX = 120; // characters of a title or place in the prompt and on Upcoming

const WINDOW_BACK_MS = 864e5;
const WINDOW_AHEAD_MS = 60 * 864e5;

async function clientFor(c) {
  await assertReachable(c.config.url);
  const client = new DAVClient({ serverUrl: c.config.url, credentials: { username: c.config.username, password: passwordOf(c) },
    authMethod: 'Basic', defaultAccountType: 'caldav' });
  await client.login();
  return client;
}

const friendly = err => {
  const m = String(err?.message || err);
  if (/401|403|Unauthorized|Forbidden/i.test(m)) return 'The calendar server refused the username or password (many providers need an app password).';
  if (/ENOTFOUND|EAI_AGAIN|fetch failed/i.test(m)) return 'Couldn’t reach that calendar server (check the address).';
  if (/cannot find homeUrl|no calendar|principal/i.test(m)) return 'That address doesn’t look like a CalDAV server — check the URL.';
  return m.split('\n')[0].slice(0, 200);
};
const wrap = async (c, fn) => {
  try { const out = await fn(); markConnection(c); return out; } catch (err) {
    const msg = err.status && err.expose !== false && err.message && !/fetch failed/.test(err.message) && err.status < 500 ? err.message : friendly(err);
    markConnection(c, msg);
    throw Object.assign(new Error(msg), { status: err.status && err.status < 500 ? err.status : 400 });
  }
};

/** Event calendars on the account: [{ url, name, color }]. */
export const listCalendars = c => wrap(c, async () => {
  const client = await clientFor(c);
  return (await client.fetchCalendars()).filter(cal => !cal.components || cal.components.includes('VEVENT'))
    .map(cal => ({ url: cal.url, name: typeof cal.displayName === 'string' ? cal.displayName : 'Calendar', color: cal.calendarColor || null }));
});

// ---- iCalendar → occurrences -------------------------------------------------------------------------------------
/** How far a zone's wall clock is ahead of UTC at one instant, in ms. */
function offsetAt(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * Wall-clock parts in a time zone → the UTC instant (floating times, local times people type, free-slot windows). Two
 * passes: the offset is the one in force at the answer, not at the first guess, so times near a clock change come out
 * right. A time that doesn't exist (skipped by a spring-forward) lands on the far side of the gap.
 */
export function zonedToUtc(t, tz) {
  const guess = Date.UTC(t.year, t.month - 1, t.day, t.hour || 0, t.minute || 0, t.second || 0);
  const first = guess - offsetAt(guess, tz);
  return new Date(guess - offsetAt(first, tz));
}

/**
 * What a person typed → Date. "2026-10-02T14:30" or "2026-10-02 14:30" = their local time in `tz`; with Z or an offset
 * it is that instant; a date alone is midnight of that day in `tz`. Anything else → null.
 */
export function parseWhen(value, tz) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h = '0', mi = '0', se = '0'] = m.slice(1);
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 24 || +mi > 59 || +se > 59) return null;
  return zonedToUtc({ year: +y, month: +mo, day: +d, hour: +h, minute: +mi, second: +se }, tz);
}
// An all-day date is midnight of that day in the person's zone. ICAL.Time keeps its parts behind getters, so they are
// read one by one (spreading the object copied none of them, and every all-day event failed to sync as "unreadable").
const toUtc = (time, tz) => (time.isDate ? zonedToUtc({ year: time.year, month: time.month, day: time.day, hour: 0, minute: 0, second: 0 }, tz)
  : time.zone && time.zone.tzid && time.zone.tzid !== 'floating' ? time.toJSDate() : zonedToUtc(time, tz));

/**
 * Does this event take up time? Not when it is marked free (TRANSP:TRANSPARENT, "show as free") or cancelled. An all-day
 * event with no TRANSP counts as busy (calendar apps mark birthdays and holidays free themselves).
 */
const busyOf = vevent => {
  const transp = String(vevent?.getFirstPropertyValue('transp') || '').toUpperCase();
  const status = String(vevent?.getFirstPropertyValue('status') || '').toUpperCase();
  return transp === 'TRANSPARENT' || status === 'CANCELLED' ? 0 : 1;
};

/**
 * Occurrences of the events in one calendar object between from and to. A CalDAV object holds one event (one UID, with
 * its moved or changed occurrences); an .ics file may hold many: each UID is expanded on its own.
 */
export function occurrences(ics, from, to, tz = 'UTC') {
  const comp = new ICAL.Component(ICAL.parse(ics));
  for (const vtz of comp.getAllSubcomponents('vtimezone')) { try { ICAL.TimezoneService.register(vtz); } catch { /* duplicate */ } }
  const byUid = new Map();
  for (const v of comp.getAllSubcomponents('vevent')) {
    const uid = String(v.getFirstPropertyValue('uid') || '');
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(v);
  }
  return [...byUid.values()].flatMap(vevents => eventOccurrences(vevents, from, to, tz));
}

function eventOccurrences(vevents, from, to, tz) {
  const master = vevents.find(v => !v.hasProperty('recurrence-id')) || vevents[0];
  const event = new ICAL.Event(master);
  for (const ex of vevents.filter(v => v.hasProperty('recurrence-id'))) event.relateException(ex);
  const base = { uid: event.uid, title: event.summary || '(no title)', location: event.location || null, description: event.description || null };
  const out = [];
  const push = (start, end, allDay, recurring, details = event) => out.push({ ...base, title: details.summary || base.title, location: details.location || base.location,
    starts_at: toUtc(start, tz).toISOString(), ends_at: end ? toUtc(end, tz).toISOString() : null, all_day: allDay ? 1 : 0, recurring: recurring ? 1 : 0,
    busy: busyOf(details.component || master) });
  if (!event.isRecurring()) {
    const s = toUtc(event.startDate, tz);
    const e = event.endDate ? toUtc(event.endDate, tz) : s;
    if (e >= from && s <= to) push(event.startDate, event.endDate, event.startDate.isDate, false);
    return out;
  }
  const it = event.iterator();
  for (let next = it.next(), n = 0; next && n < 500; next = it.next(), n++) {
    const d = event.getOccurrenceDetails(next);
    const s = toUtc(d.startDate, tz);
    if (s > to) break;
    if (toUtc(d.endDate || d.startDate, tz) >= from) push(d.startDate, d.endDate, d.startDate.isDate, true, d.item);
  }
  return out;
}

// ---- Sync into calendar_events ----------------------------------------------------------------------------------
const syncing = new Map();
/** Refresh one account's events (window: yesterday → 60 days). Returns how many occurrences are stored. */
export function syncConnection(c, user) {
  if (syncing.has(c.id)) return syncing.get(c.id);
  const p = wrap(c, async () => {
    const tz = tzOf(user);
    const client = await clientFor(c);
    const from = new Date(Date.now() - WINDOW_BACK_MS), to = new Date(Date.now() + WINDOW_AHEAD_MS);
    const cals = (await client.fetchCalendars()).filter(cal => !cal.components || cal.components.includes('VEVENT'))
      .filter(cal => !c.config.calendars || c.config.calendars.includes(cal.url));
    const rows = [];
    for (const cal of cals) {
      const objects = await client.fetchCalendarObjects({ calendar: cal, timeRange: { start: from.toISOString(), end: to.toISOString() } });
      for (const o of objects) {
        if (!o.data) continue;
        try {
          for (const ev of occurrences(o.data, from, to, tz)) rows.push({ ...ev, calendar_url: cal.url, calendar_name: typeof cal.displayName === 'string' ? cal.displayName : 'Calendar', href: o.url, etag: o.etag || null });
        } catch (err) { console.warn('[calendar] unreadable event', o.url, err.message); }
      }
    }
    tx(() => {
      run('DELETE FROM calendar_events WHERE connection_id = ?', c.id);
      for (const r of rows) {
        run(`INSERT OR REPLACE INTO calendar_events (connection_id, user_id, calendar_url, calendar_name, uid, href, etag, title, location, description,
          starts_at, ends_at, all_day, recurring, busy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, c.id, user.id, r.calendar_url, r.calendar_name, r.uid, r.href, r.etag,
        r.title.slice(0, 300), r.location?.slice(0, 300) || null, r.description?.slice(0, 4000) || null, r.starts_at, r.ends_at, r.all_day, r.recurring, r.busy ?? 1);
      }
    });
    return rows.length;
  }).finally(() => syncing.delete(c.id));
  syncing.set(c.id, p);
  return p;
}

const lastSync = new Map(); // userId → ms
/** Refresh everyone's calendars that are older than `maxAgeMs` (scheduler tick; the calendar tool before reading). */
export async function syncUser(user, { maxAgeMs = 15 * 60000 } = {}) {
  if (Date.now() - (lastSync.get(user.id) || 0) < maxAgeMs) return;
  lastSync.set(user.id, Date.now());
  for (const c of connectionsOf(user, 'calendar')) await syncConnection(c, user).catch(err => console.warn('[calendar] sync', c.id, err.message));
}

/** Stored occurrences for a person between two instants, soonest first; q filters by words in title/location. */
export function eventsBetween(user, from, to, { q = '' } = {}) {
  const like = `%${String(q).trim()}%`;
  return all(`SELECT e.*, c.label AS account FROM calendar_events e JOIN connections c ON c.id = e.connection_id
    WHERE e.user_id = ? AND e.starts_at <= ? AND COALESCE(e.ends_at, e.starts_at) >= ? ${q ? 'AND (e.title LIKE ? OR e.location LIKE ?)' : ''}
    ORDER BY e.starts_at LIMIT 200`, user.id, to.toISOString(), from.toISOString(), ...(q ? [like, like] : []));
}

// ---- Free time (decision #158) --------------------------------------------------------------------------------------
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_SETS = { weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'], weekends: ['sat', 'sun'], weekend: ['sat', 'sun'] };
const badInput = msg => Object.assign(new Error(msg), { status: 400 });

/** ['mon', 'weekends', 'Tuesday'] → Set of day keys; null/empty → null (every day). Unknown names throw. */
export function dayKeys(days) {
  if (days == null || (Array.isArray(days) && !days.length)) return null;
  const out = new Set();
  for (const raw of [].concat(days)) {
    const d = String(raw).trim().toLowerCase();
    if (DAY_SETS[d]) { DAY_SETS[d].forEach(k => out.add(k)); continue; }
    const k = DAY_KEYS.find(key => d.startsWith(key));
    if (!k) throw badInput(`“${raw}” isn’t a day of the week (use mon…sun, weekdays or weekends).`);
    out.add(k);
  }
  return out;
}

/** "09:00-17:30" → { start: 540, end: 1050 } minutes after midnight. end ≤ start means the window runs past midnight. */
export function parseWithin(within) {
  if (within == null || within === '') return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})\s*$/.exec(String(within));
  const mins = m ? [+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]] : null;
  if (!mins || +m[2] > 59 || +m[4] > 59 || mins[0] > 1440 || mins[1] > 1440 || mins[0] === mins[1]) {
    throw badInput(`“${within}” isn’t a time window: use HH:MM-HH:MM, e.g. 09:00-17:30.`);
  }
  return { start: mins[0], end: mins[1] };
}

// The local calendar date of an instant in a zone, and that date moved by n days (plain date arithmetic, no clocks).
const localDate = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day };
};
const addDays = (d, n) => { const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n)); return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() }; };
const atMinutes = (d, mins, tz) => zonedToUtc({ ...addDays(d, Math.floor(mins / 1440)), hour: Math.floor((mins % 1440) / 60), minute: mins % 60, second: 0 }, tz).getTime();

/** The stretches of [from, to] inside the daily window on the allowed days, in the zone's wall-clock time. */
function allowedWindows(f, t, { within, days, tz }) {
  if (!within && !days) return [[f, t]];
  const win = within || { start: 0, end: 1440 };
  const out = [];
  // From the day before `from` (a window running past midnight may start then) to the day `to` falls on.
  const last = localDate(t, tz);
  for (let d = addDays(localDate(f, tz), -1), n = 0; n < 800; d = addDays(d, 1), n++) {
    if (Date.UTC(d.year, d.month - 1, d.day) > Date.UTC(last.year, last.month - 1, last.day)) break;
    if (days && !days.has(DAY_KEYS[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()])) continue;
    const s = atMinutes(d, win.start, tz);
    const e = atMinutes(d, win.end > win.start ? win.end : win.end + 1440, tz);
    const a = Math.max(s, f), b = Math.min(e, t);
    if (b > a) out.push([a, b]);
  }
  return out;
}

/**
 * Free stretches between two instants, in plain code (the model never does this arithmetic).
 * events: rows like calendar_events ({ starts_at, ends_at, all_day, busy }), anyone's, in any order.
 * Options: minMinutes (shortest useful slot, default 30); within 'HH:MM-HH:MM' (a daily window in `tz`, may run past
 * midnight); buffer (minutes kept clear before and after each timed event); days (['mon'…] / 'weekdays'); tz (default UTC).
 * Rules: events marked free or cancelled (busy = 0) don't count; an all-day event takes its whole day(s) (the end is the
 * next midnight when it has none); a timed event with no end takes no time; overlapping and touching events merge; windows
 * follow the wall clock across a clock change. → [{ start: Date, end: Date, minutes }], soonest first.
 */
export function freeSlotsBetween(events, from, to, { minMinutes = 30, within = null, buffer = 0, days = null, tz = 'UTC' } = {}) {
  const f = new Date(from).getTime(), t = new Date(to).getTime();
  if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) return [];
  const pad = Math.max(0, Number(buffer) || 0) * 60000;
  const busy = [];
  for (const e of events || []) {
    if (e.busy === 0 || e.busy === false) continue;
    let s = Date.parse(e.starts_at), en = e.ends_at ? Date.parse(e.ends_at) : NaN;
    if (!Number.isFinite(s)) continue;
    if (e.all_day) {
      if (!Number.isFinite(en) || en <= s) en = atMinutes(localDate(s, tz), 1440, tz);
    } else {
      if (!Number.isFinite(en) || en < s) en = s;
      s -= pad; en += pad;
    }
    if (en > s && en > f && s < t) busy.push([Math.max(s, f), Math.min(en, t)]);
  }
  busy.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const b of busy) {
    if (merged.length && b[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], b[1]);
    else merged.push([...b]);
  }
  const min = Math.max(1, Number(minMinutes) || 30) * 60000;
  const out = [];
  for (const [ws, we] of allowedWindows(f, t, { within: typeof within === 'string' ? parseWithin(within) : within, days: days instanceof Set ? days : dayKeys(days), tz })) {
    let cursor = ws;
    for (const [bs, be] of merged) {
      if (be <= cursor) continue;
      if (bs >= we) break;
      if (bs > cursor && bs - cursor >= min) out.push([cursor, bs]);
      cursor = Math.max(cursor, be);
      if (cursor >= we) break;
    }
    if (we - cursor >= min) out.push([cursor, we]);
  }
  return out.map(([s, e]) => ({ start: new Date(s), end: new Date(e), minutes: Math.round((e - s) / 60000) }));
}

// ---- Household busy sharing (decision #159) --------------------------------------------------------------------------
/** Do these two people share a group? (The only people a busy lookup can reach.) */
export const shareGroup = (a, b) => !!get(`SELECT 1 FROM group_members m1 JOIN group_members m2 ON m2.group_id = m1.group_id
  WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 1`, a, b);

/** The person's consent: "Share when I'm busy with my household" (set with users.setShareBusy / POST /api/v1/me/profile). */
export const sharesBusy = userId => !!get('SELECT share_busy FROM users WHERE id = ?', userId)?.share_busy;

/**
 * Who looked at this person's availability (Phase 25, decision #196): their own `calendar.busy_lookup` audit rows only (the
 * lookups where they were the one looked at), newest first → [{ at (ISO), who, from, to, rangeLabel, blocks }]. Metadata only,
 * as audited: who asked, for which hours, how many busy blocks were counted; never an event.
 */
export function busyLookupsFor(user, { limit = 20, days = 90 } = {}) {
  const tz = tzOf(user);
  const day = d => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const hm = d => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);
  return all(`SELECT a.at, a.detail, u.name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.action = 'calendar.busy_lookup' AND a.target_type = 'user' AND a.target_id = ? AND a.at >= datetime('now', ?) ORDER BY a.id DESC LIMIT ?`,
  String(user.id), `-${Math.max(1, days)} days`, limit).map(r => {
    let d = {};
    try { d = JSON.parse(r.detail || '{}'); } catch { /* none */ }
    const from = d.from ? new Date(d.from) : null, to = d.to ? new Date(d.to) : null;
    const rangeLabel = from && to ? (day(from) === day(to) ? `${day(from)}, ${hm(from)} to ${hm(to)}` : `${day(from)} to ${day(to)}`) : null;
    return { at: new Date(`${r.at.replace(' ', 'T')}Z`).toISOString(), who: r.name || 'Someone who has left', from: d.from || null, to: d.to || null,
      rangeLabel, blocks: Number(d.blocks) || 0 };
  });
}

/**
 * When `member` is busy between two instants, for `asker` — only if they share a group and `member` said yes. Busy times
 * only: nothing else about an event (title, place, notes, which calendar) leaves this function. Each lookup is audited
 * (metadata: who, whose, the range, how many blocks). → { status: 'shared', blocks } | { status: 'not_shared' |
 * 'no_calendar' | 'not_household' }.
 */
export function sharedBusyBlocks(asker, member, from, to) {
  if (asker.id !== member.id && !shareGroup(asker.id, member.id)) return { status: 'not_household' };
  if (asker.id !== member.id && !sharesBusy(member.id)) return { status: 'not_shared' };
  if (!connectionsOf(member, 'calendar').length) return { status: 'no_calendar' };
  const blocks = all(`SELECT starts_at, ends_at, all_day FROM calendar_events WHERE user_id = ? AND busy = 1 AND starts_at <= ?
    AND COALESCE(ends_at, starts_at) >= ? ORDER BY starts_at LIMIT 500`, member.id, to.toISOString(), from.toISOString())
    .map(r => ({ starts_at: r.starts_at, ends_at: r.ends_at, all_day: r.all_day, busy: 1 }));
  if (asker.id !== member.id) {
    audit('calendar.busy_lookup', { actorId: asker.id, targetType: 'user', targetId: member.id,
      detail: { from: from.toISOString(), to: to.toISOString(), blocks: blocks.length } });
  }
  return { status: 'shared', blocks };
}

// ---- Changes (after approval) ------------------------------------------------------------------------------------
const icsDate = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsDay = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/-/g, '');
const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/\r\n?/g, '\n').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

// RFC 5545 §3.1: content lines longer than 75 octets are folded (CRLF + one space), never inside a UTF-8 character.
function fold(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const out = [];
  let cur = '', bytes = 0, limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > limit) { out.push(cur); cur = ''; bytes = 0; limit = 74; } // continuation lines start with the space
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * A VCALENDAR with one or more VEVENTs. Timed events are written in UTC (every app shows them in its own zone, so an
 * event typed in another zone, a flight leaving Tokyo at 10:00, lands at the right moment); all-day events as dates in
 * the event's zone (`tz` unless the event says `tz`). events: [{ uid, title, start, end?, allDay?, location?, description?,
 * tz? }]. Options: method 'PUBLISH' and name (X-WR-CALNAME) for a file people import; CalDAV objects carry neither.
 */
export function buildCalendar(events, tz = 'UTC', { method = null, name = null } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jessbot//Calendar//EN', 'CALSCALE:GREGORIAN'];
  if (method) lines.push(`METHOD:${method}`);
  if (name) lines.push(`X-WR-CALNAME:${esc(name)}`);
  const stamp = icsDate(new Date());
  for (const { uid, title, start, end, allDay = false, location, description, tz: evTz } of events) {
    const zone = evTz || tz;
    lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`, allDay ? `DTSTART;VALUE=DATE:${icsDay(start, zone)}` : `DTSTART:${icsDate(start)}`);
    if (end) lines.push(allDay ? `DTEND;VALUE=DATE:${icsDay(end, zone)}` : `DTEND:${icsDate(end)}`);
    lines.push(`SUMMARY:${esc(title)}`);
    if (location) lines.push(`LOCATION:${esc(location)}`);
    if (description) lines.push(`DESCRIPTION:${esc(description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** A VCALENDAR with one VEVENT (times in UTC; all-day as dates in the person's zone): what CalDAV stores. */
export const buildIcs = (event, tz = 'UTC') => buildCalendar([event], tz);

async function calendarFor(client, c, calendarName) {
  const cals = (await client.fetchCalendars()).filter(cal => !cal.components || cal.components.includes('VEVENT'));
  if (!cals.length) throw Object.assign(new Error('That account has no calendars.'), { status: 400 });
  if (calendarName) {
    const want = String(calendarName).toLowerCase();
    const hit = cals.find(cal => String(cal.displayName || '').toLowerCase() === want);
    if (hit) return hit;
  }
  return cals.find(cal => !c.config.calendars || c.config.calendars.includes(cal.url)) || cals[0];
}

export function createEvent(c, user, ev) {
  return wrap(c, async () => {
    const client = await clientFor(c);
    const cal = await calendarFor(client, c, ev.calendar);
    const uid = `${crypto.randomUUID()}@jessbot`;
    const res = await client.createCalendarObject({ calendar: cal, filename: `${uid}.ics`, iCalString: buildIcs({ ...ev, uid }, tzOf(user)) });
    if (!res.ok) throw Object.assign(new Error(`The calendar refused the new event (${res.status}).`), { status: 400 });
    lastSync.delete(user.id);
    await syncConnection(c, user).catch(() => {});
    return { uid, calendar: typeof cal.displayName === 'string' ? cal.displayName : 'Calendar' };
  });
}

/** Change or delete an event by its uid (the whole series for a recurring one). */
export function changeEvent(c, user, uid, patch = null) {
  return wrap(c, async () => {
    const row = get('SELECT * FROM calendar_events WHERE connection_id = ? AND uid = ? ORDER BY starts_at LIMIT 1', c.id, String(uid));
    if (!row?.href) throw Object.assign(new Error('I can’t find that event any more — let me look at the calendar again.'), { status: 404 });
    const client = await clientFor(c);
    if (!patch) {
      const res = await client.deleteCalendarObject({ calendarObject: { url: row.href, etag: row.etag || undefined } });
      if (!res.ok && res.status !== 404) throw Object.assign(new Error(`The calendar refused to delete it (${res.status}).`), { status: 400 });
    } else {
      if (row.recurring) throw Object.assign(new Error('That’s a repeating event — change it in the calendar app to pick which occurrences.'), { status: 400 });
      const next = { uid: row.uid, title: patch.title ?? row.title, location: patch.location ?? row.location, description: patch.description ?? row.description,
        start: patch.start ?? new Date(row.starts_at), end: patch.end ?? (row.ends_at ? new Date(row.ends_at) : null), allDay: patch.allDay ?? !!row.all_day };
      const res = await client.updateCalendarObject({ calendarObject: { url: row.href, etag: row.etag || undefined, data: buildIcs(next, tzOf(user)) } });
      if (!res.ok) throw Object.assign(new Error(`The calendar refused the change (${res.status}).`), { status: 400 });
    }
    lastSync.delete(user.id);
    await syncConnection(c, user).catch(() => {});
    return row;
  });
}

/**
 * For the prompt and Upcoming: "Tue 14:00–15:00 · Dentist · Rue de Rome" in their zone. Title and place come from whoever
 * made the entry (an invitation from anyone): one clean line each, capped (decision #118).
 */
export function eventLine(e, tz) {
  const fmtDay = d => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const fmtTime = d => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);
  const s = new Date(e.starts_at), en = e.ends_at ? new Date(e.ends_at) : null;
  const when = e.all_day ? `${fmtDay(s)} (all day)` : `${fmtDay(s)} ${fmtTime(s)}${en ? `–${fmtTime(en)}` : ''}`;
  return `${when} · ${oneLine(e.title, EVENT_FIELD_MAX)}${e.location ? ` · ${oneLine(e.location, EVENT_FIELD_MAX)}` : ''}`;
}
