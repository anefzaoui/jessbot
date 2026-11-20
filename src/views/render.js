// Render partials outside a request (realtime events, background jobs) with the same engine, helpers and
// page context (bot, presence) as full pages — "one source of markup" (docs/UI.md).
import { settings } from '../db/index.js';
import { presenceFor } from '../services/presence.js';
import { skyOf } from '../services/weather.js';
import { voiceOn } from '../services/voice.js';

let app;
export const configureRenderer = expressApp => { app = expressApp; };

// Page-level context a partial may reference via @root (bot name, living presence).
export function fragmentLocals(user) {
  const bot = { name: 'Jessbot', ...settings.get('bot', {}) };
  return { bot, presence: presenceFor({ bot, user, weather: skyOf(user) }), user, voiceOn: voiceOn() };
}

export async function renderFragment(partial, data, user) {
  if (!app) throw new Error('renderer not configured');
  return new Promise((resolve, reject) =>
    app.render('fragment', { layout: false, partial, data, ...fragmentLocals(user), ...data },
      (err, html) => (err ? reject(err) : resolve(html))));
}
