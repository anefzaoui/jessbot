// Interactive browsing sessions (decision #56): Jess drives a real page like a person — snapshot, click, type, pick,
// scroll, tabs, dialogs — through the browser. Built on Playwright's public AI snapshot API (page.ariaSnapshot
// { mode: 'ai' } → YAML with [ref=eN]; page.locator('aria-ref=eN'); locator.normalize() fails fast on stale refs),
// the same design as Playwright MCP, researched in docs/DECISIONS.md #56.
// One session per chat thread (so "now pick next week" continues on the same page), closed after IDLE_MS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openSessionContext, note, browserSettings } from './index.js';
import { learnRecipe, recipeHint, noteRecipeUse } from './recipes.js';
import { trustSignals, cautionLine, brandsFor } from './trust.js';
import { antiAdblockWall, adblockOffFor, switchOffFor } from './adblock.js';
import { assertPublicUrl, extractVisible } from './read.js';
import { probeWall, dismissConsent } from './walls.js';
import { profileFile, loadProfile, saveProfile as saveProfileFile, forgetSiteInProfile, siteOf } from './profiles.js';
import { looseDate } from '../lib/when.js';
import { oneLine } from '../lib/untrusted.js';
import { publish } from '../lib/bus.js';
import { settings } from '../db/index.js';
import { noteIcon } from '../services/favicons.js';
import { getUser } from '../services/users.js';
import { sizeLabel } from '../services/library.js';
import { saveDownload as saveDownloadedFile, UPLOAD_MAX_BYTES, DOWNLOAD_SESSION_FILES, DOWNLOAD_SESSION_BYTES } from '../services/uploads.js';
import { renderFragment } from '../views/render.js';
import { badRequest } from '../lib/errors.js';
import { decide, choice, noul, picked, yes, note as noteDecision, threshold } from '../services/decide.js';

const IDLE_MS = 10 * 60000;
const MAX_SESSIONS = 4;
const SNAPSHOT_BUDGET = 14000;   // characters of page snapshot per tool result
const LIST_KEEP = 12;            // repeated siblings kept before "… N more"
// Several actions in a row that change nothing (or fail): stop guessing — change approach or ask the person.
const STUCK_AFTER = 3;
const STUCK_HINT = 'STUCK: several tries in a row made no progress. Don’t repeat them. Try a different way (the site’s search, '
  + 'a direct URL with parameters, keyboard: Tab/ArrowDown/Enter, closing an overlay with Escape) — or ask the person with ask_user '
  + '(show_screen: true), saying briefly what you tried and offering the options you see.';
export const SNAPSHOT_MARK = '--- page snapshot ---'; // prompt.js collapses older snapshots at this marker

// ---- Cookie / consent banners: DuckDuckGo autoconsent (MPL-2.0) rejects them the way a careful person would ------
const acDir = path.dirname(fileURLToPath(import.meta.resolve('@duckduckgo/autoconsent')));
const AUTOCONSENT_JS = fs.readFileSync(path.join(acDir, 'autoconsent.playwright.js'), 'utf8');
let consentRules = null;
const rules = () => (consentRules ||= JSON.parse(fs.readFileSync(fileURLToPath(import.meta.resolve('@duckduckgo/autoconsent/rules/compact-rules.json')), 'utf8')));
const CONSENT_CONFIG = {
  enabled: true, autoAction: 'optOut', disabledCmps: [], enablePrehide: true, enableCosmeticRules: true, enableGeneratedRules: true,
  detectRetries: 20, isMainWorld: false, prehideTimeout: 2000, enableHeuristicDetection: true, heuristicMode: 'tier2',
  logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
};

async function withConsent(session, ctx) {
  await ctx.exposeBinding('autoconsentSendMessage', async ({ frame }, msg) => {
    if (!msg || typeof msg !== 'object') return;
    const reply = m => frame.evaluate(x => window.autoconsentReceiveMessage?.(x), m).catch(() => {});
    if (msg.type === 'init') return reply({ type: 'initResp', config: CONSENT_CONFIG, rules: rules() });
    if (msg.type === 'eval') return reply({ type: 'evalResp', id: msg.id, result: await frame.evaluate(msg.code).catch(() => false) });
    if (msg.type === 'optOutResult' && msg.result) session.consent = msg.cmp || 'a cookie banner';
    if (msg.type === 'autoconsentDone') session.consent = msg.cmp || session.consent || 'a cookie banner';
  });
  await ctx.addInitScript({ content: AUTOCONSENT_JS });
}

// ---- Sessions ----------------------------------------------------------------------------------------------------
const sessions = new Map(); // key → session

class Session {
  constructor(key, ctx, meta) {
    Object.assign(this, { key, ctx, meta, pages: [], active: null, dialog: null, events: [], consent: null, stuck: 0,
      saved: { files: 0, bytes: 0 }, imported: [], // downloads kept in the Library this session (imported: not yet reported)
      prev: new Map(), refs: new Map(), lastUsed: Date.now(), timer: null });
  }
  touch() {
    this.lastUsed = Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => closeSession(this.key), IDLE_MS);
    this.timer.unref?.();
  }
  adopt(page) {
    if (this.pages.includes(page)) return;
    this.pages.push(page);
    page.setDefaultTimeout(15000);
    page.on('dialog', d => { this.dialog = d; this.events.push(`A ${d.type()} dialog opened: “${oneLine(d.message(), 200)}”`); });
    page.on('download', d => this.saveDownload(d));
    page.on('close', () => {
      this.pages = this.pages.filter(p => p !== page);
      if (this.active === page) this.active = this.pages.at(-1) || null;
    });
  }
  saveDownload(d) { return keepDownload(this, d); }
}

/**
 * A file the page downloaded becomes a Library item for the person (decision #117): typed from its bytes and read like
 * an upload (services/uploads.js), labelled "Downloaded from <host>", then the temporary copy is deleted. Capped per
 * session (DOWNLOAD_SESSION_FILES / _BYTES). The next tool result says what happened, with the Library link; files we
 * don't take are named honestly as not kept. s: a Session (or its shape: meta, saved, imported, events).
 */
export async function keepDownload(s, d) {
  const name = oneLine(d.suggestedFilename() || 'download', 120) || 'download';
  const capped = () => `A download (“${name}”) was not kept: this browsing session already saved ${s.saved.files} file${s.saved.files === 1 ? '' : 's'} `
    + `(${sizeLabel(s.saved.bytes)}); the limit is ${DOWNLOAD_SESSION_FILES} files or ${sizeLabel(DOWNLOAD_SESSION_BYTES)}. Close the browser (browser_close) and start again if more are needed.`;
  if (s.saved.files >= DOWNLOAD_SESSION_FILES || s.saved.bytes >= DOWNLOAD_SESSION_BYTES) {
    await d.cancel?.().catch(() => {});
    s.events.push(capped());
    return null;
  }
  let dir = null; // runs from a page event: nothing here may throw past the catch below
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-dl-'));
    const file = path.join(dir, 'download');
    await d.saveAs(file);
    const size = fs.statSync(file).size;
    if (size > UPLOAD_MAX_BYTES) { s.events.push(`A download (“${name}”, ${sizeLabel(size)}) was not kept: files over ${sizeLabel(UPLOAD_MAX_BYTES)} aren’t saved to the Library.`); return null; }
    if (s.saved.bytes + size > DOWNLOAD_SESSION_BYTES) { s.events.push(capped()); return null; }
    const user = getUser(s.meta.userId);
    if (!user) throw new Error('the person this browser belongs to no longer exists');
    const url = /^https?:/.test(d.url?.() || '') ? d.url() : d.page?.()?.url?.() || '';
    const view = await saveDownloadedFile(user, { buffer: fs.readFileSync(file), filename: name, url }, { threadId: s.meta.threadId || null, runId: s.meta.runId || null });
    s.saved.files++;
    s.saved.bytes += size;
    s.imported.push({ id: view.id, title: view.title });
    s.events.push(`Downloaded “${name}” and saved it to their Library as “${view.title}” (library id ${view.id}). Link it for them as `
      + `[${view.title}](/library/${view.id}); read it with library_read.`);
    renderFragment('library-card', view, user).catch(() => null) // open Library pages add the card live
      .then(html => publish(user.id, 'library.created', { item: view, html })).catch(() => {});
    return view;
  } catch (err) {
    s.events.push(err.errors?.file ? `A download wasn’t kept: ${err.errors.file}` : `A download (“${name}”) failed: ${String(err.message || err).split('\n')[0]}`);
    return null;
  } finally {
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { console.warn('[browser] download temp folder left behind:', err.message); }
  }
}

