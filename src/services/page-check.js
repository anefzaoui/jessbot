// Jess looks at the pages she makes (decision #145). A Library HTML page is rendered once through the browser with the
// same sandbox CSP the viewer serves it with (services/library.js ARTIFACT_CSP): inline code plus the three CDNs, no
// network APIs; the browser's own guard still blocks the local network. That one render gives
//   - the 1024×640 thumbnail the person sees on the step and in the Library (as before);
//   - what went wrong while it ran: uncaught errors (with their line in the file), console errors, resources the page
//     rules blocked, scripts and styles that failed to load;
//   - how it holds up on a phone (390×844, the same page resized, so responsive CSS and resize handlers apply):
//     horizontal overflow, text cut off by overflow:hidden boxes (a bounded count), a near-blank screen (little visible
//     text and nothing drawn, confirmed by the pixel spread of the phone screenshot);
//   - the phone screenshot itself, which the tool can hand to the model as an image (shot refs below).
// Best effort and time-bounded: a check that can't run never fails the save.
import fs from 'node:fs';
import path from 'node:path';
import { withPage } from '../browser/index.js';
import { saveShot } from '../browser/read.js';
import { paths } from '../config/index.js';
import { oneLine } from '../lib/untrusted.js';

export const ARTIFACT_URL = 'https://artifact.jessbot.invalid/'; // reserved name: never resolves, only our route answers
export const THUMB = { width: 1024, height: 640 };
export const PHONE = { width: 390, height: 844 };
const MAX_LISTED = 3;

const trim = (s, n = 140) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Some browser builds (CloakBrowser, an anti-detection build) send no console or page-error events over DevTools, so the
// page reports on itself: this runs before any of its own scripts (Page.addScriptToEvaluateOnNewDocument, not subject to its CSP) and
// keeps uncaught errors, rejected promises, console.error calls, resources that failed and CSP refusals in a hidden
// array that readIssues() collects. A page could tamper with it, but it can only hide its own problems from its own check.
const STORE = '__jessbotPageIssues';
function instrument(key) {
  const store = [];
  Object.defineProperty(window, key, { value: store });
  const push = (kind, message, line = null) => { if (store.length < 40 && message) store.push({ kind, message: String(message).slice(0, 300), line: line || null }); };
  addEventListener('error', e => {
    const el = e.target;
    if (el && el !== window && el.tagName) push('failed', el.src || el.href || el.currentSrc || el.tagName.toLowerCase());
    else push('error', e.error ? `${e.error.name || 'Error'}: ${e.error.message}` : e.message, e.lineno);
  }, true);
  addEventListener('unhandledrejection', e => push('error', `Unhandled promise rejection: ${e.reason?.message || e.reason}`));
  document.addEventListener('securitypolicyviolation', e => push('blocked', e.blockedURI && e.blockedURI !== 'inline' ? e.blockedURI : `${e.violatedDirective} (inline)`));
  const original = console.error;
  console.error = function error(...args) {
    push('console', args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'object' ? (() => { try { return JSON.stringify(a); } catch { return String(a); } })() : String(a))).join(' '));
    return original.apply(this, args);
  };
}

/**
 * Serve `html` at ARTIFACT_URL with `csp` on this page, start collecting what goes wrong, and open it.
 * → issues: { errors: [{ message, line }], console: [{ message, line }], blocked: [url or text], failed: [{ url, why }] }
 * (filled by the network listeners now and by readIssues later).
 */
export async function openArtifact(page, html, { csp, timeout = 15000 } = {}) {
  const issues = { errors: [], console: [], blocked: [], failed: [] };
  await page.addInitScript(instrument, STORE);
  // Seen through DevTools too: refusals by the page rules, and requests that failed or came back with an error.
  page.on('console', msg => {
    const text = msg.type() === 'error' ? msg.text() : '';
    if (/violates the following Content Security Policy|^Refused to /.test(text)) addIssue(issues, 'blocked', /'((?:https?|wss?|data|blob):[^']*)'/.exec(text)?.[1] || trim(text.split(/ because | violates /)[0], 120));
  });
  page.on('requestfailed', req => {
    if (req.url() === ARTIFACT_URL) return;
    const why = req.failure()?.errorText || 'failed';
    if (/csp/i.test(why)) addIssue(issues, 'blocked', req.url()); else addIssue(issues, 'failed', req.url(), why);
  });
  page.on('response', res => {
    const type = res.request().resourceType();
    if (res.status() >= 400 && ['script', 'stylesheet', 'font', 'image'].includes(type)) addIssue(issues, 'failed', res.url(), `HTTP ${res.status()}`);
  });
  await page.route(ARTIFACT_URL, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html,
    headers: csp ? { 'Content-Security-Policy': csp } : {} }));
  await page.goto(ARTIFACT_URL, { waitUntil: 'load', timeout });
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  return issues;
}

