// Interactive browsing tools (decision #56): Jess drives a real page — open, look (snapshot), click, type, choose,
// press keys, scroll, go back, switch tabs, answer dialogs, read and screenshot. One live session per chat thread.
// Anything that pays, books, orders, subscribes, signs up or sends asks the person first (checked against the real
// element name from the page, not the model's description).
import { registerTool } from './registry.js';
import { get } from '../../db/index.js';
import * as B from '../../browser/session.js';
import { saveShot } from '../../browser/read.js';
import { browserStatus } from '../../browser/index.js';
import { decide, choice, note, threshold, enabled as decideEnabled } from '../../services/decide.js';
import { autopilot } from '../autopilot.js';
import { guardOutside } from '../injection.js';
import { oneLine } from '../../lib/untrusted.js';
import { datedLabel } from '../../lib/when.js';
import { buildLink, LinkError, SITES, SITE_KEYS, shopsFor, todayIn } from '../../lib/deeplinks.js';
import { recipeOff } from '../../browser/links.js';
import { learnRecipe } from '../../browser/recipes.js';
import { fetchRaw, decodeBody } from '../../browser/read.js';
import { siteOf } from '../../browser/profiles.js';
import { primaryPlace } from '../../services/places.js';
import { itemForUser, readBytes } from '../../services/library.js';
import { domainNotes } from '../../services/lessons.js';

const SPEND = /\b(pay|payment|purchase|buy( now)?|checkout|check out|place (?:your |my )?order|complete (?:booking|purchase|order|reservation)|confirm (?:and pay|booking|purchase|order|reservation|payment)|book now|reserve now|subscribe|donate|add funds|top up)\b/i;
const OUTWARD = /\b(send|post|publish|submit (?:application|review|comment|form)|sign up|create (?:an )?account|register|delete (?:account|my account)|unsubscribe|apply now|share)\b/i;

const sessionKey = ctx => `t${ctx.thread.id}`;
const keyOfRun = runId => { const r = runId != null && get('SELECT thread_id FROM runs WHERE id = ?', runId); return r ? `t${r.thread_id}` : null; };

/** spend (pay/book/order…) · external (send/post/sign up…) · read — from an element's name. */
export const riskOfName = name => (SPEND.test(name) ? 'spend' : OUTWARD.test(name) ? 'external' : 'read');

/** Risk of acting on an element: its real accessible name (from the last snapshot) and the model's description. */
const elementRisk = (args, { runId } = {}) => riskOfName(`${B.refName(B.peek(keyOfRun(runId)), args.ref)} ${args.element || ''}`);

// The decision model reads the element and its page in any language (#108): a button the words above don't catch
// ("Réserver et payer", "احجز الآن", an icon-only "Place order") still asks first. It can only raise the risk — a
// name the regex already flags asks regardless, and "unsure" leaves it as it was.
// "search" and "choose" are their own answers: without them a site-search submit read as "send" (0.51 for Wikipedia's
// search box), and choosing a fare on the way to checkout ("Select the lowest priced return flight … EUR 1,909") read as
// "pays or books" (0.61–0.73) — the owner was asked to approve fare selections and a denial stopped the task (#113).
const EFFECTS = {
  search: 'searches or looks something up on this site (a search box, a filter, "Go", "Find")',
  choose: 'selects or chooses an option on the way to checkout — a fare, flight, room, seat, size, date or plan — '
    + 'nothing is paid, booked or sent yet (the price shown is just information)',
  look: 'opens, shows, filters, sorts, expands or selects something — nothing leaves this browser',
  fill: 'enters or changes information in a form without sending it yet',
  spend: 'the final step that actually charges money or commits a booking or order: pay, purchase, place order, confirm and pay, '
    + 'complete booking',
  send: 'sends, posts, publishes, submits a form or application, signs up, creates an account, or deletes something',
  other: 'something else',
};
async function riskCheck(args, { user, runId } = {}) {
  const s = B.peek(keyOfRun(runId));
  const name = `${B.refName(s, args.ref)} ${args.element || ''}`.trim();
  if (!s?.active || !name || riskOfName(name) !== 'read') return null; // no page, or the words already ask
  const res = await decide('risk', {
    user, runId, timeoutMs: 2500,
    state: { page: `${await s.active.title().catch(() => '')} — ${s.active.url()}`, element: name,
      ...(args.text ? { typed_then_enter: String(args.text).slice(0, 200) } : {}) },
    questions: { effect: choice(`What would ${args.text ? 'typing into `element` and pressing Enter' : 'clicking `element`'} on \`page\` do?`, EFFECTS) },
  });
  if (!res) return null;
  const pr = res.answers.effect?.probabilities || {};
  const spend = Number(pr.spend) || 0, send = Number(pr.send) || 0;
  // Raise only on a clear lean (the admin's bar, at least 60%): the words above already catch the plain cases.
  const raised = spend + send >= Math.max(0.6, threshold()) ? (spend >= send ? 'spend' : 'external') : null;
  note(res.id, raised ? `asks first — looks like it ${raised === 'spend' ? 'pays or books' : 'sends'} (${(spend + send).toFixed(2)})`
    : `fine to click (${(1 - spend - send).toFixed(2)})`, { confidence: raised ? spend + send : 1 - spend - send });
  return raised;
}

const needsBrowser = () => {
  if (!browserStatus().installed) throw new Error('The browser isn’t installed yet — the admin can install it in Admin → Browser.');
};

