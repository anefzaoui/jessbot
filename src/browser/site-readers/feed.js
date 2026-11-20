// Feeds in web_read (decision #135) and the Feed's parser (decision #23): RSS, Atom, RDF and JSON Feed through feedsmith,
// OPML subscription lists too. web_read used to hand the raw XML to the model (up to 200k characters); now it shows the
// newest 50 items as "- [date] [title](link) — summary". normalizeFeed() is the Feed's own normaliser (services/feed.js
// re-exports it), so both read a feed the same way. Pure: no browser, no database.
import crypto from 'node:crypto';
import { parseFeed, parseOpml } from 'feedsmith';

const strip = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
const isoDate = v => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };

/** feedsmith output (RSS/Atom/RDF/JSON Feed) → our items. Exported for tests. */
const txt = v => (v && typeof v === 'object' ? v.value ?? '' : v ?? ''); // Atom text constructs are { value }
export function normalizeFeed(text) {
  const { format, feed } = parseFeed(text);
  const atom = format === 'atom';
  const items = (atom ? feed.entries : feed.items || []).map(it => {
    const link = atom ? (it.links?.find(l => !l.rel || l.rel === 'alternate')?.href || it.links?.[0]?.href) : format === 'json' ? it.url : it.link;
    const title = strip(txt(it.title));
    const guid = txt(it.guid) || it.id;
    const src = it.source?.title ? { name: strip(txt(it.source.title)), host: hostOf(it.source.url) } : null;
    // A picture the feed offers itself (Media RSS, image enclosures, YouTube's media:group, JSON Feed image).
    const pic = it.media?.contents?.find(m => !m.medium || m.medium === 'image')?.url || it.media?.thumbnails?.[0]?.url
      || it.media?.groups?.[0]?.thumbnails?.[0]?.url || it.media?.groups?.[0]?.contents?.find(m => m.medium === 'image')?.url
      || it.enclosures?.find(e => /^image\//.test(e.type || ''))?.url || it.image || it.banner_image || null;
    return {
      image: /^https?:\/\//.test(pic || '') ? pic : null,
      dedupe: String(guid || link || crypto.createHash('sha1').update(title).digest('hex')).slice(0, 500),
      url: link || null, title: src && title.endsWith(` - ${src.name}`) ? title.slice(0, -(src.name.length + 3)) : title,
      summary: strip(txt(it.description) || txt(it.summary) || it.content_text || it.content?.encoded || txt(it.content) || '').slice(0, 600) || null,
      sourceName: src?.name || null, sourceHost: src?.host || hostOf(link),
      published: isoDate(it.pubDate || it.published || it.updated || it.date_published || it.dc?.dates?.[0] || it.dc?.date),
    };
  }).filter(i => i.title);
  const home = atom ? (feed.links?.find(l => !l.rel || l.rel === 'alternate')?.href || feed.links?.[0]?.href) : feed.link || feed.home_page_url;
  return { format, title: strip(txt(feed.title)) || null, siteUrl: home || null, description: strip(txt(feed.description) || txt(feed.subtitle)) || null, items };
}

// ---- Is this a feed? ----------------------------------------------------------------------------------------------------
// The document element, after a byte-order mark (\s covers it), an XML prolog, comments, doctype or processing instructions (an XSL stylesheet line).
const FEED_ROOT = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<\?[^>]*\?>|<!DOCTYPE[^>]*>)\s*)*<(rss|feed|rdf:RDF|opml)\b/i;

/** 'feed' | 'opml' | null for a response body (text) and its Content-Type. */
export function feedKind(contentType = '', text = '') {
  const head = String(text || '').slice(0, 4000);
  const root = FEED_ROOT.exec(head)?.[1]?.toLowerCase();
  if (root === 'opml') return 'opml';
  if (root) return 'feed';
  if (/json/i.test(contentType) || /^\s*\{/.test(head)) {
    if (/"version"\s*:\s*"https?:\/\/jsonfeed\.org\/version\//.test(head)) return 'feed';
    return null;
  }
  return /opml/i.test(contentType) ? 'opml' : null;
}

// ---- Rendering ----------------------------------------------------------------------------------------------------------
const FORMAT_NAMES = { rss: 'RSS', atom: 'Atom', rdf: 'RDF', json: 'JSON Feed' };
const dayOf = iso => (iso ? iso.slice(0, 10) : 'undated');
const oneLine = (s, max) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t; };
const mdText = s => String(s || '').replace(/([[\]])/g, '\\$1');

export const FEED_SHOW = 50;

/**
 * A feed's text → the web_read document: newest FEED_SHOW items as "- [2026-09-20] [Title](link) — summary (≤ 200 chars)",
 * undated ones last. → { title, siteName, published (newest item), markdown, contentType, feed: { format, items, shown } }.
 */
export function renderFeed(text, url) {
  const f = normalizeFeed(text);
  const items = [...f.items].sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  const shown = items.slice(0, FEED_SHOW);
  const lines = shown.map(it => {
    const title = mdText(oneLine(it.title, 200));
    const head = it.url ? `[${title}](${it.url})` : title;
    const from = it.sourceName ? ` (${oneLine(it.sourceName, 60)})` : '';
    return `- [${dayOf(it.published)}] ${head}${from}${it.summary ? ` — ${oneLine(it.summary, 200)}` : ''}`;
  });
  const kind = FORMAT_NAMES[f.format] || 'feed';
  const count = items.length > shown.length ? `the newest ${shown.length} of ${items.length} items` : `${items.length} item${items.length === 1 ? '' : 's'}`;
  const markdown = [`A ${kind} feed — ${count}, newest first.${f.siteUrl ? ` Site: ${f.siteUrl}` : ''}`,
    f.description ? oneLine(f.description, 400) : null, '', lines.length ? lines.join('\n') : '(The feed has no items.)'].filter(l => l != null).join('\n');
  return {
    url, title: f.title || hostOf(url) || url, siteName: hostOf(f.siteUrl || url), published: shown.find(i => i.published)?.published || null,
    markdown, contentType: 'feed', feed: { format: f.format, items: items.length, shown: shown.length },
  };
}

/** An OPML subscription list → the web_read document: its feeds, grouped by folder. */
export function renderOpml(text, url) {
  const o = parseOpml(text);
  const out = [];
  let total = 0;
  const walk = (outlines, depth) => {
    for (const n of outlines || []) {
      const name = oneLine(n.title || n.text || n.xmlUrl || '', 120);
      if (n.xmlUrl) {
        total++;
        out.push(`${'  '.repeat(Math.max(0, depth - 1))}- [${mdText(name)}](${n.xmlUrl})${n.htmlUrl ? ` — site: ${n.htmlUrl}` : ''}${n.description ? ` — ${oneLine(n.description, 160)}` : ''}`);
      } else if (n.outlines?.length) {
        out.push(`${depth ? '' : '\n'}${'#'.repeat(Math.min(4, depth + 2))} ${name || 'Folder'}`);
        walk(n.outlines, depth + 1);
      }
    }
  };
  walk(o.body?.outlines, 0);
  const title = oneLine(o.head?.title || '', 160) || 'Feed list (OPML)';
  return {
    url, title, siteName: hostOf(url), published: isoDate(o.head?.dateModified || o.head?.dateCreated),
    markdown: `An OPML list of ${total} feed${total === 1 ? '' : 's'} (subscriptions — each link is a feed you can web_read).\n${out.join('\n').replace(/^\n+/, '\n')}`,
    contentType: 'opml', feed: { format: 'opml', items: total, shown: total },
  };
}
