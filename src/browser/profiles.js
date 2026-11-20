// Saved sign-ins, sealed (decision #136). Each person's browser keeps its cookies and site storage between sessions
// (data/browser-profiles/u<id>.json, decision #56) — which includes every site they signed in to during a hand-over. Those
// files used to be plain JSON forever; now they are sealed with the install's key (lib/secrets.js, AES-256-GCM, the key in
// .env, never in the data folder), so a copied data folder or backup doesn't carry live sign-ins. An older plaintext file is
// sealed the first time it is read. Also here: which sites a person is signed in to, and forgetting one.
import fs from 'node:fs';
import path from 'node:path';
import { getDomain } from 'tldts';
import { paths } from '../config/index.js';
import { sealData, unsealData, isSealed } from '../lib/secrets.js';

export const profileFile = userId => path.join(paths.browserProfiles, `u${Number(userId)}.json`);
export const searchProfileFile = () => path.join(paths.browserProfiles, 'search.json'); // search engines' checks only, no sign-ins

const validState = j => (j && Array.isArray(j.cookies) ? { cookies: j.cookies, origins: Array.isArray(j.origins) ? j.origins : [] } : undefined);

/** Write a storage state sealed, via a temp file then rename (tasks and sessions save at the same time). Never throws. */
export function saveProfile(file, state) {
  try {
    const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, sealData(JSON.stringify(validState(state) || { cookies: [], origins: [] })), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.warn('[browser] profile not saved:', err.message);
    return false;
  }
}

/**
 * A profile's storage state ({ cookies, origins }) for a new browser context, or undefined (none yet, unreadable, or
 * sealed with another key — the browser then starts fresh, as it did for a broken file). A plaintext file from before
 * sealing is read once and rewritten sealed.
 */
export function loadProfile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  if (isSealed(text)) {
    try { return validState(JSON.parse(unsealData(text.trim()))); } catch (err) {
      console.warn(`[browser] ${path.basename(file)} couldn’t be unsealed (${err.message.split('\n')[0]}): starting that browser fresh`);
      return undefined;
    }
  }
  let state;
  try { state = validState(JSON.parse(text)); } catch { return undefined; }
  if (state) saveProfile(file, state); // migrate: plaintext → sealed, once
  return state;
}

// ---- Signed-in sites ---------------------------------------------------------------------------------------------------
// A cookie that looks like a sign-in: session / auth / token / login names and the big sites' own sign-in cookies. Not
// analytics, consent choices or bot-check passes (those say nothing about an account).
const SIGN_IN = /sess|(^|[_.-])sid($|[_.-])|^sid|auth|token|login|logged|jwt|remember|(^|[_-])user|account|identity|sso|^li_at$|^c_user$|^xs$|^twid$|^ct0$|^(__secure-[0-9a-z]*)?(sapisid|apisid|ssid|hsid|psid)|^dotcom_user$|^_gh_sess$/i;
const NOT_SIGN_IN = /^(_ga|_gid|_gat|_gcl|_fbp|_fbc|__utm|_hj|_clck|_clsk|ajs_|amplitude|mp_|optimizely|optanon|euconsent|consent|socs|cookieconsent|cookie_consent|cookie-consent|cookielawinfo|__cf_bm|cf_clearance|_cfuvid|aec|nid|1p_jar|otz|datadome|_px|ak_bmsc|bm_|_abck|abck|csrf|xsrf|_csrf|g_state)/i;
export const looksSignIn = name => SIGN_IN.test(String(name || '')) && !NOT_SIGN_IN.test(String(name || ''));

/** The registrable domain ("bbc.co.uk") of a cookie domain or host name. */
export const siteOf = host => { const h = String(host || '').replace(/^\./, '').toLowerCase(); return getDomain(h, { allowPrivateDomains: true }) || h; };
const unexpired = c => c.expires == null || c.expires < 0 || c.expires * 1000 > Date.now();

/**
 * Sites in a storage state, grouped by registrable domain → [{ site, cookies, signIn, expires }] sorted by site; only the
 * ones with sign-in-looking cookies unless all. expires: the latest sign-in cookie expiry (ISO), null for session cookies.
 */
export function sitesOf(state, { all = false } = {}) {
  const by = new Map();
  for (const c of (state?.cookies || []).filter(unexpired)) {
    const site = siteOf(c.domain);
    const s = by.get(site) || { site, cookies: 0, signIn: 0, expires: null };
    s.cookies++;
    if (looksSignIn(c.name)) {
      s.signIn++;
      if (c.expires > 0) { const iso = new Date(c.expires * 1000).toISOString(); if (!s.expires || iso > s.expires) s.expires = iso; }
    }
    by.set(site, s);
  }
  return [...by.values()].filter(s => all || s.signIn > 0).sort((a, b) => a.site.localeCompare(b.site));
}

/** The sites this person's browser is signed in to (see sitesOf). */
export const signedInSites = (userId, opts) => sitesOf(loadProfile(profileFile(userId)), opts);

/** A storage state without anything belonging to `site` (cookies of that registrable domain, its origins' storage). */
export function withoutSite(state, site) {
  const s = siteOf(site);
  const cookies = (state?.cookies || []).filter(c => siteOf(c.domain) !== s);
  const origins = (state?.origins || []).filter(o => { try { return siteOf(new URL(o.origin).hostname) !== s; } catch { return true; } });
  return { state: { cookies, origins }, removed: (state?.cookies?.length || 0) - cookies.length + (state?.origins?.length || 0) - origins.length };
}

/** Remove one site from this person's saved profile file. → how many cookies/storage entries went. (Live sessions:
 *  session.js forgetSite clears those first, then calls this.) */
export function forgetSiteInProfile(userId, site) {
  const file = profileFile(userId);
  const state = loadProfile(file);
  if (!state) return 0;
  const out = withoutSite(state, site);
  if (out.removed) saveProfile(file, out.state);
  return out.removed;
}