export const hasSession = key => sessions.has(key);

// Each chat's last page (6 h), so a tab closed while idle — or by a restart — is reopened where it was.
const LAST_MS = 6 * 3600000;
const lastKey = key => `browser.last.${key}`;
export const lastUrlOf = key => { const v = settings.get(lastKey(key), null); return v?.url && Date.now() - v.at < LAST_MS ? v.url : null; };
const rememberUrl = (key, url) => { if (/^https?:/.test(url)) settings.set(lastKey(key), { url, at: Date.now() }); };
export const forgetUrl = key => settings.set(lastKey(key), null);
// The person's cookies and site storage, sealed on disk (profiles.js, decision #136).
const saveProfile = s => s.ctx.storageState().then(state => saveProfileFile(s.meta.profile, state)).catch(() => {});

/** The chat's session (made when create). threadId/runId: where downloads land (their Library item's chat and task). */
export async function sessionFor(key, { userId, threadId = null, runId = null, create = true } = {}) {
  let s = sessions.get(key);
  if (s) Object.assign(s.meta, { threadId: threadId ?? s.meta.threadId, runId: runId ?? s.meta.runId });
  if (s && s.ctx.pages().length === 0 && !create) return null;
  if (!s) {
    if (!create) return null;
    if (sessions.size >= MAX_SESSIONS) { // make room: close the least recently used
      const oldest = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      await closeSession(oldest.key);
    }
    // Each person's browser remembers cookies and site trust between sessions, like a real browser (bot walls score
    // returning visitors better; a login they do themselves sticks). Private to them: data/browser-profiles/u<id>.json.
    const profile = profileFile(userId);
    const ctx = await openSessionContext({ storageState: loadProfile(profile) });
    s = new Session(key, ctx, { userId, profile, threadId, runId });
    await withConsent(s, ctx);
    ctx.on('page', p => { s.adopt(p); s.active = p; s.events.push('A new tab opened — it is now the active tab.'); });
    ctx.on('close', () => { if (sessions.get(key) === s) sessions.delete(key); clearTimeout(s.timer); });
    sessions.set(key, s);
    s.adopt(await ctx.newPage());
    s.active = s.pages[0];
    s.events.length = 0; // the first tab isn't news
  }
  s.touch();
  return s;
}

export async function closeSession(key) {
  const s = sessions.get(key);
  if (!s) return false;
  sessions.delete(key);
  clearTimeout(s.timer);
  await saveProfile(s);
  await s.ctx.close().catch(() => {});
  return true;
}
export const closeAllSessions = () => Promise.all([...sessions.keys()].map(closeSession));

/**
 * Forget one site's sign-in for a person (decision #136): its cookies (and the storage of its open pages) leave their live
 * browser first — so a later save can't write them back — then their saved profile. → entries removed from the file.
 */
export async function forgetSite(userId, site) {
  const target = siteOf(site);
  if (!target || !/\./.test(target)) throw badRequest('Name a site, like example.com.');
  const domain = new RegExp(`(^|\\.)${escapeRe(target)}$`, 'i');
  for (const s of sessions.values()) {
    if (Number(s.meta.userId) !== Number(userId)) continue;
    await s.ctx.clearCookies({ domain }).catch(() => {});
    for (const page of s.pages) {
      let host = '';
      try { host = new URL(page.url()).hostname; } catch { /* about:blank */ }
      if (host && siteOf(host) === target) await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* storage blocked */ } }).catch(() => {});
    }
    await saveProfile(s);
  }
  return forgetSiteInProfile(userId, target);
}

// ---- Snapshots ---------------------------------------------------------------------------------------------------
const indentOf = line => line.match(/^\s*/)[0].length;
const roleOf = line => (line.trim().match(/^- ([\w-]+)/) || [])[1] || '';
const stripRefs = line => line.replace(/\s*\[ref=[^\]]+\]/g, '').replace(/\s*\[cursor=pointer\]/g, '').trim();

/**
 * Grids of labelled cells (seat maps, calendars) as one line per row: "- row [ref=r1]: A1 f1e80 · A2 f1e83 · A3 f1e86 (occupied)".
 * Only rows whose children are all single-line cells with a {label} (from withHiddenNames) are compacted.
 */
function compactRows(lines) {
  const out = [];
  const CELL = /^\s*- (?:cell|gridcell|button) \[ref=([^\]]+)\](?: \[cursor=pointer\])? \{([^}]*)\}:?$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (roleOf(line) !== 'row') { out.push(line); continue; }
    let end = i + 1;
    while (end < lines.length && indentOf(lines[end]) > indentOf(line)) end++;
    const kids = lines.slice(i + 1, end);
    const cells = kids.map(k => CELL.exec(k));
    if (kids.length < 4 || cells.some(c => !c)) { out.push(line); continue; }
    const items = cells.map(([, ref, info]) => {
      const parts = info.split(' ').filter(Boolean);
      const first = parts.find(p => p.includes('=')) || parts[0];
      const label = first.includes('=') ? first.split('=').slice(1).join('=') : first;
      const state = parts.filter(p => p !== first).map(p => (p.includes('=') ? p.split('=').slice(1).join('=') : p))
        .filter(v => !/^(available|free)$/i.test(v));
      return `${label} ${ref}${state.length ? ` (${state.join(', ')})` : ''}`;
    });
    out.push(`${line.replace(/:$/, '')}: ${items.join(' · ')}`);
    i = end - 1;
  }
  return out;
}

/** Collapse long runs of same-role siblings (result lists, menus, table rows) to the first LIST_KEEP. */
function collapseLists(lines) {
  const out = [];
  for (let i = 0; i < lines.length;) {
    const ind = indentOf(lines[i]), role = roleOf(lines[i]);
    // Find the run of siblings (same indent, same role) starting here, each with its own children.
    const items = [];
    let j = i;
    while (j < lines.length && indentOf(lines[j]) === ind && roleOf(lines[j]) === role && role) {
      let k = j + 1;
      while (k < lines.length && indentOf(lines[k]) > ind) k++;
      items.push(lines.slice(j, k));
      j = k;
    }
    // Each item keeps its own children, collapsed the same way (lists usually sit inside a parent).
    const emit = it => { out.push(it[0], ...collapseLists(it.slice(1))); };
    // Cells of one table row stay whole (seat maps, calendars); other long runs keep the first LIST_KEEP.
    const keep = role === 'cell' || role === 'gridcell' ? 60 : LIST_KEEP;
    if (items.length > keep + 3) {
      items.slice(0, keep).forEach(emit);
      out.push(`${' '.repeat(ind)}- … ${items.length - keep} more ${role} items (use browser_snapshot with find, or scroll)`);
      i = j;
    } else if (items.length) { items.forEach(emit); i = j; }
    else {
      let k = i + 1;
      while (k < lines.length && indentOf(lines[k]) > indentOf(lines[i])) k++;
      out.push(lines[i], ...collapseLists(lines.slice(i + 1, k)));
      i = k;
    }
  }
  return out;
}

