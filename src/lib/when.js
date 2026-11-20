// Time helpers for schedules and alarms (decision #48). croner computes occurrences in a person's timezone (DST-safe);
// cronstrue turns patterns into words. Everything stored is UTC ISO; everything shown is the person's local time.
import { Cron } from 'croner';
import cronstrue from 'cronstrue';

export const validTimezone = tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return !!tz; } catch { return false; } };

// Fallback when a person has no timezone yet: JESSBOT_TIMEZONE, else the server's zone. (On Windows Node may report a
// fixed-offset zone like "Etc/GMT-1" that ignores daylight saving — set JESSBOT_TIMEZONE, or let the person's own
// browser/home place set theirs.)
export const defaultTimezone = () => (validTimezone(process.env.JESSBOT_TIMEZONE) ? process.env.JESSBOT_TIMEZONE : Intl.DateTimeFormat().resolvedOptions().timeZone);
export const tzOf = user => (validTimezone(user?.timezone) ? user.timezone : defaultTimezone());

/** Next occurrence of a 5/6-field cron pattern in `tz` strictly after `from`, or null. Throws on a bad pattern. */
export function nextFromCron(pattern, tz, from = new Date()) {
  const c = new Cron(pattern, { timezone: tz, paused: true });
  const next = c.nextRun(from);
  c.stop();
  return next;
}

/** "2026-09-25T07:30" (wall-clock in tz) → Date, or null if it isn't a valid future moment. */
export function localToDate(local, tz) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(local || '').trim());
  if (!m) return null;
  const c = new Cron(`${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}`, { timezone: tz, paused: true });
  const d = c.nextRun();
  c.stop();
  return d;
}

/** Next time the clock shows HH:MM in tz (today if still ahead, else tomorrow). */
export function nextClockTime(hhmm, tz, from = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return nextFromCron(`${Number(m[2])} ${Number(m[1])} * * *`, tz, from);
}

/** Friendly repeat names → cron at a given clock time; a raw cron pattern passes through (validated). */
export function repeatToCron(repeat, hhmm, { tz, from = new Date() } = {}) {
  const r = String(repeat || 'once').trim().toLowerCase();
  if (!r || r === 'once' || r === 'none') return null;
  const [h, min] = String(hhmm || '09:00').split(':').map(Number);
  const at = `${min || 0} ${h || 0}`;
  // weekly / monthly / yearly repeat on the weekday / day of month / date it was set (in the person's timezone).
  const local = new Intl.DateTimeFormat('en-US', { timeZone: validTimezone(tz) ? tz : undefined, weekday: 'short', day: 'numeric', month: 'numeric' }).formatToParts(from);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(local.find(p => p.type === 'weekday').value);
  const dom = Number(local.find(p => p.type === 'day').value), month = Number(local.find(p => p.type === 'month').value);
  const day = Math.min(28, dom); // 29–31 don't exist every month
  // Yearly (birthdays, anniversaries; decision #154): that date every year; 29 February falls back to the 28th, which every year has.
  const yearly = month === 2 && dom === 29 ? `${at} 28 2 *` : `${at} ${dom} ${month} *`;
  const named = { daily: `${at} * * *`, 'every day': `${at} * * *`, weekdays: `${at} * * 1-5`, weekends: `${at} * * 0,6`,
    weekly: `${at} * * ${weekday}`, monthly: `${at} ${day} * *`, yearly, annually: yearly, 'every year': yearly };
  if (named[r]) return named[r];
  const days = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const list = r.split(/[\s,]+/).map(d => days[d.slice(0, 3)]).filter(d => d !== undefined);
  if (list.length && list.length === r.split(/[\s,]+/).length) return `${at} * * ${list.join(',')}`;
  nextFromCron(repeat, 'UTC'); // throws if it's not a valid pattern either
  return String(repeat).trim();
}

export function describeCron(pattern) {
  try { return cronstrue.toString(pattern, { use24HourTimeFormat: true, verbose: false }); } catch { return pattern; }
}

/** "Fri 25 Sep, 07:30" (or "Today, 07:30" / "Tomorrow, 07:30") in tz. */
export function localLabel(date, tz, now = new Date()) {
  const d = new Date(date);
  const day = x => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);
  if (day(d) === day(now)) return `Today, ${time}`;
  if (day(d) === day(new Date(now.getTime() + 864e5))) return `Tomorrow, ${time}`;
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d)}, ${time}`;
}

/** Is `date` inside the quiet window "22:00"–"07:30" (wrapping midnight) in tz? */
export function inQuietHours(start, end, tz, date = new Date()) {
  if (!start || !end) return false;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  return start <= end ? hm >= start && hm < end : hm >= start || hm < end;
}

/** "Today" / "Yesterday" / "Monday, September 21" for a moment, in a timezone (activity, feed history). */
export function dayLabel(iso, timeZone, now = new Date()) {
  const tz = validTimezone(timeZone) ? timeZone : undefined;
  const fmt = d => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const d = new Date(iso);
  if (fmt(d) === fmt(now)) return 'Today';
  if (fmt(d) === fmt(new Date(now.getTime() - 864e5))) return 'Yesterday';
  return new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(d);
}

/** YYYY-MM-DD of a moment in a timezone (grouping key). */
export const dayKey = (iso, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone: validTimezone(timeZone) ? timeZone : undefined,
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));


// ---- How old is a source? (owner: "she doesn't know a result from 1 year ago from one from 10 years ago") ----------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/** A date written the ways search engines and pages write it (at the start of a snippet, or a meta value), or null. */
export function looseDate(text, now = new Date()) {
  const t = String(text || '').trim().slice(0, 80);
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if ((m = /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago\b/i.exec(t))) {
    const ms = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[m[2].toLowerCase()];
    return new Date(now.getTime() - Number(m[1]) * ms);
  }
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(t)) && MONTHS[m[1].slice(0, 4).toLowerCase().replace(/t$/, '')] !== undefined) {
    return new Date(Date.UTC(+m[3], MONTHS[m[1].toLowerCase().slice(0, 3)], +m[2]));
  }
  if ((m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/.exec(t)) && MONTHS[m[2].toLowerCase().slice(0, 3)] !== undefined) {
    return new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase().slice(0, 3)], +m[1]));
  }
  const d = /^\d{4}-\d{2}-\d{2}T/.test(t) ? new Date(t) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** "today" · "3 days ago" · "5 months ago" · "about 10 years ago" */
export function ageLabel(date, now = new Date()) {
  const days = (now - new Date(date)) / 864e5;
  if (!Number.isFinite(days)) return '';
  if (days < 1) return 'today';
  if (days < 45) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'} ago`;
  if (days < 548) return `${Math.round(days / 30.4)} months ago`;
  return `about ${Math.round(days / 365.25)} years ago`;
}

/** "published 3 Mar 2016 (about 10 years ago)" for tool output. */
export const datedLabel = (date, now = new Date()) => (date
  ? `${new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} (${ageLabel(date, now)})` : null);