async function session(ctx, { create = false } = {}) {
  needsBrowser();
  const key = sessionKey(ctx);
  const where = { userId: ctx.user.id, threadId: ctx.thread?.id ?? null, runId: ctx.run?.id ?? null }; // downloads land here
  let s = await B.sessionFor(key, { ...where, create });
  if (s || create) return s;
  // The tab closed (idle, or a restart): reopen where this chat left off rather than making the model start over.
  const last = B.lastUrlOf(key);
  if (!last) throw Object.assign(new Error('No page is open in this chat yet — open one with browser_open.'), { friendly: 'Opening the page first' });
  s = await B.sessionFor(key, { ...where, create: true });
  await B.open(s, last);
  s.events.push(`The tab had closed, so I reopened ${last} — refs from before no longer apply; look at the page again.`);
  return s;
}

// What people see when a step fails (the model gets the technical message).
function friendlyFailure(msg) {
  if (/no longer on the page|isn't a ref/i.test(msg)) return 'The page changed — looking again';
  if (/covering|on top of it/i.test(msg)) return 'Something was in the way';
  if (/Timeout/i.test(msg)) return 'The page was slow to respond';
  if (/private or local network/i.test(msg)) return 'That address isn’t on the public web';
  if (/isn’t installed/i.test(msg)) return 'The browser isn’t installed yet';
  return 'That didn’t work — trying another way';
}

const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const pageLabel = url => `page on ${hostOf(url) || 'a website'}`;

// The readable step for the chat ("Clicked “Search flights”" · page title). A file the page downloaded into the Library
// since the last step takes over the step's detail and link.
const stepFor = (text, s) => {
  const url = s?.active?.url?.() || '';
  const title = (/^Page: (.*) — /m.exec(text) || [])[1];
  const saved = s?.imported?.splice(0) || [];
  return { detail: saved.length ? `Saved “${saved[0].title}” to your Library${saved.length > 1 ? ` (+${saved.length - 1} more)` : ''}`.slice(0, 90) : (title || url).slice(0, 90),
    href: saved.length ? `/library/${saved[0].id}` : /^https?:/.test(url) ? url : undefined, status: /^BLOCKED:/m.test(text) ? 'bad' : undefined,
    handover: /^(BLOCKED|LOGIN|SIGN-IN|STUCK):/m.test(text) }; // the person may want to step in
};

// A tool result: Jess's own account of what happened stays plain; the page's words after the snapshot mark are outside
// content — fenced and screened for text addressed to AI assistants (agent/injection.js), and the run marked as having
// read the page. The mark stays outside the fence, so prompt.js can still drop old snapshots whole.
const done = async (text, s, ctx, tool) => {
  const at = text.indexOf(B.SNAPSHOT_MARK);
  if (at < 0) return { content: text, step: stepFor(text, s) };
  const url = s?.active?.url?.() || '';
  const g = await guardOutside(ctx, { tool, kind: 'browser_page', attrs: { url }, body: text.slice(at + B.SNAPSHOT_MARK.length).replace(/^\n/, ''),
    label: pageLabel(url), origin: hostOf(url) });
  return { content: `${text.slice(0, at).trimEnd()}\n\n${B.SNAPSHOT_MARK}\n${g.content}`, step: stepFor(text, s) };
};
const wrap = fn => async (args, ctx) => {
  try { return await fn(args, ctx); } catch (err) {
    const msg = err instanceof B.StaleRef ? err.message : `That didn’t work: ${String(err.message || err).split('\n')[0].slice(0, 300)}`;
    return { content: msg, step: { status: 'bad', detail: err.friendly || friendlyFailure(msg) } };
  }
};

const REF = { type: 'string', description: 'The element’s ref from the latest snapshot, e.g. "e12" or "f1e7".' };
const ELEMENT = { type: 'string', description: 'What the element is, in a few words (e.g. "Search flights button") — shown to the person.' };

registerTool({
  name: 'browser_open', toolset: 'web', risk: 'read', activity: 'browsing', iconName: 'globe',
  description: 'Open a web page in your own live browser tab to USE the site like a person: fill forms, pick dates and options, '
    + 'search inside the site, click through results, compare prices, check availability. Returns what happened and a snapshot '
    + 'of the page: every element you can use has a ref like [ref=e12]. Then use browser_click / browser_type / browser_select / '
    + 'browser_press with those refs, and look at the new snapshot each action returns. The tab stays open for this chat '
    + '(follow-up messages can continue on it). Tips: for flights, stays, shops, maps, jobs, events, parcels and scholarly search, '
    + 'open_search builds the results address for you (one step); if another site takes search parameters in the URL, open that URL directly; '
    + 'cookie banners are usually declined for you; a result starting BLOCKED means the site refused: say so, never describe results '
    + 'you didn’t see. When one way fails on a site, other routes: its other country or language domain, its own search, a results '
    + 'URL with parameters, the keyboard, scrolling, closing overlays; ask the person (ask_user, show_screen: true) only after '
    + 'several genuinely different attempts. For just reading an article, web_read is cheaper. '
    + 'For a form, search or filter with several steps, browser_autopilot does them in seconds — hand it the whole goal, then check.',
  parameters: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string' } } },
  label: args => `Opened ${String(args.url || '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}`,
  target: args => { try { return new URL(args.url).hostname.replace(/^www\./, ''); } catch { return ''; } },
  run: wrap(async (args, ctx) => {
    const s = await session(ctx, { create: true });
    const text = await B.open(s, args.url);
    // Lessons for this site (decision #188) go before the snapshot mark, so they survive when older snapshots collapse.
    const notes = domainNotes(ctx.user, s.active?.url?.() || args.url, { runId: ctx.run?.id });
    return done(notes ? `${notes}\n\n${text}` : text, s, ctx, 'browser_open');
  }),
});

// The autopilot (decision #111, the jev-ultrafast technique): a decision model drives a well-defined piece of work on
// the open page — ~0.3 s a step — and hands the page back for Jess to check. It never pays, books or sends.
const PILOT_OUTCOMES = {
  done: 'DONE (its claim — check the page below before telling the person)',
  blocked: 'BLOCKED', unsure: 'HANDED BACK (unsure)', needs_ok: 'NEEDS THE PERSON’S OK', needs_info: 'NEEDS INFORMATION',
  stuck: 'STUCK', budget: 'OUT OF STEPS', stopped: 'STOPPED',
};
registerTool({
  name: 'browser_autopilot', displayName: 'Browser autopilot', toolset: 'web', risk: 'read', activity: 'clicking', iconName: 'zap',
  available: () => decideEnabled('steps'),
  description: 'FAST: hand a well-defined piece of browser work on the open page to the autopilot — a decision model that clicks, '
    + 'types and chooses about 3 steps a second (a whole flight search takes seconds). Use it for filling forms, searches, filters, '
    + 'date pickers and clicking through to a result. Give a complete goal with every value it needs, e.g. "Search one-way flights '
    + 'from Zurich to London on 3 October 2026 for 1 adult in economy; stop when flight results are visible; do not select or book." '
    + 'It stops when done, stuck or unsure, when a value is missing, and BEFORE anything that pays, books or sends (you then do that '
    + 'click with browser_click, which asks the person). It returns what it did and the page — always check the page yourself. '
    + 'Not for reading, comparing or choosing between results: do that yourself.',
  parameters: { type: 'object', required: ['goal'], additionalProperties: false,
    properties: { goal: { type: 'string', description: 'The complete goal with every value, and where to stop.' },
      max_actions: { type: 'integer', minimum: 1, maximum: 30, description: 'Upper bound on actions (default 20).' } } },
  label: args => `Autopilot: ${String(args.goal || '').slice(0, 70)}`,
  target: args => String(args.goal || '').slice(0, 40),
  run: wrap(async (args, ctx) => {
    const s = await session(ctx);
    const goal = String(args.goal || '').trim();
    if (!goal) throw new Error('Give the autopilot a goal.');
    const startUrl = s.active.url();
    const out = await autopilot({ page: s.active, goal, user: ctx.user, run: ctx.run, signal: ctx.signal, maxActions: Number(args.max_actions) || 20 });
    // What it typed that led to a results address: keep the address's shape, never the text (recipes.js, decision #165).
    const typed = out.history.filter(h => h.kind === 'fill' && h.text).map(h => h.text);
    if (typed.length && s.active && s.active.url() !== startUrl && ['done', 'stuck', 'unsure', 'budget'].includes(out.outcome)
      && siteOf(hostOf(s.active.url())) === siteOf(hostOf(startUrl))) learnRecipe(s.active.url(), typed, { formUrl: startUrl });
    // Its labels and reason quote the page's element names: one clean line each (the snapshot below is fenced).
    const steps = out.history.map((h, i) => `${i + 1}. ${oneLine(h.label, 160)}${h.changed ? '' : ' (no visible change)'}`).join('\n') || '(no actions)';
    const page = s.active;
    const text = `AUTOPILOT: ${PILOT_OUTCOMES[out.outcome] || out.outcome} after ${out.history.length} action${out.history.length === 1 ? '' : 's'} `
      + `in ${(out.ms / 1000).toFixed(1)} s. ${oneLine(out.why, 300)}\nWhat it did:\n${steps}\n\nPage: ${oneLine(await page.title(), 160)} — ${page.url()}\n\n${B.SNAPSHOT_MARK}\n${await B.snapshot(s)}`;
    const shown = await done(text, s, ctx, 'browser_autopilot');
    shown.step.detail = `${out.history.length} steps in ${(out.ms / 1000).toFixed(1)} s · ${PILOT_OUTCOMES[out.outcome]?.split(' (')[0].toLowerCase() || out.outcome}`;
    return shown;
  }),
});

// ---- Ready-made searches (decision #164): one step to a results page instead of a form -----------------------------------
const FIELD = (type, description, extra = {}) => ({ type, description, ...extra });
const AREAS = [...new Set(Object.values(SITES).map(d => d.area))];
const siteList = AREAS.map(a => `${a}: ${SITE_KEYS.filter(k => SITES[k].area === a).join(', ')}`).join('; ');
const fieldsSummary = f => Object.entries(f).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))
  .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ');

