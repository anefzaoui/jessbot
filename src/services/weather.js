// Weather (decisions #30, #49): Open-Meteo forecasts fetched through CloakBrowser, normalised, cached per ~1 km
// (coords rounded to 2 dp) for 30 min and served stale up to 6 h when a refresh fails. Buckets drive the avatar's sky.
// Data by Open-Meteo.com (CC BY 4.0) — credited wherever weather is shown.
import { get, run } from '../db/index.js';
import { fetchJson } from '../browser/read.js';
import { primaryPlace } from './places.js';

export const FRESH_MS = 30 * 60000;
export const STALE_MS = 6 * 3600000;
export const CREDIT = { label: 'Weather data by Open-Meteo.com', href: 'https://open-meteo.com/' };

const LABELS = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

/** WMO code (+ visibility in m) → sky bucket used by the avatar scenes (decision #30). */
export function bucketOf(code, visibility = null) {
  const c = Number(code);
  if (c >= 95) return 'storm';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if (c === 45 || c === 48 || (visibility != null && visibility < 1000)) return 'fog';
  if (c === 2 || c === 3) return 'cloudy';
  return 'clear';
}

const keyOf = (lat, lon) => `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;

/** Open-Meteo JSON → our shape; every time as UTC ISO (Open-Meteo returns local wall times + the offset). */
export function normalize(raw) {
  const off = Number(raw.utc_offset_seconds) || 0;
  const utc = t => (t ? new Date(Date.parse(`${t}${t.length === 10 ? 'T00:00' : ''}Z`) - off * 1000).toISOString() : null);
  const c = raw.current || {}, d = raw.daily || {}, h = raw.hourly || {};
  return {
    timezone: raw.timezone, utcOffsetSec: off,
    current: {
      at: utc(c.time), temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m,
      precip: c.precipitation, wind: c.wind_speed_10m, gusts: c.wind_gusts_10m ?? null, uv: c.uv_index ?? null, isDay: !!c.is_day, code: c.weather_code,
      label: LABELS[c.weather_code] || 'unknown', bucket: bucketOf(c.weather_code, c.visibility),
    },
    daily: (d.time || []).map((t, i) => ({
      date: t, code: d.weather_code[i], label: LABELS[d.weather_code[i]] || 'unknown', bucket: bucketOf(d.weather_code[i]),
      max: d.temperature_2m_max[i], min: d.temperature_2m_min[i], precipProb: d.precipitation_probability_max?.[i] ?? null,
      precipSum: d.precipitation_sum?.[i] ?? null, sunrise: utc(d.sunrise?.[i]), sunset: utc(d.sunset?.[i]),
      uvMax: d.uv_index_max?.[i] ?? null, windMax: d.wind_speed_10m_max?.[i] ?? null, gustsMax: d.wind_gusts_10m_max?.[i] ?? null,
    })),
    hourly: (h.time || []).map((t, i) => ({
      at: utc(t), local: t.slice(11, 16), temp: h.temperature_2m[i], feels: h.apparent_temperature?.[i] ?? null,
      precipProb: h.precipitation_probability?.[i] ?? null, precip: h.precipitation?.[i] ?? 0,
      code: h.weather_code[i], label: LABELS[h.weather_code[i]] || 'unknown', bucket: bucketOf(h.weather_code[i]),
      wind: h.wind_speed_10m?.[i] ?? null, gusts: h.wind_gusts_10m?.[i] ?? null, uv: h.uv_index?.[i] ?? null,
    })),
  };
}

// UV and wind ride along on every forecast (decision #140): "is it windy for the beach?", "do the kids need sun cream?".
const HOURLY = 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,uv_index';
const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,'
  + 'uv_index_max,wind_speed_10m_max,wind_gusts_10m_max';
const forecastUrl = (lat, lon) => 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
  latitude: Number(lat).toFixed(4), longitude: Number(lon).toFixed(4), timezone: 'auto', forecast_days: '7', forecast_hours: '36',
  current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,uv_index,is_day,visibility',
  hourly: HOURLY, daily: DAILY,
});

const cacheRow = (lat, lon) => get('SELECT * FROM weather_cache WHERE key = ?', keyOf(lat, lon)) || null;

/** Cached forecast only (never touches the network) — safe in request paths and prompts. Null when missing or too old. */
export function cachedForecast(lat, lon, now = Date.now()) {
  const row = cacheRow(lat, lon);
  if (!row?.data || now - new Date(row.fetched_at).getTime() > STALE_MS) return null;
  return { ...JSON.parse(row.data), fetchedAt: row.fetched_at, stale: now - new Date(row.fetched_at).getTime() > FRESH_MS };
}

const inflight = new Map();
/** Fresh-enough forecast, fetching through the browser when needed; stale data (≤ 6 h) if the fetch fails. */
export async function forecast(lat, lon, { force = false, signal } = {}) {
  const key = keyOf(lat, lon);
  const have = cachedForecast(lat, lon);
  if (have && !have.stale && !force) return have;
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      try {
        const data = normalize(await fetchJson(forecastUrl(lat, lon), { signal }));
        run(`INSERT INTO weather_cache (key, latitude, longitude, timezone, data, source, fetched_at, error, error_at)
             VALUES (?, ?, ?, ?, ?, 'open-meteo', ?, NULL, NULL)
             ON CONFLICT(key) DO UPDATE SET data = excluded.data, timezone = excluded.timezone, source = excluded.source,
               fetched_at = excluded.fetched_at, error = NULL, error_at = NULL`,
        key, Number(lat), Number(lon), data.timezone, JSON.stringify(data), new Date().toISOString());
      } catch (err) {
        run(`INSERT INTO weather_cache (key, latitude, longitude, error, error_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET error = excluded.error, error_at = excluded.error_at`,
        key, Number(lat), Number(lon), err.message.slice(0, 300), new Date().toISOString());
        if (!have) throw err;
      } finally { inflight.delete(key); }
    })());
  }
  await inflight.get(key);
  return cachedForecast(lat, lon);
}

// ---- Words ------------------------------------------------------------------------------------------------
const deg = t => (t == null ? '?' : `${Math.round(t)}°C`);
const hm = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** Today's entry (in the forecast's own timezone). */
export function today(f, now = new Date()) {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: f.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return f.daily.find(d => d.date === local) || f.daily[0] || null;
}

/** "22°C, mainly clear (feels 21°C). Today 14–25°C, rain 10%. Sunset 19:32." */
export function describe(f, now = new Date()) {
  if (!f) return null;
  const d = today(f, now);
  const parts = [`${deg(f.current.temp)}, ${f.current.label}${Math.abs((f.current.feels ?? f.current.temp) - f.current.temp) >= 2 ? ` (feels ${deg(f.current.feels)})` : ''}`];
  if (d) {
    parts.push(`Today ${deg(d.min)}–${deg(d.max)}${d.precipProb != null ? `, rain chance ${d.precipProb}%` : ''}`);
    const sun = new Date(d.sunrise) > now ? `Sunrise ${hm(d.sunrise, f.timezone)}` : new Date(d.sunset) > now ? `Sunset ${hm(d.sunset, f.timezone)}` : null;
    if (sun) parts.push(sun);
  }
  return `${parts.join('. ')}.`;
}

/** Next hours worth mentioning: when rain/snow/storm is likely soon. */
export function outlook(f, now = new Date(), hours = 12) {
  const soon = f.hourly.filter(x => new Date(x.at) > now && new Date(x.at) - now <= hours * 3600000);
  const wet = soon.find(x => (x.precipProb ?? 0) >= 50 && ['rain', 'snow', 'storm'].includes(x.bucket));
  return wet ? `${wet.bucket === 'storm' ? 'Storms' : wet.bucket === 'snow' ? 'Snow' : 'Rain'} likely from about ${hm(wet.at, f.timezone)} (${wet.precipProb}%).` : null;
}

export function tomorrowLine(f, now = new Date()) {
  const d = today(f, now);
  const i = d ? f.daily.indexOf(d) : -1;
  const t = f.daily[i + 1];
  return t ? `Tomorrow ${deg(t.min)}–${deg(t.max)}, ${t.label}${t.precipProb != null ? `, rain chance ${t.precipProb}%` : ''}.` : null;
}

/** For the avatar scene + small UI chips. */
export function sky(f, now = new Date()) {
  if (!f) return null;
  const d = today(f, now);
  return { bucket: f.current.bucket, sunrise: d?.sunrise || null, sunset: d?.sunset || null, temp: f.current.temp, label: f.current.label };
}

// ---- Per person ------------------------------------------------------------------------------------------
/** Cached forecast for a person's primary place (never touches the network) + the place, or null without a place. */
export function weatherOf(user, now = new Date()) {
  const place = primaryPlace(user);
  if (!place) return null;
  return { place, forecast: cachedForecast(place.latitude, place.longitude, now.getTime()) };
}

/** Prompt tail: the weather where they live — or a nudge to learn where that is. */
export function weatherBlock(user, now = new Date()) {
  const w = weatherOf(user, now);
  if (!w) return "## Weather\n- You don't know where they live yet. When it matters (weather, local plans), ask once and save it with set_location.";
  if (!w.forecast) return `## Weather\n- ${w.place.name} (${w.place.label}): no forecast yet — use get_weather if it matters.`;
  const f = w.forecast;
  return ['## Weather', `- ${w.place.name} (${w.place.label}): ${describe(f, now)}`,
    outlook(f, now) && `- ${outlook(f, now)}`, tomorrowLine(f, now) && `- ${tomorrowLine(f, now)}`].filter(Boolean).join('\n');
}

