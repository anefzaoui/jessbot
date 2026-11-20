// Phase 21 part B (decisions #164–#168): the deep-link builder and open_search, learned site recipes, browser_upload,
// web_screenshot options, the autopilot's domain lock, snapshot shrinking by priority, domain trust warnings, and ad/tracker
// blocking inside the request guard. Run: npm test (throwaway data dir, no network: the browser is replaced by fakes where
// a tool would open a page). Real-browser checks live in scripts/e2e-chat.js ("open_search" and "links:check").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-unit-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env'); // keys the code makes (secrets, VAPID) never land in the real .env
process.env.JESSBOT_EMBED_OFF = '1'; // no embedding calls from unit tests
process.env.JESSBOT_DECIDE_OFF = '1'; // no decision-model calls either: every use takes its fallback

const { openDb, closeDb, get, all } = await import('../src/db/index.js');
const { ensureDirs, paths } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser } = await import('../src/services/users.js');
const { getTool } = await import('../src/agent/tools/registry.js');
await import('../src/agent/tools/index.js');
const DL = await import('../src/lib/deeplinks.js');
const L = await import('../src/browser/links.js');
const RC = await import('../src/browser/recipes.js');
const T = await import('../src/browser/trust.js');
const AB = await import('../src/browser/adblock.js');
const B = await import('../src/browser/index.js');
const S = await import('../src/browser/session.js');
const R = await import('../src/browser/read.js');
const { domainLock, HANDOFFS } = await import('../src/agent/autopilot.js');
const { __test: browse } = await import('../src/agent/tools/browse.js');
const { savePlace } = await import('../src/services/places.js');
const up = await import('../src/services/uploads.js');
const policy = await import('../src/services/policy.js');
const { reachOf, undoOf } = await import('../src/services/approvals.js');
const { saveConnection } = await import('../src/services/connections.js');
const { FiltersEngine } = await import('@ghostery/adblocker');

const TODAY = '2026-09-26';
const link = (site, fields, ctx = {}) => DL.buildLink(site, fields, { today: TODAY, ...ctx });
const failsOn = (fn, field, re) => assert.throws(fn, err => { assert.equal(err.name, 'LinkError'); assert.equal(err.field, field); if (re) assert.match(err.message, re); return true; });