// Overpass answers as JSON: listed for the model nearest first, with distances worked out here (not by the model).
const km = (a, b) => { const r = x => (x * Math.PI) / 180; const d = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(d)); };
export function overpassText(json, center) {
  const els = (json?.elements || []).map(e => ({ tags: e.tags || {}, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, type: e.type, id: e.id }))
    .filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lon)).map(e => ({ ...e, km: km(center, e) })).sort((a, b) => a.km - b.km);
  if (!els.length) return 'No places matched within that distance (OpenStreetMap may simply not have them mapped).';
  return `${els.length} place${els.length === 1 ? '' : 's'}, nearest first (straight-line distance, rough):\n` + els.map(e => {
    const t = e.tags;
    const addr = [t['addr:street'] && `${t['addr:housenumber'] ? `${t['addr:housenumber']} ` : ''}${t['addr:street']}`, t['addr:city']].filter(Boolean).join(', ');
    return `- ${t.name || t['name:en'] || t['name:fr'] || '(no name)'} · ${e.km < 1 ? `${Math.round(e.km * 1000)} m` : `${e.km.toFixed(1)} km`}`
      + `${addr ? ` · ${addr}` : ''}${t.opening_hours ? ` · hours ${t.opening_hours}` : ''}${t.phone || t['contact:phone'] ? ` · ${t.phone || t['contact:phone']}` : ''}`
      + `${t.website || t['contact:website'] ? ` · ${t.website || t['contact:website']}` : ''} · https://www.openstreetmap.org/${e.type}/${e.id}`
      + ` · directions: https://www.google.com/maps/dir/?api=1&destination=${e.lat.toFixed(6)},${e.lon.toFixed(6)}`;
  }).join('\n');
}