/** Sky for a person's avatar (cached data only), or null → clear. */
export const skyOf = user => (user ? sky(weatherOf(user)?.forecast) : null);

// ---- One day by the hour, and the past (decision #140) ---------------------------------------------------------------
// "Saturday at the beach?" and "when does the rain stop?" need one date's hours, up to 16 days out (fetched on demand, not
// part of the cached 7-day forecast); "how hot was last August?" needs the archive (ERA5, 1940 onwards). Same source, same
// fetch path (CloakBrowser, #15/#30), same credit. Small in-process caches: a day for 30 min, the past for 12 h.
export const FORECAST_DAYS_MAX = 16;
export const HISTORY_DAYS_MAX = 731;
export const HISTORY_FROM = '1940-01-01';
const memo = new Map();
async function cachedFetch(url, ttl, { signal } = {}) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = await fetchJson(url, { signal });
  memo.set(url, { at: Date.now(), data });
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return data;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = d => Date.parse(`${d}T00:00:00Z`);
const addDays = (d, n) => new Date(dayMs(d) + n * 864e5).toISOString().slice(0, 10);
/** Today's date where the place is ("YYYY-MM-DD"). */
export const localDate = (tz, now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAYS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
/** "2026-10-03" · "today" · "tomorrow" · "saturday" (the next one, today included) → a date in the place's timezone, or null. */
export function resolveDay(day, tz, now = new Date()) {
  const d = String(day || '').trim().toLowerCase();
  if (!d) return null;
  if (ISO_DATE.test(d)) return Number.isFinite(dayMs(d)) ? d : null;
  const today = localDate(tz, now);
  if (['today', "aujourd'hui", 'اليوم'].includes(d)) return today;
  if (['tomorrow', 'demain', 'غدا', 'غداً'].includes(d)) return addDays(today, 1);
  const i = WEEKDAYS.indexOf(d) >= 0 ? WEEKDAYS.indexOf(d) : WEEKDAYS_FR.indexOf(d);
  if (i < 0) return null;
  const dow = new Date(dayMs(today)).getUTCDay();
  return addDays(today, (i - dow + 7) % 7);
}

const dayUrl = (lat, lon, date) => 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
  latitude: Number(lat).toFixed(4), longitude: Number(lon).toFixed(4), timezone: 'auto', start_date: date, end_date: date,
  hourly: HOURLY, daily: DAILY,
});

