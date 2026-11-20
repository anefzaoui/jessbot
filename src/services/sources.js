// Sources per run (Phase 21 item 5, decision #180): the addresses a task found in web search results and the pages it
// actually read (web_read, browser_read, browser_open, open_search) are kept on the run (`runs.sources`, migration 044),
// in normal form (browser/read.js normalizeUrl). They feed three things:
//   - the citation check: links in the final reply that the task never saw get one re-prompt, then are removed;
//   - a code-built "Sources" section on a Markdown document the task writes after reading pages;
//   - the trust chip on the run view ("Checked 4 sources · 3 sites · newest 2 days old"; the screen is Phase 25).
import { get, run } from '../db/index.js';
import { config } from '../config/index.js';
import { normalizeUrl } from '../browser/read.js';
import { escapeMarkdown } from '../lib/text-safe.js';

const MAX_SOURCES = 80;
export const READ_TOOLS = new Set(['web_read', 'browser_read', 'browser_open', 'open_search']);
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
const MONTH = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
// Tool results write dates as lib/when.js datedLabel does: "3 Oct 2026 (2 days ago)".
const isoDay = text => {
  const m = /\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})\b/.exec(String(text || ''));
  return m ? `${m[3]}-${String(MONTH[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};

export function sourcesOf(runOrId) {
  const r = typeof runOrId === 'object' ? runOrId : get('SELECT sources FROM runs WHERE id = ?', runOrId);
  try { return JSON.parse(r?.sources || '[]'); } catch { return []; }
}

/** What one successful call found or read → [{ url, link, host, title, kind, date }]. step: the tool's visible step. */
export function sourcesFrom(name, args = {}, content = '', step = {}) {
  const text = String(content || '');
  if (/^(?:Error:|BLOCKED)/.test(text)) return [];
  if (name === 'web_search') {
    const out = [];
    // "1. Title\n   https://… · dated 3 Oct 2026 (2 days ago)" (agent/tools/web.js searchResultText)
    for (const m of text.matchAll(/^\s*\d+\.\s+(.+)\n\s+(https?:\/\/\S+) · ([^\n]*)$/gm)) {
      out.push({ link: m[2], title: clip(m[1].replace(/\s*\[found by \d+ engines\]$/, ''), 160), kind: 'search', date: /date unknown/.test(m[3]) ? null : isoDay(m[3]) });
    }
    return out.map(s => ({ ...s, url: normalizeUrl(s.link), host: hostOf(s.link) })).filter(s => s.host);
  }
  if (!READ_TOOLS.has(name)) return [];
  const link = [step?.href, args?.url].find(u => /^https?:\/\//i.test(String(u || '')));
  if (!link) return [];
  const date = isoDay(/\bpublished ([^·\n]+)/.exec(text)?.[1] || /\bupdated ([^·\n]+)/.exec(text)?.[1]);
  return [{ link, url: normalizeUrl(link), host: hostOf(link), title: clip(step?.detail || '', 160) || null, kind: 'read', date }].filter(s => s.host);
}

/** Add what a call found or read to its run (a read upgrades a search hit; newest first wins nothing: first seen is kept). */
export function noteSources(runId, name, args, content, step) {
  const found = sourcesFrom(name, args, content, step);
  if (!found.length) return 0;
  const list = sourcesOf(runId);
  const at = new Date().toISOString();
  for (const s of found) {
    const have = list.find(x => x.url === s.url);
    if (have) {
      if (s.kind === 'read' && have.kind !== 'read') Object.assign(have, { kind: 'read', title: s.title || have.title, date: s.date || have.date, at });
      continue;
    }
    list.push({ ...s, at });
  }
  // Pages read are what matter: when the list is full, search hits make room first.
  while (list.length > MAX_SOURCES) {
    const i = list.findIndex(x => x.kind === 'search');
    list.splice(i >= 0 ? i : 0, 1);
  }
  run('UPDATE runs SET sources = ? WHERE id = ?', JSON.stringify(list), runId);
  return found.length;
}

// ---- Links in a reply -----------------------------------------------------------------------------------------------
const TRAIL = /[)\].,;:!?'"”’»]+$/;
/** Absolute http(s) links in a text: [{ raw, url }] (markdown links and bare addresses; trailing punctuation dropped). */
export function linksIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>()[\]"'`]+(?:\([^\s()]*\)[^\s<>()[\]"'`]*)*/gi)) {
    const raw = m[0].replace(TRAIL, '');
    if (raw.length > 10) out.push({ raw, url: normalizeUrl(raw) });
  }
  return out;
}