registerTool({
  name: 'open_search', displayName: 'Ready-made searches', toolset: 'web', risk: 'read', activity: 'searching', iconName: 'search',
  description: 'Open a site’s RESULTS directly from a ready-made search address, in your browser tab — one step instead of filling '
    + 'its form (no autocomplete, no date picker). Returns the results page’s snapshot like browser_open; then read prices, compare, '
    + `click through as usual. Sites (${siteList}). Give the fields the site needs: flights from/to (airport codes; Google Flights also takes `
    + 'city names), depart and return (YYYY-MM-DD; leave out return for one way), adults, children as a list of AGES (under 2 = infant), '
    + 'cabin, currency (ISO code); stays place, checkin, checkout, adults, children ages, rooms; shopping query, sort, price_min/max, '
    + 'country (the shop’s country; default: where the person lives — e.g. Senegal → jumia.sn and amazon.fr); jobs query, location, '
    + 'posted, remote; events query, city, country; parcels number (site "parcel" picks the carrier from the number); scholarly query, '
    + 'year_from; places: google_maps query, google_maps_directions origin/destination/mode, overpass tags like ["amenity=pharmacy"] '
    + '(near lat/lon, default their home: a list of real places with distances). What a link can’t carry is said in the result — set '
    + 'it on the page. Dates in the past are refused. If a site’s link stopped working, its own search page opens instead: use its form.',
  parameters: {
    type: 'object', required: ['site'], additionalProperties: false,
    properties: {
      site: FIELD('string', 'Which site.', { enum: SITE_KEYS }),
      from: FIELD('string', 'Flights: departure airport code (NBO), or a city for Google Flights.'),
      to: FIELD('string', 'Flights: arrival airport code; Ryanair fare finder: a code or ANY.'),
      depart: FIELD('string', 'Flights: departure date YYYY-MM-DD.'),
      return: FIELD('string', 'Flights: return date YYYY-MM-DD (leave out for one way).'),
      adults: FIELD('integer', 'Adults (flights default 1, stays default 2).', { minimum: 1, maximum: 30 }),
      children: FIELD('array', 'Children’s ages, e.g. [7, 4] (0–17; under 2 = infant on a lap).', { items: { type: 'integer', minimum: 0, maximum: 17 }, maxItems: 8 }),
      cabin: FIELD('string', 'Flights: cabin class.', { enum: ['economy', 'premium', 'business', 'first'] }),
      nonstop: FIELD('boolean', 'Flights: direct flights only (where the site supports it).'),
      currency: FIELD('string', 'ISO currency code, e.g. EUR, JPY.'),
      place: FIELD('string', 'Stays: the town or area, e.g. "Lisbon, Portugal".'),
      checkin: FIELD('string', 'Stays: YYYY-MM-DD.'),
      checkout: FIELD('string', 'Stays: YYYY-MM-DD.'),
      rooms: FIELD('integer', 'Stays: rooms.', { minimum: 1, maximum: 30 }),
      price_min: FIELD('number', 'Lowest price (shops; stays per night).'),
      price_max: FIELD('number', 'Highest price (shops; stays per night).'),
      sort: FIELD('string', 'Shops: relevance, price_asc, price_desc, rating, newest. Stays: relevance, price, rating.'),
      query: FIELD('string', 'What to search for (shops, jobs, events, maps, scholarly).'),
      country: FIELD('string', 'Two-letter country code: which country’s shop / Indeed / Eventbrite (default: the person’s).'),
      origin: FIELD('string', 'Directions: from where.'),
      destination: FIELD('string', 'Directions: to where.'),
      mode: FIELD('string', 'Directions: driving, walking, bicycling or transit.', { enum: ['driving', 'walking', 'bicycling', 'transit'] }),
      location: FIELD('string', 'Jobs: town or region.'),
      city: FIELD('string', 'Events: the city.'),
      posted: FIELD('string', 'Jobs: posted within.', { enum: ['day', 'week', 'month'] }),
      remote: FIELD('string', 'Jobs: remote, hybrid or onsite.', { enum: ['remote', 'hybrid', 'onsite'] }),
      number: FIELD('string', 'Parcels: the tracking number.'),
      year_from: FIELD('integer', 'Scholarly: published in or after this year.'),
      lat: FIELD('number', 'Overpass: latitude (default: the person’s home).'),
      lon: FIELD('number', 'Overpass: longitude (default: the person’s home).'),
      radius: FIELD('integer', 'Overpass: metres around the point (100–10000, default 1500).'),
      tags: FIELD('array', 'Overpass: OpenStreetMap tags, all must match, e.g. ["amenity=place_of_worship","religion=muslim"].', { items: { type: 'string' }, maxItems: 4 }),
      limit: FIELD('integer', 'Overpass: most places to return (default 30).'),
      date_from: FIELD('string', 'Ryanair fare finder: earliest departure YYYY-MM-DD.'),
      date_to: FIELD('string', 'Ryanair fare finder: latest departure YYYY-MM-DD.'),
      nights_min: FIELD('integer', 'Ryanair fare finder: shortest stay in nights.'),
      nights_max: FIELD('integer', 'Ryanair fare finder: longest stay in nights.'),
      max_price: FIELD('number', 'Ryanair fare finder: price limit.'),
      day_of_week: FIELD('string', 'Ryanair fare finder: departure weekday (monday … sunday).'),
      one_way: FIELD('boolean', 'Ryanair fare finder: one-way fares.'),
    },
  },
  label: args => `Opened ${SITES[args.site]?.label || 'a search'}${args.query ? ` for “${String(args.query).slice(0, 40)}”` : args.from && args.to ? ` ${String(args.from).slice(0, 20)} → ${String(args.to).slice(0, 20)}` : args.place ? ` in ${String(args.place).slice(0, 40)}` : ''}`,
  target: args => SITES[args.site]?.label || '',
  run: wrap((args, ctx) => openSearch(args, ctx)),
});