/** One date's forecast: { timezone, date, day: { …daily row }, hours: [{ at, local: "HH:MM", temp, feels, precipProb, precip, label, wind, gusts, uv }] }. */
export function normalizeDay(raw, date) {
  const f = normalize(raw);
  return { timezone: f.timezone, date, day: f.daily.find(x => x.date === date) || f.daily[0] || null, hours: f.hourly };
}

/** A date from today to 15 days ahead (where the place is). Throws a person-readable error outside that window. */
export async function forecastDay(lat, lon, date, { tz = null, signal, now = new Date() } = {}) {
  if (!ISO_DATE.test(date)) throw Object.assign(new Error('Give the day as YYYY-MM-DD.'), { status: 400 });
  const today = localDate(tz, now);
  if (date < addDays(today, -1)) throw Object.assign(new Error(`${date} is in the past — ask for history instead.`), { status: 400 });
  if (date > addDays(today, FORECAST_DAYS_MAX - 1)) throw Object.assign(new Error(`Forecasts reach ${FORECAST_DAYS_MAX} days ahead (to ${addDays(today, FORECAST_DAYS_MAX - 1)}); ${date} is too far.`), { status: 400 });
  return normalizeDay(await cachedFetch(dayUrl(lat, lon, date), FRESH_MS, { signal }), date);
}

const historyUrl = (lat, lon, from, to) => 'https://archive-api.open-meteo.com/v1/archive?' + new URLSearchParams({
  latitude: Number(lat).toFixed(4), longitude: Number(lon).toFixed(4), timezone: 'auto', start_date: from, end_date: to,
  daily: 'weather_code,temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,wind_speed_10m_max',
});

