// X / Twitter posts in web_read (decision #135). x.com shows nothing to a signed-out browser, so a status link is read
// from FxTwitter's public JSON API (api.fxtwitter.com, the service behind fxtwitter.com embeds) — fetched through our
// browser like any page — and written as markdown: text, author, date, counts, media, poll, the quoted post and X
// articles. The document keeps the x.com address. Replies aren't in that API: said honestly. Pure except readX().

const STATUS = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/|$)/;

/** { user, id } for an x.com / twitter.com status URL, or null. */
export function tweetRef(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|mobile|m)\./, '');
  if (!['x.com', 'twitter.com', 'fxtwitter.com', 'fixupx.com', 'vxtwitter.com'].includes(host)) return null;
  const m = STATUS.exec(u.pathname);
  return m ? { user: m[1], id: m[2] } : null;
}
export const apiUrl = ({ user, id }) => `https://api.fxtwitter.com/${user}/status/${id}`;
export const statusUrl = ({ user, id }) => `https://x.com/${user}/status/${id}`;

const n = v => (v == null ? null : Number(v).toLocaleString('en-US'));
const isoOf = t => (t?.created_timestamp ? new Date(t.created_timestamp * 1000).toISOString() : t?.created_at ? new Date(t.created_at).toISOString() : null);

// The post's text with t.co links replaced by what they point at (FxTwitter's facets), media links dropped (listed below).
function textOf(t) {
  let text = String(t.raw_text?.text ?? t.text ?? '');
  const facets = [...(t.raw_text?.facets || [])].filter(f => f.original).sort((a, b) => (b.indices?.[0] ?? 0) - (a.indices?.[0] ?? 0));
  for (const f of facets) text = text.split(f.original).join(f.type === 'media' ? '' : f.replacement || f.display || f.original);
  return text.trim();
}

function mediaLines(t) {
  return (t.media?.all || []).map(m => {
    const what = m.type === 'photo' ? 'Photo' : m.type === 'video' ? 'Video' : m.type === 'gif' ? 'GIF' : 'Media';
    const len = m.duration ? ` (${Math.round(m.duration)} s)` : '';
    return `- ${what}${len}: ${m.url || m.thumbnail_url}${m.altText ? ` — alt text: “${String(m.altText).replace(/\s+/g, ' ').slice(0, 300)}”` : ''}`;
  });
}

function pollLines(p) {
  if (!p?.choices?.length) return [];
  return [`Poll (${n(p.total_votes)} votes${p.ends_at ? `, ${new Date(p.ends_at) < new Date() ? 'ended' : 'ends'} ${new Date(p.ends_at).toISOString().slice(0, 10)}` : ''}):`,
    ...p.choices.map(c => `- ${c.label}: ${c.percentage ?? '?'}% (${n(c.count)})`)];
}

// X articles (long posts): title, preview and the text blocks FxTwitter hands over.
function articleLines(a) {
  if (!a) return [];
  const blocks = (a.content?.blocks || []).map(b => String(b.text || '').trim()).filter(Boolean);
  return [`## Article: ${a.title || '(untitled)'}`, ...(blocks.length ? blocks : [a.preview_text || '(The article’s text wasn’t included.)'])];
}

function head(t) {
  const who = t.author ? `${t.author.name || t.author.screen_name} (@${t.author.screen_name})` : 'unknown author';
  const counts = [t.replies != null && `${n(t.replies)} replies`, t.retweets != null && `${n(t.retweets)} reposts`, t.quotes != null && `${n(t.quotes)} quotes`,
    t.likes != null && `${n(t.likes)} likes`, t.bookmarks != null && `${n(t.bookmarks)} bookmarks`, t.views != null && `${n(t.views)} views`].filter(Boolean).join(' · ');
  return { who, counts };
}

/** FxTwitter's JSON (the whole response) → the web_read document, or throws when it holds no post. */
export function renderTweet(json, url) {
  const t = json?.tweet;
  if (!t) throw new Error(json?.message ? `FxTwitter: ${json.message}` : 'no post in the response');
  const { who, counts } = head(t);
  const date = isoOf(t);
  const lines = [`Post by ${who}${date ? ` on ${date.slice(0, 16).replace('T', ' ')} UTC` : ''}${t.replying_to ? ` — a reply to @${t.replying_to}` : ''}`,
    counts || null, '', textOf(t) || '(No text.)'];
  const media = mediaLines(t);
  if (media.length) lines.push('', 'Media:', ...media);
  const poll = pollLines(t.poll);
  if (poll.length) lines.push('', ...poll);
  if (t.community_note?.text) lines.push('', `Community note: ${String(t.community_note.text).replace(/\s+/g, ' ')}`);
  lines.push(...(t.article ? ['', ...articleLines(t.article)] : []));
  if (t.quote) {
    const q = t.quote, qh = head(q), qd = isoOf(q);
    lines.push('', `## Quoting ${qh.who}${qd ? ` (${qd.slice(0, 10)})` : ''}${q.url ? ` — ${q.url}` : ''}`, textOf(q) || '(No text.)', ...mediaLines(q));
  }
  lines.push('', '(Replies aren’t available through this reader. If they matter, open the post with browser_open — X may ask to sign in.)');
  return { url, title: `${t.author?.name || t.author?.screen_name || 'X'} on X: “${textOf(t).replace(/\s+/g, ' ').slice(0, 80)}${textOf(t).length > 80 ? '…' : ''}”`,
    siteName: 'X', byline: t.author ? `@${t.author.screen_name}` : null, published: date, modified: null, markdown: lines.filter(l => l != null).join('\n'),
    contentType: 'post', post: { id: t.id, author: t.author?.screen_name || null, quote: !!t.quote, media: (t.media?.all || []).length } };
}

/** Read a status URL through the browser (fetchJson: read.js's JSON fetch). */
export async function readX(url, { fetchJson, signal }) {
  const ref = tweetRef(url);
  if (!ref) throw new Error('not a post address');
  const json = await fetchJson(apiUrl(ref), { signal, timeout: 20000 });
  return renderTweet(json, statusUrl(ref));
}