// open_search's work. openPage(ctx, url) → { s, text } opens the address in the chat's tab (tests pass their own, and the
// links:check state).
const openInTab = async (ctx, url) => { const s = await session(ctx, { create: true }); return { s, text: await B.open(s, url) }; };
export async function openSearch(args, ctx, { openPage = openInTab, linkState, today = null } = {}) {
  const { site, ...fields } = args;
  const place = ctx.user ? primaryPlace(ctx.user) : null;
  const notes = [];
  if (site === 'overpass' && (fields.lat == null || fields.lon == null)) {
    if (!place) return { content: 'open_search overpass needs lat and lon (the person has no home place saved — ask where, or use set_location).', step: { status: 'bad', detail: 'Needs a place' } };
    Object.assign(fields, { lat: place.latitude, lon: place.longitude });
    notes.push(`Around their home (${oneLine(place.name, 80)}).`);
  }
  let link;
  try { link = buildLink(site, fields, { today: today || todayIn(place?.timezone || 'UTC'), homeCountry: place?.country_code || null }); } catch (err) {
    if (!(err instanceof LinkError)) throw err;
    return { content: `open_search didn’t open anything: ${err.message} Fix that field and call it again.`, step: { status: 'bad', detail: oneLine(err.message, 90) } };
  }
  notes.push(...link.notes);
  if (link.carrier) notes.push(`Carrier from the number: ${link.carrier}.`);
  if (link.area === 'shopping' && place?.country_code) {
    const others = shopsFor(place.country_code).filter(x => x.site !== site).map(x => x.domain);
    if (others.length) notes.push(`Other shops that serve ${place.country_code}: ${others.join(', ')} (open_search with that site).`);
  }
  if (link.kind === 'json') return openData(ctx, link, fields, notes);
  const off = recipeOff(site, linkState);
  const { s, text } = await openPage(ctx, off ? link.home : link.url);
  const head = off
    ? `OPEN_SEARCH: ${link.label}’s results address stopped working (checked ${String(off.at).slice(0, 10)}: ${off.detail}), so I opened its own `
      + `search page instead — fill its form for: ${fieldsSummary(fields)}.`
      : `OPEN_SEARCH: ${link.label} results for ${fieldsSummary(fields)} (${link.url}).`;
  const siteNotes = domainNotes(ctx.user, link.url, { runId: ctx.run?.id }); // lessons for this site (decision #188)
  if (siteNotes) notes.push(siteNotes);
    return done(`${[head, ...notes].join('\n')}\n${text}`, s, ctx, 'open_search');
}

/** A data recipe (Overpass, Semantic Scholar, Crossref): read through the browser, mirrors in turn, fenced like web_read. */
async function openData(ctx, link, fields, notes) {
  const tried = [];
  for (const url of [link.url, ...link.alternates]) {
    const host = hostOf(url);
    try {
      const r = await fetchRaw(url, { signal: ctx.signal, timeout: 20000 });
      if (r.status >= 400) { tried.push(`${host} answered ${r.status}`); continue; }
      const raw = decodeBody(r.body, r.contentType);
      let json = null;
      try { json = JSON.parse(raw); } catch { tried.push(`${host} didn’t answer with data`); continue; }
      const body = link.site === 'overpass' ? overpassText(json, { lat: Number(fields.lat), lon: Number(fields.lon) }) : JSON.stringify(json).slice(0, 12000);
      const g = await guardOutside(ctx, { tool: 'open_search', kind: 'web_page', attrs: { url }, label: `data from ${host}`, origin: host, body });
      return { content: `OPEN_SEARCH: ${link.label} for ${fieldsSummary(fields)}${tried.length ? ` (${tried.join('; ')}; used ${host})` : ''}.\n${notes.join('\n')}\n\n${g.content}`,
        step: { detail: `${link.label} · ${host}`, href: /^https?:/.test(url) ? url : undefined } };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      tried.push(`${host}: ${String(err.message || err).split('\n')[0].slice(0, 80)}`);
    }
  }
  return { content: `open_search couldn’t get ${link.label}: ${tried.join('; ')}. Try again later, or search the web instead.`, step: { status: 'bad', detail: `${link.label} didn’t answer` } };
}

