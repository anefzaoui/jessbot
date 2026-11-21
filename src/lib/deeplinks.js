// Deep links (decision #164): ready-made results addresses for the sites people search most — flights, stays, maps,
// shops, jobs, events, parcels and scholarly search — so Jess opens the results in one step instead of driving a form
// through autocomplete and a date picker (the verified Google Flights run took 18 steps; the date picker was where
// an airline's site failed, #112). Pure code: validated inputs in, one URL out. The recipes come from the skills review
// (volt report-householdA C2); `npm run links:check` opens one sample per site and switches off recipes that stopped
// landing on results (data/deeplinks-state.json), and Jess then uses the site's own form.
//
// Fields are the same words across sites (from, to, depart, return, adults, children = ages…); each builder encodes them
// the site's way (Skyscanner YYMMDD dates and "7|4" ages, Booking's repeated age=, Ryanair's adults/teens/children/infants).
// What a site's link can't carry is returned in `notes` ("set the travellers on the page"), never silently dropped.

export class LinkError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'LinkError';
    this.field = field;
    this.status = 400;
    this.expose = true;
  }
}
const fail = (field, message) => { throw new LinkError(field, message); };

// ---- Field checks -----------------------------------------------------------------------------------------------------
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const enc = v => encodeURIComponent(v);

/** Today as YYYY-MM-DD in a time zone (the person's; UTC when unknown or invalid). */
export function todayIn(timeZone = 'UTC', now = new Date()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); } catch {
    return now.toISOString().slice(0, 10);
  }
}

function text(v, field, { max = 200, required = true } = {}) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return required ? fail(field, `${field} is needed.`) : null;
  if (t.length > max) fail(field, `${field} is too long (at most ${max} characters).`);
  return t;
}

function isoDate(v, field, today, { required = true } = {}) {
  if (v == null || v === '') return required ? fail(field, `${field} is needed (YYYY-MM-DD).`) : null;
  const m = DATE.exec(String(v).trim());
  if (!m) fail(field, `${field} must be a date as YYYY-MM-DD (got “${String(v).slice(0, 30)}”).`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) fail(field, `${field}: ${v} isn’t a real date.`);
  if (today && String(v).trim() < today) fail(field, `${field} (${v}) is in the past — today is ${today}.`);
  return String(v).trim();
}

function int(v, field, { min, max, def }) {
  if (v == null || v === '') { if (def === undefined) fail(field, `${field} is needed.`); return def; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(field, `${field} must be a whole number from ${min} to ${max}.`);
  return n;
}

function money(v, field) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) fail(field, `${field} must be an amount of 0 or more.`);
  return Math.round(n * 100) / 100;
}

/** Children as a list of ages (0–17; under 2 = an infant on a lap). */
function ages(v, field = 'children') {
  if (v == null || v === '') return [];
  const list = Array.isArray(v) ? v : String(v).split(/[\s,|]+/).filter(Boolean);
  if (list.length > 8) fail(field, 'At most 8 children.');
  return list.map(a => {
    const n = Number(a);
    if (!Number.isInteger(n) || n < 0 || n > 17) fail(field, `${field} are ages from 0 to 17 (got “${a}”); adults go in adults.`);
    return n;
  });
}

function currency(v) {
  if (v == null || v === '') return null;
  const c = String(v).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c) || !CURRENCIES.has(c)) fail('currency', `currency must be an ISO code like EUR, JPY or USD (got “${String(v).slice(0, 10)}”).`);
  return c;
}

function iata(v, field, { cityCodes = false } = {}) {
  const t = String(v ?? '').trim();
  if (!t) fail(field, `${field} is needed (an airport code like NBO).`);
  if (!(cityCodes ? /^[A-Za-z]{3,4}$/ : /^[A-Za-z]{3}$/).test(t)) fail(field, `${field} must be an airport code like NBO or CDG (got “${t.slice(0, 20)}”).`);
  return t.toUpperCase();
}

function oneOf(v, field, options, def) {
  if (v == null || v === '') return def;
  const k = String(v).trim().toLowerCase();
  if (!options.includes(k)) fail(field, `${field} must be one of: ${options.join(', ')}.`);
  return k;
}

function country(v, field = 'country') {
  if (v == null || v === '') return null;
  const c = String(v).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) fail(field, `${field} must be a two-letter country code like KE, FR or GB.`);
  return c;
}

const CABINS = ['economy', 'premium', 'business', 'first'];