function remember(s, page, yaml) {
  for (const line of yaml.split('\n')) {
    const m = /\[ref=([^\]]+)\]/.exec(line);
    if (m) s.refs.set(m[1], stripRefs(line).replace(/^- /, '').replace(/:$/, '').slice(0, 160));
  }
  const prev = s.prev.get(page);
  s.prev.set(page, { url: page.url(), lines: new Set(yaml.split('\n').map(stripRefs)) });
  return prev && prev.url === page.url() ? prev.lines : null;
}

// Form fields: what the ARIA snapshot doesn't say but a person sees — the input type and expected date format, whether it
// opens a popup/calendar, is read-only or required, and slider ranges. Appended as {…} to those lines (≤ 60 fields).
const FIELD_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'slider', 'checkbox', 'radio', 'switch']);
async function withFieldState(page, lines) {
  const targets = [];
  lines.forEach((l, i) => { const ref = /\[ref=([^\]]+)\]/.exec(l)?.[1]; if (ref && FIELD_ROLES.has(roleOf(l))) targets.push({ i, ref }); });
  const states = await Promise.all(targets.slice(0, 60).map(t => page.locator(`aria-ref=${t.ref}`).evaluate(el => {
    const a = n => el.getAttribute(n);
    const type = el.tagName === 'INPUT' ? el.type : null;
    const out = [];
    if (type && !['text', 'search', 'checkbox', 'radio'].includes(type)) out.push(`type=${type}`);
    if (type === 'date') out.push('format=YYYY-MM-DD');
    const fmt = a('data-date-format') || a('data-format') || (/(dd|mm|yyyy)/i.test(a('placeholder') || '') ? a('placeholder') : null);
    if (fmt) out.push(`format=${fmt}`);
    if (a('aria-haspopup') && a('aria-haspopup') !== 'false') out.push(`opens=${a('aria-haspopup') === 'true' ? 'popup' : a('aria-haspopup')}`);
    if (a('aria-expanded') === 'false') out.push('collapsed');
    if (el.readOnly || a('aria-readonly') === 'true') out.push('readonly');
    if (el.required || a('aria-required') === 'true') out.push('required');
    for (const k of ['min', 'max', 'step']) if (a(k) || a(`aria-value${k}`)) out.push(`${k}=${a(k) || a(`aria-value${k}`)}`);
    if (el.disabled || a('aria-disabled') === 'true') out.push('disabled');
    return out.join(' ');
  }).catch(() => '')));
  const next = [...lines];
  targets.slice(0, 60).forEach((t, n) => {
    if (!states[n]) return;
    // A password field never shows what is in it (the person may have typed it during a hand-over).
    const base = /type=password/.test(states[n]) ? next[t.i].replace(/(\[ref=[^\]]+\](?: \[[^\]]+\])*):.*$/, '$1') : next[t.i];
    next[t.i] = `${base.replace(/:$/, '')} {${states[n]}}${base.endsWith(':') ? ':' : ''}`;
  });
  return withFileFields(page, await withHiddenNames(page, next));
}

// A file field shows as a plain button ("Choose File" in Chromium's en-US build): mark the real ones {type=file} so Jess
// knows browser_upload is the way (clicking would open a file chooser nobody can answer).
async function withFileFields(page, lines) {
  const targets = [];
  lines.forEach((l, i) => { const ref = /\[ref=([^\]]+)\]/.exec(l)?.[1]; if (ref && /^\s*- button "(Choose Files?|Browse…?|No file chosen)"/i.test(l) && !/type=file/.test(l)) targets.push({ i, ref }); });
  if (!targets.length) return lines;
  const isFile = await Promise.all(targets.slice(0, 20).map(t => page.locator(`aria-ref=${t.ref}`).evaluate(el => el.tagName === 'INPUT' && el.type === 'file').catch(() => false)));
  const next = [...lines];
  targets.slice(0, 20).forEach((t, n) => { if (isFile[n]) next[t.i] = `${next[t.i].replace(/:$/, '')} {type=file}${next[t.i].endsWith(':') ? ':' : ''}`; });
  return next;
}

// Clickable things with no accessible name (seat-map cells, calendar days, colour swatches) say nothing in the snapshot.
// Add what the page encodes or shows for them: title, short data-* values, state classes, short text (≤ 300 elements).
const STATE_WORDS = /\b(available|free|selected|chosen|occupied|taken|booked|reserved|unavailable|disabled|sold|blocked|active|current)\b/g;
async function withHiddenNames(page, lines) {
  const targets = [];
  lines.forEach((l, i) => {
    const ref = /\[ref=([^\]]+)\]/.exec(l)?.[1];
    if (ref && l.includes('[cursor=pointer]') && !/^\s*- [\w-]+ "/.test(l) && !/\{[^}]*\}/.test(l)) targets.push({ i, ref });
  });
  if (!targets.length) return lines;
  const states = await Promise.all(targets.slice(0, 300).map(t => page.locator(`aria-ref=${t.ref}`).evaluate((el, words) => {
    const re = new RegExp(words, 'g');
    const out = [];
    for (const node of [el, el.firstElementChild].filter(Boolean)) {
      const a = n => node.getAttribute(n);
      const t = a('title') || a('data-tooltip') || a('data-original-title') || a('aria-description');
      if (t && !out.some(o => o.startsWith('title='))) out.push(`title=${t.slice(0, 40)}`);
      for (const { name, value } of node.attributes) {
        if (name.startsWith('data-') && value && value.length <= 20 && !/^data-(v-|testid|reactid|index|key|id$)/.test(name) && out.length < 6) out.push(`${name.slice(5)}=${value}`);
      }
      const cls = (typeof node.className === 'string' ? node.className : node.className?.baseVal || '').toLowerCase();
      for (const w of new Set(cls.match(re) || [])) if (!out.includes(w)) out.push(w);
    }
    const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (txt && txt.length <= 20) out.push(`text=${txt}`);
    return out.slice(0, 7).join(' ');
  }, STATE_WORDS.source).catch(() => '')));
  // What every one of them shares (type=Standard armchair…) is noise: keep only what tells them apart (seat number, status).
  const counts = new Map();
  for (const st of states) for (const kv of new Set(String(st).split(' ').filter(Boolean))) counts.set(kv, (counts.get(kv) || 0) + 1);
  const shared = kv => states.length >= 8 && counts.get(kv) > states.length * 0.6;
  const next = [...lines];
  targets.slice(0, 300).forEach((t, n) => {
    const kept = String(states[n] || '').split(' ').filter(kv => kv && !shared(kv)).join(' ');
    if (kept) next[t.i] = `${next[t.i].replace(/:$/, '')} {${kept}}${next[t.i].endsWith(':') ? ':' : ''}`;
  });
  return next;
}

/**
 * Whatever is on top of the screen (any markup — <dialog>, role=dialog, or a custom <x-foo-modal> in shadow DOM): the element
 * under the viewport centre, climbed to its overlay container. Marked data-jb-modal so the snapshot can show it first
 * (pop-ups are often appended at the end of the page, past the snapshot budget). Returns its name, or null.
 */
