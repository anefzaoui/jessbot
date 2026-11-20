// Reddit threads in web_read (decision #135). Read through Readability, a thread is mostly page furniture; its own
// ".json" (the same address plus .json, fetched from inside the thread's page so it's the same browser session) gives the
// post and its comments cleanly: the post with its score and text, then the top comments (score, author, text cut at
// 600 characters) with their best replies. Read-only. Reddit often challenges automated visitors: the wall is then passed
// to read.js, whose ladder retries once with the person's own cookies and otherwise says BLOCKED. Pure except readReddit().

const THREAD = /^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{3,12})(?:\/|$)/i;

/** { sub, id } for a Reddit thread URL (www/old/new/m/np.reddit.com, redd.it/<id>), or null. */
export function threadRef(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host === 'redd.it') { const id = u.pathname.split('/')[1]; return /^[a-z0-9]{3,12}$/i.test(id || '') ? { sub: null, id: id.toLowerCase() } : null; }
  if (!/(^|\.)reddit\.com$/.test(host)) return null;
  const m = THREAD.exec(u.pathname);
  return m ? { sub: m[1], id: m[2].toLowerCase() } : null;
}
export const threadUrl = ({ sub, id }) => (sub ? `https://www.reddit.com/r/${sub}/comments/${id}/` : `https://www.reddit.com/comments/${id}/`);
export const jsonUrl = ref => `${threadUrl(ref)}.json?limit=60&depth=3&sort=top&raw_json=1`;

const cut = (s, max) => { const t = String(s || '').replace(/\n{3,}/g, '\n\n').trim(); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t; };
const oneLine = (s, max) => cut(String(s || '').replace(/\s+/g, ' '), max);
const n = v => (v == null ? '?' : Number(v).toLocaleString('en-US'));
const iso = s => (s ? new Date(s * 1000).toISOString() : null);

export const TOP_COMMENTS = 20;

/** Reddit's thread JSON ([post listing, comment listing]) → the web_read document. Throws when it isn't a thread. */
export function renderThread(json, url, { top = TOP_COMMENTS } = {}) {
  const post = Array.isArray(json) ? json[0]?.data?.children?.find(c => c.kind === 't3')?.data : null;
  if (!post) throw new Error('not a Reddit thread response');
  const gone = b => /^\[(removed|deleted)\]$/.test(String(b || '').trim());
  const comments = (json[1]?.data?.children || []).filter(c => c.kind === 't1' && c.data && !c.data.stickied && c.data.body && !gone(c.data.body) && c.data.author !== 'AutoModerator');
  const sorted = [...comments].sort((a, b) => (b.data.score ?? 0) - (a.data.score ?? 0)).slice(0, top);
  const lines = [`Posted in r/${post.subreddit} by u/${post.author} on ${iso(post.created_utc)?.slice(0, 10) || 'an unknown date'} · score ${n(post.score)}`
    + `${post.upvote_ratio != null ? ` (${Math.round(post.upvote_ratio * 100)}% upvoted)` : ''} · ${n(post.num_comments)} comments${post.link_flair_text ? ` · ${oneLine(post.link_flair_text, 40)}` : ''}`];
  if (post.over_18) lines.push('(Marked NSFW.)');
  if (!post.is_self && post.url) lines.push(`Link: ${post.url}`);
  if (post.selftext) lines.push('', cut(post.selftext, 4000));
  lines.push('', `## Top comments (${sorted.length} of ${n(post.num_comments)}, by score)`);
  if (!sorted.length) lines.push('(No comments yet.)');
  for (const c of sorted) {
    const d = c.data;
    lines.push('', `- (${n(d.score)}) u/${d.author}${d.is_submitter ? ' [OP]' : ''}: ${cut(d.body, 600).replace(/\n+/g, ' ')}`);
    const replies = (d.replies?.data?.children || []).filter(r => r.kind === 't1' && r.data?.body && !gone(r.data.body))
      .sort((a, b) => (b.data.score ?? 0) - (a.data.score ?? 0)).slice(0, 2);
    for (const r of replies) lines.push(`  - (${n(r.data.score)}) u/${r.data.author}${r.data.is_submitter ? ' [OP]' : ''}: ${cut(r.data.body, 300).replace(/\n+/g, ' ')}`);
  }
  return { url, title: post.title, siteName: `Reddit · r/${post.subreddit}`, byline: `u/${post.author}`, published: iso(post.created_utc), modified: post.edited ? iso(post.edited) : null,
    markdown: lines.join('\n'), contentType: 'thread', thread: { sub: post.subreddit, comments: post.num_comments, shown: sorted.length } };
}

/**
 * Read a thread: open it in the browser (a challenge that solves itself is waited out), then fetch its JSON from inside
 * the page. Throws on failure — with err.wall set when a wall stood in the way, so read.js goes straight to its retry.
 */
export async function readReddit(url, { withPage, signal, walls }) {
  const ref = threadRef(url);
  if (!ref) throw new Error('not a Reddit thread address');
  const target = threadUrl(ref);
  return withPage(async page => {
    const doc = walls.trackDocument(page);
    try {
      doc.set(await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }));
      let wall = await walls.probeWall(page, doc.status());
      if (wall?.selfSolving) wall = await walls.waitOutWall(page, { maxMs: 12000, statusOf: doc.status });
      if (wall) throw Object.assign(new Error(`Reddit showed ${wall.label}`), { wall });
    } finally { doc.stop(); }
    const body = await page.evaluate(async u => {
      try { const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } }); return { status: r.status, text: await r.text() }; }
      catch (e) { return { status: 0, text: String(e) }; }
    }, jsonUrl(ref));
    let json;
    try { json = JSON.parse(body.text); } catch { throw new Error(`Reddit’s JSON didn’t come back (HTTP ${body.status})`); }
    return renderThread(json, target);
  }, { signal });
}
