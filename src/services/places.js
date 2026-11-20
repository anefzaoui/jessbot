// Where people are (decisions #30, #49): home (primary), work, or a custom label. Names come from Open-Meteo geocoding;
// browser GPS positions get their name from OpenStreetMap Nominatim (rare, cached by the weather cache key, through
// the browser like every other request). A home place also fixes the person's timezone when it was unknown/unreliable.
import { get, all, run } from '../db/index.js';
import { fetchJson } from '../browser/read.js';
import { invalid, notFound } from '../lib/errors.js';
import { validTimezone } from '../lib/when.js';
import { oneLine } from '../lib/untrusted.js';

const LABEL_RE = /^[\p{L}\p{N} _-]{1,24}$/u;

/** "Lyon" → [{ name, region, country, countryCode, latitude, longitude, timezone, population }] (best first). */
export async function geocode(query, { count = 5 } = {}) {
  const q = String(query || '').trim().slice(0, 120);
  if (q.length < 2) throw invalid({ query: 'Type a town or city.' });
  const url = 'https://geocoding-api.open-meteo.com/v1/search?' + new URLSearchParams({ name: q.split(',')[0].trim(), count: '10', language: 'en', format: 'json' });
  const data = await fetchJson(url);
  const hint = q.split(',').slice(1).join(' ').trim().toLowerCase();
  const results = (data.results || []).map(r => ({
    name: r.name, region: r.admin1 || null, country: r.country || null, countryCode: r.country_code || null,
    latitude: r.latitude, longitude: r.longitude, timezone: r.timezone || null, population: r.population || 0,
  }));
  // "Paris, Texas": prefer results whose region/country matches what came after the comma.
  if (hint) results.sort((a, b) => Number(!`${a.region} ${a.country} ${a.countryCode}`.toLowerCase().includes(hint))
    - Number(!`${b.region} ${b.country} ${b.countryCode}`.toLowerCase().includes(hint)));
  return results.slice(0, count);
}

// Names come from community-edited map data (#40, decision #238): each part one clean line, the whole capped.
export const placeName = r => oneLine([r.name, r.region && r.region !== r.name ? r.region : null, r.country]
  .map(x => (x ? oneLine(x, 60) : null)).filter(Boolean).join(', '), PLACE_NAME_MAX);
export const PLACE_NAME_MAX = 120;

/** Coordinates → a readable place (best effort; falls back to the coordinates). */
export async function reverseGeocode(lat, lon) {
  try {
    const url = 'https://nominatim.openstreetmap.org/reverse?' + new URLSearchParams({ format: 'jsonv2', lat: String(lat), lon: String(lon), zoom: '10', 'accept-language': 'en' });
    const d = await fetchJson(url);
    const a = d.address || {};
    const town = a.city || a.town || a.village || a.municipality || a.county;
    return { name: oneLine([town, a.state, a.country].filter(Boolean).join(', ') || d.display_name, PLACE_NAME_MAX) || `Near ${Number(lat).toFixed(2)}, ${Number(lon).toFixed(2)}`,
      countryCode: a.country_code?.toUpperCase() || null };
  } catch {
    return { name: `Near ${Number(lat).toFixed(2)}, ${Number(lon).toFixed(2)}`, countryCode: null };
  }
}

export const placesOf = user => all('SELECT * FROM places WHERE user_id = ? ORDER BY is_primary DESC, label', user.id);
export const primaryPlace = user => get('SELECT * FROM places WHERE user_id = ? AND is_primary = 1', user.id)
  || get('SELECT * FROM places WHERE user_id = ? ORDER BY id LIMIT 1', user.id) || null;

export function placeForUser(user, id) {
  const p = get('SELECT * FROM places WHERE id = ?', Number(id));
  if (!p || p.user_id !== user.id) throw notFound('That place isn’t saved.');
  return p;
}

/** Save (or replace) the place with this label. Home becomes primary; the first place saved is primary too. */
export function savePlace(user, { label = 'home', name, latitude, longitude, timezone = null, countryCode = null, source = 'chat' }) {
  const l = String(label || 'home').trim().toLowerCase();
  if (!LABEL_RE.test(l)) throw invalid({ label: 'Use a short label like home, work or school.' });
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) throw invalid({ query: 'I couldn’t find that place.' });
  const hasPrimary = !!get('SELECT 1 FROM places WHERE user_id = ? AND is_primary = 1 AND label != ?', user.id, l);
  const primary = l === 'home' || !hasPrimary ? 1 : 0;
  if (primary) run('UPDATE places SET is_primary = 0 WHERE user_id = ?', user.id);
  run(`INSERT INTO places (user_id, label, name, latitude, longitude, timezone, country_code, source, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, label) DO UPDATE SET name = excluded.name, latitude = excluded.latitude, longitude = excluded.longitude,
         timezone = excluded.timezone, country_code = excluded.country_code, source = excluded.source, is_primary = excluded.is_primary,
         alerted_key = NULL, updated_at = datetime('now')`,
  user.id, l, String(name).slice(0, 160), Number(latitude), Number(longitude), validTimezone(timezone) ? timezone : null,
  countryCode ? String(countryCode).toUpperCase().slice(0, 2) : null, source, primary);
  // Home decides the person's clock when theirs is missing or a fixed-offset guess (e.g. Windows' "Etc/GMT-1").
  if (primary && validTimezone(timezone) && (!validTimezone(user.timezone) || /^Etc\//.test(user.timezone) || l === 'home')) {
    run('UPDATE users SET timezone = ? WHERE id = ?', timezone, user.id);
  }
  return get('SELECT * FROM places WHERE user_id = ? AND label = ?', user.id, l);
}

export function removePlace(place) {
  run('DELETE FROM places WHERE id = ?', place.id);
  if (place.is_primary) run(`UPDATE places SET is_primary = 1 WHERE id = (SELECT id FROM places WHERE user_id = ? ORDER BY id LIMIT 1)`, place.user_id);
}

export const markAlerted = (place, key) => run('UPDATE places SET alerted_key = ? WHERE id = ?', key, place.id);

export const placeView = p => ({ id: p.id, label: p.label, name: p.name, latitude: p.latitude, longitude: p.longitude, timezone: p.timezone, primary: !!p.is_primary, source: p.source });