async function markModal(page) {
  return page.evaluate(() => {
    for (const old of document.querySelectorAll('[data-jb-modal]')) old.removeAttribute('data-jb-modal');
    const cx = innerWidth / 2, cy = innerHeight / 2;
    let el = document.elementFromPoint(cx, cy);
    for (let i = 0; el?.shadowRoot && i < 10; i++) { const inner = el.shadowRoot.elementFromPoint(cx, cy); if (!inner || inner === el) break; el = inner; }
    const locked = ['hidden', 'clip'].includes(getComputedStyle(document.body).overflowY) || ['hidden', 'clip'].includes(getComputedStyle(document.documentElement).overflowY);
    const looksModal = n => n.matches?.(':modal, [aria-modal="true"], dialog[open], [role="dialog"], [role="alertdialog"]')
      || /modal|dialog|popup|pop-up|overlay|drawer|lightbox/i.test(`${n.tagName} ${n.id} ${typeof n.className === 'string' ? n.className : ''}`);
    let found = null;
    for (let n = el, i = 0; n && n !== document.body && n !== document.documentElement && i < 40; i++) {
      const st = getComputedStyle(n), r = n.getBoundingClientRect();
      const big = r.width * r.height >= 0.2 * innerWidth * innerHeight;
      if (looksModal(n) && (big || locked || st.position === 'fixed')) found = n; // keep climbing: the outermost overlay wins
      n = n.parentElement || (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
    }
    if (!found) return null;
    found.setAttribute('data-jb-modal', '1');
    const texts = [...new Set((found.innerText || '').split('\n').map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length >= 3 && t.length <= 80))].slice(0, 12);
    const name = found.getAttribute('aria-label') || found.querySelector?.('h1, h2, h3, [role="heading"]')?.textContent
      || found.shadowRoot?.querySelector('h1, h2, h3, [role="heading"]')?.textContent || texts[0] || 'a pop-up';
    return { name: name.replace(/\s+/g, ' ').trim().slice(0, 80), texts };
  }).catch(() => null);
}

/** The part of the page snapshot that is the pop-up: the smallest subtree holding most of its visible text lines. */
function popupLines(lines, texts) {
  if (!texts?.length) return null;
  const want = texts.map(t => t.toLowerCase());
  const perLine = lines.map(l => { const lo = l.toLowerCase(); let n = 0; for (const t of want) if (lo.includes(t)) n++; return n; });
  let best = null;
  for (let i = lines.length - 1; i >= 0; i--) { // pop-ups sit at the end of the page: prefer the last match
    let end = i + 1, total = perLine[i];
    while (end < lines.length && indentOf(lines[end]) > indentOf(lines[i])) total += perLine[end++];
    const size = end - i;
    if (total >= Math.max(2, Math.ceil(want.length * 0.6)) && size <= 150 && (!best || size < best.size)) best = { i, end, size };
  }
  return best ? lines.slice(best.i, best.end) : null;
}

/** The page as the model sees it: trimmed YAML, new lines marked, optional find filter or subtree. */
export async function snapshot(s, { ref = null, find = null } = {}) {
  const page = s.active;
  const target = ref ? await resolve(s, ref) : page;
  const modal = !ref && !find ? await markModal(page) : null; // a pop-up on top (shown first below)
  let yaml = await target.ariaSnapshot({ mode: 'ai', timeout: 10000 });
  const before = remember(s, page, yaml);
  let lines = yaml.split('\n');
  // Enrich first (field state, names of unnamed clickables) so find and the budget see them; gap cells say nothing.
  lines = (await withFieldState(page, lines)).filter(l => !/^\s*- (?:cell|gridcell) \[ref=[^\]]+\]$/.test(l));
  if (find) {
    const needles = String(find).toLowerCase().split('|').map(n => n.trim()).filter(Boolean); // "Continue|Next" = either
    const keep = new Set();
    lines.forEach((l, i) => {
      const lo = l.toLowerCase();
      if (!needles.some(n => lo.includes(n))) return;
      keep.add(i);
      for (let j = i - 1, ind = indentOf(l); j >= 0 && ind > 0; j--) if (indentOf(lines[j]) < ind) { keep.add(j); ind = indentOf(lines[j]); } // ancestors
      for (let j = i + 1; j < lines.length && indentOf(lines[j]) > indentOf(l); j++) keep.add(j); // its children
    });
    // Text that matched but has no ref of its own (a label inside a div that handles the click): point at the nearest
    // ancestor that has one — that is what to click.
    lines = lines.map((l, i) => {
      if (!keep.has(i) || /\[ref=/.test(l) || !needles.some(n => l.toLowerCase().includes(n))) return l;
      for (let j = i - 1; j >= 0; j--) {
        if (indentOf(lines[j]) < indentOf(l)) { const r = /\[ref=([^\]]+)\]/.exec(lines[j])?.[1]; if (r) return `${l}   ← no ref of its own: to press it, click ${r}`; }
      }
      return l;
    }).filter((_, i) => keep.has(i));
    if (!lines.length) return `Nothing on the page matches “${find}” (this searches the page text and element labels). Look at the whole page with browser_snapshot before deciding it is empty.`;
  }
  lines = collapseLists(compactRows(lines));
  let appeared = [];
  if (before) {
    lines = lines.map(l => (l.includes('[ref=') && !before.has(stripRefs(l).replace(/ \{[^}]*\}/, '')) ? `${l} [new]` : l));
    appeared = lines.filter(l => l.endsWith('[new]'));
  }
  // What matters most goes first, so the budget never cuts it: the pop-up on top, then what the last action made appear.
  const dedent = ls => { const min = Math.min(...ls.map(indentOf)); return ls.map(l => l.slice(min)); };
  const plain = l => stripRefs(l).replace(/ \{[^}]*\}/, '').replace(/ \[new\]$/, '');
  let head = '';
  const pop = modal && popupLines(lines, modal.texts);
  if (pop) {
    const sub = dedent(pop);
    head += `Pop-up on top (“${modal.name}”) — act inside it:\n${sub.slice(0, 80).join('\n')}${sub.length > 80 ? `\n… ${sub.length - 80} more lines` : ''}\n\n`;
  }
  if (appeared.length && appeared.length < lines.length * 0.6 && !head) {
    const a = dedent(appeared);
    head += `Appeared after this action (use these):\n${a.slice(0, 40).join('\n')}${a.length > 40 ? `\n… ${a.length - 40} more new elements` : ''}\n\n`;
  }
  let body = lines.join('\n');
  const room = Math.max(4000, SNAPSHOT_BUDGET - head.length);
  if (body.length > room) body = shrinkSnapshot(lines, room);
  return head ? `${head}Whole page:\n${body}` : body;
}

const CONTINUES = '… (page continues — use browser_snapshot with find="…", a ref to a region, or scroll)';
const cutLine = (l, n) => (l.length > n ? `${l.slice(0, n)}…` : l);
/**
 * Fit a long snapshot into `room` characters by what matters (decision #166): 1) drop link targets (the "/url:" lines);
 * 2) keep every line with a ref (what Jess can act on), every heading, and their ancestors (where they sit), and shorten
 * each run of plain text to its first line and "… N more lines of text"; 3) then plain text goes entirely, one marker per
 * run; 4) only then is the end cut — at a line, never mid-element. Pure.
 */