// ---- Files from the Library into a web form (decision #166): always asks — the website gets a copy -------------------------
const cleanSite = v => String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '').slice(0, 120);
const ownItem = (user, id) => { try { return user ? itemForUser(user, id, { write: true }) : null; } catch { return null; } };
const itemTitle = id => oneLine(get('SELECT title FROM library_items WHERE public_id = ? AND deleted_at IS NULL', String(id || ''))?.title || 'a file', 80);
// The site the task's tab is on right now ('' with no tab open): an upload's card names the site that would really get the
// file, not the one the model wrote (#209).
const tabHost = runId => { try { const s = B.peek(keyOfRun(runId)); return s?.active ? hostOf(s.active.url()) : ''; } catch { return ''; } };
const uploadSite = (args, ctx) => tabHost(ctx?.runId) || cleanSite(args.site);
const fileNameOf = item => { const base = String(item.title || 'file').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100) || 'file'; return base.toLowerCase().endsWith(`.${item.ext}`) ? base : `${base}.${item.ext}`; };

registerTool({
  name: 'browser_upload', displayName: 'Uploads files to websites', toolset: 'web', activity: 'filling', iconName: 'upload',
  // Only the person's own Library items can go out (anyone else's is refused when it runs, without a card that would name it).
  risk: (args, { user } = {}) => (ownItem(user, args.library_id) ? 'external' : 'read'),
  undo: { possible: false, note: 'the website keeps its copy of the file' },
  reach: (args, ctx) => `the website ${uploadSite(args, ctx) || 'open in the browser'}`,
  // A tab on another site than the one named is refused before the gate: never a card for an upload that couldn't run.
  precheck: (args, { run } = {}) => {
    const here = tabHost(run?.id), asked = cleanSite(args.site);
    return here && asked && siteOf(here) !== siteOf(asked)
      ? `The open page is on ${here}, not ${asked}, so nothing was attached and nobody was asked. Attach it on the page that is open (site "${here}") or open the right page first.` : null;
  },
  description: 'Attach one of the person’s own Library files to a file field on the open page — a CV to a job application, a photo or a '
    + 'scanned document to a form. ref: the file field (in the snapshot: button "Choose File" {type=file}) or the site’s own upload button; library_id: the file (library_list shows '
    + 'them); site: the website the page is on, as in the snapshot’s Page line. It asks the person first, naming the file and '
    + 'the site, because the website receives a copy. Files from someone else’s Library can’t be used.',
  parameters: { type: 'object', required: ['ref', 'library_id', 'site'], additionalProperties: false,
    properties: { ref: REF, library_id: { type: 'string', description: 'The Library file’s id.' },
      site: { type: 'string', description: 'The website’s host, e.g. jobs.example.com.' }, element: ELEMENT } },
  label: args => `Attached “${itemTitle(args.library_id).slice(0, 40)}” on ${cleanSite(args.site).slice(0, 40)}`,
  target: args => cleanSite(args.site),
  approvalTitle: (args, ctx) => `Upload “${itemTitle(args.library_id)}” to ${uploadSite(args, ctx)}`,
  approvalPreview: (args, ctx) => `File: ${itemTitle(args.library_id)}\nWebsite: ${uploadSite(args, ctx)}${args.element ? `\nField: ${oneLine(args.element, 80)}` : ''}\n\n`
    + 'The website gets a copy of this file (many sites upload it as soon as it is attached). Nothing is attached until you approve.',
  run: wrap(async (args, ctx) => {
    const item = ownItem(ctx.user, args.library_id);
    if (!item) return { content: 'That isn’t one of the person’s Library files (only their own files can be uploaded). Check the id with library_list.', step: { status: 'bad', detail: 'Not one of your files' } };
    const s = await session(ctx);
    const here = hostOf(s.active.url()), asked = cleanSite(args.site);
    if (!asked || siteOf(here) !== siteOf(asked)) {
      return { content: `Nothing was attached: the open page is on ${here || 'no website'}, not ${asked || '(no site given)'}. The person approved ${asked || 'another site'}; ask again for this one if it is right.`,
        step: { status: 'bad', detail: 'The page is on another site' } };
    }
    const buffer = readBytes(item);
    const text = await B.upload(s, args.ref, { name: fileNameOf(item), mimeType: item.mime || 'application/octet-stream', buffer });
    return done(text, s, ctx, 'browser_upload');
  }),
});

registerTool({
  name: 'browser_snapshot', toolset: 'web', risk: 'read', activity: 'looking', iconName: 'scan-eye',
  description: 'Look at the open page again (fresh refs). Use find="text" to see only the parts mentioning something (prices, '
    + 'a flight number, "Sold out"…), or ref to look inside one region. Refs from older snapshots may no longer work.',
  parameters: { type: 'object', additionalProperties: false, properties: { find: { type: 'string' }, ref: REF } },
  label: args => (args.find ? `Looked for “${String(args.find).slice(0, 40)}”` : 'Looked at the page'),
  target: args => (args.find ? String(args.find).slice(0, 40) : ''),
  run: wrap(async (args, ctx) => {
    const s = await session(ctx);
    return done(`Page: ${oneLine(await s.active.title(), 160)} — ${s.active.url()}\n\n${B.SNAPSHOT_MARK}\n${await B.snapshot(s, { find: args.find, ref: args.ref })}`, s, ctx, 'browser_snapshot');
  }),
});

