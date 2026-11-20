import { settings } from '../db/index.js';
import { presenceFor } from '../services/presence.js';
import { skyOf } from '../services/weather.js';
import { assetVersion } from '../lib/assets.js';
import { availableLocales, pickLocale, directionOf, clientCatalog } from '../lib/i18n.js';
import { readCookie } from './auth.js';
import { voiceOn } from '../services/voice.js';
import { shellFor } from '../services/shell.js';
import { latestSeq } from '../lib/bus.js';
import { ACCEPT as UPLOAD_ACCEPT } from '../services/uploads.js';

// Primary destinations (rail + mobile tab bar). Counts are filled per request once services exist.
export const NAV_ITEMS = [
  { key: 'chat', href: '/chat', label: 'Chat', iconName: 'message-circle' },
  { key: 'feed', href: '/feed', label: 'Feed', iconName: 'newspaper' },
  { key: 'ideas', href: '/ideas', label: 'Ideas', iconName: 'lightbulb' },
  { key: 'goals', href: '/goals', label: 'Goals', iconName: 'target' },
  { key: 'lists', href: '/lists', label: 'Lists', iconName: 'list-checks' },
  { key: 'library', href: '/library', label: 'Library', iconName: 'library' },
];

// Shell contract (rail, tab bar, right panel, status). Pages may override any part via res.locals.shell.
export function emptyShell() {
  return {
    navItems: NAV_ITEMS.map(n => ({ ...n, count: 0 })),
    agent: { activity: 'resting', doneToday: 0, upcomingCount: 0 },
    counts: { approvals: 0 },
    projects: [],
    sideChats: [],
    panel: { activity: [], approvals: [], upcoming: { alarms: [], jobs: [] } },
    ringing: [],
    usage: null,
  };
}

// The language (#14, lib/i18n.js): ?lang=xx (remembered in a cookie), else the cookie, else the browser's
// Accept-Language; only languages that have a catalog are picked, else English.
const LANG_COOKIE = 'jb_lang';
function localeOf(req, res) {
  const asked = typeof req.query?.lang === 'string' ? req.query.lang : null;
  if (asked && availableLocales().includes(asked)) {
    res.cookie(LANG_COOKIE, asked, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 365 * 864e5 });
    return asked;
  }
  const saved = readCookie(req, LANG_COOKIE);
  if (saved && availableLocales().includes(saved)) return saved;
  return pickLocale(req.get('accept-language'));
}

// Values every template can rely on.
export function locals(req, res, next) {
  res.locals.locale = localeOf(req, res);
  res.locals.dir = directionOf(res.locals.locale);
  res.locals.i18nCatalog = JSON.stringify(clientCatalog(res.locals.locale)).replace(/</g, '\\u003c');
  const bot = settings.get('bot', null);
  res.locals.bot = { name: 'Jessbot', ...bot };
  res.locals.path = req.path;
  res.locals.isDev = process.env.NODE_ENV !== 'production';
  res.locals.user = req.user || null;
  res.locals.voiceOn = voiceOn(); // the mic and Listen buttons (#11: OpenRouter only)
  res.locals.assetV = assetVersion(); // fingerprint for css / icons / main.js (decision #51)
  res.locals.uploadAccept = UPLOAD_ACCEPT; // the file pickers' accept list: one definition, services/uploads.js
  res.locals.shell = req.user ? shellFor(req.user) : emptyShell();
  res.locals.seq = req.user ? latestSeq(req.user.id) : null; // realtime resume point for this render
  res.locals.presence = presenceFor({ bot: res.locals.bot, user: res.locals.user, weather: skyOf(res.locals.user) });
  next();
}