export function shrinkSnapshot(lines, room) {
  const fits = ls => ls.join('\n').length <= room;
  const cur = lines.filter(l => !/^\s*- \/url:/.test(l));
  if (fits(cur)) return cur.join('\n');
  const keep = cur.map(l => /\[ref=/.test(l) || roleOf(l) === 'heading');
  for (let i = cur.length - 1; i >= 0; i--) {
    if (!keep[i]) continue;
    for (let j = i - 1, ind = indentOf(cur[i]); j >= 0 && ind > 0; j--) if (indentOf(cur[j]) < ind) { keep[j] = true; ind = indentOf(cur[j]); }
  }
  const pass = firstLine => {
    const out = [];
    for (let i = 0; i < cur.length;) {
      if (keep[i]) { out.push(cutLine(cur[i], 300)); i++; continue; }
      let j = i;
      while (j < cur.length && !keep[j]) j++;
      const pad = ' '.repeat(indentOf(cur[i])), n = j - i;
      if (firstLine) { out.push(cutLine(cur[i], 160)); if (n > 1) out.push(`${pad}- … ${n - 1} more line${n === 2 ? '' : 's'} of text`); }
      else out.push(`${pad}- … ${n} line${n === 1 ? '' : 's'} of text`);
      i = j;
    }
    return out;
  };
  const shortened = pass(true);
  const note = '(long page: plain text was shortened to fit; browser_read gives the text)';
  if (fits([...shortened, note])) return [...shortened, note].join('\n');
  const bare = pass(false);
  if (fits([...bare, note])) return [...bare, note].join('\n');
  const out = [];
  let size = CONTINUES.length + 1;
  for (const l of bare) { if (size + l.length + 1 > room) break; out.push(l); size += l.length + 1; }
  return `${out.join('\n')}\n${CONTINUES}`;
}

// ---- Acting ------------------------------------------------------------------------------------------------------
class StaleRef extends Error {}

async function resolve(s, ref) {
  if (!/^[a-z]?\d*e\d+$/i.test(String(ref))) throw new StaleRef(`“${ref}” isn't a ref from the snapshot (they look like e12 or f1e3).`);
  const loc = s.active.locator(`aria-ref=${ref}`);
  try { return await loc.normalize(); } catch {
    throw new StaleRef(`Element ${ref} is no longer on the page (it changed). Take a new browser_snapshot and use the new refs.`);
  }
}

async function fingerprint(page) {
  const info = await page.evaluate(() => ({ title: document.title, len: document.body?.innerText?.length || 0,
    head: (document.body?.innerText || '').slice(0, 3000) })).catch(() => ({ title: '', len: 0, head: '' }));
  return { url: page.url(), ...info, hash: crypto.createHash('sha1').update(info.head).digest('hex') };
}

/** Wait like a person would: the requests this action started, the navigation, then the DOM going quiet. */
async function settle(page, requests, navigated) {
  const pending = [...requests].filter(r => ['document', 'fetch', 'xhr'].includes(r.resourceType()));
  await Promise.race([Promise.allSettled(pending.map(r => r.response().catch(() => null))), new Promise(r => setTimeout(r, 5000))]);
  if (navigated) await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => new Promise(resolve => {
    let t = null;
    const done = () => { obs.disconnect(); resolve(); };
    const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 400); });
    obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    t = setTimeout(done, 400);
    setTimeout(done, 3000);
  })).catch(() => {}); // a navigation mid-wait is fine
}

// Bot walls: one definition for web_read and this browser (walls.js). 403/429 answers count as walls too.
async function wallOf(page, status) {
  return (await probeWall(page, status))?.label || null;
}

// ---- What kind of page is this, and did the last action help? (decision model, #108) --------------------------------
// The regex checks above only know a few English/French phrasings; this reads the page in any language. It only adds
// warnings (a wall, a login, a cookie panel…) — it never clears one the checks found.
const PAGE_KINDS = {
  content: 'the site’s normal content — an article, a product, a home page',
  results: 'a list of search results, listings, flights, hotels, products or prices',
  form: 'a form or a step of a flow to fill in',
  bot_wall: 'a CAPTCHA, bot check, “are you human”, access denied or security check instead of the site',
  login_wall: 'it asks to sign in, log in or create an account before continuing',
  cookie_panel: 'a cookie or privacy consent panel covers the page',
  paywall: 'a subscription or paywall hides the content',
  error: 'an error page, 404, “not found”, “something went wrong”, or an empty or broken page',
  confirmation: 'a confirmation that something was completed — booked, ordered, sent, saved',
  other: 'none of these',
};
const PAGE_LINES = {
  bot_wall: 'BLOCKED: this page is a bot check or access wall, not the site’s content. Don’t treat it as results. Tell the person you were '
    + 'blocked here and offer another site, trying again later, or opening the link themselves.',
  login_wall: 'SIGN-IN: the site wants a sign-in before continuing. Use a guest option if there is one; otherwise show the person '
    + '(ask_user with show_screen: true) and ask whether they want to sign in themselves.',
  cookie_panel: 'COOKIES: a cookie or privacy panel covers the page — decline it (or accept if that is the only way), then continue.',
  paywall: 'PAYWALL: the content is behind a subscription. Say so; try another source rather than guessing what it says.',
  error: 'ERROR PAGE: the site shows an error or an empty page. Go back or try another way; don’t report this as results.',
  confirmation: 'CONFIRMATION: the page says something was completed. Read exactly what it confirms and tell the person.',
};
async function judgePage(s, after, { effect, status }) {
  const doing = s.doing;
  s.doing = null;
  const res = await decide('page', {
    user: s.meta.userId ? { id: s.meta.userId } : null, timeoutMs: 2500,
    state: { url: after.url, title: after.title || '(untitled)', http_status: status ?? 'ok', last_action: doing || '(none)',
      what_happened: effect, visible_text: String(after.head || '').slice(0, 2500) },
    questions: {
      kind: choice('What kind of page is this, as a person would see it right now?', PAGE_KINDS),
      ...(doing ? { progress: noul('Did `last_action` move things forward — new content or results, the next step of a flow, a field '
        + 'filled or an option chosen — rather than nothing, an error or the same page?') } : {}),
    },
  }).catch(() => null);
  if (!res) return null;
  const k = picked(res.answers.kind);
  const progress = doing ? yes(res.answers.progress) : null;
  noteDecision(res.id, `${k?.pick || '?'} (${(k?.p ?? 0).toFixed(2)})${progress != null ? ` · progress ${progress.toFixed(2)}` : ''}`, { confidence: k?.p ?? null });
  return k ? { kind: k.pick, p: k.p, progress } : null;
}

/**
 * Run one action on the active page, wait for the page to settle and describe the effect.
 * Returns the tool result text: what happened, where we are, open tabs, then the fresh snapshot.
 */
export async function act(s, fn, { snapshotAfter = true } = {}) {
  const page = s.active;
  if (!page) throw new Error('No page is open — use browser_open first.');
  if (s.dialog) throw new Error(`A dialog is waiting: “${oneLine(s.dialog.message(), 160)}”. Answer it with browser_dialog first.`);
  const before = await fingerprint(page);
  const requests = new Set();
  let navigated = false, status = null;
  const onReq = r => requests.add(r);
  const chain = [before.url]; // main-frame addresses this action went through (trust.js: a redirect across sites)
  const onNav = f => { if (f === page.mainFrame()) { navigated = true; if (chain.at(-1) !== f.url()) chain.push(f.url()); } };
  page.on('request', onReq);
  page.on('framenavigated', onNav);
  try {
    const res = await fn(page);
    if (res && typeof res.status === 'function') status = res.status();
    await settle(page, requests, navigated);
    if (navigated) {
      // A cookie wall autoconsent didn't recognise: decline it ourselves (or accept, when that's the only button).
      await page.waitForTimeout(800);
      const hit = await dismissConsent(page);
      if (hit) { s.consent = `the cookie panel (“${hit}”)`; await settle(page, new Set(), false); }
    }
  } catch (err) {
    s.stuck++; // failed actions count toward "stuck" (see describe)
    if (s.stuck >= STUCK_AFTER) err.message += `
${STUCK_HINT}`;
    throw err;
  } finally { page.off('request', onReq); page.off('framenavigated', onNav); }
  s.touch();
  saveProfile(s); // cookies/trust survive a restart too
  s.chain = chain.length > 1 ? chain : null;
  return describe(s, before, { status, snapshotAfter });
}