registerTool({
  name: 'browser_click', displayName: 'Clicks on websites', toolset: 'web', risk: elementRisk, riskCheck, activity: 'clicking', iconName: 'mouse-pointer-click',
  description: 'Click an element on the open page (links, buttons, tabs, checkboxes, a day in a calendar, an option in an open '
    + 'list). Anything that pays, books, orders, subscribes, signs up or sends asks the person first.',
  parameters: { type: 'object', required: ['ref', 'element'], additionalProperties: false,
    properties: { ref: REF, element: ELEMENT, double: { type: 'boolean', description: 'Double-click.' } } },
  label: args => `Clicked “${String(args.element || args.ref).slice(0, 50)}”`,
  target: args => String(args.element || '').slice(0, 40),
  approvalTitle: args => `Click “${String(args.element || 'this button').slice(0, 60)}” on a website`,
  approvalPreview: args => `${args.element || ''}

This looks like it pays, books, orders, signs up or sends something. Nothing happens until you approve.`,
  run: wrap(async (args, ctx) => { const s = await session(ctx); return done(await B.click(s, args.ref, { double: !!args.double }), s, ctx, 'browser_click'); }),
});

registerTool({
  name: 'browser_type', displayName: 'Typing on websites', toolset: 'web', risk: (args, c) => (args.submit ? elementRisk(args, c) : 'read'),
  riskCheck: (args, c) => (args.submit ? riskCheck(args, c) : null), activity: 'filling', iconName: 'keyboard',
  description: 'Type into a field on the open page (replaces what is there). For autocomplete fields (airports, cities, addresses) '
    + 'set pick to the suggestion you want (e.g. text "Nairobi", pick "NBO"): it types like a person, clicks the matching suggestion and '
    + 'reads the field back. Without pick, suggestions appear under "Appeared after this action" — click one; don’t press Enter on '
    + 'an autocomplete. For dates use browser_pick_date. submit=true presses Enter afterwards.',
  parameters: { type: 'object', required: ['ref', 'text'], additionalProperties: false,
    properties: { ref: REF, text: { type: 'string' }, pick: { type: 'string', description: 'Text of the suggestion to choose.' }, element: ELEMENT, submit: { type: 'boolean', description: 'Press Enter after typing (default false).' } } },
  label: args => `Typed “${String(args.text || '').slice(0, 40)}”${args.element ? ` in ${String(args.element).slice(0, 30)}` : ''}`,
  target: args => String(args.element || args.text || '').slice(0, 40),
  run: wrap(async (args, ctx) => { const s = await session(ctx); return done(await B.type(s, args.ref, args.text, { submit: !!args.submit, pick: args.pick || null }), s, ctx, 'browser_type'); }),
});

registerTool({
  name: 'browser_pick_date', toolset: 'web', risk: 'read', activity: 'filling', iconName: 'calendar-days',
  description: 'Set a date in a date field or pop-up calendar (departure, check-in, birthday…): give the field (or the button that '
    + 'opens the calendar) and the date as YYYY-MM-DD. It types it when the field allows, otherwise opens the calendar, moves to the '
    + 'right month and clicks the day. For a range, call it for the start, then for the end. Always check the dates shown afterwards.',
  parameters: { type: 'object', required: ['ref', 'date'], additionalProperties: false,
    properties: { ref: REF, date: { type: 'string', description: 'YYYY-MM-DD' }, element: ELEMENT } },
  label: args => `Picked ${String(args.date)}${args.element ? ` in ${String(args.element).slice(0, 30)}` : ''}`,
  target: args => String(args.date || ''),
  run: wrap(async (args, ctx) => { const s = await session(ctx); return done(await B.pickDate(s, args.ref, args.date), s, ctx, 'browser_pick_date'); }),
});

registerTool({
  name: 'browser_select', toolset: 'web', risk: 'read', activity: 'choosing', iconName: 'list-checks',
  description: 'Choose option(s) in a native dropdown (a "combobox" with "option" children in the snapshot), by their visible text. '
    + 'Custom dropdowns: click to open them, then click the option.',
  parameters: { type: 'object', required: ['ref', 'values'], additionalProperties: false,
    properties: { ref: REF, values: { type: 'array', items: { type: 'string' }, minItems: 1 }, element: ELEMENT } },
  label: args => `Chose “${[].concat(args.values || []).join(', ').slice(0, 50)}”`,
  target: args => [].concat(args.values || []).join(', ').slice(0, 40),
  run: wrap(async (args, ctx) => { const s = await session(ctx); return done(await B.select(s, args.ref, args.values), s, ctx, 'browser_select'); }),
});

registerTool({
  name: 'browser_press', toolset: 'web', risk: 'read', activity: 'clicking', iconName: 'keyboard',
  description: 'Press a key on the open page: Enter, Escape (closes popups), Tab, ArrowDown/ArrowUp (move in suggestion lists), '
    + 'PageDown, Backspace…',
  parameters: { type: 'object', required: ['key'], additionalProperties: false, properties: { key: { type: 'string' } } },
  label: args => `Pressed ${String(args.key).slice(0, 20)}`,
  run: wrap(async (args, ctx) => { const s = await session(ctx); return done(await B.press(s, args.key), s, ctx, 'browser_press'); }),
});

registerTool({
  name: 'browser_scroll', toolset: 'web', risk: 'read', activity: 'scrolling', iconName: 'arrow-down-up',
  description: 'Scroll the open page (loads more results on infinite lists), or bring an element into view with ref.',
  parameters: { type: 'object', additionalProperties: false, properties: { direction: { type: 'string', enum: ['down', 'up'] }, ref: REF } },
  label: args => (args.ref ? 'Scrolled to an element' : `Scrolled ${args.direction || 'down'}`),
  run: wrap(async (args, ctx) => { const s = await session(ctx); return done(await B.scroll(s, args), s, ctx, 'browser_scroll'); }),
});

