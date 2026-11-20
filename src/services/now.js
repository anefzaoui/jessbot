// "Right now" for a person (feed hero + chat widget): an inviting greeting for their local time, a friendly line,
// the weather at home and what's next. Owner rule: greetings invite ("Up late, Alex?"), never dismiss ("Good night").
import { tzOf, localLabel } from '../lib/when.js';
import { weatherOf, today } from './weather.js';
import { listAlarms, alarmView } from './alarms.js';
import { listSchedules, jobView } from './schedules.js';

const LINES = {
  early: ['Want me to line up your day?', 'Early start — anything I can take off your plate?', 'Coffee first. Then tell me what’s on today.'],
  morning: ['What’s on today?', 'Anything I can get moving for you this morning?', 'Tell me what matters today and I’ll keep track.'],
  afternoon: ['Need a hand with anything?', 'What can I take off your list this afternoon?', 'Anything you want me to look into?'],
  evening: ['How was your day?', 'Anything to wrap up before tonight?', 'Want me to set anything up for tomorrow?'],
  late: ['I’m here if something’s on your mind.', 'Can’t sleep? I’m good company.', 'Anything you want to get out of your head before tomorrow?'],
};

function localHour(now, tz) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).split(':').map(Number);
  return h + m / 60;
}

export function greetingFor(user, now = new Date()) {
  const tz = tzOf(user);
  const h = localHour(now, tz);
  const name = user?.callMe || user?.firstName || '';
  const [part, text] = h >= 4 && h < 6 ? ['early', `Early start${name ? `, ${name}` : ''}?`]
    : h < 12 && h >= 6 ? ['morning', `Good morning${name ? `, ${name}` : ''}`]
      : h >= 12 && h < 17 ? ['afternoon', `Good afternoon${name ? `, ${name}` : ''}`]
        : h >= 17 && h < 22 ? ['evening', `Good evening${name ? `, ${name}` : ''}`]
          : ['late', `Up late${name ? `, ${name}` : ''}?`];
  const lines = LINES[part];
  const day = Math.floor((now.getTime() + 3600e3 * 2) / 864e5); // varies day to day, stable within a day
  return {
    part, text, line: lines[day % lines.length],
    date: new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }).format(now),
  };
}

const WEATHER_ICON = { clear: ['sun', 'moon'], cloudy: ['cloud-sun', 'cloud-moon'], rain: ['cloud-rain'], snow: ['snowflake'], storm: ['cloud-lightning'], fog: ['cloud-fog'] };

export function nowFor(user, now = new Date()) {
  const g = greetingFor(user, now);
  const w = weatherOf(user, now);
  let weather = null;
  if (w?.forecast) {
    const f = w.forecast, d = today(f, now);
    const night = d?.sunrise && d?.sunset ? now < new Date(d.sunrise) || now > new Date(d.sunset) : !f.current.isDay;
    const icons = WEATHER_ICON[f.current.bucket] || WEATHER_ICON.clear;
    weather = { temp: `${Math.round(f.current.temp)}°`, label: f.current.label, place: w.place.name.split(',')[0], iconName: icons[night ? icons.length - 1 : 0] };
  }
  // Next thing coming up in the next 24 h: an alarm/reminder/timer or a scheduled task.
  const soon = [
    ...listAlarms(user).map(a => ({ at: a.fire_at, v: alarmView(a, now), kind: 'alarm' })),
    ...listSchedules(user).filter(s => !s.paused && s.next_run_at).map(s => ({ at: s.next_run_at, v: jobView(s, now), kind: 'task' })),
  ].filter(x => new Date(x.at) - now < 864e5).sort((a, b) => a.at.localeCompare(b.at))[0];
  const next = soon ? {
    label: soon.kind === 'alarm' ? soon.v.label : soon.v.title, iconName: soon.v.iconName,
    whenLabel: soon.v.status === 'ringing' ? 'now' : localLabel(soon.at, tzOf(user), now), href: '/upcoming',
  } : null;
  return { ...g, weather, next };
}
