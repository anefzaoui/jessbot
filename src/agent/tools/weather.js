// Place + weather tools (Phase 7b, decisions #30/#49; by day and hour, UV, wind and history #140). Weather comes from
// Open-Meteo through CloakBrowser.
import { registerTool } from './registry.js';
import { geocode, placeName, savePlace, primaryPlace } from '../../services/places.js';
import * as weather from '../../services/weather.js';
import { publish } from '../../lib/bus.js';

const summary = (name, f) => [
  `${name}: ${weather.describe(f)}`, weather.outlook(f), weather.tomorrowLine(f),
  `Next days: ${f.daily.slice(1, 5).map(d => `${d.date.slice(5)} ${Math.round(d.min)}–${Math.round(d.max)}°C ${d.label}${d.precipProb != null ? ` ${d.precipProb}%` : ''}`).join('; ')}.`,
].filter(Boolean).join('\n');

registerTool({
  name: 'set_location', toolset: 'memory', risk: 'write', activity: 'remembering', iconName: 'map-pin-house', activityKind: 'memory',
  persistent: true, // their home sets their timezone and every weather answer: asks first after outside content (#124)
  description: 'Save where the person lives (label "home") or another place they care about ("work", "school", …). Use when they '
    + 'tell you, e.g. "I live in Lyon". Their home drives weather, local suggestions, your sky and their timezone. Private to them.',
  parameters: {
    type: 'object', required: ['place'], additionalProperties: false,
    properties: {
      place: { type: 'string', description: 'Town or city, optionally with region/country: "Lyon", "Paris, Texas".' },
      label: { type: 'string', description: 'home (default), work, school, … (one short word).' },
    },
  },
  label: args => `Saved ${args.label && args.label !== 'home' ? `${args.label} location` : 'where you live'}`,
  target: args => String(args.place || '').slice(0, 40),
  run: async (args, ctx) => {
    const [best, ...others] = await geocode(args.place);
    if (!best) return `I couldn't find “${args.place}”. Ask them for the nearest town, or add the country.`;
    const p = savePlace(ctx.user, { label: args.label || 'home', name: placeName(best), latitude: best.latitude, longitude: best.longitude,
      timezone: best.timezone, countryCode: best.countryCode, source: 'chat' });
    let line = '';
    try {
      const f = await weather.forecast(p.latitude, p.longitude, { signal: ctx.signal });
      if (p.is_primary) publish(ctx.user.id, 'weather.updated', { sky: weather.sky(f), place: p.name }, { persist: false });
      line = ` Weather there now: ${weather.describe(f)}`;
    } catch { /* weather is a bonus here */ }
    return {
      content: `Saved ${p.label} = ${p.name} (timezone ${p.timezone || 'unknown'}).${line}`
        + (others.length ? ` Other matches were: ${others.slice(0, 3).map(placeName).join('; ')} — if they meant one of those, save again with region/country.` : ''),
      step: { detail: p.name, href: '/me/places' },
    };
  },
});

// Where the weather is for: a named place (geocoded) or their home. → { name, lat, lon, tz } or a message for the model.
async function placeFor(args, ctx) {
  if (args.place) {
    const [best] = await geocode(args.place);
    if (!best) return `I couldn't find “${args.place}”.`;
    return { name: placeName(best), lat: best.latitude, lon: best.longitude, tz: best.timezone };
  }
  const home = primaryPlace(ctx.user);
  if (!home) return 'I don’t know where they live yet — ask, then save it with set_location.';
  return { name: home.name, lat: home.latitude, lon: home.longitude, tz: home.timezone || ctx.user.timezone };
}
const CREDIT_LINE = '(Weather data by Open-Meteo.com)';

registerTool({
  name: 'get_weather', toolset: 'core', risk: 'read', activity: 'browsing', iconName: 'cloud-sun',
  description: 'Weather for the person’s home (default) or any named place. With no options: now and the next days. `day`: one date '
    + 'hour by hour, up to 16 days ahead ("Saturday at the beach?", "when does the rain stop tomorrow?"). `hourly`: hour by hour (the '
    + 'next 24 hours, or every hour of `day`). `extra`: add the UV index and/or wind and gusts. `history`: past weather between two '
    + 'dates, 1940 to yesterday, at most two years ("how hot was last August?"). Use before planning outdoor things, travel, clothes, '
    + 'or when they ask.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      place: { type: 'string', description: 'Optional town/city; omit for their home.' },
      day: { type: 'string', description: 'One date: YYYY-MM-DD, "today", "tomorrow" or a weekday name (the next one).' },
      hourly: { type: 'boolean', description: 'Hour by hour instead of the summary (every hour of `day`, or the next 24 hours).' },
      extra: { type: 'array', items: { type: 'string', enum: ['uv', 'wind'] }, description: 'Also give the UV index and/or wind speed and gusts.' },
      history: {
        type: 'object', additionalProperties: false, required: ['from', 'to'], description: 'Past weather between two dates.',
        properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD (inclusive)' } },
      },
    },
  },
  label: args => `Checked ${args.history ? 'past weather' : 'the weather'}${args.place ? ` in ${String(args.place).slice(0, 30)}` : ''}${args.day ? ` for ${String(args.day).slice(0, 12)}` : ''}`,
  target: args => args.place || 'home',
  run: async (args, ctx) => {
    const at = await placeFor(args, ctx);
    if (typeof at === 'string') return at;
    const extra = Array.isArray(args.extra) ? args.extra.filter(x => ['uv', 'wind'].includes(x)) : [];
    try {
      if (args.history) {
        const h = await weather.history(at.lat, at.lon, args.history.from, args.history.to, { tz: at.tz, signal: ctx.signal });
        return { content: `${weather.historyText(at.name, h)}\n${CREDIT_LINE}`, step: { detail: `${h.from} to ${h.to}` } };
      }
      if (args.day) {
        const date = weather.resolveDay(args.day, at.tz);
        if (!date) return `“${args.day}” isn’t a day I can read — use YYYY-MM-DD, today, tomorrow or a weekday.`;
        const fd = await weather.forecastDay(at.lat, at.lon, date, { tz: at.tz, signal: ctx.signal });
        return { content: `${weather.dayText(at.name, fd, { hourly: !!args.hourly, extra })}\n${CREDIT_LINE}`,
          step: { detail: fd.day ? `${date}: ${Math.round(fd.day.min)}–${Math.round(fd.day.max)}°C, ${fd.day.label}` : date } };
      }
    } catch (err) {
      if (err.status === 400) return err.message; // out of range, bad date: the model can fix the call or tell them
      throw err;
    }
    const f = await weather.forecast(at.lat, at.lon, { signal: ctx.signal });
    const parts = [summary(at.name, f), weather.extrasText(f, extra), args.hourly ? weather.hoursAhead(f, extra) : null, CREDIT_LINE];
    return { content: parts.filter(Boolean).join('\n'), step: { detail: `${Math.round(f.current.temp)}°C, ${f.current.label}` } };
  },
});
