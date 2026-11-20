import Handlebars from 'handlebars';
import { renderMarkdown } from '../lib/markdown.js';
import { ACTIVITIES, describe, activityOf } from '../../public/js/activities.js';
import { presenceManifest } from '../services/presence.js';
import { validTimezone, defaultTimezone } from '../lib/when.js';
import { assetVersion } from '../lib/assets.js';

const { SafeString, escapeExpression: esc } = Handlebars;

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const UNITS = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5], ['day', 864e5],
  ['hour', 36e5], ['minute', 6e4], ['second', 1e3]];

// The person the page is rendered for (pages: res.locals.user; fragments: fragmentLocals) → their timezone.
function viewerTz(options) {
  const tz = options?.data?.root?.user?.timezone;
  return validTimezone(tz) ? tz : defaultTimezone();
}

function toDate(v) {
  if (v instanceof Date) return v;
  // SQLite datetime('now') is UTC without a zone marker.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v)) return new Date(v.replace(' ', 'T') + 'Z');
  return new Date(v);
}

const helpers = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  and: (...args) => args.slice(0, -1).every(Boolean),
  or: (...args) => args.slice(0, -1).some(Boolean),
  not: v => !v,
  iff: (cond, a, b) => (cond ? a : b),
  array: (...args) => args.slice(0, -1),
  includes: (arr, v) => Array.isArray(arr) && arr.includes(v),
  startsWith: (s, prefix) => typeof prefix === 'string' && String(s ?? '').startsWith(prefix),
  obj: options => ({ ...options.hash }),
  gt: (a, b) => a > b,
  default: (v, fallback) => (v ?? '') === '' ? fallback : v,
  // Agent activity vocabulary (public/js/activities.js is the single source of truth).
  activityIcon: key => activityOf(key).iconName,
  activityAvatar: key => activityOf(key).avatar,
  activityTone: key => activityOf(key).tone,
  describeActivity: (key, target) => describe(key, typeof target === 'string' ? target : undefined),
  isActivity: key => key in ACTIVITIES,
  // Living presence: the emotion frame for an activity (falls back to neutral if that frame doesn't exist yet).
  presenceFrame(presence, activity) {
    const want = activityOf(activity || 'resting').emotion;
    return presence?.frames?.includes(want) ? want : 'neutral';
  },
  // Does a portrait set exist for this variant yet? (setup identity picker)
  hasPortrait: variant => (presenceManifest().avatars?.[variant] || []).includes('neutral'),
  frameOr: (variant, frame) => ((presenceManifest().avatars?.[variant] || []).includes(frame) ? frame : 'neutral'),
  // Image resolution by display size: small avatars use the 256px file.
  imgSuffix: size => (['2xl', 'hero'].includes(size) ? '' : '-256'),
  inc: n => Number(n) + 1,
  // Library file-type hue (placeholder thumbnails, badges).
  typeHue: type => ({ html: 205, doc: 245, md: 180, pdf: 25, image: 330, sheet: 150, slides: 65 })[type] ?? 240,
  urlencode: s => encodeURIComponent(String(s ?? '')),
  hasPreview: options => Array.isArray(options) && options.some(o => o.preview),
  lastItem: arr => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null),
  // How many items have this value: {{countWhere lessons "status" "retired"}}.
  countWhere: (arr, key, value) => (Array.isArray(arr) ? arr.filter(x => x?.[key] === value).length : 0),
  plural: (n, word, pluralWord) => `${n} ${n === 1 ? word : (typeof pluralWord === 'string' ? pluralWord : `${word}s`)}`,
  concat: (...args) => args.slice(0, -1).join(''),
  join: (arr, sep) => (Array.isArray(arr) ? arr.join(typeof sep === 'string' ? sep : ',') : ''),
  // A goal measure's readings as a small line (Phase 25, #196): points [{ at, value }] oldest first → an inline SVG, 2px line in
  // the accent, the latest reading marked, a hover title on every reading ("72 kg · 12 Sep"). One series: no legend.
  sparkline(points, options) {
    const pts = (Array.isArray(points) ? points : []).filter(p => Number.isFinite(Number(p?.value)));
    const unit = options?.hash?.unit ? ` ${options.hash.unit}` : '';
    if (pts.length < 2) return '';
    const W = 128, H = 40, P = 5;
    const vals = pts.map(p => Number(p.value));
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const xy = pts.map((p, i) => [P + (i * (W - 2 * P)) / (pts.length - 1), H - P - ((Number(p.value) - lo) * (H - 2 * P)) / span]);
    const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    const area = `${line} L${xy.at(-1)[0].toFixed(1)} ${H - P} L${xy[0][0].toFixed(1)} ${H - P} Z`;
    const day = at => toDate(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: viewerTz(options) });
    const hits = xy.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" class="spark-hit"><title>${esc(`${vals[i]}${unit} · ${day(pts[i].at)}`)}</title></circle>`).join('');
    const [lx, ly] = xy.at(-1);
    return new SafeString(`<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${pts.length} readings, from ${vals[0]}${unit} to ${vals.at(-1)}${unit}`)}">`
      + `<path d="${area}" class="spark-area"/><path d="${line}" class="spark-line"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5" class="spark-dot"/>${hits}</svg>`);
  },
  // 1240 → "1,240" (counts people read: characters, uses, pages).
  num: v => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : String(v ?? '')),
  json: v => new SafeString(esc(JSON.stringify(v))),
  // Join truthy class names: {{cx "base" (iff active "is-active")}}
  cx: (...args) => args.slice(0, -1).filter(Boolean).join(' '),

  // Nav state: exact match, or prefix match for sections (/goals/12 → /goals).
  active(href, current) {
    if (href === current) return true;
    return href !== '/' && current.startsWith(href + '/');
  },

  // {{icon "sparkles" class="size-4"}} → inline reference into /icons.svg sprite.
  icon(name, options) {
    const cls = esc(options.hash.class || 'size-5');
    const label = options.hash.label;
    const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
    return new SafeString(`<svg class="icon ${cls}" ${a11y} focusable="false"><use href="/icons.svg?v=${assetVersion()}#${esc(name)}"/></svg>`);
  },

  // Pages push content into named layout slots: {{#contentFor "head"}}…{{/contentFor}}
  contentFor(name, options) {
    const root = options.data.root;
    const blocks = root._blocks || (root._blocks = {});
    (blocks[name] ||= []).push(options.fn(this));
  },
  block(name, options) {
    const content = options.data.root._blocks?.[name];
    return content ? new SafeString(content.join('\n')) : '';
  },

  markdown: text => new SafeString(renderMarkdown(text)),

  timeAgo(v) {
    const diff = toDate(v).getTime() - Date.now();
    for (const [unit, ms] of UNITS) {
      if (Math.abs(diff) >= ms || unit === 'second') return rtf.format(Math.round(diff / ms), unit);
    }
  },
  // Clock/date text is in the VIEWER's timezone (the signed-in person), never the server's.
  time: (v, options) => toDate(v).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', timeZone: viewerTz(options) }),
  date: (v, options) => toDate(v).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: viewerTz(options) }),
  iso: v => toDate(v).toISOString(),
  // "12 March 2027" (a date far enough away that the weekday doesn't help), in the viewer's time zone.
  longDate: (v, options) => toDate(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: viewerTz(options) }),
  // A calendar day stored as "YYYY-MM-DD" (no time, so no time zone): "Tue 22 Sep", with the year when it isn't this one.
  dayDate(ymd) {
    const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return String(ymd ?? '');
    const year = d.getUTCFullYear() !== new Date().getUTCFullYear();
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' }).replace(',', '');
  },
  // Compact timestamp: "4:43 PM" today · "Mon 4:43 PM" this week · "Sep 12" older.
  when(v, options) {
    const d = toDate(v), now = new Date(), timeZone = viewerTz(options);
    const day = x => x.toLocaleDateString('en-CA', { timeZone });
    if (day(d) === day(now)) return d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', timeZone });
    if (now - d < 6 * 864e5) return d.toLocaleString('en', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone });
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone });
  },
  initials: name => String(name || '?').split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase(),
};

export default helpers;