registerTool({
  name: 'browser_back', toolset: 'web', risk: 'read', activity: 'browsing', iconName: 'arrow-left',
  description: 'Go back to the previous page in the open tab.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'Went back',
  run: wrap(async (args, ctx) => { const s = await session(ctx); return done(await B.back(s), s, ctx, 'browser_back'); }),
});

registerTool({
  name: 'browser_tabs', toolset: 'web', risk: 'read', activity: 'browsing', iconName: 'app-window',
  description: 'List the open tabs, switch to one (select) or close one. Links that open a new tab switch to it automatically.',
  parameters: { type: 'object', required: ['action'], additionalProperties: false,
    properties: { action: { type: 'string', enum: ['list', 'select', 'close'] }, index: { type: 'integer' } } },
  label: args => ({ list: 'Checked the tabs', select: `Switched to tab ${args.index}`, close: `Closed tab ${args.index}` })[args.action] || 'Tabs',
  run: wrap(async (args, ctx) => { const s = await session(ctx); return done(await B.tabs(s, args), s, ctx, 'browser_tabs'); }),
});

registerTool({
  name: 'browser_wait', toolset: 'web', risk: 'read', activity: 'loading', iconName: 'hourglass',
  description: 'Wait for something on the open page: until a text appears (results loaded), until a text disappears ("Loading…"), '
    + 'or a few seconds.',
  parameters: { type: 'object', additionalProperties: false,
    properties: { text: { type: 'string' }, textGone: { type: 'string' }, seconds: { type: 'number' } } },
  label: args => (args.text ? `Waited for “${String(args.text).slice(0, 40)}”` : 'Waited for the page'),
  run: wrap(async (args, ctx) => { const s = await session(ctx); return done(await B.wait(s, args), s, ctx, 'browser_wait'); }),
});

registerTool({
  name: 'browser_dialog', toolset: 'web', risk: 'read', activity: 'clicking', iconName: 'message-square-warning',
  description: 'Answer a pop-up dialog (alert / confirm / prompt) the page opened. accept=false dismisses it.',
  parameters: { type: 'object', required: ['accept'], additionalProperties: false,
    properties: { accept: { type: 'boolean' }, text: { type: 'string', description: 'For prompt dialogs.' } } },
  label: args => (args.accept ? 'Accepted a dialog' : 'Dismissed a dialog'),
  run: wrap(async (args, ctx) => { const s = await session(ctx); return done(await B.dialog(s, args), s, ctx, 'browser_dialog'); }),
});

registerTool({
  name: 'browser_read', toolset: 'web', risk: 'read', activity: 'reading', iconName: 'book-open',
  description: 'Read the open page as text (the article, or the whole page for result lists) — for pulling out details, prices '
    + 'and lists after you navigated there. Long pages come in parts: use start to continue.',
  parameters: { type: 'object', additionalProperties: false, properties: { start: { type: 'integer', minimum: 0 } } },
  label: () => 'Read the page',
  run: wrap(async (args, ctx) => {
    const s = await session(ctx);
    const r = await B.read(s, { start: args.start || 0 });
    const more = r.end < r.total ? `\n\n… ${r.total - r.end} more characters — call browser_read with start=${r.end}.` : '';
    const g = await guardOutside(ctx, { tool: 'browser_read', kind: 'web_page', attrs: { url: r.url }, label: pageLabel(r.url), origin: hostOf(r.url),
      body: `# ${r.title}\n${r.published ? `Published ${datedLabel(r.published)}` : 'Publish date unknown'}\n\n${r.text || '(The page had no readable text.)'}`,
      hidden: r.hidden });
    const text = `Page: ${oneLine(r.title, 160)} — ${r.url}\n\n${g.content}${more}`;
    return { content: text, step: stepFor(text, s) };
  }),
});

registerTool({
  name: 'browser_screenshot', toolset: 'web', risk: 'read', activity: 'capturing', iconName: 'camera',
  description: 'Show the person what the open tab looks like right now (a picture in the chat) — e.g. results you found, or a '
    + 'page that needs them (a login, a CAPTCHA, a payment they must do themselves).',
  parameters: { type: 'object', additionalProperties: false, properties: { full_page: { type: 'boolean' } } },
  label: () => 'Took a screenshot',
  run: wrap(async (args, ctx) => {
    const s = await session(ctx);
    const shot = await B.screenshot(s, { fullPage: !!args.full_page });
    const { href } = saveShot(ctx.user.id, shot.buf);
    return { content: `Screenshot of “${oneLine(shot.title, 160)}” (${shot.url}) is shown to the person in the chat (they can take over the tab from it).`,
      step: { detail: oneLine(shot.title, 90), image: href, href: shot.url, handover: true } };
  }),
});

registerTool({
  name: 'browser_close', toolset: 'web', risk: 'read', activity: 'browsing', iconName: 'x',
  description: 'Close this chat’s browser tab(s) when the task is finished.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'Closed the browser',
  run: wrap(async (args, ctx) => { B.forgetUrl(sessionKey(ctx)); return (await B.closeSession(sessionKey(ctx))) ? 'Closed.' : 'Nothing was open.'; }),
});

export const __test = { done, stepFor, openSearch, overpassText }; // unit tests
