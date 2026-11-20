// The living presence (decision #33). Every [data-presence] avatar on the page shares one "soul" state:
//   activity → base expression · moments → brief reactions · typing → listening · idle → blinks & glances
//   · time of day (+ weather) → sky scene. Frames are crossfaded between two stacked <img> layers.
// Motion is decorative except state changes: with prefers-reduced-motion only expressions/scenes change.
import { $$, on, reducedMotion, icon, escapeHtml } from './core.js';
import { activityOf, MOMENTS } from './activities.js';

const soul = {
  activity: 'resting',
  base: 'neutral',      // expression implied by the activity
  moment: null,         // temporary reaction frame
  listening: false,
  shown: new WeakMap(), // element → frame currently displayed
};
let manifest = { avatars: {}, scenes: [] };
let timers = [];

const els = () => $$('[data-presence]');
const hasFrame = (variant, f) => manifest.avatars?.[variant]?.includes(f);
const frameUrl = (el, f) => `/img/avatars/${el.dataset.variant}/${f}${el.dataset.res || ''}.webp`;
const sceneUrl = (el, s) => `/img/scenes/${s}${el.dataset.res || ''}.webp`;

// Swap one layer group (portrait or scene) to a new image WITHOUT a see-through dip:
// the incoming frame fades in ON TOP of the fully-opaque current frame; the old frame is hidden only after the
// fade completes. (A symmetric crossfade leaves both layers semi-transparent mid-way, so the sky shows through
// the face — that was the white flash / flicker on blinks.) A token cancels superseded swaps (blink → back).
async function swap(group, url, fade) {
  const [a, b] = group.querySelectorAll('img');
  const top = group._top || (b.classList.contains('is-shown') ? b : a);
  group._top = top;
  const token = (group._token = (group._token || 0) + 1); // cancels any swap still decoding
  if (top.getAttribute('src') === url) return;          // already showing it
  const next = top === a ? b : a;
  if (next.getAttribute('src') !== url) next.src = url;
  try { await next.decode(); } catch { return; }       // missing frame → keep what we have
  if (token !== group._token) return;                   // a newer swap won
  clearTimeout(group._cleanup);
  next.style.transition = 'none';
  next.style.opacity = '0';
  next.style.zIndex = '2';
  top.style.zIndex = '1';
  top.style.transition = 'none';
  top.style.opacity = '1';                              // current frame stays solid underneath
  void next.offsetWidth;                                // commit the start state
  next.style.transition = `opacity ${fade}ms ease-out`;
  next.style.opacity = '1';
  next.classList.add('is-shown');
  group._top = next;
  group._cleanup = setTimeout(() => {
    if (group._top !== next) return;
    top.classList.remove('is-shown');
    top.style.opacity = '0';                            // hidden instantly, already fully covered
  }, fade + 40);
}

// Decode frames ahead of time so a swap never waits on the network or the decoder.
const warmed = new Set();
function warm(url) {
  if (warmed.has(url)) return;
  warmed.add(url);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  img.decode?.().catch(() => warmed.delete(url));
}
function warmFrames(frames, idle = false) {
  const run = () => { for (const el of els()) for (const f of frames) if (hasFrame(el.dataset.variant, f)) warm(frameUrl(el, f)); };
  if (idle && 'requestIdleCallback' in window) requestIdleCallback(run, { timeout: 4000 }); else run();
}

function show(frame, fade = 450) {
  for (const el of els()) {
    const f = hasFrame(el.dataset.variant, frame) ? frame : (hasFrame(el.dataset.variant, soul.base) ? soul.base : 'neutral');
    if (soul.shown.get(el) === f) continue;
    soul.shown.set(el, f);
    swap(el.querySelector('.presence-portrait'), frameUrl(el, f), fade);
  }
}

// What she should look like right now (priority: moment > listening > activity).
const current = () => soul.moment || (soul.listening && soul.activity === 'resting' ? 'life-listening' : soul.base);
const render = (fade) => show(current(), fade);