/** The shared flight fields, checked. */
function flightFields(f, today, { cityCodes = false, requireIata = true } = {}) {
  const from = requireIata ? iata(f.from, 'from', { cityCodes }) : text(f.from, 'from', { max: 80 });
  const to = requireIata ? iata(f.to, 'to', { cityCodes }) : text(f.to, 'to', { max: 80 });
  if (from.toUpperCase() === to.toUpperCase()) fail('to', 'from and to are the same place.');
  const depart = isoDate(f.depart, 'depart', today);
  const ret = isoDate(f.return, 'return', today, { required: false });
  if (ret && ret < depart) fail('return', `return (${ret}) is before depart (${depart}).`);
  const adults = int(f.adults, 'adults', { min: 1, max: 9, def: 1 });
  const children = ages(f.children);
  if (adults + children.length > 9) fail('children', 'At most 9 travellers in one search.');
  if (children.filter(a => a < 2).length > adults) fail('children', 'Each infant under 2 needs an adult.');
  return { from, to, depart, ret, adults, children, cabin: oneOf(f.cabin, 'cabin', CABINS, 'economy'), currency: currency(f.currency), nonstop: !!f.nonstop };
}

function stayFields(f, today) {
  const place = text(f.place ?? f.query, 'place', { max: 120 });
  const checkin = isoDate(f.checkin, 'checkin', today);
  const checkout = isoDate(f.checkout, 'checkout', today);
  if (checkout <= checkin) fail('checkout', `checkout (${checkout}) must be after checkin (${checkin}).`);
  const priceMin = money(f.price_min, 'price_min'), priceMax = money(f.price_max, 'price_max');
  if (priceMin != null && priceMax != null && priceMax < priceMin) fail('price_max', 'price_max is below price_min.');
  return { place, checkin, checkout, adults: int(f.adults, 'adults', { min: 1, max: 30, def: 2 }), children: ages(f.children),
    rooms: int(f.rooms, 'rooms', { min: 1, max: 30, def: 1 }), currency: currency(f.currency), priceMin, priceMax,
    sort: oneOf(f.sort, 'sort', ['price', 'rating', 'relevance'], 'relevance') };
}

const SORTS = ['relevance', 'price_asc', 'price_desc', 'rating', 'newest'];
function shopFields(f) {
  const priceMin = money(f.price_min, 'price_min'), priceMax = money(f.price_max, 'price_max');
  if (priceMin != null && priceMax != null && priceMax < priceMin) fail('price_max', 'price_max is below price_min.');
  return { query: text(f.query, 'query', { max: 150 }), sort: oneOf(f.sort, 'sort', SORTS, 'relevance'), priceMin, priceMax, country: country(f.country) };
}

