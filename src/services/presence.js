// The living presence (decision #33): which portrait frames exist, which sky scene fits "now", and where the
// images live. Shared rules with public/js/presence.js (timeOfDay/sceneFor are duplicated there on purpose —
// the client re-evaluates every minute without a round trip; both read the same presence.json).
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/index.js';
import { openRead } from '../lib/safe-path.js';

const MANIFEST = path.join(paths.public, 'img', 'presence.json');
let cache = null, cacheMtime = 0;

export function presenceManifest() {
  try {
    const f = openRead(MANIFEST);
    const m = f.stat.mtimeMs;
    if (!cache || m !== cacheMtime) { cache = JSON.parse(f.read('utf8')); cacheMtime = m; } else f.close();
  } catch { cache = { avatars: {}, scenes: [] }; }
  return cache;
}

// Hour of day in a timezone (falls back to server local time).
function localHour(date, timeZone) {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: 'numeric', hour12: false, timeZone }).format(date);
    const [hh, mm] = h.split(':').map(Number);
    return hh + mm / 60;
  } catch { return date.getHours() + date.getMinutes() / 60; }
}

// dawn/dusk = ±45 min around sunrise/sunset when known (Phase 7 weather), else a sensible clock approximation.
export function timeOfDay({ now = new Date(), timeZone, sunrise, sunset } = {}) {
  if (sunrise && sunset) {
    const t = now.getTime(), rise = new Date(sunrise).getTime(), set = new Date(sunset).getTime(), w = 45 * 60e3;
    if (Math.abs(t - rise) <= w) return 'dawn';
    if (Math.abs(t - set) <= w) return 'dusk';
    return t > rise && t < set ? 'day' : 'night';
  }
  const h = localHour(now, timeZone);
  if (h >= 5.5 && h < 7) return 'dawn';
  if (h >= 7 && h < 18.5) return 'day';
  if (h >= 18.5 && h < 20) return 'dusk';
  return 'night';
}

// Best available scene: exact → same time, clear → day-clear → first → null.
export function sceneFor({ time = 'day', weather = 'clear' } = {}) {
  const have = new Set(presenceManifest().scenes);
  for (const s of [`${time}-${weather}`, `${time}-clear`, 'day-clear']) if (have.has(s)) return s;
  return presenceManifest().scenes[0] || null;
}

export function variantFrames(variant) {
  return presenceManifest().avatars?.[variant] || [];
}

// Presence data for templates (res.locals.presence). weather = services/weather.sky() of the person's home, or null (clear).
export function presenceFor({ bot, user, weather } = {}) {
  const variant = variantFrames(bot?.variant).length ? bot.variant : null;
  const time = timeOfDay({ timeZone: user?.timezone || undefined, sunrise: weather?.sunrise, sunset: weather?.sunset });
  const w = weather?.bucket || 'clear';
  return {
    variant, time, weather: w, scene: sceneFor({ time, weather: w }),
    sunrise: weather?.sunrise || null, sunset: weather?.sunset || null,
    temp: weather?.temp ?? null, weatherLabel: weather?.label || null,
    frames: variant ? variantFrames(variant) : [],
  };
}