// One entry per problem: a blocked URL is not also reported as failed; the same message is kept once.
function addIssue(issues, kind, message, extra) {
  if (kind === 'blocked') {
    const url = trim(message, 120);
    issues.failed = issues.failed.filter(f => f.url !== url);
    if (issues.blocked.length < 20 && !issues.blocked.includes(url)) issues.blocked.push(url);
  } else if (kind === 'failed') {
    const url = trim(message, 120);
    if (issues.failed.length < 20 && !issues.blocked.includes(url) && !issues.failed.some(f => f.url === url)) issues.failed.push({ url, why: extra || 'failed to load' });
  } else {
    const list = kind === 'error' ? issues.errors : issues.console;
    const entry = { message: trim(message, 160), line: extra || null };
    if (list.length < 20 && !list.some(x => x.message === entry.message)) list.push(entry);
  }
}

/** Collect what the page reported about itself (instrument) into issues. Call while the page is still open. */
export async function readIssues(page, issues) {
  const found = await page.evaluate(key => window[key] || [], STORE).catch(() => []);
  for (const f of found) addIssue(issues, f.kind, f.message, f.line);
  return issues;
}

// Evaluated in the page (through DevTools, so its CSP doesn't apply): layout facts at the current viewport.
function measure(limit) {
  const de = document.documentElement, body = document.body;
  const vw = window.innerWidth;
  const name = el => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
  const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  const scrollsX = el => { for (let a = el.parentElement; a && a !== body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true; } return false; };
  const all = body ? [...body.querySelectorAll('*')].slice(0, 4000) : [];
  const width = Math.max(de.scrollWidth, body ? body.scrollWidth : 0);
  const hides = el => el && ['hidden', 'clip'].includes(getComputedStyle(el).overflowX);
  let widest = null;
  if (width > vw + 1) {
    for (const el of all) {
      if (!visible(el) || scrollsX(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && (!widest || r.width > widest.w || (r.width === widest.w && widest.el.contains(el)))) widest = { el, w: r.width };
    }
  }
  const clipped = [];
  for (const el of all) {
    if (clipped.length >= limit) break;
    const cs = getComputedStyle(el);
    const hidesY = ['hidden', 'clip'].includes(cs.overflowY), hidesX = ['hidden', 'clip'].includes(cs.overflowX);
    if (!hidesY && !hidesX) continue;
    const text = (el.innerText || '').trim();
    if (!text || !visible(el)) continue;
    const cutY = hidesY && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2;
    const cutX = hidesX && cs.textOverflow !== 'ellipsis' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && cs.whiteSpace !== 'normal';
    if ((cutY || cutX) && !clipped.some(c => c.el.contains(el))) clipped.push({ el, text });
  }
  const media = all.filter(el => /^(IMG|SVG|CANVAS|VIDEO|svg|canvas)$/.test(el.tagName) && visible(el) && el.getBoundingClientRect().width * el.getBoundingClientRect().height > 2500).length;
  return {
    viewport: vw, width, widest: widest ? name(widest.el) : null, cutRight: hides(de) || hides(body),
    clipped: clipped.map(c => ({ name: name(c.el), text: c.text.replace(/\s+/g, ' ').slice(0, 60) })),
    textLength: (body?.innerText || '').replace(/\s+/g, ' ').trim().length, media,
  };
}

// Evaluated in a blank page: the spread (standard deviation, 0–255) of a screenshot's brightness, sampled on a small grid.
function spread(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = 60, h = Math.max(1, Math.round((img.height / img.width) * 60));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data;
      let n = 0, sum = 0, sq = 0;
      for (let i = 0; i < d.length; i += 4) { const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += y; sq += y * y; n++; }
      const mean = sum / n;
      resolve(Math.sqrt(Math.max(0, sq / n - mean * mean)));
    };
    img.onerror = () => reject(new Error('screenshot unreadable'));
    img.src = dataUrl;
  });
}

/** A near-blank screen: almost no text and nothing drawn, and a flat screenshot (or a completely flat one). */
export const looksBlank = ({ textLength, media, spread: s }) => s != null && (s < 2 || (textLength < 20 && media === 0 && s < 12));

/**
 * Render a Library page once: thumbnail, what went wrong, phone layout and a phone screenshot.
 * → { thumb: Buffer, phone: Buffer | null, issues, phoneFacts: measure() + { spread } | null }.
 */
export async function checkPage(html, { csp, signal } = {}) {
  return withPage(async page => {
    const issues = await openArtifact(page, html, { csp });
    await new Promise(r => setTimeout(r, 400)); // let entrance animations settle
    const thumb = await page.screenshot({ type: 'jpeg', quality: 70 });
    let phone = null, phoneFacts = null;
    try {
      await page.setViewportSize(PHONE);
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
      await new Promise(r => setTimeout(r, 300)); // resize handlers (charts) redraw
      phoneFacts = await page.evaluate(measure, MAX_LISTED);
      phone = await page.screenshot({ type: 'jpeg', quality: 70 });
      await readIssues(page, issues); // (errors from resize handlers too)
      await page.goto('about:blank', { timeout: 5000 });
      phoneFacts.spread = await page.evaluate(spread, `data:image/jpeg;base64,${phone.toString('base64')}`).catch(() => null);
    } catch (err) {
      if (err.name === 'AbortError') throw err; // otherwise the thumbnail and the error lists still count
      await readIssues(page, issues);
    }
    return { thumb, phone, issues, phoneFacts };
  }, { signal, media: true, viewport: THUMB });
}

