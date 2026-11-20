// Upcoming (page + right panel): the next 7 days at a glance, live alarms/reminders/timers, scheduled tasks and the
// check-in rhythm (contracts: pages/upcoming.hbs, partials/upcoming-panel.hbs, alarm-card.hbs, job-card.hbs).
import { Cron } from 'croner';
import { get } from '../db/index.js';
import { listAlarms, alarmView } from './alarms.js';
import { listSchedules, jobView, CHECKIN_CRON } from './schedules.js';
import { tzOf, describeCron } from '../lib/when.js';
import { eventsBetween, eventLine } from './calendar.js';
import { hasConnection } from './connections.js';
import { datedItems } from './memory.js';

const PER_DAY = 5;

function occurrences(pattern, tz, from, until, max = 40) {
  try {
    const c = new Cron(pattern, { timezone: tz, paused: true });
    const list = c.nextRuns(max, from).filter(d => d < until);
    c.stop();
    return list;
  } catch { return []; }
}

export function weekStrip(user, now = new Date()) {
  const tz = tzOf(user);
  const dayKey = d => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const hm = d => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);
  const until = new Date(now.getTime() + 7 * 864e5);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 864e5);
    days.push({ key: dayKey(d), label: i === 0 ? 'Today' : new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(d),
      date: new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric' }).format(d), isToday: i === 0, items: [] });
  }
  const put = (when, title, kind) => days.find(x => x.key === dayKey(when))?.items.push({ at: when.getTime(), time: hm(when), title, kind });
  for (const a of listAlarms(user)) {
    const first = new Date(a.fire_at);
    if (first < until) put(first, a.label || a.kind, a.kind);
    if (a.repeat_cron) for (const d of occurrences(a.repeat_cron, a.timezone, first, until)) put(d, a.label || a.kind, a.kind);
  }
  for (const s of listSchedules(user)) {
    if (s.paused || !s.next_run_at) continue;
    const first = new Date(s.next_run_at);
    if (first < until) put(first, s.title, 'task');
    if (s.cron) for (const d of occurrences(s.cron, s.timezone, first, until)) put(d, s.title, 'task');
  }
  // Their calendar (cached; decision #79). All-day events sort first with no time.
  for (const e of eventsBetween(user, now, until)) {
    const d = new Date(e.starts_at);
    days.find(x => x.key === dayKey(e.all_day ? new Date(d.getTime() + 12 * 3600e3) : d))?.items.push({ at: e.all_day ? 0 : d.getTime(), time: e.all_day ? 'All day' : hm(d), title: e.title, kind: 'event' });
  }
  for (const day of days) {
    day.items.sort((a, b) => a.at - b.at);
    day.more = Math.max(0, day.items.length - PER_DAY);
    day.runs = day.items.slice(0, PER_DAY);
    delete day.items;
  }
  return days;
}

export function checkinsView(user) {
  const value = user.checkins || 'normal';
  const row = get(`SELECT * FROM schedules WHERE user_id = ? AND kind = 'checkin'`, user.id);
  return {
    value, lastRunAt: row?.last_run_at || null, lastStatus: row?.last_status || null,
    options: [
      { value: 'off', label: 'Off', hint: 'Only when you write to me' },
      { value: 'light', label: 'Light', hint: describeCron(CHECKIN_CRON.light) },
      { value: 'normal', label: 'Normal', hint: describeCron(CHECKIN_CRON.normal) },
    ],
  };
}

export function upcomingData(user, now = new Date()) {
  const tz = tzOf(user);
  return {
    week: weekStrip(user, now),
    calendar: { connected: hasConnection(user, 'calendar'),
      events: eventsBetween(user, now, new Date(now.getTime() + 7 * 864e5)).map(e => ({ line: eventLine(e, tz), title: e.title, location: e.location, recurring: !!e.recurring, account: e.account })) },
    alarms: listAlarms(user).map(a => alarmView(a, now)),
    jobs: listSchedules(user).map(s => jobView(s, now)),
    checkins: checkinsView(user),
    dates: datesSoon(user, now),
  };
}

// Dates I remember in the next two weeks (birthdays, anniversaries, one-off events from memories; #196): the same dated
// memories the prompt's "Dates soon" block reads (services/memory.js datedItems), as a list for the page.
const REL = n => (n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`);
export function datesSoon(user, now = new Date(), { ahead = 14 } = {}) {
  const part = (ymd, o) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...o });
  return datedItems(user, now, { back: 0, ahead }).filter(d => d.diff >= 0).slice(0, 8).map(d => ({
    id: d.id, text: d.text, ymd: d.ymd, time: d.time, relLabel: d.diff > 1 ? `${part(d.ymd, { weekday: 'long' })}, ${REL(d.diff).toLowerCase()}` : REL(d.diff),
    day: part(d.ymd, { day: 'numeric' }), month: part(d.ymd, { month: 'short' }), soon: d.diff <= 1, age: d.age, yearly: d.recurs === 'yearly',
  }));
}

/** The panel shows what is next: live alarms/timers first, then the next few tasks. */
export function upcomingPanel(user, now = new Date()) {
  return { alarms: listAlarms(user).slice(0, 6).map(a => alarmView(a, now)), jobs: listSchedules(user).slice(0, 4).map(s => jobView(s, now)) };
}