/** Archive JSON → { timezone, days: [{ date, code, label, max, min, mean, precipSum, windMax }], missing } (days without data dropped). */
export function normalizeHistory(raw) {
  const d = raw.daily || {};
  const days = (d.time || []).map((t, i) => ({
    date: t, code: d.weather_code?.[i] ?? null, label: LABELS[d.weather_code?.[i]] || null, max: d.temperature_2m_max?.[i] ?? null,
    min: d.temperature_2m_min?.[i] ?? null, mean: d.temperature_2m_mean?.[i] ?? null, precipSum: d.precipitation_sum?.[i] ?? null,
    windMax: d.wind_speed_10m_max?.[i] ?? null,
  }));
  const have = days.filter(x => x.max != null || x.min != null);
  return { timezone: raw.timezone, days: have, missing: days.length - have.length };
}

const avg = xs => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
/** Totals over days: { days, avgMax, avgMin, hottest: { date, max }, coldest: { date, min }, rainTotal, rainyDays (≥ 1 mm) }. */
export function summarizeDays(days) {
  const withMax = days.filter(x => x.max != null), withMin = days.filter(x => x.min != null), withRain = days.filter(x => x.precipSum != null);
  const hottest = withMax.reduce((a, b) => (b.max > (a?.max ?? -Infinity) ? b : a), null);
  const coldest = withMin.reduce((a, b) => (b.min < (a?.min ?? Infinity) ? b : a), null);
  return {
    days: days.length, avgMax: avg(withMax.map(x => x.max)), avgMin: avg(withMin.map(x => x.min)),
    hottest: hottest && { date: hottest.date, max: hottest.max }, coldest: coldest && { date: coldest.date, min: coldest.min },
    rainTotal: withRain.length ? Math.round(withRain.reduce((a, b) => a + b.precipSum, 0) * 10) / 10 : null,
    rainyDays: withRain.filter(x => x.precipSum >= 1).length,
  };
}

/** Past weather between two dates (inclusive), from 1940 up to yesterday; at most two years at a time. */
export async function history(lat, lon, from, to, { tz = null, signal, now = new Date() } = {}) {
  if (!ISO_DATE.test(from || '') || !ISO_DATE.test(to || '')) throw Object.assign(new Error('Give history dates as YYYY-MM-DD.'), { status: 400 });
  if (from > to) [from, to] = [to, from];
  const yesterday = addDays(localDate(tz, now), -1);
  if (from > yesterday) throw Object.assign(new Error('History covers days that are over; use the forecast for today and later.'), { status: 400 });
  if (to > yesterday) to = yesterday;
  if (from < HISTORY_FROM) from = HISTORY_FROM;
  if ((dayMs(to) - dayMs(from)) / 864e5 + 1 > HISTORY_DAYS_MAX) throw Object.assign(new Error(`Ask for at most ${HISTORY_DAYS_MAX} days of history at a time.`), { status: 400 });
  return { from, to, ...normalizeHistory(await cachedFetch(historyUrl(lat, lon, from, to), 12 * 3600000, { signal })) };
}

// ---- Words for get_weather ---------------------------------------------------------------------------------------------
export const uvWord = uv => (uv == null ? null : uv < 3 ? 'low' : uv < 6 ? 'moderate' : uv < 8 ? 'high' : uv < 11 ? 'very high' : 'extreme');
const r1 = x => (x == null ? '?' : Math.round(x));
/** "14:00 21°C partly cloudy, rain 30% · wind 14 km/h (gusts 30) · UV 5" */
export function hourRow(h, extra = []) {
  return [`${h.local || '??:??'} ${deg(h.temp)} ${h.label || ''}`.trim() + (h.precipProb != null ? `, rain ${h.precipProb}%` : '')
    + (h.precip ? ` (${Math.round(h.precip * 10) / 10} mm)` : ''),
  extra.includes('wind') && h.wind != null ? `wind ${r1(h.wind)} km/h${h.gusts != null ? ` (gusts ${r1(h.gusts)})` : ''}` : null,
  extra.includes('uv') && h.uv != null ? `UV ${Math.round(h.uv)}` : null].filter(Boolean).join(' · ');
}

/** The next `n` hours from a forecast, one row each. */
export function hoursAhead(f, extra = [], now = new Date(), n = 24) {
  const rows = f.hourly.filter(h => new Date(h.at) > new Date(now.getTime() - 3600000)).slice(0, n);
  return rows.length ? `Next ${rows.length} hours:\n${rows.map(h => `- ${hourRow(h, extra)}`).join('\n')}` : null;
}