async function describe(s, before, { status = null, snapshotAfter = true } = {}) {
  const page = s.active;
  const lines = [];
  const events = s.events.splice(0);
  if (page) {
    const after = await fingerprint(page);
    const effect = before.url !== after.url ? `Navigated to ${after.url}`
      : after.hash !== before.hash || after.len !== before.len ? 'The page changed.' : 'No visible change on the page.';
    const judging = judgePage(s, after, { effect, status }); // runs while the rest is read
    const changed = !effect.startsWith('No visible change');
    const consent = s.consent;
    s.consent = null;
    const wall = await wallOf(page, status);
    const judged = await judging;
    // Stuck = no progress: the page's own change, refined by the judgment (a ticked box is progress; a reload of the same
    // error isn't).
    const thr = threshold();
    const progressed = judged?.progress == null ? changed
      : changed ? judged.progress > 1 - thr : judged.progress >= thr;
    s.stuck = progressed ? 0 : s.stuck + 1;
    lines.push(effect, ...events);
    if (s.stuck >= STUCK_AFTER) lines.push(STUCK_HINT);
    if (consent) lines.push(`(Closed ${consent} for you.)`);
    if (wall) {
      lines.push(`BLOCKED: this page is ${wall}, not the site's content. Don't treat it as results. Tell the person you were blocked `
        + 'here and offer another site, trying again later, or opening the link themselves.');
    } else if (judged && judged.p >= thr && PAGE_LINES[judged.kind] && !(judged.kind === 'cookie_panel' && consent)) {
      lines.push(PAGE_LINES[judged.kind]);
    }
    lines.push(`Page: ${oneLine(after.title, 160) || '(untitled)'} — ${after.url}`);
    rememberUrl(s.key, after.url);
    s.last = { url: after.url, status, wall: wall || null };
    // A search typed into the site's form that landed on a results address: keep its shape (recipes.js, decision #165).
    if (s.typed && before.url !== after.url) {
      if (!wall && !(status >= 400) && sameSite(s.typed.url, after.url)) learnRecipe(after.url, s.typed.texts, { formUrl: s.typed.url });
      s.typed = null;
    }
    // The site noticed the ad blocker and asks for it off (decision #168): switch it off there and say so.
    if (browserSettings().blockAds && hostOf(after.url) && !adblockOffFor(hostOf(after.url)) && antiAdblockWall({ title: after.title, text: after.head })) {
      switchOffFor(hostOf(after.url));
      lines.push(`This site asks for the ad blocker to be turned off, so ad blocking is now off for ${hostOf(after.url)}. Open the page again `
        + '(browser_open the same address) to load it normally.');
    }
    // Where we are on the page, and anything that takes over the screen.
    const modal = await markModal(page);
    const view = await page.evaluate(() => {
      const h = innerHeight || 1, visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
      return { above: scrollY / h, below: Math.max(0, (document.documentElement.scrollHeight - scrollY - h) / h),
        password: [...document.querySelectorAll('input[type="password"]')].some(visible),
        icon: document.querySelector('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]')?.href || null };
    }).catch(() => null);
    if (view?.icon) noteIcon(after.url, view.icon); // the site's own icon for the chat's step rows
    if (view) {
      lines.push(`Scroll: ${view.above.toFixed(1)} screens above, ${view.below.toFixed(1)} below.`);
      if (modal) lines.push(`A pop-up is on top (“${oneLine(modal.name, 100)}”) — its contents come first in the snapshot. Act inside it (e.g. its main button), or close it.`);
      if (view.password) lines.push('LOGIN: this page asks for a password. Never type the person’s passwords or card details. Ask them with '
        + 'ask_user (show_screen: true) whether to continue without signing in, or to sign in themselves.');
    }
    if (s.pages.length > 1) lines.push(`Tabs: ${s.pages.map((p, i) => `[${i}]${p === page ? '*' : ''} ${p.url().slice(0, 80)}`).join(' · ')}`);
    if (s.dialog) lines.push(`A ${s.dialog.type()} dialog is open: “${oneLine(s.dialog.message(), 200)}” — use browser_dialog.`);
    if (snapshotAfter && !s.dialog) {
      const snap = await snapshot(s).catch(err => `(couldn't read the page: ${err.message.split('\n')[0]})`);
      // The site answered the last action with a sign-in prompt (not only a password field): that's a wall, not a hang.
      const reacted = /^(?:Pop-up on top|Appeared after this action)[\s\S]*?\n\n/.exec(snap)?.[0] || '';
      if (/\b(log ?in|sign ?in|se connecter|connexion|create (?:an )?account|continue as guest)\b/i.test(reacted) && !view?.password && !lines.some(l => l.startsWith('SIGN-IN:'))) {
        lines.push('SIGN-IN: the site answered with a sign-in prompt. If it offers a guest option, use it; otherwise tell the person the '
          + 'site wants them signed in, show them (ask_user with show_screen: true) and ask whether they want to sign in themselves.');
      }
      lines.push('', SNAPSHOT_MARK, snap);
    }
    // Domain trust (trust.js, decision #167): always kept for the hand-over viewer; said to Jess on sign-in pages only.
    const user = s.meta.userId ? getUser(s.meta.userId) : null;
    const signals = trustSignals({ url: after.url, password: !!view?.password, chain: s.chain || [], brands: brandsFor(user) });
    s.trust = { url: after.url, site: siteOf(hostOf(after.url)) || null, warnings: signals.map(x => x.text) };
    const signIn = lines.findIndex(l => /^(LOGIN|SIGN-IN):/.test(l));
    const caution = signIn >= 0 ? cautionLine(signals) : null;
    if (caution) lines.splice(signIn + 1, 0, caution);
  } else lines.push(...events, 'No tab is open.');
  note({ kind: 'session', url: page?.url() || '', title: 'Interactive browsing' });
  return lines.join('\n');
}

// ---- The actions (tools in src/agent/tools/browse.js) ---------------------------------------------------------------
export async function open(s, rawUrl) {
  const url = await assertPublicUrl(rawUrl);
  s.doing = `open ${url}`; // what the page judgment weighs progress against
  s.typed = null; // opening an address isn't a search typed into a form
  const text = await act(s, page => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));
  // A learned results address (recipes.js): opening one counts as a success or a failure; otherwise offer the shape.
  const used = noteRecipeUse({ requestedUrl: url, finalUrl: s.last?.url, status: s.last?.status, wall: s.last?.wall });
  const line = used === 'dropped' ? 'That results address (learned from an earlier search here) failed twice, so it is forgotten — use the site’s form.'
    : used ? null : recipeHint(url);
  return line ? beforeSnapshot(text, line) : text;
}

/** Put a line of Jess's own notes just before the page snapshot (or at the end when there is none). */
export function beforeSnapshot(text, line) {
  const at = text.indexOf(`\n\n${SNAPSHOT_MARK}`);
  return at < 0 ? `${text}\n${line}` : `${text.slice(0, at)}\n${line}${text.slice(at)}`;
}

export const refName = (s, ref) => s?.refs.get(String(ref)) || '';

/** Click; if something sits on top or it won't settle, press the element itself (its own click()). Returns the cover, if any. */
async function pressEl(loc, { timeout = 6000 } = {}) {
  try { await loc.click({ timeout }); return null; } catch (err) {
    if (!/intercepts pointer events|not visible|outside of the viewport|not stable|Timeout/i.test(err.message)) throw err;
    const cover = await coveringElement(loc);
    const ok = await loc.evaluate(el => { if (!el.isConnected) return false; el.click(); return true; }).catch(() => false);
    if (!ok) throw new Error(`Couldn't click it${cover ? ` — ${cover} is on top of it; close that first` : ''}. Take a new snapshot.`);
    return cover || 'something';
  }
}

/** What sits on top of an element's centre (an overlay, a consent layer…), described for the model. */
async function coveringElement(loc) {
  return loc.evaluate(el => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || top === el || el.contains(top)) return null;
    const box = top.closest('[role="dialog"], [aria-modal="true"], dialog, [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [class*="modal" i], [class*="overlay" i]') || top;
    const name = box.getAttribute('aria-label') || box.querySelector('h1, h2, h3, [role="heading"]')?.textContent || box.textContent || '';
    return `${box.getAttribute('role') || box.tagName.toLowerCase()} “${name.replace(/\s+/g, ' ').trim().slice(0, 80)}”`;
  }).catch(() => null);
}

/**
 * Click like a person — and when something is on top (a transparent layer, a sticky banner), still press the element
 * itself the way assistive tech does (its own click()), telling the model what was in the way.
 */
