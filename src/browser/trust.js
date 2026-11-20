// Domain trust warnings (decision #167; skills review volt report-browsercost C8). Local heuristics, warn-only: Jess's
// browser never refuses a page because of them. They answer "is this really the site it looks like?" before anyone signs
// in: look-alike letters (punycode, mixed alphabets), a bare IP address, a known brand's name on somebody else's domain
// (brands = a built-in list + the person's own mail/calendar domains + sites they are signed in to), a password asked
// over plain http, and a redirect chain that crossed to another site on the way. session.js adds the CAUTION line to the
// page description only on sign-in/password pages, and the hand-over viewer (GET /threads/:id/browser) shows the site and
// its warnings so the person sees them before typing anything. Pure functions except brandsFor (reads their accounts).
import net from 'node:net';
import { domainToUnicode } from 'node:url';
import { parse } from 'tldts';
import { siteOf, signedInSites } from './profiles.js';
import { connectionsOf } from '../services/connections.js';

// Brands people get phished with, each with the registrable domains that really are theirs (besides <token>.<any suffix>).
const BUILTIN = {
  paypal: ['paypalobjects.com', 'paypal-community.com'], google: ['googleusercontent.com', 'googleapis.com', 'gstatic.com', 'googlevideo.com', 'youtube.com', 'goo.gl', 'g.co'],
  gmail: ['google.com'], apple: ['icloud.com', 'apple-cloudkit.com', 'mzstatic.com'], icloud: ['apple.com'],
  microsoft: ['microsoftonline.com', 'live.com', 'office.com', 'outlook.com', 'msn.com', 'azure.com', 'windows.net', 'sharepoint.com', 'bing.com'],
  outlook: ['live.com', 'office.com', 'microsoft.com'], office365: ['office.com', 'microsoft.com'], amazon: ['amazonaws.com', 'media-amazon.com', 'amazon-adsystem.com', 'a2z.com'],
  facebook: ['fb.com', 'facebook.net', 'fbcdn.net', 'meta.com'], instagram: ['cdninstagram.com', 'facebook.com'], whatsapp: ['whatsapp.net', 'wa.me', 'facebook.com'],
  netflix: ['nflxext.com', 'nflxso.net'], spotify: ['scdn.co'], ebay: ['ebayimg.com', 'ebaystatic.com'], linkedin: ['licdn.com'], dropbox: ['dropboxusercontent.com'],
  docusign: ['docusign.net'], adobe: [], yahoo: ['yimg.com'], steam: ['steampowered.com', 'steamcommunity.com', 'steamstatic.com'], roblox: [], tiktok: [],
  telegram: ['t.me', 'telegram.org'], binance: [], coinbase: [], revolut: [], stripe: [], visa: [], mastercard: [], americanexpress: ['aexp.com', 'amex.com'],
  chase: [], wellsfargo: [], bankofamerica: [], hsbc: [], barclays: [], santander: [], bnpparibas: ['mabanque.bnpparibas'], societegenerale: [], creditagricole: ['credit-agricole.fr'],
  dhl: [], fedex: [], usps: [], laposte: ['labanquepostale.fr'], aramex: [], booking: ['bstatic.com'], airbnb: [], emirates: [], ryanair: [], jumia: [], noon: [],
  attijariwafa: [], attijaribank: [], biat: [], zitouna: [],
};
// Too common to be a brand when they come from someone's own domains.
const GENERIC = new Set(['mail', 'email', 'login', 'account', 'accounts', 'secure', 'online', 'cloud', 'home', 'shop', 'store', 'site', 'info',
  'service', 'services', 'support', 'portal', 'bank', 'www', 'webmail', 'test', 'example', 'local', 'server', 'office', 'news', 'blog', 'app', 'apps']);

// Letters from other alphabets that look Latin (the common IDN spoofing set), mapped to what they imitate.
const CONFUSABLE = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ԁ: 'd', һ: 'h', ӏ: 'l', ѕ: 's', ԛ: 'q', ԝ: 'w', ү: 'y', к: 'k',
  м: 'm', т: 't', в: 'b', н: 'h', α: 'a', ο: 'o', ρ: 'p', ν: 'v', τ: 't', ι: 'i', κ: 'k', χ: 'x', υ: 'u', ε: 'e', β: 'b', ѡ: 'w' };
const SCRIPTS = [['Latin', /\p{Script=Latin}/u], ['Cyrillic', /\p{Script=Cyrillic}/u], ['Greek', /\p{Script=Greek}/u], ['Armenian', /\p{Script=Armenian}/u],
  ['Cherokee', /\p{Script=Cherokee}/u], ['Georgian', /\p{Script=Georgian}/u]];
const scriptsOf = label => new Set([...label].filter(ch => /\p{L}/u.test(ch)).map(ch => SCRIPTS.find(([, re]) => re.test(ch))?.[0] || 'other'));
const skeleton = label => [...label.toLowerCase()].map(ch => CONFUSABLE[ch] || ch).join('');
const leet = label => label.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/5/g, 's').replace(/rn/g, 'm').replace(/vv/g, 'w');

/** brands: { token: Set(registrable domains that are really theirs) }. The built-in list, as sets. */
export function builtinBrands() {
  return Object.fromEntries(Object.entries(BUILTIN).map(([t, d]) => [t, new Set(d)]));
}

