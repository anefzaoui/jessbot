// The living presence (decision #33): which portrait frames exist, which sky scene fits "now", and where the
// images live. Shared rules with public/js/presence.js (timeOfDay/sceneFor are duplicated there on purpose —
// the client re-evaluates every minute without a round trip; both read the same presence.json).
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/index.js';
import { openRead } from '../lib/safe-path.js';
import { pictureChoices, pictureBase } from './assistant-pictures.js';

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

/**
 * The web app manifest (#55, decision #253): Jessbot installs on a phone's home screen or as a desktop app under the
 * assistant's name. The icons are the logo (#39, `public/img/app/`, copies of docs/images/brand's) for the default look,
 * else that look's own neutral portrait; never an uploaded picture, which is served behind sign-in (the browser fetches
 * the manifest and its icons without the session cookie).
 */
export function webManifest(bot = {}) {
  const name = String(bot?.name || '').trim() || 'Jessbot'; // the page title's own default (middleware/locals.js)
  const look = bot?.variant && bot.variant !== 'female' && variantFrames(bot.variant).length ? bot.variant : null;
  const icons = look
    ? [{ src: `/img/avatars/${look}/neutral-256.webp`, sizes: '256x256', type: 'image/webp' },
      { src: `/img/avatars/${look}/neutral.webp`, sizes: '1024x1024', type: 'image/webp' }]
    : [{ src: '/img/app/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/img/app/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/img/app/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }];
  return { id: '/', name, short_name: name, description: `${name}, your household's assistant (Jessbot).`, start_url: '/', scope: '/',
    display: 'standalone', background_color: '#faf9f7', theme_color: '#faf9f7', icons };
}

// Presence data for templates (res.locals.presence). weather = services/weather.sky() of the person's home, or null (clear).
// The admin's pictures (#7, services/assistant-pictures.js) replace the built-in art only for signed-in people: their
// files are served behind sign-in, so the sign-in and invite pages keep the built-in look.
//   avatarBase/sceneBase: where frames and scenes load from ("<base>/<frame>[-256].webp", "<base>/<scene>[-256].webp")
//   pinned: the background doesn't follow the clock (a picked scene or an upload) · liveScene: the sky right now, always
//   cover: { url, live } for the chat header and the Feed greeting (live: it follows the sky)
export function presenceFor({ bot, user, weather } = {}) {
  const pics = user ? pictureChoices() : { avatar: { kind: 'look' }, background: { kind: 'sky' }, cover: { kind: 'sky' } };
  const look = variantFrames(bot?.variant).length ? bot.variant : null;
  const upload = pics.avatar.kind === 'upload';
  const variant = upload ? look || 'custom' : look;
  const time = timeOfDay({ timeZone: user?.timezone || undefined, sunrise: weather?.sunrise, sunset: weather?.sunset });
  const w = weather?.bucket || 'clear';
  const liveScene = sceneFor({ time, weather: w });
  const bg = pics.background;
  const scene = bg.kind === 'upload' ? 'picture' : bg.kind === 'scene' ? bg.scene : liveScene;
  const cv = pics.cover;
  const cover = cv.kind === 'upload' ? { url: `${pictureBase('cover', cv.id)}/picture.webp`, live: false }
    : cv.kind === 'scene' ? { url: `/img/scenes/${cv.scene}.webp`, live: false }
    : { url: liveScene ? `/img/scenes/${liveScene}.webp` : null, live: true };
  return {
    variant, time, weather: w, scene, liveScene, pinned: bg.kind !== 'sky', cover,
    sceneBase: bg.kind === 'upload' ? pictureBase('background', bg.id) : '/img/scenes',
    avatarBase: upload ? pictureBase('avatar', pics.avatar.id) : look ? `/img/avatars/${look}` : null, avatarUpload: upload,
    sunrise: weather?.sunrise || null, sunset: weather?.sunset || null,
    temp: weather?.temp ?? null, weatherLabel: weather?.label || null,
    frames: upload ? ['neutral'] : variant ? variantFrames(variant) : [],
  };
}
