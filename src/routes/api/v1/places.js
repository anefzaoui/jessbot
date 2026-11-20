// Places + weather (Phase 7b, decisions #30/#49). Saving a place by name geocodes it; by coordinates (browser GPS)
// reverse-geocodes it. Both go through CloakBrowser.
import { Router } from 'express';
import { geocode, placeName, reverseGeocode, savePlace, placesOf, placeForUser, removePlace, primaryPlace, placeView } from '../../../services/places.js';
import * as weather from '../../../services/weather.js';
import { publish } from '../../../lib/bus.js';
import { invalid } from '../../../lib/errors.js';
import { getUser } from '../../../services/users.js';

const router = Router();

router.get('/me/places', (req, res) => res.json({ places: placesOf(req.user).map(placeView) }));

router.get('/places/search', async (req, res) => {
  const results = await geocode(req.query.q);
  res.json({ results: results.map(r => ({ ...r, label: placeName(r) })) });
});

router.post('/me/places', async (req, res) => {
  const b = req.body || {};
  let place;
  if (b.latitude != null && b.longitude != null) {
    const lat = Number(b.latitude), lon = Number(b.longitude);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw invalid({ query: 'Those coordinates look wrong.' });
    const [{ name, countryCode }, f] = await Promise.all([reverseGeocode(lat, lon), weather.forecast(lat, lon).catch(() => null)]);
    place = savePlace(req.user, { label: b.label || 'home', name, latitude: lat, longitude: lon, timezone: f?.timezone, countryCode, source: 'gps' });
  } else {
    const [best] = await geocode(b.query);
    if (!best) throw invalid({ query: 'I couldn’t find that place — try adding the country.' });
    place = savePlace(req.user, { label: b.label || 'home', name: placeName(best), latitude: best.latitude, longitude: best.longitude,
      timezone: best.timezone, countryCode: best.countryCode, source: 'settings' });
  }
  const f = await weather.forecast(place.latitude, place.longitude).catch(() => null);
  if (f && place.is_primary) publish(req.user.id, 'weather.updated', { sky: weather.sky(f), place: place.name }, { persist: false });
  res.status(201).json({ place: placeView(place), user: { timezone: getUser(req.user.id).timezone }, weather: f ? weather.describe(f) : null });
});

router.delete('/me/places/:id', (req, res) => {
  removePlace(placeForUser(req.user, req.params.id));
  res.json({ ok: true });
});

router.get('/weather', async (req, res) => {
  const home = primaryPlace(req.user);
  if (!home) return res.json({ place: null, forecast: null, credit: weather.CREDIT });
  const f = await weather.forecast(home.latitude, home.longitude).catch(() => weather.cachedForecast(home.latitude, home.longitude));
  res.json({ place: placeView(home), forecast: f, summary: f ? weather.describe(f) : null, credit: weather.CREDIT });
});

export default router;