export async function click(s, ref, { double = false } = {}) {
  const loc = await resolve(s, ref);
  s.doing = `click ${refName(s, ref)}`;
  return act(s, async () => {
    if (double) { await loc.dblclick({ timeout: 6000 }); return; }
    const cover = await pressEl(loc);
    if (cover) s.events.push(`The normal click was blocked by ${cover}, so I pressed the element directly.`);
  });
}

// Consent walls autoconsent doesn't know: walls.js dismissConsent (declines, or accepts when that's the only way).
export { dismissConsent };

const escapeRe = t => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Type into a field (replacing its content). Autocomplete fields get real key events so suggestions appear; with
 * `pick`, the suggestion whose text contains it is clicked (e.g. text "Nairobi", pick "NBO") and the field is read back.
 */
export async function type(s, ref, text, { submit = false, pick = null } = {}) {
  const loc = await resolve(s, ref);
  s.doing = `type “${String(text).slice(0, 60)}” into ${refName(s, ref)}${submit ? ' and press Enter' : ''}`;
  const role = (refName(s, ref).match(/^([\w-]+)/) || [])[1];
  const auto = role === 'combobox' || pick || await loc.getAttribute('aria-autocomplete').catch(() => null);
  // What was typed on this page, for a results address it may lead to (recipes.js — only its shape is kept, never the text).
  const formUrl = s.active.url();
  s.typed = { url: formUrl, texts: [...(s.typed?.url === formUrl ? s.typed.texts : []), String(text)].slice(-6) };
  let picked = null;
  const result = await act(s, async page => {
    if (auto) {
      // Autocomplete fields react to key events: clear, then type like a person and let the suggestions appear.
      await loc.click().catch(() => {});
      await loc.fill('').catch(() => {});
      await loc.pressSequentially(String(text), { delay: 60 });
      const options = page.locator('[role="option"], [role="listbox"] li, [role="menuitem"]');
      await options.first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
      if (pick) {
        const match = options.filter({ hasText: new RegExp(escapeRe(pick), 'i') }).first();
        if (await match.isVisible().catch(() => false)) {
          picked = (await match.innerText().catch(() => pick)).replace(/\s+/g, ' ').trim().slice(0, 120);
          await pressEl(match);
        }
      }
    } else {
      try { await loc.fill(String(text)); } catch { await loc.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(String(text), { delay: 20 }); }
    }
    if (submit) await loc.press('Enter');
  });
  if (!pick) return result;
  const value = await loc.inputValue().catch(() => null);
  return `${picked ? `Picked the suggestion “${picked}”.` : `No suggestion matched “${pick}” — look at what appeared and click one, or type differently.`}`
    + `${value != null ? ` The field now reads “${value}”.` : ''}\n${result}`;
}

/**
 * Set a date in a date field or calendar: types it when the field takes typing (verified by reading it back),
 * otherwise opens the calendar and clicks the day, moving month by month (up to 18) until it's shown.
 */
export async function pickDate(s, ref, iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) throw new Error('Give the date as YYYY-MM-DD.');
  s.doing = `set the date ${iso} in ${refName(s, ref)}`;
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const fmt = o => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(date);
  const fmtGB = o => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...o }).format(date);
  const variants = [iso, `${m[3]}/${m[2]}/${m[1]}`, `${m[2]}/${m[3]}/${m[1]}`, fmt({ month: 'long', day: 'numeric', year: 'numeric' }),
    fmtGB({ day: 'numeric', month: 'long', year: 'numeric' }), fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    fmtGB({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), fmt({ weekday: 'long', month: 'long', day: 'numeric' })];
  const loc = await resolve(s, ref);
  const type = await loc.getAttribute('type').catch(() => null);
  let how = null;
  const result = await act(s, async page => {
    if (type === 'date') { await loc.fill(iso); how = 'typed'; return; }
    // A day cell whose label (aria-label, data attributes or title) names the date — marked for the click.
    const findDay = () => page.evaluate(vs => {
        const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const attrs = ['aria-label', 'data-iso', 'data-date', 'data-value', 'data-day', 'title', 'datetime'];
        const lower = vs.map(v => v.toLowerCase());
        const el = [...document.querySelectorAll('[aria-label], [data-iso], [data-date], [data-value], [data-day], td[title], button[title], time[datetime]')]
          .filter(vis).find(e => attrs.some(a => { const v = (e.getAttribute(a) || '').toLowerCase(); return v && lower.some(x => v === x || v.startsWith(`${x},`) || v.startsWith(`${x} `)); }));
        if (!el) return false;
        el.setAttribute('data-jb-pick', '1');
        return true;
      }, variants);
    // Range pickers keep the calendar open for the second date (and it covers the field): only open it when needed.
    if (!(await findDay())) {
      await pressEl(loc, { timeout: 6000 });
      await page.waitForTimeout(400);
    }
    for (let step = 0; step < 18 && !how; step++) {
      const found = await findDay();
      if (found) {
        await pressEl(page.locator('[data-jb-pick="1"]').first());
        await page.evaluate(() => document.querySelectorAll('[data-jb-pick]').forEach(e => e.removeAttribute('data-jb-pick'))).catch(() => {});
        how = 'clicked';
        break;
      }
      const next = page.locator(':is(button, [role="button"], a):is([aria-label*="next" i], [title*="next" i], [aria-label*="forward" i])').first();
      if (!(await next.isVisible().catch(() => false))) break;
      await pressEl(next);
      await page.waitForTimeout(350);
    }
  });
  const value = await loc.inputValue().catch(() => null);
  const head = how ? `${how === 'typed' ? 'Typed' : 'Clicked'} ${fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`
    : `Couldn't find ${iso} in the calendar — look at the snapshot: click the day yourself, or the month arrows.`;
  return `${head}${value ? ` The field now reads “${value}”.` : ''} Check the dates shown before searching.\n${result}`;
}

export async function select(s, ref, values) {
  const loc = await resolve(s, ref);
  s.doing = `choose ${[].concat(values).join(', ')} in ${refName(s, ref)}`;
  const list = [].concat(values).map(String);
  return act(s, async () => {
    try { await loc.selectOption(list.map(label => ({ label })), { timeout: 5000 }); } catch {
      try { await loc.selectOption(list, { timeout: 5000 }); } catch {
        throw new Error('That isn’t a native dropdown. Click it to open the list, take a snapshot, then click the option.');
      }
    }
  });
}

export const press = (s, key) => { s.doing = `press ${key}`; return act(s, page => page.keyboard.press(String(key))); };
export async function hover(s, ref) { const loc = await resolve(s, ref); return act(s, () => loc.hover()); }

export async function scroll(s, { direction = 'down', ref = null } = {}) {
  if (ref) { const loc = await resolve(s, ref); return act(s, () => loc.scrollIntoViewIfNeeded()); }
  s.doing = `scroll ${direction}`;
  return act(s, page => page.mouse.wheel(0, (direction === 'up' ? -1 : 1) * 700));
}

export const back = s => (s.doing = 'go back', act(s, page => page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 })));

export async function tabs(s, { action = 'list', index = null } = {}) {
  if (action === 'select' || action === 'close') {
    const p = s.pages[Number(index)];
    if (!p) throw new Error(`There's no tab ${index}.`);
    if (action === 'close') await p.close();
    else { s.active = p; await p.bringToFront().catch(() => {}); }
  }
  s.touch();
  return describe(s, await fingerprint(s.active || { url: () => '', evaluate: async () => ({}) }), { snapshotAfter: action !== 'list' });
}