/** UV and wind lines for today (current + the day's maxima), when asked for. */
export function extrasText(f, extra = [], now = new Date()) {
  const d = today(f, now);
  return [extra.includes('uv') && (d?.uvMax != null || f.current.uv != null)
    ? `UV: ${f.current.uv != null ? `now ${Math.round(f.current.uv)}` : ''}${d?.uvMax != null ? `${f.current.uv != null ? ', ' : ''}today's max ${Math.round(d.uvMax)} (${uvWord(d.uvMax)})` : ''}.` : null,
  extra.includes('wind') && (f.current.wind != null || d?.windMax != null)
    ? `Wind: now ${r1(f.current.wind)} km/h${f.current.gusts != null ? ` (gusts ${r1(f.current.gusts)})` : ''}${d?.windMax != null ? `; today up to ${r1(d.windMax)} km/h${d.gustsMax != null ? `, gusts ${r1(d.gustsMax)}` : ''}` : ''}.` : null,
  ].filter(Boolean).join('\n') || null;
}

const weekday = date => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(dayMs(date)));
/** One date: a summary line, then its hours (every 3 h, or every hour with hourly). */
export function dayText(name, fd, { hourly = false, extra = [] } = {}) {
  const d = fd.day;
  if (!d) return `${name}: no forecast for ${fd.date}.`;
  const head = `${name}, ${weekday(fd.date)}: ${deg(d.min)}–${deg(d.max)}, ${d.label}`
    + `${d.precipProb != null ? `, rain chance ${d.precipProb}%` : ''}${d.precipSum ? ` (${Math.round(d.precipSum * 10) / 10} mm)` : ''}.`
    + `${d.uvMax != null ? ` UV max ${Math.round(d.uvMax)} (${uvWord(d.uvMax)}).` : ''}`
    + `${d.windMax != null ? ` Wind up to ${r1(d.windMax)} km/h${d.gustsMax != null ? `, gusts ${r1(d.gustsMax)}` : ''}.` : ''}`
    + `${d.sunrise ? ` Sunrise ${hm(d.sunrise, fd.timezone)}, sunset ${hm(d.sunset, fd.timezone)}.` : ''}`;
  const hours = fd.hours.filter((h, i) => hourly || i % 3 === 0);
  return [head, hours.length ? `${hourly ? 'Hour by hour' : 'Every 3 hours'} (local time):\n${hours.map(h => `- ${hourRow(h, extra)}`).join('\n')}` : null]
    .filter(Boolean).join('\n');
}

/** Past weather: totals, then each day (≤ 31 days) or each month. */
export function historyText(name, h) {
  if (!h.days.length) return `${name}: the archive has no data for ${h.from} to ${h.to} yet (it runs a few days behind).`;
  const s = summarizeDays(h.days);
  const lines = [`${name}, ${h.from} to ${h.to} (past weather, ${s.days} day${s.days === 1 ? '' : 's'}):`,
    `Average high ${s.avgMax ?? '?'}°C, low ${s.avgMin ?? '?'}°C.${s.hottest ? ` Hottest ${s.hottest.date} (${deg(s.hottest.max)})` : ''}`
      + `${s.coldest ? `, coldest ${s.coldest.date} (${deg(s.coldest.min)}).` : ''}`
      + `${s.rainTotal != null ? ` Rain ${s.rainTotal} mm in total, ${s.rainyDays} day${s.rainyDays === 1 ? '' : 's'} with 1 mm or more.` : ''}`];
  if (h.days.length <= 31) {
    lines.push(...h.days.map(d => `- ${d.date} ${deg(d.min)}–${deg(d.max)}${d.label ? ` ${d.label}` : ''}${d.precipSum != null ? `, ${Math.round(d.precipSum * 10) / 10} mm` : ''}`));
  } else {
    const months = new Map();
    for (const d of h.days) { const k = d.date.slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(d); }
    for (const [m, ds] of months) {
      const ms = summarizeDays(ds);
      lines.push(`- ${m}: average high ${ms.avgMax ?? '?'}°C, low ${ms.avgMin ?? '?'}°C, rain ${ms.rainTotal ?? '?'} mm (${ms.rainyDays} wet day${ms.rainyDays === 1 ? '' : 's'})`);
    }
  }
  if (h.missing) lines.push(`(No archive data yet for ${h.missing} of the days asked for: the archive runs a few days behind.)`);
  return lines.join('\n');
}