// ---- Public API ------------------------------------------------------------------------
export function setPresenceActivity(activity) {
  soul.activity = activity;
  soul.base = activityOf(activity).emotion;
  render(500);
}

// Brief reaction: presenceMoment('done') → proud for a few seconds, then back.
let momentTimer;
export function presenceMoment(kind, ms = 3200) {
  const frame = MOMENTS[kind] || kind;
  soul.moment = frame;
  render(380);
  clearTimeout(momentTimer);
  momentTimer = setTimeout(() => { soul.moment = null; render(700); }, ms);
}

// Switch every presence to another character (setup identity picker, admin identity edits).
export function setPresenceVariant(variant) {
  if (!manifest.avatars?.[variant]) return;
  for (const el of els()) el.dataset.variant = variant;
  soul.shown = new WeakMap();
  warmFrames(manifest.avatars[variant], true);
  presenceMoment('greeting', 2200); // a friendly hello from the newly chosen face
}

// ---- Idle life: blinks and glances ----------------------------------------------------------
const rand = (a, b) => a + Math.random() * (b - a);
const eyesOpen = () => !['sleepy', 'life-blink'].includes(current());

function scheduleBlink() {
  timers.push(setTimeout(async () => {
    if (document.visibilityState === 'visible' && eyesOpen() && !soul.moment) {
      const back = current();
      show('life-blink', 70);
      await new Promise(r => setTimeout(r, 120));
      show(back, 110);
      // Occasionally a double blink, like people do.
      if (Math.random() < 0.18) { await new Promise(r => setTimeout(r, 260)); show('life-blink', 70); await new Promise(r => setTimeout(r, 110)); show(back, 110); }
    }
    scheduleBlink();
  }, rand(2800, 7200)));
}

function scheduleGlance() {
  timers.push(setTimeout(async () => {
    const calm = ['neutral', 'focused', 'thinking'].includes(current()) && !soul.listening && !soul.moment;
    if (document.visibilityState === 'visible' && calm) {
      const back = current();
      show(Math.random() < 0.5 ? 'life-glance-left' : 'life-glance-right', 320);
      await new Promise(r => setTimeout(r, rand(900, 1700)));
      if (!soul.moment && !soul.listening) show(back, 360);
    }
    scheduleGlance();
  }, rand(12000, 26000)));
}

// ---- Listening while the person types ------------------------------------------------------
let listenTimer;
function listen() {
  if (!soul.listening) { soul.listening = true; render(520); }
  clearTimeout(listenTimer);
  listenTimer = setTimeout(() => { soul.listening = false; render(700); }, 2600);
}

// ---- Sky scene: time of day (viewer's clock) × weather ---------------------------------------
// With the home's real sunrise/sunset (server, from the forecast): dawn/dusk = ±45 min around them. Otherwise the clock.
function timeOfDay(d = new Date(), el = null) {
  const rise = Date.parse(el?.dataset.sunrise || ''), set = Date.parse(el?.dataset.sunset || '');
  if (rise && set && Math.abs(d - rise) < 20 * 3600e3) {
    const w = 45 * 60e3, t = d.getTime();
    if (Math.abs(t - rise) <= w) return 'dawn';
    if (Math.abs(t - set) <= w) return 'dusk';
    return t > rise && t < set ? 'day' : 'night';
  }
  const h = d.getHours() + d.getMinutes() / 60;
  return h >= 5.5 && h < 7 ? 'dawn' : h >= 7 && h < 18.5 ? 'day' : h >= 18.5 && h < 20 ? 'dusk' : 'night';
}
function sceneFor(time, weather) {
  const have = new Set(manifest.scenes || []);
  return [`${time}-${weather}`, `${time}-clear`, 'day-clear'].find(s => have.has(s)) || null;
}
export function updateScene({ weather, sunrise, sunset } = {}) {
  for (const el of els()) {
    if (el.hasAttribute('data-pinned')) continue; // demo/test scenes stay as rendered
    if (weather) el.dataset.weather = weather;
    if (sunrise && sunset) { el.dataset.sunrise = sunrise; el.dataset.sunset = sunset; }
    const time = timeOfDay(new Date(), el);
    el.dataset.time = time;
    const scene = sceneFor(time, el.dataset.weather || 'clear');
    if (scene && scene !== el.dataset.scene) {
      el.dataset.scene = scene;
      swap(el.querySelector('.presence-scene'), sceneUrl(el, scene), 1400);
    }
  }
  // Sky headers (chat) follow the same scene as the avatar.
  const scene = els().find(el => !el.hasAttribute('data-pinned'))?.dataset.scene;
  if (scene) for (const sky of document.querySelectorAll('[data-sky]')) sky.style.setProperty('--scene', `url('/img/scenes/${scene}.webp')`);
}

