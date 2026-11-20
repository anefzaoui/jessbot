// Walls between Jess and a page (decision #136): bot checks, access-denied pages and full-page consent screens. One
// definition, used by web_read (read.js, the escalation ladder) and the interactive browser (session.js). A wall is judged on
// what a person would see first: the title, the first ~1,500 characters of text and the frames on the page — challenge
// pages are short, so text-only signals count only on a short page (an article ABOUT Cloudflare is not a Cloudflare wall).
// Many of these pages answer 200, so the status alone never decides.
//
// The ladder in read.js: a check that solves itself (Cloudflare's "Just a moment…", DDoS-Guard, Vercel) gets up to 12 s;
// then one retry with the person's own cookies (read-only) and media on; then an honest BLOCKED and a 30-minute rest for
// that host, so Jess doesn't hammer a site that said no.

export const WALL_TEXT_CHARS = 1500;
const SHORT_PAGE = 3000; // characters of visible text: challenge and consent pages are well under this

// selfSolving: the page runs a check and moves on by itself when the browser passes it.
const RULES = [
  { id: 'cloudflare', label: 'Cloudflare', selfSolving: true,
    title: /^(just a moment|un instant|einen moment|un momento|um momento|attention required|one more step|please wait|checking your browser)\b/i,
    text: /checking (if the site connection is secure|your browser)|verif(y|ying) you are (a )?human|enable javascript and cookies to continue|needs to review the security of your connection|performance (&|and) security by cloudflare/i,
    frames: /(?:^|\s)https:\/\/challenges\.cloudflare\.com\//i }, // a frame served from that host (frames are space-joined)
  { id: 'ddos-guard', label: 'DDoS-Guard', selfSolving: true, title: /^ddos-guard/i, text: /ddos-guard|checking your browser before accessing/i },
  { id: 'vercel', label: 'a Vercel security check', selfSolving: true, title: /vercel security checkpoint/i, text: /vercel security checkpoint/i },
  { id: 'reddit', label: 'Reddit’s bot check', selfSolving: true, title: /prove your humanity/i, text: /prove your humanity/i },
  { id: 'reddit-block', label: 'Reddit’s network block', selfSolving: false, text: /you'?ve been blocked by network security/i },
  { id: 'perimeterx', label: 'PerimeterX', selfSolving: false, title: /access to this page has been denied/i,
    text: /press (&|and) hold|px-captcha|perimeterx|pardon our interruption/i, frames: /px-cloud|perimeterx|captcha\.px-cdn/i },
  { id: 'datadome', label: 'DataDome', selfSolving: false, text: /captcha-delivery|datadome/i, frames: /captcha-delivery\.com|geo\.captcha-delivery/i },
  { id: 'incapsula', label: 'Imperva', selfSolving: false, text: /incapsula incident id|request unsuccessful\. incapsula/i, frames: /_incapsula_resource/i },
  { id: 'akamai', label: 'an access-denied wall', selfSolving: false, title: /^access denied$|^403 forbidden$|^forbidden$/i,
    text: /you don'?t have permission to access|reference #\d+\.[0-9a-f]+|access to this page is forbidden/i },
  { id: 'captcha', label: 'a bot check', selfSolving: false, title: /captcha|are you (a )?(robot|human)|robot check|security check|bot verification/i,
    text: /are you a robot|unusual traffic|verify you are human|i'?m not a robot|not a robot|enter the characters you see below|complete the security check|solve this captcha/i,
    frames: /recaptcha\/api2\/anchor|hcaptcha\.com\/captcha|arkoselabs|funcaptcha/i },
  // Amazon's soft block for automated visitors (seen from this network, #164): a 200 page that only says "click the button
  // below to continue shopping", or "Sorry, an internal error" with no results. `host` must match as well (AND), so a real
  // Amazon page is never a wall and a shop page elsewhere saying "continue shopping" isn't either.
  { id: 'amazon', label: 'Amazon’s bot check', selfSolving: false, host: /(^|\.)amazon\.[a-z.]+$/i,
    title: /^(toutes nos excuses|sorry! something went wrong!?|lo sentimos|es tut uns leid)$/i,
    text: /click the button below to continue shopping|cliquez sur le bouton ci-dessous pour continuer vos achats|klicke auf die schaltfläche unten, um mit dem einkaufen fortzufahren|to discuss automated access to amazon data|erreur de système interne a été décelée/i },
  // Full-page consent screens (Google, YouTube, Yahoo send you to a separate consent page before the site).
  { id: 'consent', label: 'a consent page', kind: 'consent', selfSolving: false,
    url: /^https?:\/\/(consent\.(google|youtube)\.[a-z.]+|guce\.(yahoo|aol)\.com|consent\.yahoo\.com)\//i,
    title: /^before you continue|^bevor sie fortfahren|^avant d'accéder|^prima di continuare|^antes de continuar/i },
];

/**
 * { title, text, textLength, frames: [src…], url, status } → { id, label, kind: 'bot'|'consent', selfSolving } | null. Pure.
 * text: the page's first WALL_TEXT_CHARS characters; textLength: all of its visible text.
 */
export function detectWall({ title = '', text = '', textLength = null, frames = [], url = '', status = null } = {}) {
  const t = String(title || '').trim();
  const head = String(text || '').slice(0, WALL_TEXT_CHARS);
  const len = textLength ?? String(text || '').length;
  const frameList = [].concat(frames || []).join(' ');
  const short = len < SHORT_PAGE;
  let host = '';
  try { host = new URL(url).hostname; } catch { /* no address */ }
  for (const r of RULES) {
    if (r.host && !r.host.test(host)) continue; // a site-specific rule: the host must match too
    const hit = (r.url && r.url.test(url)) || (r.title && r.title.test(t)) || (r.frames && frameList && r.frames.test(frameList) && short)
      || (r.text && short && r.text.test(head));
    if (hit) return { id: r.id, label: r.label, kind: r.kind || 'bot', selfSolving: !!r.selfSolving };
  }
  // A refusal with no page of its own worth reading. 503 is often a maintenance page: only when short.
  if (status === 403 || status === 429 || (status === 503 && short)) return { id: 'http', label: `an HTTP ${status} block`, kind: 'bot', selfSolving: false };
  return null;
}

/** What detectWall needs, read from the live page (never throws: a page mid-navigation reads as empty). */
export async function wallProbe(page) {
  const probe = await page.evaluate(n => {
    const body = document.body?.innerText || '';
    return { title: document.title, text: body.slice(0, n), textLength: body.trim().length,
      frames: [...document.querySelectorAll('iframe')].map(f => f.src).filter(Boolean).slice(0, 20) };
  }, WALL_TEXT_CHARS).catch(() => ({ title: '', text: '', textLength: 0, frames: [] }));
  return { ...probe, url: page.url() };
}

/** The wall on this page right now, or null. status: the HTTP status of the page's document, when known. */
export async function probeWall(page, status = null) {
  return detectWall({ ...(await wallProbe(page)), status });
}

/**
 * A check that solves itself: wait (≤ maxMs) until the page stops being a wall. statusOf() gives the current document's
 * status (a passed check navigates to the real page, with its own status). → the wall still there, or null.
 */
export async function waitOutWall(page, { maxMs = 12000, statusOf = () => null, stepMs = 500 } = {}) {
  const until = Date.now() + maxMs;
  let wall = await probeWall(page, statusOf());
  while (wall && Date.now() < until) {
    await page.waitForTimeout(stepMs).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    wall = await probeWall(page, statusOf());
  }
  return wall;
}

/**
 * Follow the page's main document: a passed check navigates to the real page, which has its own response and status.
 * → { response(), status(), stop() }. first: the response page.goto returned (until a newer one arrives).
 */
export function trackDocument(page, first = null) {
  let last = first;
  const on = r => { try { if (r.frame() === page.mainFrame() && r.request().isNavigationRequest()) last = r; } catch { /* detached frame */ } };
  page.on('response', on);
  return { response: () => last, status: () => last?.status() ?? null, stop: () => page.off('response', on), set: r => { last ||= r; } };
}

// ---- Resting a host that blocked us ---------------------------------------------------------------------------------------
export const HOST_COOLDOWN_MS = 30 * 60000;
const resting = new Map(); // host → { until, label }
const hostKey = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return String(u || '').toLowerCase(); } };

export function restHost(url, label, ms = HOST_COOLDOWN_MS) {
  resting.set(hostKey(url), { until: Date.now() + ms, label });
  if (resting.size > 500) resting.delete(resting.keys().next().value);
}
/** { until, label } while the host rests, else null. */
export function hostResting(url) {
  const k = hostKey(url);
  const r = resting.get(k);
  if (!r) return null;
  if (r.until <= Date.now()) { resting.delete(k); return null; }
  return r;
}
export const clearResting = () => resting.clear(); // tests

// ---- Cookie / consent panels the browser's autoconsent didn't handle -----------------------------------------------------
// Find the panel (any frame) and decline — or accept, when that is the only way on (a consent wall with one button).
const CONSENT_TEXT = /cookie|consent|privacy|confidentialit|vie privée|données personnelles|rgpd|gdpr|datenschutz|privacidad/i;
const REJECT = /^(tout refuser|refuser(?: tout| les cookies)?|continuer sans accepter|reject(?: all)?(?: cookies)?|decline(?: all)?|deny|only (?:necessary|essential)(?: cookies)?|(?:use )?necessary cookies only|accept only (?:necessary|essential)|alle ablehnen|nur notwendige|rechazar(?: todo)?|rifiuta(?: tutto)?)\b/i;
const ACCEPT = /^(tout accepter|accepter(?: tout| et fermer| les cookies)?|j'accepte|accept(?: all)?(?: cookies)?|i accept|agree|allow all|got it|ok|alle akzeptieren|aceptar(?: todo)?|accetta(?: tutto)?)\b/i;

/** Click the panel's decline (else accept) button. → the button's label, or null when there was no panel. */
export async function dismissConsent(page) {
  for (const frame of page.frames()) {
    const inFrame = frame !== page.mainFrame();
    const hit = await frame.evaluate(([textRe, rejectRe, acceptRe, isFrame]) => {
      const [t, rj, ac] = [textRe, rejectRe, acceptRe].map(x => new RegExp(x, 'i'));
      const visible = el => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
      const panels = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog, [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="cmp" i], [class*="didomi" i], [id*="onetrust" i], [id*="truste" i], [class*="axeptio" i]')]
        .filter(el => visible(el) && t.test(el.textContent || ''));
      // Consent iframes (Sourcepoint, TrustArc…) are small documents that are the panel themselves; so are full-page
      // consent screens (consent.google.com), which have no panel element — their whole body is the panel.
      const wholePage = document.documentElement.textContent.length < 5000 && t.test(document.body?.textContent || '');
      if (!panels.length && !((isFrame || location.hostname.startsWith('consent.') || location.hostname.startsWith('guce.')) && wholePage)) return null;
      const scope = panels.length ? panels : [document.body];
      const buttons = scope.flatMap(p => [...p.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')]).filter(visible);
      const label = b => (b.getAttribute('aria-label') || b.value || b.textContent || '').replace(/\s+/g, ' ').trim();
      const pick = buttons.find(b => rj.test(label(b))) || buttons.find(b => ac.test(label(b)));
      if (!pick) return null;
      pick.click();
      return label(pick).slice(0, 40);
    }, [CONSENT_TEXT.source, REJECT.source, ACCEPT.source, inFrame]).catch(() => null);
    if (hit) return hit;
  }
  return null;
}