export async function wait(s, { text = null, textGone = null, seconds = null } = {}) {
  return act(s, async page => {
    // Text as it appears on the page (not roles like "progressbar"); 10 s, then the snapshot shows what is there instead.
    try {
      if (text) await page.getByText(String(text)).first().waitFor({ state: 'visible', timeout: 10000 });
      else if (textGone) await page.getByText(String(textGone)).first().waitFor({ state: 'hidden', timeout: 10000 });
    } catch { s.events.push(`Waited 10 s — “${text || textGone}” ${text ? 'did not appear' : 'is still there'}. Look at the page as it is now.`); return; }
    if (text || textGone) return;
    await page.waitForTimeout(Math.min(15, Math.max(1, Number(seconds) || 2)) * 1000);
  });
}

export async function dialog(s, { accept = true, text = null } = {}) {
  const d = s.dialog;
  if (!d) throw new Error('No dialog is open.');
  s.dialog = null;
  return act(s, async () => { await (accept ? d.accept(text ?? undefined) : d.dismiss()); });
}

/**
 * The page's readable text as a reader sees it (hidden text left out; Readability, or the whole page when it isn't an
 * article) — for reading results. → { title, url, published: Date|null, text (this part), start, end, total, hidden }.
 */
export async function read(s, { start = 0, length = 12000 } = {}) {
  const page = s.active;
  if (!page) throw new Error('No page is open — use browser_open first.');
  s.touch();
  const x = await extractVisible(page);
  const text = x.markdown || '';
  const from = Math.max(0, Math.min(Number(start) || 0, text.length));
  const chunk = text.slice(from, from + length);
  return { title: x.title, url: page.url(), published: looseDate(x.published), text: chunk, start: from, end: from + chunk.length, total: text.length, hidden: x.hidden };
}

/** A screenshot of the active tab (shown to the person in the chat). */
export async function screenshot(s, { fullPage = false } = {}) {
  const page = s.active;
  if (!page) throw new Error('No page is open — use browser_open first.');
  s.touch();
  return { buf: await page.screenshot({ type: 'jpeg', quality: 72, fullPage }), title: await page.title(), url: page.url() };
}

/**
 * Attach a file to a file field (browser_upload, decision #166): a real <input type=file> (the ref, or one inside it) gets
 * the file directly; anything else (a styled "Upload" button) is clicked and the file chooser it opens is answered.
 * file: { name, mimeType, buffer }.
 */
export async function upload(s, ref, file) {
  const loc = await resolve(s, ref);
  s.doing = `attach the file “${file.name}” to ${refName(s, ref)}`;
  return act(s, async page => {
    const own = await loc.evaluate(el => el.tagName === 'INPUT' && el.type === 'file').catch(() => false);
    const inner = own ? null : loc.locator('input[type="file"]').first();
    if (own) await loc.setInputFiles(file);
    else if (inner && await inner.count().catch(() => 0)) await inner.setInputFiles(file);
    else {
      const chooser = page.waitForEvent('filechooser', { timeout: 8000 });
      await pressEl(loc);
      await (await chooser.catch(() => { throw new Error('Clicking it didn’t open a file chooser — find the page’s file field (an upload button or “Choose file”) in the snapshot.'); })).setFiles(file);
    }
    s.events.push(`Attached “${oneLine(file.name, 120)}” (${sizeLabel(file.buffer.length)}) to the file field.`);
  });
}

/** The trust warnings and site of the tab's page (the hand-over viewer shows them). → { url, site, warnings } | null. */
export const trustOf = s => (s?.active && s.trust?.url === s.active.url() ? s.trust : s?.active ? { url: s.active.url(), site: siteOf(hostOf(s.active.url())) || null, warnings: [] } : null);

const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const sameSite = (a, b) => { const x = hostOf(a), y = hostOf(b); return !!x && !!y && siteOf(x) === siteOf(y); };

export { StaleRef };

/** The session for a key without touching it (risk checks read the last snapshot's element names). */
export const peek = key => (key ? sessions.get(key) || null : null);

export const __test = { popupLines, collapseLists, compactRows, shrinkSnapshot, sessions }; // unit tests (sessions: a stand-in tab)

// ---- Hand-over (decision #61): the person uses Jess's own tab — sign in, solve a CAPTCHA, pay — then hands it back ----
// Frames are plain JPEG screenshots of the active tab; input arrives as fractions of the viewport. Typed text goes straight to
// the page and is never logged or shown to the model.
const HANDOVER_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Shift+Tab']);

export async function handoverFrame(s) {
  const page = s?.active;
  if (!page) return null;
  s.touch();
  return { buf: await page.screenshot({ type: 'jpeg', quality: 60, timeout: 8000 }), url: page.url(), title: await page.title().catch(() => '') };
}

/**
 * The tab as live video (decision #115): Chromium's screencast pushes a JPEG whenever the page changes; frames go to
 * onFrame at most `fps` a second — the newest always wins and the last one is never dropped, so the view never sits on a
 * stale frame. Follows tab switches. Returns stop().
 */
export async function handoverStream(s, onFrame, { fps = 10 } = {}) {
  const gap = 1000 / fps;
  let cdp = null, page = null, stopped = false, sentAt = 0, pending = null, timer = null;
  const flush = () => { timer = null; if (!pending || stopped) return; const buf = pending; pending = null; sentAt = Date.now(); onFrame(buf); };
  const push = buf => {
    pending = buf;
    s.touch();
    const wait = gap - (Date.now() - sentAt);
    if (wait <= 0) flush(); else if (!timer) timer = setTimeout(flush, wait);
  };
  const detach = async () => {
    const c = cdp;
    cdp = null; page = null;
    if (c) { await c.send('Page.stopScreencast').catch(() => {}); await c.detach().catch(() => {}); }
  };
  const attach = async () => {
    if (stopped || !s.active || s.active === page) return;
    await detach();
    page = s.active;
    const c = await page.context().newCDPSession(page);
    cdp = c;
    c.on('Page.screencastFrame', f => {
      c.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      push(Buffer.from(f.data, 'base64'));
    });
    await c.send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 1400, maxHeight: 1400, everyNthFrame: 1 });
  };
  await attach();
  // The screencast only sends a frame when the page repaints — a page sitting still sends nothing. Open with a snapshot so
  // the viewer never starts blank.
  s.active?.screenshot({ type: 'jpeg', quality: 65, timeout: 8000 }).then(buf => { if (!sentAt && !pending) push(buf); }).catch(() => {});
  const follow = setInterval(() => attach().catch(() => {}), 500);
  return async () => { stopped = true; clearInterval(follow); clearTimeout(timer); await detach(); };
}

export async function handoverInput(s, ev = {}) {
  const page = s?.active;
  if (!page) throw new Error('The browser tab is closed.');
  s.touch();
  s.handedOver = true;
  const vp = page.viewportSize() || { width: 1280, height: 900 };
  const fx = n => Math.max(0, Math.min(1, Number(n) || 0));
  switch (ev.kind) {
    case 'click': await page.mouse.click(fx(ev.x) * vp.width, fx(ev.y) * vp.height); break;
    case 'wheel': await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, Number(ev.dy) || 0))); break;
    case 'type': await page.keyboard.type(String(ev.text || '').slice(0, 500), { delay: 15 }); break;
    case 'key': if (!HANDOVER_KEYS.has(ev.key)) throw Object.assign(new Error('Unknown key.'), { status: 400, expose: true }); await page.keyboard.press(ev.key === 'Space' ? ' ' : ev.key); break;
    case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); break;
    case 'reload': await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}); break;
    default: throw new Error('Unknown input.');
  }
  await page.waitForTimeout(250);
  return { url: page.url(), title: await page.title().catch(() => '') };
}

/** The person hands the tab back: Jess is told to look again before acting. */
export function handoverDone(s) {
  if (!s) return;
  if (s.handedOver) s.events.push('The person used this tab themselves (e.g. signed in or solved a check) and handed it back — take a fresh look before acting.');
  s.handedOver = false;
  saveProfile(s); // a sign-in they did should survive
}
