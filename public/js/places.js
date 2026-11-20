// You → Where you live: "Use my location" (browser GPS → server names it) and refresh after saving a place.
import { $, on, api, withBusy } from './core.js';
import { toast } from './toast.js';

export function initPlaces() {
  const form = $('[data-places-form]');
  if (!form) return;
  form.addEventListener('ajax:success', () => location.reload());

  on(document, 'click', '[data-use-location]', async (e, btn) => {
    if (!('geolocation' in navigator)) return toast.error('This browser can’t share its location.');
    await withBusy(btn, () => new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(async pos => {
        try {
          const res = await api('/api/v1/me/places', { method: 'POST', body: {
            latitude: pos.coords.latitude, longitude: pos.coords.longitude, label: form.label.value } });
          toast.success(`Saved ${res.place.name}.`);
          setTimeout(() => location.reload(), 600);
        } catch (err) { toast.error(err.message, { title: 'Couldn’t save your location' }); }
        resolve();
      }, err => {
        toast.error(err.code === 1 ? 'Location permission was declined. Type your town instead.' : 'Couldn’t get your location (it needs HTTPS or localhost).');
        resolve();
      }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
    }), 'Locating…');
  });
}