/** Travellers split the way airlines count them (Ryanair): adults 16+, teens 12–15, children 2–11, infants under 2. */
export function airlineBands(adults, children) {
  return { adults: adults + children.filter(a => a >= 16).length, teens: children.filter(a => a >= 12 && a < 16).length,
    children: children.filter(a => a >= 2 && a < 12).length, infants: children.filter(a => a < 2).length };
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const travellers = (adults, children) => [plural(adults, 'adult'), children.length ? `${plural(children.length, 'child', 'children')} (ages ${children.join(', ')})` : null].filter(Boolean).join(' and ');
const yymmdd = iso => iso.slice(2).replace(/-/g, '');

// Country → shop domains (Amazon's own sites; Jumia's African sites; Noon's regions). Several North and West African
// countries have no Amazon site of their own: amazon.fr ships there (#164).
const AMAZON = { US: 'com', GB: 'co.uk', IE: 'co.uk', FR: 'fr', BE: 'com.be', LU: 'fr', MC: 'fr', TN: 'fr', MA: 'fr', DZ: 'fr', SN: 'fr', CI: 'fr',
  DE: 'de', AT: 'de', CH: 'de', IT: 'it', ES: 'es', PT: 'es', NL: 'nl', SE: 'se', PL: 'pl', TR: 'com.tr', AE: 'ae', SA: 'sa', EG: 'eg',
  QA: 'ae', KW: 'ae', BH: 'ae', OM: 'ae', JO: 'ae', LB: 'ae', CA: 'ca', MX: 'com.mx', BR: 'com.br', AU: 'com.au', JP: 'co.jp', IN: 'in', SG: 'sg' };
const JUMIA = { TN: 'com.tn', EG: 'com.eg', MA: 'ma', NG: 'com.ng', KE: 'co.ke', GH: 'com.gh', CI: 'ci', SN: 'sn', UG: 'ug', DZ: 'dz' };
const NOON = { AE: 'uae-en', SA: 'saudi-en', EG: 'egypt-en' };
const INDEED = { US: 'www', GB: 'uk', FR: 'fr', DE: 'de', ES: 'es', IT: 'it', NL: 'nl', BE: 'be', CH: 'ch', CA: 'ca', AU: 'au', IN: 'in', IE: 'ie',
  AE: 'ae', SA: 'sa', EG: 'eg', MA: 'ma', TN: 'tn', QA: 'qa', MX: 'mx', BR: 'br', JP: 'jp', SG: 'sg', ZA: 'za', NG: 'ng', PT: 'pt', PL: 'pl', AT: 'at', SE: 'se' };
const AMAZON_SORT = { price_asc: 'price-asc-rank', price_desc: 'price-desc-rank', rating: 'review-rank', newest: 'date-desc-rank' };

/** Shops that serve a country, in the order Jess should try them (the default when the person names none). */
export function shopsFor(countryCode) {
  const c = String(countryCode || '').toUpperCase();
  const list = [];
  if (JUMIA[c]) list.push({ site: 'jumia', domain: `jumia.${JUMIA[c]}` });
  if (NOON[c]) list.push({ site: 'noon', domain: `noon.com/${NOON[c]}` });
  list.push({ site: 'amazon', domain: `amazon.${AMAZON[c] || 'com'}` });
  if (c === 'GB') list.push({ site: 'argos', domain: 'argos.co.uk' });
  return list;
}

const regionName = code => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code); } catch { return code; } };
const slug = t => String(t).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- Parcel carriers by number shape (report-householdA B14) -------------------------------------------------------
/** The carrier a tracking number most likely belongs to (a site key), or null when the shape says nothing. */
export function carrierOf(number) {
  const n = String(number || '').replace(/\s+/g, '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(n)) return 'ups';
  if (/^(94|93|92|95)\d{20}$/.test(n)) return 'usps';
  if (/^[A-Z]{2}\d{9}FR$/.test(n)) return 'laposte';
  if (/^[A-Z]{2}\d{9}US$/.test(n)) return 'usps';
  if (/^\d{10,11}$/.test(n)) return 'dhl';
  if (/^(\d{12}|\d{15})$/.test(n)) return 'fedex';
  return null;
}
function trackingNumber(v) {
  const n = String(v ?? '').replace(/\s+/g, '').toUpperCase();
  if (!n) fail('number', 'number (the tracking number) is needed.');
  if (!/^[A-Z0-9-]{6,40}$/.test(n)) fail('number', 'A tracking number is 6–40 letters and digits.');
  return n;
}

// ---- The recipes ------------------------------------------------------------------------------------------------------
// area: what kind of search · label · home: the site's own search page (the fallback) · kind: 'page' (open in the browser)
// or 'json' (data, read like web_read) · build(fields, ctx) → { url, notes? } · sample(today+N) for links:check.
// Public Overpass instances (OpenStreetMap wiki), tried in this order: the main one, then two community mirrors. On
// 2026-09-26 the main one answered this network "406 Not Acceptable" and the mirrors were up one hour and hanging the next,
// so open_search tries each in turn. VK's instance (maps.mail.ru) is left out on purpose: the query carries the person's
// home coordinates.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const plus = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

export const SITES = {
  // Flights
  google_flights: {
    area: 'flights', label: 'Google Flights', home: 'https://www.google.com/travel/flights?hl=en',
    build(f, { today }) {
      const v = flightFields(f, today, { requireIata: false });
      const words = [`Flights from ${v.from} to ${v.to} on ${v.depart}`, v.ret ? `through ${v.ret}` : 'one way',
        v.cabin !== 'economy' ? `${v.cabin === 'premium' ? 'premium economy' : v.cabin} class` : null, v.nonstop ? 'nonstop' : null].filter(Boolean).join(' ');
      const notes = [];
      if (v.adults > 1 || v.children.length) notes.push(`The link can’t carry travellers: set ${travellers(v.adults, v.children)} on the page.`);
      return { url: `https://www.google.com/travel/flights?q=${enc(words)}${v.currency ? `&curr=${v.currency}` : ''}&hl=en`, notes };
    },
    sample: t => ({ from: 'NBO', to: 'CDG', depart: plus(t, 30), return: plus(t, 37) }),
    expect: /\b(Best|Cheapest|flights?)\b/i,
  },
  skyscanner: {
    area: 'flights', label: 'Skyscanner', home: 'https://www.skyscanner.net/',
    build(f, { today }) {
      const v = flightFields(f, today, { cityCodes: true });
      const p = [`adultsv2=${v.adults}`, v.children.length ? `childrenv2=${v.children.join('|')}` : null, `cabinclass=${v.cabin === 'premium' ? 'premiumeconomy' : v.cabin}`,
        `rtn=${v.ret ? 1 : 0}`, v.nonstop ? 'preferdirects=true' : null, v.currency ? `currency=${v.currency}` : null].filter(Boolean).join('&');
      return { url: `https://www.skyscanner.net/transport/flights/${v.from.toLowerCase()}/${v.to.toLowerCase()}/${yymmdd(v.depart)}/${v.ret ? `${yymmdd(v.ret)}/` : ''}?${p}` };
    },
    sample: t => ({ from: 'NBO', to: 'CDG', depart: plus(t, 30), return: plus(t, 37) }),
  },
  kayak: {
    area: 'flights', label: 'Kayak', home: 'https://www.kayak.com/flights',
    build(f, { today }) {
      const v = flightFields(f, today);
      const kids = v.children.length ? `/children-${v.children.map(a => (a < 2 ? '1L' : String(a))).join('-')}` : '';
      const cabin = v.cabin === 'economy' ? '' : `/${v.cabin}`;
      const q = ['sort=price_a', v.nonstop ? 'fs=stops=0' : null].filter(Boolean).join('&');
      const notes = v.currency ? ['Kayak shows the currency of the site’s country: change it on the page if needed.'] : [];
      return { url: `https://www.kayak.com/flights/${v.from}-${v.to}/${v.depart}${v.ret ? `/${v.ret}` : ''}${cabin}/${v.adults}adults${kids}?${q}`, notes };
    },
    sample: t => ({ from: 'NBO', to: 'CDG', depart: plus(t, 30), return: plus(t, 37) }),
  },
  ryanair: {
    area: 'flights', label: 'Ryanair (flight select)', home: 'https://www.ryanair.com/gb/en',
    build(f, { today }) {
      const v = flightFields(f, today);
      const b = airlineBands(v.adults, v.children);
      const p = new URLSearchParams({ adults: b.adults, teens: b.teens, children: b.children, infants: b.infants, dateOut: v.depart, dateIn: v.ret || '',
        isConnectedFlight: 'false', isReturn: String(!!v.ret), discount: '0', originIata: v.from, destinationIata: v.to });
      const notes = v.cabin !== 'economy' ? ['Ryanair sells one cabin; fare bundles are chosen on the page.'] : [];
      return { url: `https://www.ryanair.com/gb/en/trip/flights/select?${p}`, notes };
    },
    sample: t => ({ from: 'STN', to: 'BCN', depart: plus(t, 30), return: plus(t, 34) }),
  },
  ryanair_fare_finder: {
    area: 'flight_deals', label: 'Ryanair fare finder', home: 'https://www.ryanair.com/gb/en/fare-finder',
    build(f, { today }) {
      const from = iata(f.from, 'from');
      const to = f.to == null || f.to === '' || String(f.to).toUpperCase() === 'ANY' ? 'ANY' : iata(f.to, 'to');
      const dateFrom = isoDate(f.date_from ?? f.depart, 'date_from', today);
      const dateTo = isoDate(f.date_to ?? f.return ?? plus(dateFrom, 30), 'date_to', today);
      if (dateTo < dateFrom) fail('date_to', `date_to (${dateTo}) is before date_from (${dateFrom}).`);
      const oneWay = f.one_way === true;
      const nMin = int(f.nights_min, 'nights_min', { min: 0, max: 30, def: oneWay ? 0 : 2 });
      const nMax = int(f.nights_max, 'nights_max', { min: nMin, max: 30, def: oneWay ? 0 : Math.max(nMin, 7) });
      const adults = int(f.adults, 'adults', { min: 1, max: 9, def: 1 });
      const b = airlineBands(adults, ages(f.children));
      const day = oneOf(f.day_of_week, 'day_of_week', ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], '');
      const max = money(f.max_price, 'max_price');
      const p = new URLSearchParams({ originIata: from, destinationIata: to, isReturn: String(!oneWay), isMacDestination: 'false', promoCode: '',
        adults: b.adults, teens: b.teens, children: b.children, infants: b.infants, dateOut: dateFrom, dateIn: dateTo, daysTrip: String(nMax),
        nightsFrom: String(nMin), nightsTo: String(nMax), dayOfWeek: day.toUpperCase(), isExactDate: 'false', outboundFromHour: '00:00',
        outboundToHour: '23:59', inboundFromHour: '00:00', inboundToHour: '23:59', priceValueTo: max == null ? '' : String(max),
        currency: currency(f.currency) || 'EUR', isFlexibleDay: 'false' });
      return { url: `https://www.ryanair.com/gb/en/fare-finder?${p}` };
    },
    sample: t => ({ from: 'STN', to: 'ANY', date_from: plus(t, 20), date_to: plus(t, 50) }),
  },
  // Stays
  airbnb: {
    area: 'stays', label: 'Airbnb', home: 'https://www.airbnb.com/',
    build(f, { today }) {
      const v = stayFields(f, today);
      const place = v.place.split(',').map(p => enc(p.trim().replace(/\s+/g, '-'))).filter(Boolean).join('--');
      const kids = v.children.filter(a => a >= 2 && a <= 12).length, infants = v.children.filter(a => a < 2).length;
      const adults = v.adults + v.children.filter(a => a > 12).length; // Airbnb counts 13+ as adults
      const p = [`checkin=${v.checkin}`, `checkout=${v.checkout}`, `adults=${adults}`, `children=${kids}`, `infants=${infants}`,
        v.priceMin != null ? `price_min=${Math.floor(v.priceMin)}` : null, v.priceMax != null ? `price_max=${Math.ceil(v.priceMax)}` : null,
        v.currency ? `currency=${v.currency}` : null].filter(Boolean).join('&');
      const notes = [v.rooms > 1 ? 'Airbnb searches whole places, not rooms: rooms was left out.' : null,
        v.sort !== 'relevance' ? 'Airbnb has no sort in the link: sort or filter on the page.' : null].filter(Boolean);
      return { url: `https://www.airbnb.com/s/${place}/homes?${p}`, notes };
    },
    sample: t => ({ place: 'Lisbon, Portugal', checkin: plus(t, 30), checkout: plus(t, 34) }),
  },
  booking: {
    area: 'stays', label: 'Booking.com', home: 'https://www.booking.com/',
    build(f, { today }) {
      const v = stayFields(f, today);
      const p = [`ss=${enc(v.place)}`, `checkin=${v.checkin}`, `checkout=${v.checkout}`, `group_adults=${v.adults}`, `group_children=${v.children.length}`,
        ...v.children.map(a => `age=${a}`), `no_rooms=${v.rooms}`, v.sort === 'price' ? 'order=price' : v.sort === 'rating' ? 'order=review_score_and_price' : null,
        v.currency ? `selected_currency=${v.currency}` : null, 'lang=en-gb'].filter(Boolean).join('&');
      const notes = v.priceMin != null || v.priceMax != null ? ['Booking’s price filter isn’t in the link: set the budget on the page.'] : [];
      return { url: `https://www.booking.com/searchresults.html?${p}`, notes };
    },
    sample: t => ({ place: 'Lisbon', checkin: plus(t, 30), checkout: plus(t, 34) }),
  },
  google_hotels: {
    area: 'stays', label: 'Google Hotels', home: 'https://www.google.com/travel/hotels?hl=en',
    build(f, { today }) {
      const v = stayFields(f, today);
      return { url: `https://www.google.com/travel/search?q=${enc(`hotels in ${v.place}`)}&hl=en${v.currency ? `&curr=${v.currency}` : ''}`,
        notes: [`The link can’t carry dates or guests: set ${v.checkin} to ${v.checkout} and ${travellers(v.adults, v.children)} on the page.`] };
    },
    sample: t => ({ place: 'Lisbon', checkin: plus(t, 30), checkout: plus(t, 34) }),
  },
  // Places (Google's documented Maps URLs, api=1)
  google_maps: {
    area: 'places', label: 'Google Maps search', home: 'https://www.google.com/maps',
    build: f => ({ url: `https://www.google.com/maps/search/?api=1&query=${enc(text(f.query, 'query', { max: 200 }))}` }),
    sample: () => ({ query: 'pharmacy near Rua Augusta, Lisbon' }),
  },
  google_maps_directions: {
    area: 'places', label: 'Google Maps directions', home: 'https://www.google.com/maps',
    build(f) {
      const destination = text(f.destination, 'destination', { max: 200 });
      const origin = text(f.origin, 'origin', { max: 200, required: false });
      const mode = oneOf(f.mode, 'mode', ['driving', 'walking', 'bicycling', 'transit'], null);
      return { url: `https://www.google.com/maps/dir/?api=1${origin ? `&origin=${enc(origin)}` : ''}&destination=${enc(destination)}${mode ? `&travelmode=${mode}` : ''}`,
        notes: origin ? [] : ['No origin: Maps starts from where the browser is, which isn’t the person — give an origin for real directions.'] };
    },
    sample: () => ({ origin: 'Lisbon Airport', destination: 'Sintra', mode: 'driving' }),
  },
  overpass: {
    area: 'places', label: 'OpenStreetMap places (Overpass)', home: 'https://overpass-turbo.eu/', kind: 'json',
    build(f) {
      const lat = Number(f.lat), lon = Number(f.lon);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) fail('lat', 'lat must be a latitude (−90 to 90).');
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) fail('lon', 'lon must be a longitude (−180 to 180).');
      const radius = int(f.radius, 'radius', { min: 100, max: 10000, def: 1500 });
      const limit = int(f.limit, 'limit', { min: 1, max: 100, def: 30 });
      const tags = [].concat(f.tags ?? []).map(t => String(t).trim()).filter(Boolean);
      if (!tags.length) fail('tags', 'tags is needed: OpenStreetMap tags like "amenity=pharmacy" (add "religion=muslim" etc. to narrow).');
      if (tags.length > 4) fail('tags', 'At most 4 tags.');
      for (const t of tags) if (!/^[a-z][a-z0-9_:]{0,40}=[\p{L}\p{N}_:;. -]{1,60}$/u.test(t)) fail('tags', `“${t.slice(0, 40)}” isn’t an OpenStreetMap tag like amenity=pharmacy.`);
      const filter = tags.map(t => { const [k, ...rest] = t.split('='); return `["${k}"="${rest.join('=').replace(/"/g, '')}"]`; }).join('');
      const q = `[out:json][timeout:25];nwr(around:${radius},${lat.toFixed(5)},${lon.toFixed(5)})${filter};out center ${limit};`;
      const [url, ...alternates] = OVERPASS.map(base => `${base}?data=${enc(q)}`);
      return { url, alternates,
        notes: ['Distances aren’t in the answer: work them out from each place’s lat/lon (rough), and say they are rough. Opening hours are often missing.'] };
    },
    sample: () => ({ lat: 14.6928, lon: -17.4467, tags: ['amenity=pharmacy'], radius: 1500 }),
  },
  // Shops
  amazon: {
    area: 'shopping', label: 'Amazon', home: 'https://www.amazon.com/',
    build(f, { homeCountry }) {
      const v = shopFields(f);
      const domain = AMAZON[v.country || homeCountry] || 'com';
      const p = [`k=${enc(v.query)}`, AMAZON_SORT[v.sort] ? `s=${AMAZON_SORT[v.sort]}` : null,
        v.priceMin != null || v.priceMax != null ? `rh=${enc(`p_36:${v.priceMin != null ? Math.round(v.priceMin * 100) : ''}-${v.priceMax != null ? Math.round(v.priceMax * 100) : ''}`)}` : null].filter(Boolean).join('&');
      return { url: `https://www.amazon.${domain}/s?${p}`, domain: `amazon.${domain}` };
    },
    sample: () => ({ query: 'air fryer', sort: 'price_asc', country: 'FR' }),
  },
  noon: {
    area: 'shopping', label: 'Noon', home: 'https://www.noon.com/uae-en/',
    build(f, { homeCountry }) {
      const v = shopFields(f);
      const c = v.country || homeCountry;
      const region = NOON[c] || (v.country ? fail('country', `Noon sells in the UAE, Saudi Arabia and Egypt only (not ${regionName(v.country)}).`) : 'uae-en');
      const notes = v.sort !== 'relevance' || v.priceMin != null || v.priceMax != null ? ['Sort and price filters aren’t in Noon’s link: set them on the page.'] : [];
      if (!NOON[c] && !v.country) notes.push('Noon doesn’t sell in the person’s country: this is the UAE site.');
      return { url: `https://www.noon.com/${region}/search/?q=${enc(v.query)}`, notes, domain: `noon.com/${region}` };
    },
    sample: () => ({ query: 'air fryer', country: 'AE' }),
  },
  jumia: {
    area: 'shopping', label: 'Jumia', home: 'https://www.jumia.com.ng/',
    build(f, { homeCountry }) {
      const v = shopFields(f);
      const c = v.country || homeCountry;
      const tld = JUMIA[c] || fail('country', `Jumia doesn’t sell in ${c ? regionName(c) : 'the person’s country'} — name a country Jumia serves (${Object.keys(JUMIA).join(', ')}).`);
      const notes = v.sort !== 'relevance' || v.priceMin != null || v.priceMax != null ? ['Sort and price filters aren’t in Jumia’s link: set them on the page.'] : [];
      return { url: `https://www.jumia.${tld}/catalog/?q=${enc(v.query)}`, notes, domain: `jumia.${tld}` };
    },
    sample: () => ({ query: 'air fryer', country: 'KE' }),
  },
  argos: {
    area: 'shopping', label: 'Argos', home: 'https://www.argos.co.uk/',
    build(f) {
      const v = shopFields(f);
      const opts = [v.priceMin != null || v.priceMax != null ? `price:${Math.floor(v.priceMin ?? 0)}-${Math.ceil(v.priceMax ?? 100000)}` : null,
        { price_asc: 'sort:price', price_desc: 'sort:price-desc', rating: 'sort:rating' }[v.sort] || null].filter(Boolean);
      return { url: `https://www.argos.co.uk/search/${enc(v.query.toLowerCase().replace(/\s+/g, '-'))}/${opts.length ? `opt/${opts.join('/')}/` : ''}`,
        notes: v.sort === 'newest' ? ['Argos has no “newest” sort in the link.'] : [] };
    },
    sample: () => ({ query: 'kettle', sort: 'price_asc' }),
  },
  google_shopping: {
    area: 'shopping', label: 'Google Shopping', home: 'https://shopping.google.com/',
    build(f, { homeCountry }) {
      const v = shopFields(f);
      const gl = v.country || homeCountry;
      return { url: `https://www.google.com/search?q=${enc(v.query)}&tbm=shop&hl=en${gl ? `&gl=${gl.toLowerCase()}` : ''}`,
        notes: v.sort !== 'relevance' || v.priceMin != null || v.priceMax != null ? ['Sort and price filters aren’t in the link: use the page’s filters.'] : [] };
    },
    sample: () => ({ query: 'air fryer' }),
  },
  // Jobs
  linkedin_jobs: {
    area: 'jobs', label: 'LinkedIn Jobs', home: 'https://www.linkedin.com/jobs/',
    build(f) {
      const query = text(f.query, 'query', { max: 150 });
      const location = text(f.location, 'location', { max: 120, required: false });
      const posted = oneOf(f.posted, 'posted', ['day', 'week', 'month'], null);
      const remote = oneOf(f.remote, 'remote', ['remote', 'hybrid', 'onsite'], null);
      const p = [`keywords=${enc(query)}`, location ? `location=${enc(location)}` : null,
        posted ? `f_TPR=r${{ day: 86400, week: 604800, month: 2592000 }[posted]}` : null, remote ? `f_WT=${{ onsite: 1, remote: 2, hybrid: 3 }[remote]}` : null].filter(Boolean).join('&');
      return { url: `https://www.linkedin.com/jobs/search/?${p}` };
    },
    sample: () => ({ query: 'data analyst', location: 'Paris', posted: 'week' }),
  },
  indeed: {
    area: 'jobs', label: 'Indeed', home: 'https://www.indeed.com/',
    build(f, { homeCountry }) {
      const query = text(f.query, 'query', { max: 150 });
      const location = text(f.location, 'location', { max: 120, required: false });
      const posted = oneOf(f.posted, 'posted', ['day', 'week', 'month'], null);
      const c = country(f.country) || homeCountry;
      const sub = INDEED[c] || 'www';
      const p = [`q=${enc(query)}`, location ? `l=${enc(location)}` : null, posted ? `fromage=${{ day: 1, week: 7, month: 30 }[posted]}` : null, 'sort=date'].filter(Boolean).join('&');
      const notes = f.remote ? ['Indeed’s remote filter isn’t in the link: add “remote” to the words or use the page’s filter.'] : [];
      if (c && !INDEED[c]) notes.push(`Indeed has no site for ${regionName(c)}: this is the US site.`);
      return { url: `https://${sub}.indeed.com/jobs?${p}`, notes };
    },
    sample: () => ({ query: 'developer', location: 'Lyon', country: 'FR', posted: 'week' }),
  },
  // Events
  eventbrite: {
    area: 'events', label: 'Eventbrite', home: 'https://www.eventbrite.com/',
    build(f, { homeCountry }) {
      const city = text(f.city ?? f.location, 'city', { max: 80 });
      const c = country(f.country) || homeCountry || fail('country', 'country is needed (two letters, e.g. FR).');
      const what = text(f.query, 'query', { max: 80, required: false });
      return { url: `https://www.eventbrite.com/d/${slug(regionName(c))}--${slug(city)}/${what ? `${slug(what)}/` : 'all-events/'}` };
    },
    sample: () => ({ city: 'Paris', country: 'FR', query: 'jazz' }),
  },
  meetup: {
    area: 'events', label: 'Meetup', home: 'https://www.meetup.com/find/',
    build(f, { homeCountry }) {
      const what = text(f.query, 'query', { max: 80 });
      const city = text(f.city ?? f.location, 'city', { max: 80, required: false });
      const c = country(f.country) || homeCountry;
      return { url: `https://www.meetup.com/find/?keywords=${enc(what)}${city && c ? `&location=${enc(`${c.toLowerCase()}--${city}`)}` : ''}&source=EVENTS`,
        notes: city && !c ? ['Meetup needs the country with the city: the location was left out.'] : [] };
    },
    sample: () => ({ query: 'hiking', city: 'Paris', country: 'FR' }),
  },
  // Parcels
  parcel: {
    area: 'parcels', label: 'Parcel tracking (carrier from the number, else 17track)', home: 'https://t.17track.net/en',
    build(f, ctx) { const n = trackingNumber(f.number); const c = carrierOf(n); return { ...SITES[c || 'track17'].build({ number: n }, ctx), carrier: c ? SITES[c].label : SITES.track17.label }; },
    sample: () => ({ number: '1Z999AA10123456784' }),
  },
  track17: { area: 'parcels', label: '17track', home: 'https://t.17track.net/en', build: f => ({ url: `https://t.17track.net/en#nums=${enc(trackingNumber(f.number))}` }), sample: () => ({ number: 'LX123456789CN' }) },
  parcelsapp: { area: 'parcels', label: 'Parcels (parcelsapp)', home: 'https://parcelsapp.com/en', build: f => ({ url: `https://parcelsapp.com/en/tracking/${enc(trackingNumber(f.number))}` }), sample: () => ({ number: 'LX123456789CN' }) },
  ups: { area: 'parcels', label: 'UPS', home: 'https://www.ups.com/track', build: f => ({ url: `https://www.ups.com/track?tracknum=${enc(trackingNumber(f.number))}` }), sample: () => ({ number: '1Z999AA10123456784' }) },
  fedex: { area: 'parcels', label: 'FedEx', home: 'https://www.fedex.com/fedextrack/', build: f => ({ url: `https://www.fedex.com/fedextrack/?trknbr=${enc(trackingNumber(f.number))}` }), sample: () => ({ number: '123456789012' }) },
  dhl: { area: 'parcels', label: 'DHL', home: 'https://www.dhl.com/global-en/home/tracking.html', build: f => ({ url: `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${enc(trackingNumber(f.number))}` }), sample: () => ({ number: '1234567890' }) },
  usps: { area: 'parcels', label: 'USPS', home: 'https://tools.usps.com/go/TrackConfirmAction', build: f => ({ url: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${enc(trackingNumber(f.number))}` }), sample: () => ({ number: '9400100000000000000000' }) },
  laposte: { area: 'parcels', label: 'La Poste', home: 'https://www.laposte.fr/outils/suivre-vos-envois', build: f => ({ url: `https://www.laposte.fr/outils/suivre-vos-envois?code=${enc(trackingNumber(f.number))}` }), sample: () => ({ number: 'LX123456789FR' }) },
  aramex: { area: 'parcels', label: 'Aramex', home: 'https://www.aramex.com/us/en/track/shipments', build: f => ({ url: `https://www.aramex.com/us/en/track/results?ShipmentNumber=${enc(trackingNumber(f.number))}` }), sample: () => ({ number: '12345678901' }) },
  // Scholarly
  google_scholar: {
    area: 'scholarly', label: 'Google Scholar', home: 'https://scholar.google.com/',
    build: f => { const y = f.year_from == null || f.year_from === '' ? null : int(f.year_from, 'year_from', { min: 1800, max: 2100 }); return { url: `https://scholar.google.com/scholar?q=${enc(text(f.query, 'query'))}&hl=en${y ? `&as_ylo=${y}` : ''}` }; },
    sample: () => ({ query: 'vitamin D deficiency children', year_from: 2020 }),
  },
  pubmed: {
    area: 'scholarly', label: 'PubMed', home: 'https://pubmed.ncbi.nlm.nih.gov/',
    build: f => { const y = f.year_from == null || f.year_from === '' ? null : int(f.year_from, 'year_from', { min: 1800, max: 2100 }); return { url: `https://pubmed.ncbi.nlm.nih.gov/?term=${enc(text(f.query, 'query'))}${y ? `&filter=years.${y}-${new Date().getUTCFullYear()}` : ''}` }; },
    sample: () => ({ query: 'vitamin D deficiency children' }),
  },
  arxiv: { area: 'scholarly', label: 'arXiv', home: 'https://arxiv.org/', build: f => ({ url: `https://arxiv.org/search/?query=${enc(text(f.query, 'query'))}&searchtype=all` }), sample: () => ({ query: 'retrieval augmented generation' }) },
  semantic_scholar: {
    area: 'scholarly', label: 'Semantic Scholar (data)', home: 'https://www.semanticscholar.org/', kind: 'json',
    build: f => { const y = f.year_from == null || f.year_from === '' ? null : int(f.year_from, 'year_from', { min: 1800, max: 2100 });
      return { url: `https://api.semanticscholar.org/graph/v1/paper/search?query=${enc(text(f.query, 'query'))}&fields=title,year,authors,url,externalIds,venue,citationCount&limit=10${y ? `&year=${y}-` : ''}` }; },
    sample: () => ({ query: 'retrieval augmented generation' }),
  },
  crossref: {
    area: 'scholarly', label: 'Crossref (data)', home: 'https://search.crossref.org/', kind: 'json',
    build: f => ({ url: `https://api.crossref.org/works?query.bibliographic=${enc(text(f.query, 'query', { max: 300 }))}&rows=5&select=DOI,title,author,issued,container-title,URL` }),
    sample: () => ({ query: 'Attention is all you need Vaswani 2017' }),
  },
};

export const SITE_KEYS = Object.keys(SITES);

/**
 * Build one results address. site: a key of SITES; fields: the search (see the tool's schema); ctx: { today (YYYY-MM-DD,
 * the person's date), homeCountry (ISO-2, for shop domains and Indeed/Eventbrite), recipes (the table, SITES unless a test
 * brings local stand-ins) }.
 * → { site, label, area, kind: 'page'|'json', url, alternates: [same search elsewhere, tried in turn], notes: [], home, domain?,
 *   carrier? }. Throws LinkError(field, message).
 */
export function buildLink(site, fields = {}, { today = todayIn(), homeCountry = null, recipes = SITES } = {}) {
  const def = Object.hasOwn(recipes, site) ? recipes[site] : null;
  if (!def) fail('site', `Unknown site “${String(site).slice(0, 40)}”. Known: ${Object.keys(recipes).join(', ')}.`);
  const out = def.build(fields || {}, { today, homeCountry: homeCountry ? String(homeCountry).toUpperCase() : null });
  return { site, label: def.label, area: def.area, kind: def.kind || 'page', home: def.home, notes: [], alternates: [], ...out, url: out.url };
}

/** The sample search links:check opens for a site (dates relative to today). */
export const sampleOf = (site, today = todayIn(), recipes = SITES) => recipes[site].sample(today);
