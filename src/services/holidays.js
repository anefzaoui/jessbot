// Public holidays (decision #141): offline, from the maintained `date-holidays` package (code ISC; data CC BY-SA 3.0,
// compiled from Wikipedia — credited in every answer). No network, no key: 200+ countries with their regions.
// Islamic holidays are computed from the calendar; the official date follows the moon sighting and can move by a day.
import Holidays from 'date-holidays';
import { invalid } from '../lib/errors.js';

export const CREDIT = 'Holiday data: date-holidays (CC BY-SA 3.0, from Wikipedia)';
const TYPES = ['public', 'bank'];
const ALL_TYPES = ['public', 'bank', 'school', 'optional', 'observance'];
const HIJRI = /\b(Muharram|Safar|Rabi|Jumada|Rajab|Shaban|Sha'ban|Ramadan|Shawwal|Dhu al-Qidah|Dhu al-Hijjah)\b/i;
const MAX_SPAN_DAYS = 3 * 366;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const catalog = new Holidays();
const fold = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

// Country names people use, in the household's languages (Intl knows them: "Indonésie", "إندونيسيا", "Deutschland"), plus the
// data's own official names ("République française").
const NAME_LANGS = ['en', 'fr', 'ar', 'de', 'es', 'it', 'nl', 'pt', 'tr'];
let byName = null;
function countryNames() {
  if (byName) return byName;
  byName = new Map();
  const codes = Object.keys(catalog.getCountries('en'));
  for (const lang of NAME_LANGS) {
    const dn = new Intl.DisplayNames([lang], { type: 'region' });
    for (const code of codes) {
      for (const n of [dn.of(code), catalog.getCountries(lang)?.[code]]) if (n && !byName.has(fold(n))) byName.set(fold(n), code);
    }
  }
  return byName;
}

const ALIASES = { uk: 'GB', greatbritain: 'GB', britain: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', usa: 'US', america: 'US',
  uae: 'AE', emirates: 'AE', ksa: 'SA', holland: 'NL' };

/** "ID" / "indonesia" / "Indonésie" / "إندونيسيا" → "ID", or null. */
export function countryCode(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[a-z]{2}$/i.test(s) && catalog.getCountries('en')[s.toUpperCase()]) return s.toUpperCase();
  const f = fold(s);
  if (ALIASES[f]) return ALIASES[f];
  const names = countryNames();
  if (names.has(f)) return names.get(f);
  const near = [...new Set([...names].filter(([n]) => n.length > 3 && (n.includes(f) || f.includes(n))).map(([, c]) => c))];
  return near.length === 1 ? near[0] : null;
}

/** A region code for that country ("BY" / "Bayern" / "Bavaria" → "BY"), or null when it has no such region. */
export function regionCode(country, input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const states = catalog.getStates(country, 'en') || {};
  if (states[s.toUpperCase()]) return s.toUpperCase();
  const f = fold(s);
  const hit = Object.entries(states).find(([code, n]) => fold(n) === f || fold(code) === f) || Object.entries(states).find(([, n]) => fold(n).includes(f));
  return hit ? hit[0] : null;
}

export const countryName = code => catalog.getCountries('en')[code] || code;
export const regionsOf = code => catalog.getStates(code, 'en') || {};

function calendar({ country, region = null, timezone = null, all = false }) {
  const c = countryCode(country);
  if (!c) throw invalid({ country: `I don't have holidays for “${country}” — give the country's name or its two-letter code.` });
  let r = null;
  if (region) {
    r = regionCode(c, region);
    if (!r) {
      const names = Object.entries(regionsOf(c)).map(([code, n]) => `${n} (${code})`);
      throw invalid({ region: names.length ? `${countryName(c)} has no region “${region}”. Its regions: ${names.slice(0, 40).join(', ')}.`
        : `${countryName(c)} has no regional holidays in this data.` });
    }
  }
  const opts = { languages: ['en'], types: all ? ALL_TYPES : TYPES, ...(timezone ? { timezone } : {}) };
  return { hd: r ? new Holidays(c, r, opts) : new Holidays(c, opts), country: c, region: r };
}

// date-holidays → { date, end?, name, type, moonSighted? }. `date` is the civil date it falls on ("YYYY-MM-DD").
function view(h) {
  const date = String(h.date).slice(0, 10);
  const days = Math.round((new Date(h.end) - new Date(h.start)) / 864e5);
  const end = days > 1 ? new Date(Date.parse(`${date}T00:00:00Z`) + (days - 1) * 864e5).toISOString().slice(0, 10) : null;
  return { date, ...(end && { end }), name: h.name, type: h.type, ...(HIJRI.test(h.rule || '') && { moonSighted: true }) };
}

/** Holidays between two dates (inclusive), soonest first. */
export function holidaysBetween({ country, region = null, from, to, timezone = null, all = false }) {
  if (!ISO_DATE.test(from || '') || !ISO_DATE.test(to || '')) throw invalid({ from: 'Give dates as YYYY-MM-DD.' });
  if (from > to) [from, to] = [to, from];
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > MAX_SPAN_DAYS) throw invalid({ to: 'Ask for at most three years at a time.' });
  const cal = calendar({ country, region, timezone, all });
  const out = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (const h of cal.hd.getHolidays(y) || []) {
      const v = view(h);
      if ((v.end || v.date) >= from && v.date <= to) out.push(v);
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return { country: cal.country, countryName: countryName(cal.country), region: cal.region, from, to, holidays: out };
}

/** Is this date a holiday there? → { date, holidays: [view] } (empty when it isn't). */
export function holidaysOn({ country, region = null, date, timezone = null, all = false }) {
  if (!ISO_DATE.test(date || '')) throw invalid({ date: 'Give the date as YYYY-MM-DD.' });
  const r = holidaysBetween({ country, region, from: date, to: date, timezone, all });
  return { ...r, date };
}

/** Plain text for the tool. */
export function holidaysText(r, { asked = null } = {}) {
  const where = `${r.countryName}${r.region ? ` (${regionsOf(r.country)[r.region] || r.region})` : ''}`;
  const line = h => `- ${h.date}${h.end ? ` to ${h.end}` : ''} ${h.name}${h.type !== 'public' ? ` (${h.type})` : ''}${h.moonSighted ? ' (date follows the moon sighting; it can move by a day)' : ''}`;
  if (asked) {
    return r.holidays.length ? `${asked} is a holiday in ${where}:\n${r.holidays.map(line).join('\n')}\n(${CREDIT})`
      : `${asked} is not a public holiday in ${where}.\n(${CREDIT})`;
  }
  if (!r.holidays.length) return `No public holidays in ${where} between ${r.from} and ${r.to}.\n(${CREDIT})`;
  return `Holidays in ${where}, ${r.from} to ${r.to}:\n${r.holidays.map(line).join('\n')}\n(${CREDIT})`;
}