/** This app's own addresses (its public URL, localhost): never checked. */
export function appLink(url) {
  const host = hostOf(url);
  if (!host) return false;
  return ['localhost', '127.0.0.1', '::1'].includes(host) || host === hostOf(config.publicUrl || '');
}

/** Links in the reply the task never saw. seen: a Set of normalised addresses (sources, tool results, what the person wrote). */
export function unseenLinks(reply, seen) {
  const bad = [];
  for (const l of linksIn(reply)) {
    if (appLink(l.raw) || seen.has(l.url) || bad.some(b => b.url === l.url)) continue;
    bad.push(l);
  }
  return bad;
}

/** Every address mentioned in these texts, normalised (for `seen`). */
export const urlsSeenIn = texts => new Set(texts.flatMap(t => linksIn(t).map(l => l.url)));

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The reply without these links: a markdown link keeps its words, a bare address goes (and "( )" left behind with it). */
export function stripLinks(text, links) {
  let out = String(text || '');
  for (const l of links) {
    const raw = escapeRe(l.raw);
    out = out.replace(new RegExp(String.raw`\[([^\]]*)\]\(\s*${raw}[^)]*\)`, 'g'), (m, words) => words);
    out = out.replace(new RegExp(String.raw`<${raw}[^>]*>`, 'g'), () => '');
    out = out.replace(new RegExp(`${raw}[^\\s)\\]]*`, 'g'), () => '');
  }
  return out.replace(/\(\s*\)/g, '').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

// ---- The Sources section of a document ------------------------------------------------------------------------------
export const hasSourcesSection = md => /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?(?:sources?|references|further reading|références|المصادر|المراجع)(?:\*\*)?\s*:?\s*$/imu.test(String(md || ''));

/** "## Sources" built in code from the pages the task read (≤ 12). null when it read none. */
export function sourcesSection(sources) {
  const read = sources.filter(s => s.kind === 'read').slice(0, 12);
  if (!read.length) return null;
  const esc = s => escapeMarkdown(s);
  return `## Sources\n${read.map(s => `- [${esc(s.title || s.host)}](${s.url}) · ${s.host}${s.date ? ` · ${s.date}` : ''}`).join('\n')}`;
}

// ---- The trust chip -------------------------------------------------------------------------------------------------
/** For the run view: { checked, sites, newestDays, label, items } or null when the task used no web sources. */
export function trustChip(sources, now = new Date()) {
  if (!sources.length) return null;
  const read = sources.filter(s => s.kind === 'read');
  const pool = read.length ? read : sources;
  const sites = new Set(pool.map(s => s.host)).size;
  const days = pool.map(s => (s.date ? Math.floor((now - new Date(`${s.date}T00:00:00Z`)) / 864e5) : null)).filter(d => d != null && d >= 0);
  const newestDays = days.length ? Math.min(...days) : null;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const newest = newestDays == null ? null : newestDays === 0 ? 'newest from today' : `newest ${plural(newestDays, 'day')} old`;
  const label = read.length
    ? [`Checked ${plural(read.length, 'source')}`, plural(sites, 'site'), newest].filter(Boolean).join(' · ')
    : [`Only search results (${plural(sources.length, 'link')}, no page read)`, newest].filter(Boolean).join(' · ');
  return { checked: read.length, found: sources.length, sites, newestDays, label,
    items: sources.map(s => ({ url: s.link || s.url, host: s.host, title: s.title, date: s.date, kind: s.kind })) };
}