// Weather chip in the chat header (server-rendered; refreshed live from weather.updated).
const WEATHER_ICON = { clear: ['sun', 'moon'], cloudy: ['cloud-sun', 'cloud-moon'], rain: ['cloud-rain'], snow: ['snowflake'], storm: ['cloud-lightning'], fog: ['cloud-fog'] };
function updateWeatherChip(sky, place) {
  const chip = document.querySelector('[data-now-weather]');
  if (!chip || !sky) return;
  const night = sky.sunrise && sky.sunset && (Date.now() < Date.parse(sky.sunrise) || Date.now() > Date.parse(sky.sunset));
  const icons = WEATHER_ICON[sky.bucket] || WEATHER_ICON.clear;
  chip.title = `${sky.label} · ${place || ''}`;
  chip.innerHTML = `${icon(icons[night ? icons.length - 1 : 0], 'size-4')}<span class="tabular font-semibold">${Math.round(sky.temp)}°</span><span class="hidden sm:inline">${escapeHtml(String(place || '').split(',')[0])}</span>`;
}

// ---- Boot ---------------------------------------------------------------------------------------
export async function initPresence() {
  if (!els().length) return;
  try { manifest = await (await fetch('/img/presence.json', { cache: 'force-cache' })).json(); } catch { /* keep defaults */ }
  const first = els()[0];
  soul.activity = first.dataset.activity || 'resting';
  soul.base = activityOf(soul.activity).emotion;

  // Decode idle frames now (blinks start within seconds), every other expression when the browser is idle.
  warmFrames(['life-blink', 'life-glance-left', 'life-glance-right', 'life-listening', 'happy']);
  warmFrames(manifest.avatars?.[first.dataset.variant] || [], true);

  document.addEventListener('jb:activity', e => setPresenceActivity(e.detail.activity));
  document.addEventListener('jb:variant', e => setPresenceVariant(e.detail.variant));
  document.addEventListener('jb:moment', e => presenceMoment(e.detail.kind));
  on(document, 'input', '[data-composer-input], [data-ask-dock] input, [data-ask-dock] textarea', listen);

  updateScene();
  setInterval(updateScene, 60_000);
  // The server refreshed the forecast for this person's home (every 30 min, or when they set a place).
  document.addEventListener('jb:ws:weather.updated', e => {
    const s = e.detail.data.sky;
    if (!s) return;
    updateScene({ weather: s.bucket, sunrise: s.sunrise, sunset: s.sunset });
    updateWeatherChip(s, e.detail.data.place);
  });

  if (!reducedMotion()) { scheduleBlink(); scheduleGlance(); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateScene(); });

  // A warm hello once per browser session.
  try {
    if (!sessionStorage.getItem('jb-greeted')) { sessionStorage.setItem('jb-greeted', '1'); setTimeout(() => presenceMoment('greeting', 2600), 600); }
  } catch { /* private mode */ }
}