/** Add a person's own domain (their mail provider, a site they sign in to) as a brand: its name belongs to that domain. */
export function addBrandDomain(brands, domain) {
  const p = parse(String(domain || '').toLowerCase().replace(/^\./, ''), { allowPrivateDomains: true });
  const token = p.domainWithoutSuffix;
  if (!p.domain || !token || token.length < 4 || GENERIC.has(token) || /^\d+$/.test(token) || token.includes('.')) return brands;
  (brands[token] ||= new Set()).add(p.domain);
  return brands;
}

const isOwnDomain = (token, site, domainWithoutSuffix, brands) => domainWithoutSuffix === token || brands[token]?.has(site);

/**
 * What looks wrong about an address → [{ kind, text }]. Pure.
 * kinds: ip · punycode · mixed-script · lookalike · brand · http-password · redirect.
 * password: the page shows a password field; chain: the main-frame addresses the last action went through (oldest first).
 */
export function trustSignals({ url, password = false, chain = [], brands = builtinBrands() } = {}) {
  let u;
  try { u = new URL(url); } catch { return []; }
  if (!['http:', 'https:'].includes(u.protocol)) return [];
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const out = [];
  if (net.isIP(host)) {
    out.push({ kind: 'ip', text: `The address is a bare IP number (${host}), not a named site — real sign-in pages don’t use those.` });
  } else {
    const p = parse(host, { allowPrivateDomains: true });
    const site = p.domain || host;
    const own = p.domainWithoutSuffix || '';
    const shown = domainToUnicode(host);
    const labels = host.split('.');
    if (labels.some(l => l.startsWith('xn--'))) {
      const uLabels = shown.split('.');
      const mixed = uLabels.find(l => scriptsOf(l).size > 1);
      const fake = uLabels.map(skeleton).find(l => /^[a-z0-9-]+$/.test(l) && brands[l.replace(/-/g, '')] !== undefined);
      if (mixed) out.push({ kind: 'mixed-script', text: `The address mixes alphabets (${shown}): letters from different scripts that look alike are a classic fake-site trick.` });
      else out.push({ kind: 'punycode', text: `The address uses letters beyond plain a–z (${shown}, written ${host}) — check it is the site you expect.` });
      if (fake) out.push({ kind: 'lookalike', text: `It is spelled to look like ${fake} but is a different address.` });
    }
    // A brand's name somewhere in the host (subdomain or a hyphenated part) on a registrable domain that isn't the brand's.
    const words = host.slice(0, host.length - (p.publicSuffix ? p.publicSuffix.length + 1 : 0)).split(/[.-]/).filter(Boolean);
    // Short names count only as a whole word (dhl-delivery.com, not nooner.com); longer ones inside a word too (paypalsecure).
    const named = Object.keys(brands).find(t => ((t.length >= 3 && words.includes(t)) || (t.length >= 6 && words.some(w => w.length > t.length && w.includes(t))))
      && !isOwnDomain(t, site, own, brands));
    if (named) out.push({ kind: 'brand', text: `The address mentions “${named}” but the site is ${site}, not ${named}’s own domain.` });
    else {
      const swapped = leet(own);
      if (swapped !== own && brands[swapped] !== undefined && !isOwnDomain(swapped, site, own, brands)) {
        out.push({ kind: 'lookalike', text: `The site ${site} is spelled like ${swapped} with swapped characters.` });
      }
    }
  }
  if (password && u.protocol === 'http:') out.push({ kind: 'http-password', text: 'This page asks for a password over an unencrypted connection (http), so it can be read on the way.' });
  const hops = [];
  for (const c of chain) { try { const s = siteOf(new URL(c).hostname); if (s && hops.at(-1) !== s) hops.push(s); } catch { /* not a URL */ } }
  const here = siteOf(host);
  if (hops.length >= 2 && hops.at(-1) === here && hops[0] !== here) out.push({ kind: 'redirect', text: `Getting here passed through other sites: ${hops.join(' → ')}.` });
  return out;
}

/** The CAUTION line for a sign-in or password page (null when nothing looks wrong). */
export function cautionLine(signals) {
  if (!signals?.length) return null;
  return `CAUTION: ${signals.map(s => s.text).join(' ')} Don’t type anything into this page, and tell the person what looks wrong before they sign in themselves.`;
}

// ---- The person's own domains, as brands (cached: the hand-over viewer asks every 2 s) -------------------------------------
const cache = new Map(); // userId → { at, brands }
const CACHE_MS = 5 * 60000;
const domainOf = s => String(s || '').split('@').pop().trim();
export function brandsFor(user) {
  if (!user) return builtinBrands();
  const hit = cache.get(user.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.brands;
  const brands = builtinBrands();
  addBrandDomain(brands, domainOf(user.email));
  for (const kind of ['email', 'calendar']) {
    let list = [];
    try { list = connectionsOf(user, kind); } catch { /* no table yet (tests) */ }
    for (const c of list) {
      for (const d of [domainOf(c.config?.address), domainOf(c.config?.username), c.config?.imap?.host, c.config?.smtp?.host]) addBrandDomain(brands, d);
      try { if (c.config?.url) addBrandDomain(brands, new URL(c.config.url).hostname); } catch { /* not a URL */ }
    }
  }
  try { for (const s of signedInSites(user.id)) addBrandDomain(brands, s.site); } catch { /* no profile */ }
  cache.set(user.id, { at: Date.now(), brands });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return brands;
}
export const clearBrandCache = () => cache.clear(); // tests