let ann, bob;
before(async () => {
  ann = await createUser({ name: 'Ann Owner', email: 'ann@household-mail.example', password: 'correct horse battery', role: 'admin' });
  bob = await createUser({ name: 'Bob Member', email: 'bob21b@t.dev', password: 'correct horse battery' });
  savePlace(ann, { label: 'home', name: 'Dakar, Senegal', latitude: 14.6928, longitude: -17.4467, countryCode: 'SN', timezone: 'Africa/Dakar' });
});
after(() => { closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

// ---- Deep links (#164) ---------------------------------------------------------------------------------------------------
test('deep links: flights — Google Flights q-link, Skyscanner YYMMDD + ages, Kayak, Ryanair select and fare finder', () => {
  const trip = { from: 'nbo', to: 'cdg', depart: '2026-10-10', return: '2026-10-17', adults: 2, children: [7, 4], currency: 'kes' };
  const g = link('google_flights', trip);
  assert.equal(g.url, 'https://www.google.com/travel/flights?q=Flights%20from%20nbo%20to%20cdg%20on%202026-10-10%20through%202026-10-17&curr=KES&hl=en');
  assert.match(g.notes[0], /can’t carry travellers: set 2 adults and 2 children \(ages 7, 4\)/);
  assert.equal(link('google_flights', { from: 'Nairobi', to: 'Paris', depart: '2026-10-10', cabin: 'business', nonstop: true }).url,
    'https://www.google.com/travel/flights?q=Flights%20from%20Nairobi%20to%20Paris%20on%202026-10-10%20one%20way%20business%20class%20nonstop&hl=en');
  assert.equal(link('skyscanner', trip).url, 'https://www.skyscanner.net/transport/flights/nbo/cdg/261010/261017/?adultsv2=2&childrenv2=7|4&cabinclass=economy&rtn=1&currency=KES');
  assert.equal(link('skyscanner', { from: 'LOND', to: 'NBO', depart: '2026-11-02', cabin: 'premium' }).url,
    'https://www.skyscanner.net/transport/flights/lond/nbo/261102/?adultsv2=1&cabinclass=premiumeconomy&rtn=0');
  const k = link('kayak', { ...trip, children: [7, 1], nonstop: true });
  assert.equal(k.url, 'https://www.kayak.com/flights/NBO-CDG/2026-10-10/2026-10-17/2adults/children-7-1L?sort=price_a&fs=stops=0');
  assert.equal(link('kayak', { from: 'NBO', to: 'DXB', depart: '2026-10-10', cabin: 'business' }).url, 'https://www.kayak.com/flights/NBO-DXB/2026-10-10/business/1adults?sort=price_a');
  // Ryanair counts adults 16+, teens 12–15, children 2–11, infants under 2.
  assert.deepEqual(DL.airlineBands(2, [16, 13, 7, 1]), { adults: 3, teens: 1, children: 1, infants: 1 });
  assert.equal(link('ryanair', { from: 'STN', to: 'BCN', depart: '2026-10-10', return: '2026-10-14', adults: 2, children: [13, 7, 1] }).url,
    'https://www.ryanair.com/gb/en/trip/flights/select?adults=2&teens=1&children=1&infants=1&dateOut=2026-10-10&dateIn=2026-10-14&isConnectedFlight=false&isReturn=true&discount=0&originIata=STN&destinationIata=BCN');
  assert.match(link('ryanair', { from: 'STN', to: 'BCN', depart: '2026-10-10' }).url, /dateIn=&isConnectedFlight=false&isReturn=false/);
  const ff = new URL(link('ryanair_fare_finder', { from: 'stn', date_from: '2026-10-01', date_to: '2026-10-31', nights_min: 0, nights_max: 1, day_of_week: 'saturday', max_price: 80 }).url);
  assert.equal(ff.origin + ff.pathname, 'https://www.ryanair.com/gb/en/fare-finder');
  assert.deepEqual(Object.fromEntries(['originIata', 'destinationIata', 'isReturn', 'dateOut', 'dateIn', 'nightsFrom', 'nightsTo', 'dayOfWeek', 'priceValueTo', 'currency', 'outboundFromHour']
    .map(k2 => [k2, ff.searchParams.get(k2)])), { originIata: 'STN', destinationIata: 'ANY', isReturn: 'true', dateOut: '2026-10-01', dateIn: '2026-10-31',
    nightsFrom: '0', nightsTo: '1', dayOfWeek: 'SATURDAY', priceValueTo: '80', currency: 'EUR', outboundFromHour: '00:00' });
});

test('deep links: flight validation — past dates, return before departure, ages, currencies, codes, infants', () => {
  const base = { from: 'NBO', to: 'CDG', depart: '2026-10-10' };
  failsOn(() => link('skyscanner', { ...base, depart: '2026-09-25' }), 'depart', /in the past — today is 2026-09-26/);
  assert.equal(link('skyscanner', { ...base, depart: TODAY }).url.includes('/260926/'), true); // today is fine
  failsOn(() => link('kayak', { ...base, return: '2026-10-09' }), 'return', /before depart/);
  failsOn(() => link('kayak', { ...base, depart: '2026-02-30' }), 'depart', /isn’t a real date/);
  failsOn(() => link('kayak', { ...base, depart: '10/10/2026' }), 'depart', /YYYY-MM-DD/);
  failsOn(() => link('kayak', { ...base, children: [7, 18] }), 'children', /ages from 0 to 17/);
  failsOn(() => link('kayak', { ...base, children: [1, 0], adults: 1 }), 'children', /infant under 2 needs an adult/);
  failsOn(() => link('kayak', { ...base, adults: 5, children: [3, 4, 5, 6, 7] }), 'children', /At most 9 travellers/);
  failsOn(() => link('kayak', { ...base, currency: 'EURO' }), 'currency', /ISO code/);
  failsOn(() => link('kayak', { ...base, currency: 'XYZ' }), 'currency');
  failsOn(() => link('kayak', { ...base, from: 'Nairobi' }), 'from', /airport code/);
  failsOn(() => link('kayak', { ...base, to: 'nbo' }), 'to', /same place/);
  failsOn(() => link('kayak', { ...base, cabin: 'luxury' }), 'cabin', /one of: economy, premium, business, first/);
  failsOn(() => link('kayak', { ...base, adults: 0 }), 'adults');
  failsOn(() => link('nowhere', base), 'site', /Unknown site/);
  failsOn(() => link('ryanair_fare_finder', { from: 'STN', date_from: '2026-10-20', date_to: '2026-10-01' }), 'date_to', /before date_from/);
});

test('deep links: stays — Airbnb place slug and age bands, Booking repeated age=, Google Hotels; checkout after checkin', () => {
  const stay = { place: 'Lisbon, Portugal', checkin: '2026-10-10', checkout: '2026-10-17', adults: 2, children: [7, 4, 1, 14], price_min: 50, price_max: 200 };
  const a = link('airbnb', stay);
  assert.equal(a.url, 'https://www.airbnb.com/s/Lisbon--Portugal/homes?checkin=2026-10-10&checkout=2026-10-17&adults=3&children=2&infants=1&price_min=50&price_max=200');
  const b = link('booking', { ...stay, place: 'Lisbon', children: [7, 4], sort: 'price', currency: 'EUR' });
  assert.equal(b.url, 'https://www.booking.com/searchresults.html?ss=Lisbon&checkin=2026-10-10&checkout=2026-10-17&group_adults=2&group_children=2&age=7&age=4&no_rooms=1&order=price&selected_currency=EUR&lang=en-gb');
  assert.match(b.notes[0], /price filter isn’t in the link/);
  assert.equal(link('booking', { place: 'Faro', checkin: '2026-10-10', checkout: '2026-10-11' }).url.includes('group_adults=2&group_children=0&no_rooms=1'), true); // stays default 2 adults
  const h = link('google_hotels', { place: 'Lisbon', checkin: '2026-10-10', checkout: '2026-10-17' });
  assert.equal(h.url, 'https://www.google.com/travel/search?q=hotels%20in%20Lisbon&hl=en');
  assert.match(h.notes[0], /set 2026-10-10 to 2026-10-17 and 2 adults on the page/);
  failsOn(() => link('airbnb', { place: 'Lisbon', checkin: '2026-10-10', checkout: '2026-10-10' }), 'checkout', /must be after checkin/);
  failsOn(() => link('airbnb', { place: 'Lisbon', checkin: '2026-10-10', checkout: '2026-10-12', price_min: 300, price_max: 100 }), 'price_max');
  failsOn(() => link('booking', { checkin: '2026-10-10', checkout: '2026-10-12' }), 'place', /needed/);
});

test('deep links: maps (official api=1), Overpass (tags checked), shops by home country, jobs, events', () => {
  assert.equal(link('google_maps', { query: 'pharmacie de garde, Lyon' }).url, 'https://www.google.com/maps/search/?api=1&query=pharmacie%20de%20garde%2C%20Lyon');
  const d = link('google_maps_directions', { origin: 'Lisbon', destination: 'Sintra', mode: 'transit' });
  assert.equal(d.url, 'https://www.google.com/maps/dir/?api=1&origin=Lisbon&destination=Sintra&travelmode=transit');
  assert.match(link('google_maps_directions', { destination: 'Belem' }).notes[0], /No origin/);
  const o = link('overpass', { lat: 14.6928, lon: -17.4467, tags: ['amenity=place_of_worship', 'religion=muslim'], radius: 2000, limit: 10 });
  assert.equal(o.kind, 'json');
  assert.equal(decodeURIComponent(new URL(o.url).searchParams.get('data')),
    '[out:json][timeout:25];nwr(around:2000,14.69280,-17.44670)["amenity"="place_of_worship"]["religion"="muslim"];out center 10;');
  assert.equal(o.alternates.length, 2); // mirrors tried in turn
  failsOn(() => link('overpass', { lat: 36.8, lon: 10.1, tags: ['amenity=pharmacy"];out;'] }), 'tags', /isn’t an OpenStreetMap tag/);
  failsOn(() => link('overpass', { lat: 136.8, lon: 10.1, tags: ['amenity=pharmacy'] }), 'lat');
  failsOn(() => link('overpass', { lat: 36.8, lon: 10.1 }), 'tags');
  // Senegal has no Amazon site: amazon.fr ships there; Jumia's Senegalese site; the person's country is the default.
  assert.equal(link('amazon', { query: 'air fryer', sort: 'price_asc', price_min: 50, price_max: 120 }, { homeCountry: 'SN' }).url,
    'https://www.amazon.fr/s?k=air%20fryer&s=price-asc-rank&rh=p_36%3A5000-12000');
  assert.equal(link('amazon', { query: 'kettle', country: 'GB' }, { homeCountry: 'SN' }).url, 'https://www.amazon.co.uk/s?k=kettle');
  assert.equal(link('amazon', { query: 'kettle' }).url, 'https://www.amazon.com/s?k=kettle');
  assert.equal(link('jumia', { query: 'air fryer' }, { homeCountry: 'SN' }).url, 'https://www.jumia.sn/catalog/?q=air%20fryer');
  failsOn(() => link('jumia', { query: 'air fryer' }, { homeCountry: 'FR' }), 'country', /Jumia doesn’t sell in France/);
  assert.equal(link('noon', { query: 'iphone', country: 'SA' }).url, 'https://www.noon.com/saudi-en/search/?q=iphone');
  failsOn(() => link('noon', { query: 'iphone', country: 'SN' }), 'country', /UAE, Saudi Arabia and Egypt/);
  assert.equal(link('argos', { query: 'Electric Kettle', sort: 'price_asc', price_min: 20, price_max: 50 }).url, 'https://www.argos.co.uk/search/electric-kettle/opt/price:20-50/sort:price/');
  assert.equal(link('google_shopping', { query: 'air fryer' }, { homeCountry: 'SN' }).url, 'https://www.google.com/search?q=air%20fryer&tbm=shop&hl=en&gl=sn');
  assert.deepEqual(DL.shopsFor('SN').map(s => s.domain), ['jumia.sn', 'amazon.fr']);
  assert.deepEqual(DL.shopsFor('AE').map(s => s.domain), ['noon.com/uae-en', 'amazon.ae']);
  assert.deepEqual(DL.shopsFor('GB').map(s => s.domain), ['amazon.co.uk', 'argos.co.uk']);
  assert.equal(link('linkedin_jobs', { query: 'data analyst', location: 'Paris', posted: 'week', remote: 'remote' }).url,
    'https://www.linkedin.com/jobs/search/?keywords=data%20analyst&location=Paris&f_TPR=r604800&f_WT=2');
  assert.equal(link('indeed', { query: 'développeur', location: 'Lyon', posted: 'day' }, { homeCountry: 'FR' }).url,
    'https://fr.indeed.com/jobs?q=d%C3%A9veloppeur&l=Lyon&fromage=1&sort=date');
  assert.equal(link('indeed', { query: 'nurse' }, { homeCountry: 'US' }).url, 'https://www.indeed.com/jobs?q=nurse&sort=date');
  assert.equal(link('eventbrite', { city: 'Paris', country: 'FR', query: 'Jazz & blues' }).url, 'https://www.eventbrite.com/d/france--paris/jazz-blues/');
  assert.equal(link('eventbrite', { city: 'Dakar' }, { homeCountry: 'SN' }).url, 'https://www.eventbrite.com/d/senegal--dakar/all-events/');
  failsOn(() => link('eventbrite', { city: 'Dakar' }), 'country');
  assert.equal(link('meetup', { query: 'hiking', city: 'Paris', country: 'FR' }).url, 'https://www.meetup.com/find/?keywords=hiking&location=fr--Paris&source=EVENTS');
  failsOn(() => link('linkedin_jobs', { query: 'x', posted: 'year' }), 'posted');
});

test('deep links: parcels (carrier from the number), scholarly sites and their data APIs', () => {
  assert.equal(DL.carrierOf('1Z999AA10123456784'), 'ups');
  assert.equal(DL.carrierOf('9400 1000 0000 0000 0000 00'), 'usps');
  assert.equal(DL.carrierOf('LX123456789FR'), 'laposte');
  assert.equal(DL.carrierOf('1234567890'), 'dhl');
  assert.equal(DL.carrierOf('123456789012'), 'fedex');
  assert.equal(DL.carrierOf('LX123456789CN'), null);
  const p = link('parcel', { number: '1z999aa10123456784' });
  assert.equal(p.url, 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
  assert.equal(p.carrier, 'UPS');
  assert.equal(link('parcel', { number: 'LX123456789CN' }).url, 'https://t.17track.net/en#nums=LX123456789CN');
  assert.equal(link('parcelsapp', { number: 'LX123456789CN' }).url, 'https://parcelsapp.com/en/tracking/LX123456789CN');
  assert.equal(link('fedex', { number: '123456789012' }).url, 'https://www.fedex.com/fedextrack/?trknbr=123456789012');
  assert.equal(link('dhl', { number: '1234567890' }).url, 'https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=1234567890');
  assert.equal(link('usps', { number: '9400100000000000000000' }).url, 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000000');
  assert.equal(link('laposte', { number: 'LX123456789FR' }).url, 'https://www.laposte.fr/outils/suivre-vos-envois?code=LX123456789FR');
  assert.equal(link('aramex', { number: '12345678901' }).url, 'https://www.aramex.com/us/en/track/results?ShipmentNumber=12345678901');
  failsOn(() => link('ups', { number: 'abc' }), 'number', /6–40 letters and digits/);
  failsOn(() => link('ups', { number: '1Z<script>' }), 'number');
  assert.equal(link('google_scholar', { query: 'vitamin D', year_from: 2020 }).url, 'https://scholar.google.com/scholar?q=vitamin%20D&hl=en&as_ylo=2020');
  assert.equal(link('pubmed', { query: 'vitamin D' }).url, 'https://pubmed.ncbi.nlm.nih.gov/?term=vitamin%20D');
  assert.equal(link('arxiv', { query: 'rag' }).url, 'https://arxiv.org/search/?query=rag&searchtype=all');
  const ss = link('semantic_scholar', { query: 'rag', year_from: 2023 });
  assert.equal(ss.kind, 'json');
  assert.match(ss.url, /^https:\/\/api\.semanticscholar\.org\/graph\/v1\/paper\/search\?query=rag&fields=title,year,authors,url,externalIds,venue,citationCount&limit=10&year=2023-$/);
  assert.equal(link('crossref', { query: 'Attention is all you need' }).url,
    'https://api.crossref.org/works?query.bibliographic=Attention%20is%20all%20you%20need&rows=5&select=DOI,title,author,issued,container-title,URL');
  failsOn(() => link('google_scholar', { query: 'x', year_from: 1500 }), 'year_from');
  // Every site has a sample that builds (links:check opens it) and a home page to fall back to.
  for (const site of DL.SITE_KEYS) {
    const l = DL.buildLink(site, DL.sampleOf(site, TODAY), { today: TODAY });
    assert.match(l.url, /^https:\/\//, site);
    assert.match(DL.SITES[site].home, /^https:\/\//, site);
  }
  assert.equal(DL.todayIn('Pacific/Kiritimati', new Date('2026-09-26T12:00:00Z')), '2026-09-27');
  assert.equal(DL.todayIn('Not/AZone', new Date('2026-09-26T12:00:00Z')), '2026-09-26');
});

test('links:check verdicts: results, broken (error, home page, empty, off-site, no results) and blocked; the state switches a recipe off', () => {
  const l = link('booking', { place: 'Lisbon', checkin: '2026-10-10', checkout: '2026-10-12' });
  const text = 'Lisbon: 312 properties found '.repeat(20);
  assert.equal(L.linkVerdict({ link: l, finalUrl: l.url, status: 200, title: 'Hotels in Lisbon', text }).status, 'ok');
  assert.deepEqual(L.linkVerdict({ link: l, finalUrl: l.url, status: 200, wall: 'Cloudflare', text }), { status: 'blocked', detail: 'Cloudflare (the recipe may still be fine)' });
  assert.equal(L.linkVerdict({ link: l, finalUrl: l.url, status: 404, text }).detail, 'the site answered 404');
  assert.equal(L.linkVerdict({ link: l, finalUrl: 'https://www.booking.com/', status: 200, text }).detail, 'it went to the home page');
  assert.equal(L.linkVerdict({ link: l, finalUrl: 'https://elsewhere.example/x', status: 200, text }).detail, 'it went to elsewhere.example');
  assert.match(L.linkVerdict({ link: l, finalUrl: l.url, status: 200, text: 'tiny' }).detail, /nearly empty/);
  assert.equal(L.linkVerdict({ link: l, finalUrl: l.url, status: 200, title: 'Nope', text, expect: /flights?/i }).detail, 'no results on the page');
  // The state file (data/, never git): only "broken" switches a recipe off.
  L.saveLinkState({ checkedAt: '2026-09-26T05:00:00Z', sites: { booking: { status: 'broken', at: '2026-09-26T05:00:00Z', detail: 'it went to the home page' },
    kayak: { status: 'blocked', at: '2026-09-26T05:00:00Z', detail: 'PerimeterX' } } });
  assert.equal(fs.existsSync(path.join(paths.data, 'deeplinks-state.json')), true);
  assert.deepEqual(L.recipeOff('booking'), { at: '2026-09-26T05:00:00Z', detail: 'it went to the home page' });
  assert.equal(L.recipeOff('kayak'), null);
  assert.equal(L.recipeOff('airbnb'), null); // never checked counts as on
  fs.rmSync(path.join(paths.data, 'deeplinks-state.json'));
});

const fakeTab = url => ({ active: { url: () => url }, imported: [] });
const pageText = url => `Navigated to ${url}\nPage: Results — ${url}\n\n${S.SNAPSHOT_MARK}\n- heading "312 properties found" [level=1] [ref=e5]`;

test('open_search opens the built address in the tab (one step), says what the link can’t carry, and names other shops', async () => {
  const opened = [];
  const openPage = async (ctx, url) => { opened.push(url); return { s: fakeTab(url), text: pageText(url) }; };
  const ctx = { user: ann, thread: { id: 1 }, run: null };
  const out = await browse.openSearch({ site: 'google_flights', from: 'NBO', to: 'CDG', depart: '2026-10-10', return: '2026-10-17', adults: 2 }, ctx, { openPage, today: TODAY });
  assert.equal(opened[0], 'https://www.google.com/travel/flights?q=Flights%20from%20NBO%20to%20CDG%20on%202026-10-10%20through%202026-10-17&hl=en');
  assert.match(out.content, /^OPEN_SEARCH: Google Flights results for from NBO · to CDG · depart 2026-10-10 · return 2026-10-17 · adults 2/);
  assert.match(out.content, /set 2 adults on the page/);
  assert.match(out.content, new RegExp(`${S.SNAPSHOT_MARK}\\n<browser_page`)); // the page is fenced like browser_open's
  assert.equal(out.step.detail, 'Results');
  // Shops: the person's country picks the domain, and the other shops that serve it are named.
  const shop = await browse.openSearch({ site: 'jumia', query: 'air fryer' }, ctx, { openPage, today: TODAY });
  assert.equal(opened[1], 'https://www.jumia.sn/catalog/?q=air%20fryer');
  assert.match(shop.content, /Other shops that serve SN: amazon\.fr/);
  // A bad field opens nothing and says which.
  const bad = await browse.openSearch({ site: 'booking', place: 'Faro', checkin: '2026-09-01', checkout: '2026-09-03' }, ctx, { openPage, today: TODAY });
  assert.equal(opened.length, 2);
  assert.match(bad.content, /didn’t open anything: checkin \(2026-09-01\) is in the past/);
  assert.equal(bad.step.status, 'bad');
  // A recipe links:check switched off: the site's own search page, and Jess is told to use its form.
  const off = await browse.openSearch({ site: 'booking', place: 'Faro', checkin: '2026-10-01', checkout: '2026-10-03' }, ctx,
    { openPage, today: TODAY, linkState: { sites: { booking: { status: 'broken', at: '2026-09-20T04:00:00Z', detail: 'it went to the home page' } } } });
  assert.equal(opened[2], 'https://www.booking.com/');
  assert.match(off.content, /results address stopped working \(checked 2026-09-20: it went to the home page\), so I opened its own search page instead — fill its form for: place Faro/);
  // The tool is registered for the web toolset as a read, with the site list in its schema.
  const tool = getTool('open_search');
  assert.equal(tool.toolset, 'web');
  assert.equal(tool.risk, 'read');
  assert.deepEqual(tool.parameters.properties.site.enum, DL.SITE_KEYS);
});

test('open_search: Overpass places listed nearest first with distances worked out in code', () => {
  const json = { elements: [
    { type: 'node', id: 2, lat: 14.7063, lon: -17.4467, tags: { name: 'Pharmacie Nord', opening_hours: 'Mo-Sa 08:00-20:00' } },
    { type: 'way', id: 3, center: { lat: 14.6933, lon: -17.4462 }, tags: { name: 'Pharmacie Centrale', phone: '+221 33 000 00 00' } },
    { type: 'node', id: 4, tags: { name: 'no position' } },
  ] };
  const text = browse.overpassText(json, { lat: 14.6928, lon: -17.4467 });
  const lines = text.split('\n');
  assert.match(lines[0], /^2 places, nearest first/);
  assert.match(lines[1], /^- Pharmacie Centrale · \d+ m · \+221 33 000 00 00 · https:\/\/www\.openstreetmap\.org\/way\/3 · directions: https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=14\.693300,-17\.446200$/);
  assert.match(lines[2], /^- Pharmacie Nord · 1\.5 km · hours Mo-Sa 08:00-20:00/);
  assert.match(browse.overpassText({ elements: [] }, { lat: 0, lon: 0 }), /No places matched/);
});

// ---- Learned site recipes (#165) -----------------------------------------------------------------------------------------
test('recipes: only the shape is kept — names and slots, never values; session, tracking and opaque state are dropped', () => {
  const r = RC.recipeFrom('https://www.booking.com/searchresults.html?ss=Lisbon&checkin=2026-10-10&checkout=2026-10-17&group_adults=2&aid=304142&label=gen173nr-1FCAEoggI&sid=9f86d081884c7d65&utm_source=news&srpvid=77aa&gclid=xyz&lang=en-gb',
    ['Lisbon'], { formUrl: 'https://www.booking.com/' });
  assert.deepEqual(r, { host: 'www.booking.com', pathTemplate: '/searchresults.html', hasQuery: true,
    params: ['ss={query}', 'checkin={date}', 'checkout={date}', 'group_adults={number}', 'lang={value}'] });
  // A typed value in the path becomes {query}; a capitalised name the person didn't type is a value, not structure.
  assert.equal(RC.recipeFrom('https://www.airbnb.com/s/Lisbon--Portugal/homes?checkin=2026-10-10&adults=2', ['lisbon']).pathTemplate, '/s/{query}/homes');
  assert.equal(RC.recipeFrom('https://shop.example/search/Paris/results?q=blue+kettle', ['Blue kettle']).pathTemplate, '/search/{value}/results');
  // Google Flights keeps its whole search in an opaque tfs= blob: not reproducible, so no recipe.
  assert.equal(RC.recipeFrom('https://www.google.com/travel/flights/search?tfs=CBwQAhoeEgoyMDI2LTEwLTEwagcIARIDVFVOcgcIARIDQ0RHQAFIAXABggELCP8BmAEB&hl=en', ['Nairobi']), null);
  assert.equal(RC.recipeFrom('https://example.com/results?page=2', ['kettle']), null); // what was typed isn't in it: not a search address
  assert.equal(RC.recipeFrom('https://example.com/?q=kettle', []), null);
  assert.equal(RC.recipeFrom('not a url', ['x']), null);
  assert.deepEqual(RC.recipeFrom('https://app.example/find#q=tea&sessionToken=abc', ['tea']).params, ['#q={query}']);
});

test('recipes: learned after a search, offered as a hint, counted when used, dropped after two failures in a row', () => {
  const url = 'https://www.booking.com/searchresults.html?ss=Faro&checkin=2026-11-01&checkout=2026-11-03&group_adults=2&sid=abc';
  assert.ok(RC.learnRecipe(url, ['Faro'], { formUrl: 'https://www.booking.com/' }));
  RC.learnRecipe(url.replace('Faro', 'Madeira'), ['Madeira'], { formUrl: 'https://www.booking.com/' });
  const rows = all('SELECT * FROM site_recipes');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok_count, 2);
  for (const secret of ['Faro', 'Madeira', '2026-11-01', 'abc', 'sid=']) assert.ok(!JSON.stringify(rows).includes(secret), secret); // never values
  const hint = RC.recipeHint('https://booking.com/');
  assert.equal(hint, 'Known results URL shape on booking.com (learned from an earlier search there; worked 2×): '
    + 'https://www.booking.com/searchresults.html?ss={query}&checkin={date}&checkout={date}&group_adults={number} — fill the slots and open it to get results in one step; if it doesn’t give results, use the site’s form.');
  assert.equal(RC.recipeHint('https://www.airbnb.com/'), null);
  // Opening an address of that shape: kept its parameters → ok; a bot wall says nothing; the home page → failure.
  const again = 'https://www.booking.com/searchresults.html?ss=Coimbra&checkin=2026-12-01&checkout=2026-12-02&group_adults=1';
  assert.equal(RC.noteRecipeUse({ requestedUrl: again, finalUrl: `${again}&srpvid=1`, status: 200 }), 'ok');
  assert.equal(RC.noteRecipeUse({ requestedUrl: again, finalUrl: again, status: 200, wall: 'Cloudflare' }), null);
  assert.equal(RC.noteRecipeUse({ requestedUrl: 'https://www.booking.com/other.html?x=1', finalUrl: 'https://www.booking.com/', status: 200 }), null); // not its shape
  assert.equal(RC.noteRecipeUse({ requestedUrl: again, finalUrl: 'https://www.booking.com/', status: 200 }), 'fail');
  assert.equal(get('SELECT fail_count FROM site_recipes').fail_count, 1);
  assert.equal(RC.noteRecipeUse({ requestedUrl: again, finalUrl: again, status: 500 }), 'dropped');
  assert.equal(get('SELECT COUNT(*) AS n FROM site_recipes').n, 0);
  assert.equal(RC.recipeHint('https://www.booking.com/'), null);
  // A success in between resets the count: two failures must be in a row.
  RC.learnRecipe(url, ['Faro']);
  RC.noteRecipeUse({ requestedUrl: again, finalUrl: 'https://www.booking.com/', status: 200 });
  RC.noteRecipeUse({ requestedUrl: again, finalUrl: again, status: 200 });
  assert.equal(RC.noteRecipeUse({ requestedUrl: again, finalUrl: 'https://www.booking.com/', status: 200 }), 'fail');
  assert.equal(get('SELECT COUNT(*) AS n FROM site_recipes').n, 1);
  // The note goes just before the page snapshot, in Jess's own part of the result.
  assert.equal(S.beforeSnapshot(`Navigated.\nPage: x — y\n\n${S.SNAPSHOT_MARK}\n- a`, 'HINT'), `Navigated.\nPage: x — y\nHINT\n\n${S.SNAPSHOT_MARK}\n- a`);
  assert.equal(S.beforeSnapshot('No tab is open.', 'HINT'), 'No tab is open.\nHINT');
});

// ---- browser_upload (#166) -------------------------------------------------------------------------------------------------
test('browser_upload: own Library files only, always asks (external), reach = the website, preview names file and site', async () => {
  const tool = getTool('browser_upload');
  const cv = await up.saveUpload(ann, { buffer: Buffer.from('Ann Owner — CV\nExperience: lots.'), originalname: 'Ann CV.txt' });
  const args = { ref: 'e12', library_id: cv.id, site: 'https://www.jobs.example.com/apply', element: 'Upload your CV' };
  assert.equal(policy.riskOf(tool, args, { user: ann }), 'external');
  assert.equal(policy.riskOf(tool, args, { user: bob }), 'read'); // not bob's: no card that would name it; refused when it runs
  assert.equal(policy.assess(ann, tool, args, null).verdict, 'ask');
  assert.equal(reachOf(tool, args, 'external'), 'the website jobs.example.com');
  assert.deepEqual(undoOf(tool, args, 'external'), { possible: false, note: 'the website keeps its copy of the file' });
  assert.equal(tool.approvalTitle(args), `Upload “${cv.title}” to jobs.example.com`);
  assert.match(tool.approvalPreview(args), new RegExp(`^File: ${cv.title}\\nWebsite: jobs\\.example\\.com\\nField: Upload your CV\\n\\nThe website gets a copy`));
  const refused = await tool.run(args, { user: bob, thread: { id: 2 }, run: null });
  assert.match(refused.content, /isn’t one of the person’s Library files/);
  assert.equal(refused.step.status, 'bad');
  // Ann's own file, but no tab open in this chat: it fails plainly (nothing is attached anywhere).
  const noTab = await tool.run(args, { user: ann, thread: { id: 987654 }, run: null });
  assert.equal(noTab.step.status, 'bad');
  // The autopilot still never offers file inputs (they are the main loop's, with this approval).
  assert.match(fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'browser', 'pilot.js'), 'utf8'), /\['password', 'file', 'hidden'\]\.includes\(e\.type\)/);
});

// ---- web_screenshot options (#166) ---------------------------------------------------------------------------------------
test('web_screenshot: desktop, phone (390×844 at 2×, touch) and full page options; save_pdf in the schema', () => {
  assert.deepEqual(R.shotOptions(), { page: { viewport: { width: 1280, height: 800 } }, fullPage: false });
  assert.deepEqual(R.shotOptions({ mobile: true }), { page: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, mobile: true }, fullPage: false });
  assert.deepEqual(R.shotOptions({ fullPage: true, mobile: false }), { page: { viewport: { width: 1280, height: 800 } }, fullPage: true });
  assert.equal(R.shotOptions({ fullPage: 'yes' }).fullPage, true);
  assert.equal(R.FULL_PAGE_MAX, 15000);
  const tool = getTool('web_screenshot');
  for (const k of ['full_page', 'mobile', 'save_pdf']) assert.equal(tool.parameters.properties[k].type, 'boolean', k);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.label({ url: 'https://www.bbc.co.uk/news', mobile: true, save_pdf: true }), 'Saved bbc.co.uk (phone) as a PDF');
  assert.equal(tool.label({ url: 'https://www.bbc.co.uk/news' }), 'Screenshot of bbc.co.uk');
});

// ---- The autopilot's domain lock (#166) ----------------------------------------------------------------------------------
test('autopilot domain lock: same site, a site the goal named, a sign-in or payment hand-off go on; anything else stops', () => {
  const at = (url, goal = 'Search flights from Zurich to London') => domainLock({ start: 'google.com', url, goal });
  assert.deepEqual(at('https://www.google.com/travel/flights/search'), { verdict: 'same', other: null });
  assert.deepEqual(at('https://accounts.google.com/signin'), { verdict: 'same', other: null }); // same registrable domain
  assert.deepEqual(at('https://www.skyscanner.net/transport/flights'), { verdict: 'blocked', other: 'skyscanner.net' });
  assert.deepEqual(at('https://www.skyscanner.net/x', 'compare the price on Skyscanner'), { verdict: 'named', other: 'skyscanner.net' });
  assert.deepEqual(at('https://www.booking.com/', 'then check booking.com'), { verdict: 'named', other: 'booking.com' });
  assert.deepEqual(at('https://www.booking.com/', 'rebooking the flight'), { verdict: 'blocked', other: 'booking.com' }); // a word, not a substring
  assert.deepEqual(at('https://checkout.stripe.com/c/pay/cs_live'), { verdict: 'handoff', other: 'stripe.com' });
  assert.deepEqual(at('https://www.paypal.com/checkoutnow'), { verdict: 'handoff', other: 'paypal.com' });
  assert.deepEqual(at('https://login.microsoftonline.com/common'), { verdict: 'handoff', other: 'microsoftonline.com' });
  assert.deepEqual(at('https://www.facebook.com/login.php'), { verdict: 'handoff', other: 'facebook.com' });
  assert.deepEqual(at('https://www.facebook.com/someone'), { verdict: 'blocked', other: 'facebook.com' }); // only its sign-in pages
  assert.deepEqual(at('https://evilstripe.com/pay'), { verdict: 'blocked', other: 'evilstripe.com' }); // a host that merely ends in the name
  assert.deepEqual(domainLock({ start: null, url: 'https://anything.example/' }), { verdict: 'same', other: null }); // started on a blank tab
  assert.deepEqual(at('about:blank'), { verdict: 'same', other: null });
  assert.ok(HANDOFFS.length >= 20);
});

// ---- Snapshot shrink by priority (#166) ----------------------------------------------------------------------------------
test('snapshot shrink: refs, headings and their ancestors survive; plain text collapses; link targets go first', () => {
  const lines = ['- main [ref=e1]:'];
  let ref = 2;
  for (let sec = 0; sec < 40; sec++) {
    lines.push(`  - region "Section ${sec}":`, `    - heading "Heading ${sec}" [level=2]`);
    for (let p = 0; p < 20; p++) lines.push(`    - paragraph: ${`Lorem ipsum dolor sit amet ${sec}.${p} `.repeat(6)}`);
    lines.push('    - list:');
    for (let i = 0; i < 4; i++) lines.push(`      - listitem:`, `        - link "Result ${sec}-${i}" [ref=e${ref++}]:`, `          - /url: https://example.com/${sec}/${i}`);
  }
  const room = 14000;
  const out = S.__test.shrinkSnapshot(lines, room);
  assert.ok(out.length <= room, `${out.length} > ${room}`);
  assert.ok(lines.join('\n').length > room * 10); // a genuinely large page
  const kept = new Set(out.split('\n'));
  for (const l of lines.filter(x => /\[ref=|- heading /.test(x))) assert.ok(kept.has(l), `lost: ${l}`);
  for (let sec = 0; sec < 40; sec++) assert.ok(kept.has(`  - region "Section ${sec}":`), `ancestor ${sec}`);
  assert.ok(!out.includes('/url:'));
  assert.match(out, /- … (\d+ more lines|\d+ lines) of text/);
  assert.match(out, /\(long page: plain text was shortened to fit; browser_read gives the text\)$/);
  // Small enough already: unchanged apart from link targets.
  assert.equal(S.__test.shrinkSnapshot(['- a [ref=e1]', '  - /url: x', '- text: hi'], 100), '- a [ref=e1]\n- text: hi');
  // Even the important lines don't fit: cut at a line, and said so.
  const huge = Array.from({ length: 3000 }, (_, i) => `- button "B${i}" [ref=e${i}]`);
  const cut = S.__test.shrinkSnapshot(huge, 4000);
  assert.ok(cut.length <= 4000);
  assert.match(cut, /- button "B0" \[ref=e0\]/);
  assert.match(cut, /… \(page continues — use browser_snapshot with find="…", a ref to a region, or scroll\)$/);
  assert.ok(cut.split('\n').slice(0, -1).every(l => /^- button "B\d+" \[ref=e\d+\]$/.test(l))); // whole lines only
});

// ---- Domain trust (#167) -----------------------------------------------------------------------------------------------
test('trust: punycode, mixed alphabets, IP hosts, brands on other domains, look-alikes, http passwords, cross-site redirects', () => {
  const kinds = (url, o = {}) => T.trustSignals({ url, ...o }).map(s => s.kind);
  assert.deepEqual(kinds('https://www.paypal.com/signin'), []);
  assert.deepEqual(kinds('https://accounts.google.com/'), []);
  assert.deepEqual(kinds('https://lh3.googleusercontent.com/a'), []); // the brand's own other domain
  assert.deepEqual(kinds('https://www.amazon.co.uk/'), []); // the brand on another suffix
  assert.deepEqual(kinds('https://xn--80aa0cbo65f.com/'), ['punycode', 'lookalike']); // раураӏ.com, all Cyrillic
  assert.deepEqual(kinds('https://раураl.com/login'), ['mixed-script', 'lookalike']); // Cyrillic with a Latin l
  assert.match(T.trustSignals({ url: 'https://раураl.com/' })[0].text, /mixes alphabets \(раураl\.com\)/);
  assert.deepEqual(kinds('https://bücher.de/'), ['punycode']); // a real IDN: only "check it"
  assert.deepEqual(kinds('https://paypal.com.secure-login.xyz/'), ['brand']);
  assert.match(T.trustSignals({ url: 'https://paypal.com.secure-login.xyz/' })[0].text, /mentions “paypal” but the site is secure-login\.xyz/);
  assert.deepEqual(kinds('https://dhl-delivery-fee.com/'), ['brand']);
  assert.deepEqual(kinds('https://nooner.com/'), []); // a short brand only as a whole word
  assert.deepEqual(kinds('https://paypa1.com/'), ['lookalike']);
  assert.deepEqual(kinds('http://192.168.1.4/admin', { password: true }), ['ip', 'http-password']);
  assert.deepEqual(kinds('http://example.org/login', { password: true }), ['http-password']);
  assert.deepEqual(kinds('https://example.org/login', { password: true }), []);
  assert.deepEqual(kinds('https://evil.example/login', { chain: ['https://mybank.com/', 'https://t.co/abc', 'https://evil.example/login'] }), ['redirect']);
  assert.deepEqual(kinds('https://www.mybank.com/login', { chain: ['https://mybank.com/', 'https://auth.mybank.com/'] }), []); // one site
  assert.equal(T.cautionLine([]), null);
  assert.match(T.cautionLine(T.trustSignals({ url: 'https://paypa1.com/' })), /^CAUTION: The site paypa1\.com is spelled like paypal with swapped characters\. Don’t type anything into this page/);
});

test('trust: the person’s own mail and calendar domains become brands (cached)', () => {
  saveConnection(ann, 'email', { label: 'Bank mail', provider: 'custom', password: 'app-password',
    config: { address: 'ann@mybankmail.ca', username: 'ann@mybankmail.ca', imap: { host: 'imap.mybankmail.ca', port: 993, secure: true }, smtp: { host: 'smtp.mybankmail.ca', port: 465, secure: true } } });
  T.clearBrandCache();
  const brands = T.brandsFor(ann);
  assert.ok(brands['household-mail'].has('household-mail.example')); // from her account's email
  assert.ok(brands.mybankmail.has('mybankmail.ca')); // from her mail connection
  assert.deepEqual(T.trustSignals({ url: 'https://mybankmail-verify.com/', brands }).map(s => s.kind), ['brand']);
  assert.deepEqual(T.trustSignals({ url: 'https://webmail.mybankmail.ca/', brands }).map(s => s.kind), []);
  assert.equal(T.addBrandDomain({}, 'mail.example')?.mail, undefined); // generic names are never brands
  assert.equal(T.brandsFor(ann), brands); // cached for the viewer's polling
});

// ---- Ad and tracker blocking (#168) --------------------------------------------------------------------------------------
test('ad blocking: off by default; the form keeps it when it leaves it out; turning it on starts the lists', async () => {
  assert.equal(B.DEFAULTS.blockAds, false);
  assert.equal(B.browserSettings().blockAds, false);
  let started = 0;
  const start = () => { started++; };
  const form = { maxPages: 2, idleMinutes: 5, blockMedia: true, allowPrivate: false, engines: ['duckduckgo'] };
  assert.equal((await B.saveBrowserSettings(form, { start })).blockAds, false);
  assert.equal((await B.saveBrowserSettings({ ...form, blockAds: true }, { start })).blockAds, true);
  assert.equal(started, 1);
  assert.equal((await B.saveBrowserSettings(form, { start })).blockAds, true); // left out → kept
  assert.equal((await B.saveBrowserSettings({ ...form, blockAds: false }, { start })).blockAds, false);
  assert.equal(B.browserStatus().adblock, null); // status only reports it while on
});

const fakeRoute = (url, { type = 'script', page = 'https://news.example/article', mainFrame = false } = {}) => {
  const calls = [];
  const pg = { url: () => page };
  const frame = { url: () => page, page: () => pg };
  pg.mainFrame = () => (mainFrame ? frame : null);
  return { calls, request: () => ({ url: () => url, resourceType: () => type, frame: () => frame, isNavigationRequest: () => mainFrame, headers: () => ({}) }),
    abort: reason => calls.push(['abort', reason]), continue: () => calls.push(['continue']), fulfill: o => calls.push(['fulfill', o]) };
};

test('ad blocking runs inside the request guard, after the network check; top-page navigations and switched-off sites pass', async () => {
  const engine = FiltersEngine.parse('||ads.example.com^\n||tracker.example.net^$script\n@@||192.168.1.10^');
  const on = B.routeGuard({ blockAds: true, allowPrivate: true, engine: () => engine });
  const run = async (guard, url, o) => { const r = fakeRoute(url, o); await guard(r); return r.calls; };
  assert.deepEqual(await run(on, 'https://ads.example.com/banner.js'), [['abort', 'blockedbyclient']]);
  assert.deepEqual(await run(on, 'https://tracker.example.net/t.js'), [['abort', 'blockedbyclient']]);
  assert.deepEqual(await run(on, 'https://tracker.example.net/pixel.gif', { type: 'image' }), [['continue']]); // the rule says scripts
  assert.deepEqual(await run(on, 'https://news.example/app.js'), [['continue']]);
  assert.deepEqual(await run(on, 'https://ads.example.com/', { type: 'document', mainFrame: true, page: 'https://ads.example.com/' }), [['continue']]); // Jess opened it
  assert.deepEqual(await run(on, 'https://ads.example.com/frame.html', { type: 'document' }), [['abort', 'blockedbyclient']]); // an ad frame
  // Off by default (the setting), and no engine yet → everything passes.
  assert.deepEqual(await run(B.routeGuard({ blockAds: false, allowPrivate: true, engine: () => engine }), 'https://ads.example.com/banner.js'), [['continue']]);
  assert.deepEqual(await run(B.routeGuard({ blockAds: true, allowPrivate: true, engine: () => null }), 'https://ads.example.com/banner.js'), [['continue']]);
  // The network check runs first and always: a private address is refused even when the ad lists would allow it.
  const strict = B.routeGuard({ blockAds: true, allowPrivate: false, engine: () => engine });
  assert.deepEqual(await run(strict, 'http://192.168.1.10/api'), [['abort', 'blockedbyclient']]);
  assert.deepEqual(await run(B.routeGuard({ blockAds: false, allowPrivate: false, engine: () => engine }), 'http://127.0.0.1:3737/'), [['abort', 'blockedbyclient']]);
  // A site with an anti-adblock wall: blocking goes off for it (30 days), not for others.
  assert.equal(AB.antiAdblockWall({ title: 'Ad blocker detected', text: '' }), true);
  assert.equal(AB.antiAdblockWall({ title: 'Le Monde', text: 'Vous utilisez un bloqueur de publicité. Désactivez votre bloqueur pour continuer.' }), true);
  assert.equal(AB.antiAdblockWall({ title: 'Recipes', text: 'A plain page about bread.' }), false);
  assert.equal(AB.antiAdblockWall({ title: 'How ad blockers work', text: 'Ad blockers are browser extensions that hide ads.' }), false); // a mention, not a request
  assert.equal(AB.antiAdblockWall({ title: 'News', text: 'It looks like you are using an adblocker. Please disable it.' }), true);
  AB.switchOffFor('www.news.example');
  assert.equal(AB.adblockOffFor('news.example'), true);
  assert.deepEqual(await run(on, 'https://ads.example.com/banner.js'), [['continue']]);
  assert.deepEqual(await run(on, 'https://ads.example.com/banner.js', { page: 'https://other.example/' }), [['abort', 'blockedbyclient']]);
  // The engine's compiled form is what's cached on disk.
  const copy = FiltersEngine.deserialize(engine.serialize());
  assert.deepEqual(AB.adblockDecision(copy, { url: 'https://ads.example.com/x.js', type: 'script', sourceUrl: 'https://other.example/' }), { block: true });
});