/**
 * The problems a check found, as short lines for the model (empty = none found). Everything quoted from the page (error
 * texts, URLs, element names, cut-off text) is one clean capped line (lib/untrusted.js oneLine); with quote: false none of
 * it is quoted, only counts and lines (used when the quoted text looked like instructions to an AI).
 */
export function problemsOf({ issues, phoneFacts }, { quote = true } = {}) {
  const out = [];
  const q = (s, n = 160) => oneLine(s, n);
  const at = x => (x.line ? ` (line ${x.line})` : '');
  const list = (items, fmt) => `${items.slice(0, MAX_LISTED).map(fmt).join('; ')}${items.length > MAX_LISTED ? `; and ${items.length - MAX_LISTED} more` : ''}`;
  const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const lines = xs => { const l = xs.filter(x => x.line).map(x => x.line); return l.length ? ` (line${l.length === 1 ? '' : 's'} ${l.join(', ')})` : ''; };
  if (issues?.errors.length) out.push(quote ? list(issues.errors, e => `${q(e.message)}${at(e)}`) : `${count(issues.errors.length, 'script error')}${lines(issues.errors)}`);
  if (issues?.console.length) out.push(quote ? `console error: ${list(issues.console, e => `${q(e.message)}${at(e)}`)}` : count(issues.console.length, 'console error'));
  if (issues?.blocked.length) {
    out.push(`${quote ? '' : `${count(issues.blocked.length, 'resource')} `}blocked by the page rules (network calls are off; scripts, styles and fonts load only inline or from `
      + `cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com)${quote ? `: ${list(issues.blocked, b => q(b, 120))}` : ''}`);
  }
  if (issues?.failed.length) out.push(quote ? `didn’t load: ${list(issues.failed, f => `${q(f.url, 120)} (${q(f.why, 40)})`)}` : `${count(issues.failed.length, 'resource')} didn’t load`);
  if (phoneFacts) {
    if (phoneFacts.width > phoneFacts.viewport + 1) {
      out.push(`page is ${phoneFacts.width} px wide on a phone (${phoneFacts.viewport} px screen), so ${phoneFacts.cutRight ? 'its right side is cut off' : 'it scrolls sideways'}`
        + `${quote && phoneFacts.widest ? `; widest part: ${q(phoneFacts.widest, 60)}` : ''}`);
    }
    if (phoneFacts.clipped.length) {
      out.push(quote ? `text cut off on a phone in ${list(phoneFacts.clipped, c => `${q(c.name, 60)} “${q(c.text, 60)}”`)}` : `text cut off on a phone in ${count(phoneFacts.clipped.length, 'place')}`);
    }
    if (looksBlank(phoneFacts)) out.push('the page looks blank on a phone');
  }
  return out;
}

/** "Checks: 2 problems: …" / "Checks: no problems found (…)" / null when the check couldn't run. */
export function checksText(problems, { ran = true, phone = true } = {}) {
  if (!ran) return null;
  if (!problems.length) return `Checks: no problems found (script errors, blocked or failed loads${phone ? ', phone width, cut-off text, blank screen' : ''}).`;
  return `Checks: ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems.join('; ')}.`;
}

// ---- Shot refs: a screenshot handed to the model with a tool result -------------------------------------------------
// A tool result's `attachments` hold Library ids (view_image). A check screenshot is not a Library item (it would clutter
// the person's Library), so it rides as "shot:<file>", a file in data/shots saved for that person (served to them at
// /shots/<file> like web screenshots). prompt.js toolImages turns a ref into an image with shotImagePart.
const SHOT_REF = /^shot:(u(\d+)-[0-9a-f]{16}\.jpg)$/;
export const isShotRef = ref => SHOT_REF.test(String(ref));

/** Save a screenshot for this person → its attachment ref ("shot:u3-….jpg") and its /shots link. */
export function shotRef(userId, buf) {
  const { file, href } = saveShot(userId, buf);
  return { ref: `shot:${file}`, href };
}

/** The model-facing image part of a shot ref ({ type: 'image_url', … }), or null (not a shot ref, missing, too large). */
export function shotImagePart(ref, { maxBytes = 8 * 1048576 } = {}) {
  const m = SHOT_REF.exec(String(ref));
  if (!m) return null;
  try {
    const bytes = fs.readFileSync(path.join(paths.shots, m[1]));
    return bytes.length <= maxBytes ? { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } } : null;
  } catch { return null; }
}
