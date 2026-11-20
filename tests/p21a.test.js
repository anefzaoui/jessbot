// Phase 21 part A (decisions #135–#138): web_read's site readers (PDF, feeds, YouTube, X, Reddit), the shared wall detection
// and host rest of the escalation ladder, search by intent (freshness per engine, Google News editions, Wikipedia, cross-check
// merge, address normal form, caches), SearXNG (JSON parsing, health, fallback order, admin save test) and sealed browser
// profiles (seal/unseal, plaintext migration, signed-in sites, forgetting one).
// Run: npm test (throwaway data dir, no network: fixtures are real responses saved in tests/fixtures/web, SearXNG is a local
// stub server). Real-network checks of the same readers live in scripts/e2e-chat.js ("web readers" test).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-unit-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env'); // keys the code makes (secrets, VAPID) never land in the real .env
process.env.JESSBOT_EMBED_OFF = '1'; // no embedding calls from unit tests
process.env.JESSBOT_DECIDE_OFF = '1'; // no decision-model calls either: every use takes its fallback

const { openDb, closeDb } = await import('../src/db/index.js');
const { ensureDirs, paths } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { parseHTML } = await import('linkedom');
const { createUser } = await import('../src/services/users.js');
const { getTool } = await import('../src/agent/tools/registry.js');
await import('../src/agent/tools/index.js');
const W = await import('../src/browser/walls.js');
const R = await import('../src/browser/read.js');
const PDF = await import('../src/browser/site-readers/pdf.js');
const FEED = await import('../src/browser/site-readers/feed.js');
const YT = await import('../src/browser/site-readers/youtube.js');
const X = await import('../src/browser/site-readers/x.js');
const RD = await import('../src/browser/site-readers/reddit.js');
const { siteReaderFor } = await import('../src/browser/site-readers/index.js');
const N = await import('../src/browser/news.js');
const SX = await import('../src/browser/searxng.js');
const PR = await import('../src/browser/profiles.js');
const B = await import('../src/browser/index.js');
const S = await import('../src/browser/session.js');
const feed = await import('../src/services/feed.js');
const { savePlace } = await import('../src/services/places.js');
const { searchResultText } = await import('../src/agent/tools/web.js');
const secrets = await import('../src/lib/secrets.js');
const C = await import('../src/lib/captions.js');

const fx = name => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name));
const web = name => fx(path.join('web', name));
const webText = name => web(name).toString('utf8');

let ann;
before(async () => {
  ann = await createUser({ name: 'Ann Owner', email: 'ann21@t.dev', password: 'correct horse battery', role: 'admin' });
});
after(() => { closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });

// A saved page as the wall probe sees it: title, first characters of the visible text, its length, frames.
function probeOf(html, extra = {}) {
  const { document } = parseHTML(html);
  document.querySelectorAll('script, style, noscript').forEach(n => n.remove());
  const body = (document.body?.textContent || document.toString().replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return { title: document.querySelector('title')?.textContent || '', text: body.slice(0, W.WALL_TEXT_CHARS), textLength: body.length,
    frames: [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src')).filter(Boolean), ...extra };
}

// ---- Walls (decision #136) ---------------------------------------------------------------------------------------------
test('walls: real challenge pages are recognised (Cloudflare self-solving, Reddit’s network block not), articles and plain errors are not', () => {
  const cf = W.detectWall(probeOf(webText('wall-cloudflare.html'), { status: 403, url: 'https://www.w3.org/x.pdf' }));
  assert.equal(cf?.id, 'cloudflare');
  assert.equal(cf.selfSolving, true, 'Cloudflare’s “Just a moment…” is worth waiting for');
  const rd = W.detectWall(probeOf(webText('wall-reddit.html'), { status: 403 }));
  assert.equal(rd?.id, 'reddit-block');
  assert.equal(rd.selfSolving, false, 'a network block does not clear by waiting');
  // Reddit's JavaScript check answers 200: judged on the title, not the status.
  const humanity = W.detectWall({ title: 'Reddit - Prove your humanity', text: '', status: 200 });
  assert.deepEqual([humanity?.id, humanity?.selfSolving], ['reddit', true]);
  // A long article that talks about Cloudflare and captchas is content, not a wall.
  const article = `Cloudflare said on Tuesday that its “Just a moment” pages and captcha challenges ${'will change for millions of sites. '.repeat(120)}`;
  assert.equal(W.detectWall({ title: 'How Cloudflare’s bot checks work — The Verge', text: article, textLength: article.length, status: 200 }), null);
  // Status alone: 403/429 are blocks; a long 503 is a maintenance page (an error, not a wall); 404 is neither.
  assert.equal(W.detectWall({ title: 'Forbidden', text: 'nope', status: 403 })?.label, 'an access-denied wall');
  assert.equal(W.detectWall({ title: 'x', text: 'slow down', status: 429 })?.label, 'an HTTP 429 block');
  assert.equal(W.detectWall({ title: 'Down for maintenance', text: 'x'.repeat(4000), status: 503 }), null);
  assert.equal(W.detectWall({ title: 'Not found', text: 'That page is gone.', status: 404 }), null);
  // Frames and consent screens.
  assert.equal(W.detectWall({ title: 'example.com', text: 'One moment', frames: ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x'] })?.id, 'cloudflare');
  assert.equal(W.detectWall({ title: 'Something', text: 'Hold on', frames: ['https://geo.captcha-delivery.com/captcha/?initialCid=1'] })?.id, 'datadome');
  const consent = W.detectWall({ title: 'Before you continue to YouTube', url: 'https://consent.youtube.com/m?continue=x', text: 'We use cookies' });
  assert.deepEqual([consent?.id, consent?.kind], ['consent', 'consent']);
});

test('walls: a host that blocked us rests for 30 minutes, then may be tried again', () => {
  W.clearResting();
  assert.equal(W.hostResting('https://www.example.org/a'), null);
  W.restHost('https://www.example.org/a', 'Cloudflare');
  const r = W.hostResting('https://example.org/other'); // www. or not, the same host
  assert.equal(r.label, 'Cloudflare');
  assert.ok(r.until - Date.now() > 29 * 60000 && r.until - Date.now() <= W.HOST_COOLDOWN_MS);
  W.restHost('https://short.example/', 'a bot check', -1); // already over
  assert.equal(W.hostResting('https://short.example/'), null);
  W.clearResting();
});

test('web_read: a resting host answers BLOCKED at once (no browser), as a result with the hand-over hint — never as page content', async () => {
  W.clearResting();
  const url = 'https://93.184.215.14/article'; // a literal public address: no DNS lookup in unit tests
  W.restHost(url, 'DataDome');
  const out = await getTool('web_read').run({ url }, { user: ann });
  assert.match(out.content, /^BLOCKED: 93\.184\.215\.14 showed DataDome/);
  assert.match(out.content, /browser_open/);
  assert.match(out.content, /take over the tab/);
  assert.equal(out.step.status, 'bad');
  assert.match(out.step.detail, /Blocked by DataDome/);
  await assert.rejects(R.readPage(url), err => err.name === 'Blocked' && err.until > Date.now());
  W.clearResting();
});

// ---- PDF (decision #135) -------------------------------------------------------------------------------------------------
test('PDF reader: text with page markers, title and dates from the PDF’s info, bytes kept for saving; a scanned PDF is said to be scanned', async () => {
  const buf = fx('sample.pdf');
  const doc = await PDF.pdfDocument(buf, { url: 'https://forms.example.gov/docs/sample-form.pdf' });
  assert.match(doc.markdown, /^--- page 1 ---/);
  assert.equal(doc.contentType, 'application/pdf');
  assert.equal(doc.title, 'sample-form', '“about:blank” in the info is junk: the file name stands in');
  assert.equal(doc.published, '2026-09-25T02:07:34.000Z');
  assert.equal(doc.pdf.scanned, false);
  assert.ok(doc.pdf.pages >= 1);
  // Through read.js's response router: a PDF served as application/octet-stream is recognised by its first bytes.
  const res = { headers: () => ({ 'content-type': 'application/octet-stream' }), status: () => 200, body: async () => buf };
  const viaRouter = await R.__test.readResponse({ url: () => 'https://files.example.com/download?id=7' }, res);
  assert.equal(viaRouter.contentType, 'application/pdf');
  assert.equal(viaRouter.bytes.length, buf.length, 'the bytes ride along for save: true');
  assert.ok(!Object.keys(viaRouter).includes('bytes'), '…but are not enumerable (never cached, never serialised)');
  // A page with no text layer.
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const blank = await PDFDocument.create();
  blank.setTitle('Scanned letter');
  blank.addPage([595, 842]);
  blank.addPage([595, 842]);
  const scanned = await PDF.pdfDocument(Buffer.from(await blank.save()), { url: 'https://x.example/scan.pdf' });
  assert.equal(scanned.pdf.scanned, true);
  assert.equal(scanned.title, 'Scanned letter');
  assert.match(scanned.markdown, /scanned PDF with no text layer: 2 pages/);
  assert.match(scanned.markdown, /save: true/);
  // Dates, file names, sniffing.
  assert.equal(PDF.pdfDate("D:20230115093000+01'00'"), '2023-01-15T08:30:00.000Z');
  assert.equal(PDF.pdfDate('D:2021'), '2021-01-01T00:00:00.000Z');
  assert.equal(PDF.pdfDate('garbage'), null);
  assert.equal(PDF.fileNameOf('https://x.example/a/Form%20W-9.pdf?x=1'), 'Form W-9');
  assert.ok(PDF.isPdf('application/pdf') && PDF.isPdf('', buf) && !PDF.isPdf('text/html', Buffer.from('<html>')));
  await assert.rejects(PDF.pdfDocument(Buffer.from('%PDF-1.7 not really'), { url: 'https://x.example/b.pdf' }), /couldn’t be opened/);
});

// ---- Feeds ---------------------------------------------------------------------------------------------------------------
test('feed reader: RSS, Atom, RDF and JSON Feed render as dated items, newest first, summaries ≤ 200 characters', async () => {
  assert.equal(FEED.feedKind('application/rss+xml', webText('feed-nasa.rss')), 'feed');
  assert.equal(FEED.feedKind('text/xml', web('feed-slashdot.rdf').toString('latin1')), 'feed');
  assert.equal(FEED.feedKind('application/json', webText('feed-jsonfeed.json')), 'feed');
  assert.equal(FEED.feedKind('application/json', '{"results": []}'), null, 'plain JSON is not a feed');
  assert.equal(FEED.feedKind('text/html', '<!doctype html><html>'), null);
  assert.equal(FEED.feedKind('text/xml', '<?xml version="1.0"?>\n<!-- list -->\n<opml version="2.0"><body/></opml>'), 'opml');

  const rss = FEED.renderFeed(webText('feed-nasa.rss'), 'https://www.nasa.gov/feed/');
  assert.equal(rss.contentType, 'feed');
  assert.match(rss.markdown, /^A RSS feed — 4 items, newest first\./);
  const items = rss.markdown.split('\n').filter(l => l.startsWith('- ['));
  assert.equal(items.length, 4);
  for (const l of items) {
    assert.match(l, /^- \[\d{4}-\d{2}-\d{2}\] \[[^\]]+\]\(https:\/\/www\.nasa\.gov\//);
    const summary = l.split(' — ')[1] || '';
    assert.ok(summary.length <= 200, `summary too long: ${summary.length}`);
  }
  const days = items.map(l => l.slice(3, 13));
  assert.deepEqual(days, [...days].sort().reverse(), 'newest first');

  const atom = FEED.renderFeed(webText('feed-node.atom'), 'https://github.com/nodejs/node/releases.atom');
  assert.match(atom.markdown, /^A Atom feed — 3 items/);
  assert.match(atom.markdown, /\]\(https:\/\/github\.com\/nodejs\/node\/releases\/tag\//);

  // RDF declares ISO-8859-1: decoded by the prolog, like the Feed does (decision #23).
  const rdf = FEED.renderFeed(R.decodeBody(web('feed-slashdot.rdf'), 'text/xml'), 'https://rss.slashdot.org/Slashdot/slashdotMain');
  assert.match(rdf.markdown, /^A RDF feed — 4 items/);
  assert.equal(rdf.title, 'Slashdot');

  const json = FEED.renderFeed(webText('feed-jsonfeed.json'), 'https://www.jsonfeed.org/feed.json');
  assert.match(json.markdown, /^A JSON Feed feed/);
  assert.ok(json.feed.items >= 1);

  // More than 50 items: the newest 50, said so; undated items last.
  const many = `<?xml version="1.0"?><rss version="2.0"><channel><title>Many</title><link>https://m.example/</link>${
    Array.from({ length: 60 }, (_, i) => `<item><title>Item ${i}</title><link>https://m.example/${i}</link>${i === 0 ? '' : `<pubDate>${new Date(Date.UTC(2026, 0, 1 + i)).toUTCString()}</pubDate>`}<description>${'word '.repeat(80)}</description></item>`).join('')}</channel></rss>`;
  const big = FEED.renderFeed(many, 'https://m.example/feed');
  assert.match(big.markdown, /the newest 50 of 60 items/);
  assert.match(big.markdown.split('\n').find(l => l.startsWith('- [')), /Item 59/);
  assert.ok(!big.markdown.includes('Item 0]'), 'the undated item sorts last and falls outside the 50');
  // Through the response router (what web_read gets for an RSS URL), no longer raw XML.
  const res = { headers: () => ({ 'content-type': 'application/rss+xml; charset=UTF-8' }), status: () => 200, body: async () => web('feed-nasa.rss') };
  const routed = await R.__test.readResponse({ url: () => 'https://www.nasa.gov/feed/' }, res);
  assert.equal(routed.contentType, 'feed');
  assert.doesNotMatch(routed.markdown, /<\?xml|<rss/);
  // The Feed's own parser is the same one (services/feed.js re-exports it).
  assert.equal(feed.normalizeFeed, FEED.normalizeFeed);
});

test('feed reader: an OPML list shows its feeds by folder; JSON that is not a feed stays JSON', async () => {
  const opml = `<?xml version="1.0"?><opml version="2.0"><head><title>My reading</title></head><body>
    <outline text="Tech"><outline type="rss" text="HN" title="Hacker News" xmlUrl="https://news.ycombinator.com/rss" htmlUrl="https://news.ycombinator.com/"/>
    <outline type="rss" text="Lobsters" xmlUrl="https://lobste.rs/rss"/></outline>
    <outline type="rss" text="NASA" xmlUrl="https://www.nasa.gov/feed/"/></body></opml>`;
  const doc = FEED.renderOpml(opml, 'https://x.example/list.opml');
  assert.equal(doc.title, 'My reading');
  assert.match(doc.markdown, /An OPML list of 3 feeds/);
  assert.match(doc.markdown, /## Tech\n- \[Hacker News\]\(https:\/\/news\.ycombinator\.com\/rss\) — site: https:\/\/news\.ycombinator\.com\//);
  assert.match(doc.markdown, /- \[NASA\]\(https:\/\/www\.nasa\.gov\/feed\/\)/);
  const res = { headers: () => ({ 'content-type': 'application/json' }), status: () => 200, body: async () => Buffer.from('{"ok":true}') };
  const plain = await R.__test.readResponse({ url: () => 'https://api.example.com/v1/x' }, res);
  assert.match(plain.markdown, /^```json\n\{"ok":true\}/);
  const err = { headers: () => ({ 'content-type': 'application/json' }), status: () => 404, body: async () => Buffer.from('{}') };
  await assert.rejects(R.__test.readResponse({ url: () => 'https://api.example.com/v1/x' }, err), /answered 404 \(the page isn’t there\)/);
});

// ---- YouTube -------------------------------------------------------------------------------------------------------------
test('YouTube reader: video ids from every address form; the person’s language wins, written captions over automatic', () => {
  for (const u of ['https://www.youtube.com/watch?v=I29P2zHNGdI&t=30s', 'https://youtu.be/I29P2zHNGdI?si=x', 'https://m.youtube.com/watch?v=I29P2zHNGdI',
    'https://www.youtube.com/shorts/I29P2zHNGdI', 'https://www.youtube.com/live/I29P2zHNGdI', 'https://www.youtube.com/embed/I29P2zHNGdI']) {
    assert.equal(YT.videoIdOf(u), 'I29P2zHNGdI', u);
  }
  for (const u of ['https://www.youtube.com/@nasa', 'https://www.youtube.com/watch?v=short', 'https://example.com/watch?v=I29P2zHNGdI']) assert.equal(YT.videoIdOf(u), null, u);
  assert.equal(siteReaderFor('https://youtu.be/I29P2zHNGdI')?.name, 'youtube');
  const tracks = [{ languageCode: 'en', kind: 'asr', name: 'English (auto-generated)' }, { languageCode: 'en-US', kind: null, name: 'English (United States)' },
    { languageCode: 'fr', kind: 'asr', name: 'French (auto-generated)' }, { languageCode: 'de', kind: null, name: 'German' }];
  assert.equal(YT.pickTrack(tracks, 'en').languageCode, 'en-US', 'written over automatic');
  assert.equal(YT.pickTrack(tracks, 'fr').languageCode, 'fr', 'the person’s language, even automatic');
  assert.equal(YT.pickTrack(tracks, 'ar').languageCode, 'en-US', 'no Arabic: the spoken language’s written track');
  assert.equal(YT.pickTrack([], 'en'), null);
});

test('YouTube reader: json3 captions parse to lib/captions.js cues; rolling automatic lines are kept once; ~30 s paragraphs with [m:ss]', () => {
  const manual = YT.parseJson3(webText('youtube-manual.json3'));
  assert.ok(manual.length > 10);
  assert.deepEqual([manual[0].start, manual[0].speaker], [0.4, null], 'seconds, the shared cue shape');
  assert.match(manual[0].text, /^A solar eclipse, one of the year's best meteor showers\.$/, 'line breaks inside a cue become spaces');
  assert.ok(manual[0].end > manual[0].start);
  const asr = YT.parseJson3(webText('youtube-asr.json3'));
  assert.ok(asr.length > 5 && asr.every(c => c.text && c.text.trim()), 'appended line-break events are dropped');
  // The real automatic VTT of the same video rolls (every cue repeats the line before): the shared caption code keeps
  // each line once — YouTube's reader and uploaded .vtt files make transcripts the same way.
  const vtt = webText('youtube-asr.vtt');
  assert.ok(C.parseCues(vtt).length > 20);
  const rolled = C.captionsToText(vtt, { timestamps: true, maxSec: YT.PARAGRAPH_SEC });
  assert.equal(rolled.split("A solar eclipse, one of the year's best").length - 1, 1, 'the first line once, not repeated by the next cue');
  assert.match(rolled, /^\[0:00\] A solar eclipse, one of the year's best \[music\] meteor showers, Venus at its brightest in the evening sky, and a lunar eclipse/);
  assert.doesNotMatch(rolled, /<c>|<\d\d:/, 'word timing tags removed');
  // Paragraphs of about 30 s, each stamped.
  const text = YT.transcriptText(manual);
  const paras = text.split(/\n\n/);
  assert.ok(paras.length >= 2 && paras.every(p => /^\[\d+:\d\d\] \S/.test(p)), text.slice(0, 200));
  const starts = paras.map(p => p.match(/^\[(\d+):(\d\d)\]/).slice(1).reduce((m, x) => m * 60 + Number(x), 0));
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1]);
  for (const p of C.transcriptParagraphs(manual, { maxSec: 30 })) assert.ok(p.end - p.start < 30 + 10, 'no paragraph runs far past 30 s');
  assert.equal(C.transcriptParagraphs(manual).length < C.transcriptParagraphs(manual, { maxSec: 30 }).length, true, 'maxSec is what splits them');
  // The transcript panel's own lines (last resort), as the page shows them.
  assert.deepEqual(YT.parsePanelLines(['0:18 18 seconds ♪ We are no strangers ♪', '1:02:03 1 hour, 2 minutes, 3 seconds Next part', 'junk']),
    [{ start: 18, end: 18, speaker: null, text: '♪ We are no strangers ♪' }, { start: 3723, end: 3723, speaker: null, text: 'Next part' }]);
});

test('YouTube reader: the document has title, channel, length, description and the transcript; no captions is said plainly', () => {
  const meta = YT.videoMeta(JSON.parse(webText('youtube-player.json')), 'I29P2zHNGdI');
  assert.equal(meta.title, 'What\'s Up: August 2026 Skywatching Tips from NASA');
  assert.equal(meta.channel, 'NASA Jet Propulsion Laboratory');
  assert.equal(meta.tracks.length, 2);
  const track = YT.pickTrack(meta.tracks, 'en');
  const doc = YT.renderVideo({ meta, track, cues: YT.parseJson3(webText('youtube-manual.json3')), via: 'captions' });
  assert.equal(doc.url, 'https://www.youtube.com/watch?v=I29P2zHNGdI');
  assert.equal(doc.siteName, 'YouTube');
  assert.equal(doc.byline, 'NASA Jet Propulsion Laboratory');
  assert.ok(doc.published?.startsWith('2026-'));
  assert.match(doc.markdown, /^Video by NASA Jet Propulsion Laboratory · \d+:\d\d/);
  assert.match(doc.markdown, /Transcript from the written captions \(English \(United States\)\); also available: English \(auto-generated\)\./);
  assert.match(doc.markdown, /## Description\nA solar eclipse/);
  assert.match(doc.markdown, /## Transcript\n\[0:00\] A solar eclipse/);
  const none = YT.renderVideo({ meta: { ...meta, tracks: [] }, track: null, cues: [] });
  assert.match(none.markdown, /This video has no captions, so there is no transcript to read/);
  const withheld = YT.renderVideo({ meta, track, cues: [] });
  assert.match(withheld.markdown, /didn’t hand them over this time/);
});

// ---- X / Twitter -----------------------------------------------------------------------------------------------------------
test('X reader: status links go to FxTwitter’s API; posts render with author, date, counts, media and the quoted post; the url stays x.com', () => {
  assert.deepEqual(X.tweetRef('https://x.com/BarackObama/status/266031293945503744?s=20'), { user: 'BarackObama', id: '266031293945503744' });
  assert.deepEqual(X.tweetRef('https://mobile.twitter.com/jack/status/20'), { user: 'jack', id: '20' });
  assert.equal(X.tweetRef('https://x.com/BarackObama'), null);
  assert.equal(X.tweetRef('https://example.com/a/status/123456'), null);
  assert.equal(X.apiUrl({ user: 'jack', id: '20' }), 'https://api.fxtwitter.com/jack/status/20');
  assert.equal(siteReaderFor('https://twitter.com/jack/status/20')?.name, 'x');

  const post = X.renderTweet(JSON.parse(webText('x-post.json')), 'https://x.com/BarackObama/status/266031293945503744');
  assert.equal(post.url, 'https://x.com/BarackObama/status/266031293945503744');
  assert.match(post.markdown, /^Post by Barack Obama \(@BarackObama\) on 2012-11-07 04:16 UTC/);
  assert.match(post.markdown, /686,016 reposts/);
  assert.match(post.markdown, /\n\nFour more years\.\n/, 'the t.co media link is replaced by the media list');
  assert.match(post.markdown, /Media:\n- Photo: https:\/\/pbs\.twimg\.com\/media\//);
  assert.match(post.markdown, /Replies aren’t available/);
  assert.equal(post.published, '2012-11-07T04:16:18.000Z');
  const quote = X.renderTweet(JSON.parse(webText('x-quote.json')), 'https://x.com/NASAhistory/status/2064390275305296354');
  assert.match(quote.markdown, /## Quoting .+\(@\w+\)/);
  assert.equal(quote.post.quote, true);
  assert.throws(() => X.renderTweet({ code: 404, message: 'NOT_FOUND', tweet: null }, 'https://x.com/a/status/1'), /NOT_FOUND/);
});

// ---- Reddit ----------------------------------------------------------------------------------------------------------------
test('Reddit reader: thread addresses; the post and top comments by score with their best replies; moderators and removed comments left out', () => {
  assert.deepEqual(RD.threadRef('https://old.reddit.com/r/AskCulinary/comments/1ABCDE/why_does/'), { sub: 'AskCulinary', id: '1abcde' });
  assert.deepEqual(RD.threadRef('https://redd.it/1abcde'), { sub: null, id: '1abcde' });
  assert.equal(RD.threadRef('https://www.reddit.com/r/AskCulinary/'), null);
  assert.equal(RD.jsonUrl({ sub: 'AskCulinary', id: '1abcde' }), 'https://www.reddit.com/r/AskCulinary/comments/1abcde/.json?limit=60&depth=3&sort=top&raw_json=1');
  assert.equal(siteReaderFor('https://www.reddit.com/r/AskCulinary/comments/1abcde/x/')?.name, 'reddit');
  // (Reddit blocks this network, so the fixture follows Reddit's documented thread JSON rather than a live capture.)
  const doc = RD.renderThread(JSON.parse(webText('reddit-thread.json')), 'https://www.reddit.com/r/AskCulinary/comments/1abcde/');
  assert.equal(doc.title, 'Why does my bread dough never rise in winter?');
  assert.match(doc.markdown, /^Posted in r\/AskCulinary by u\/flour_power_22 on 2026-09-01 · score 412 \(97% upvoted\) · 5 comments · Baking/);
  assert.match(doc.markdown, /Kitchen is about 16 °C/);
  const top = doc.markdown.split('\n').filter(l => l.startsWith('- ('));
  assert.deepEqual(top.map(l => l.match(/u\/(\S+?):/)[1]), ['cold_ferment_fan', 'proofing_box'], 'by score; AutoModerator and [removed] left out');
  assert.match(doc.markdown, / {2}- \(310\) u\/flour_power_22 \[OP\]: Oven light trick worked/);
  assert.equal(doc.markdown.split('\n').filter(l => l.startsWith('  - (')).length, 2, 'two best replies, not three');
  assert.throws(() => RD.renderThread({ kind: 'Listing' }, 'x'), /not a Reddit thread/);
});

// ---- Search by intent (decision #137) -------------------------------------------------------------------------------------
test('search: freshness goes to each engine its own way, and nothing is added without it', () => {
  const q = 'lyon weather';
  assert.match(R.ENGINES.duckduckgo.url(q, { freshness: 'week' }), /&df=w$/);
  assert.match(R.ENGINES.brave.url(q, { freshness: 'day' }), /&tf=pd$/);
  assert.match(R.ENGINES.google.url(q, { freshness: 'month' }), /&tbs=qdr:m$/);
  assert.match(R.ENGINES.startpage.url(q, { freshness: 'year' }), /&with_date=y$/);
  assert.equal(decodeURIComponent(R.ENGINES.bing.url(q, { freshness: 'week' }).split('&filters=')[1]), 'ex1:"ez2"');
  const year = decodeURIComponent(R.ENGINES.bing.url(q, { freshness: 'year' }).split('&filters=')[1]);
  const [, from, to] = /^ex1:"ez5_(\d+)_(\d+)"$/.exec(year);
  assert.equal(to - from, 365);
  assert.equal(Number(to), Math.floor(Date.now() / 864e5));
  for (const k of Object.keys(R.ENGINES)) assert.doesNotMatch(R.ENGINES[k].url(q), /df=|tf=|tbs=|with_date=|filters=/, k);
  assert.equal(SX.searxngSearchUrl('http://127.0.0.1:8888', q, { freshness: 'week', lang: 'fr' }),
    'http://127.0.0.1:8888/search?q=lyon+weather&format=json&categories=general&pageno=1&time_range=week&language=fr');
});

test('search: one normal form per address (www, tracking, fragments, trailing slash, AMP) keys merging and the page cache', () => {
  const same = ['https://www.example.com/news/story/?utm_source=x&utm_medium=feed&fbclid=abc#comments', 'http://example.com/news/story',
    'https://amp.example.com/news/story/amp/', 'https://example.com/news/story.amp?gclid=1&ref=hn', 'https://www.google.com/amp/s/example.com/news/story',
    'https://example-com.cdn.ampproject.org/c/s/example.com/news/story?outputType=amp'];
  for (const u of same) assert.equal(R.normalizeUrl(u), 'https://example.com/news/story', u);
  assert.equal(R.normalizeUrl('https://example.com/search?q=b&a=1'), 'https://example.com/search?a=1&q=b', 'parameters that matter stay, sorted');
  assert.equal(R.normalizeUrl('https://example.com/'), 'https://example.com');
  assert.equal(R.normalizeUrl('https://example.com:8443/x'), 'https://example.com:8443/x');
  assert.equal(R.normalizeUrl('not a url'), 'not a url');
});

test('search: two engines merge by normal address; pages both found come first, tagged; distinct sites counted', async () => {
  const merged = R.mergeResults([
    { engine: 'DuckDuckGo', results: [{ title: 'Lyon - Wikipedia', url: 'https://en.wikipedia.org/wiki/Lyon' }, { title: 'Visit Lyon', url: 'https://www.visiterlyon.com/?utm_source=ddg' },
      { title: 'Lyon guide', url: 'https://travel.example.com/lyon' }] },
    { engine: 'Brave Search', results: [{ title: 'Visit Lyon (official)', url: 'https://visiterlyon.com/', date: '2026-09-01T00:00:00.000Z' },
      { title: 'Lyon on Wikivoyage', url: 'https://en.wikivoyage.org/wiki/Lyon' }, { title: 'Lyon - Wikipedia', url: 'https://en.wikipedia.org/wiki/Lyon#History' }] },
  ]);
  assert.equal(merged.results.length, 4);
  assert.deepEqual(merged.results.slice(0, 2).map(r => r.url), ['https://en.wikipedia.org/wiki/Lyon', 'https://www.visiterlyon.com/?utm_source=ddg']);
  assert.deepEqual(merged.results[1].engines, ['DuckDuckGo', 'Brave Search']);
  assert.equal(merged.results[1].date, '2026-09-01T00:00:00.000Z', 'a date one engine knew is kept');
  assert.equal(merged.sites, 4, 'wikipedia.org, visiterlyon.com, example.com, wikivoyage.org');
  const text = await searchResultText({ user: ann }, { query: 'lyon', engine: 'DuckDuckGo + Brave Search', results: merged.results, checked: 2, sites: merged.sites });
  assert.match(text, /1\. Lyon - Wikipedia \[found by 2 engines\]/);
  assert.match(text, /Cross-checked: 2 engines, 4 pages from 4 different sites/);
  assert.doesNotMatch(text, /Lyon guide \[found/);
  const wiki = await searchResultText({ user: ann }, { query: 'lyon', engine: 'Wikipedia (every search engine failed)', fallback: true, tried: ['DuckDuckGo: no results'],
    results: [{ title: 'Lyon', url: 'https://en.wikipedia.org/wiki/Lyon', date: '2026-09-20T10:00:00Z', dateKind: 'edited' }] });
  assert.match(wiki, /last edited 20 Sept? 2026/);
  assert.match(wiki, /Every search engine failed \(DuckDuckGo: no results\), so these are Wikipedia articles only/);
});

test('news: the Google News edition follows the person’s language and country, with fallbacks Google itself uses', () => {
  assert.deepEqual(N.newsEdition('fr', 'FR'), { hl: 'fr', gl: 'FR', ceid: 'FR:fr' });
  assert.deepEqual(N.newsEdition('en', 'GB'), { hl: 'en-GB', gl: 'GB', ceid: 'GB:en' });
  assert.deepEqual(N.newsEdition('ar', 'JO'), { hl: 'ar', gl: 'EG', ceid: 'EG:ar' }, 'no Jordanian Arabic edition: the main Arabic one');
  assert.deepEqual(N.newsEdition('fr', 'JO'), { hl: 'fr', gl: 'FR', ceid: 'FR:fr' });
  assert.deepEqual(N.newsEdition('es', 'MX'), { hl: 'es-419', gl: 'MX', ceid: 'MX:es-419' });
  assert.deepEqual(N.newsEdition('es', 'ES'), { hl: 'es', gl: 'ES', ceid: 'ES:es' });
  assert.deepEqual(N.newsEdition('pt', 'PT'), { hl: 'pt-PT', gl: 'PT', ceid: 'PT:pt-150' });
  assert.deepEqual(N.newsEdition('zh-TW', 'TW'), { hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-Hant' });
  assert.deepEqual(N.newsEdition('en', 'JO'), { hl: 'en-US', gl: 'US', ceid: 'US:en' });
  assert.deepEqual(N.newsEdition('xx', null), { hl: 'en-US', gl: 'US', ceid: 'US:en' }, 'an unknown language: US English');
  assert.deepEqual(N.newsEdition('fr-CA', 'CA'), { hl: 'fr', gl: 'CA', ceid: 'CA:fr' });
  const u = new URL(N.gnewsUrl('Lyon', { lang: 'fr', country: 'FR', when: '1y' }));
  assert.deepEqual([u.searchParams.get('q'), u.searchParams.get('hl'), u.searchParams.get('gl'), u.searchParams.get('ceid')], ['Lyon when:1y', 'fr', 'FR', 'FR:fr']);
  assert.equal(new URL(N.gnewsUrl('Lyon', { when: null })).searchParams.get('q'), 'Lyon');
  assert.equal(N.scriptLang('أخبار الأردن اليوم'), 'ar');
  assert.equal(N.scriptLang('Новости'), 'ru');
  assert.equal(N.scriptLang('東京のニュース'), 'ja');
  assert.equal(N.scriptLang('Lyon football'), null);
});

test('news: the Feed’s Google News sources are no longer always en-US; web_search news results carry outlet and date', () => {
  const u = new URL(feed.gnewsUrl('Olympique Lyonnais', null));
  assert.equal(u.searchParams.get('ceid'), 'US:en', 'no person, Latin letters: as before');
  assert.equal(u.searchParams.get('q'), 'Olympique Lyonnais when:3d');
  savePlace(ann, { label: 'home', name: 'London', latitude: 51.5, longitude: -0.12, countryCode: 'GB' });
  assert.equal(new URL(feed.gnewsUrl('football', ann)).searchParams.get('ceid'), 'GB:en', 'the person’s country');
  assert.equal(new URL(feed.gnewsUrl('كرة القدم', ann)).searchParams.get('ceid'), 'EG:ar', 'an Arabic topic reads Arabic news');
  const results = R.newsResults(webText('gnews-fr.xml'));
  assert.equal(results.length, 5);
  for (const r of results) {
    assert.match(r.url, /^https:\/\/news\.google\.com\//);
    assert.ok(r.date && !Number.isNaN(Date.parse(r.date)), 'each item is dated');
    assert.match(r.snippet, /^From \S/);
    assert.ok(!r.title.endsWith(` - ${r.source}`), 'the outlet is split off the title');
  }
});

test('reference: Wikipedia search results link to the article, snippets without markup, dated by last edit', () => {
  const results = R.wikipediaResults(JSON.parse(webText('wikipedia-search.json')), 'en');
  assert.equal(results[0].title, 'Lyon');
  assert.equal(results[0].url, 'https://en.wikipedia.org/wiki/Lyon');
  assert.doesNotMatch(results.map(r => r.snippet).join(' '), /<span|searchmatch|&quot;/);
  assert.equal(results[0].dateKind, 'edited');
  assert.equal(new URL(R.wikipediaSearchUrl('Lyon', 'fr', 3)).hostname, 'fr.wikipedia.org');
  assert.equal(new URL(R.wikipediaSearchUrl('Lyon', 'not a lang', 3)).hostname, 'en.wikipedia.org');
  assert.equal(new URL(R.wikipediaSearchUrl('Lyon', 'en', 50)).searchParams.get('srlimit'), '10');
});

// ---- SearXNG (decision #138) ----------------------------------------------------------------------------------------------
async function stubServer(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); handler(req, res); });
  await listen(srv);
  return { base: `http://127.0.0.1:${srv.address().port}`, hits, close: () => new Promise(r => srv.close(r)) };
}
const sxFixture = () => webText('searxng.json');

test('SearXNG: its JSON parses into dated results with the engines that found them; addresses are validated', () => {
  const { results } = SX.parseSearxng(JSON.parse(sxFixture()));
  assert.equal(results.length, 6);
  assert.equal(results[0].url, 'https://en.wikipedia.org/wiki/Lyon');
  assert.ok(results[0].engines.length >= 2);
  assert.ok(results.every(r => /^https?:\/\//.test(r.url) && r.title));
  assert.deepEqual(SX.parseSearxng({ results: [{ url: 'javascript:alert(1)', title: 'x' }, { url: 'https://a.example/', title: 'A', publishedDate: '2026-09-20T00:00:00' }] }).results.map(r => r.age), ['2026-09-20T00:00:00']);
  assert.equal(SX.cleanSearxngUrl(' http://127.0.0.1:8888/ '), 'http://127.0.0.1:8888');
  assert.equal(SX.cleanSearxngUrl('search.example.org/searx/?x=1#y'), 'http://search.example.org/searx');
  assert.equal(SX.cleanSearxngUrl(''), '');
  assert.throws(() => SX.cleanSearxngUrl('ftp://x.example'), /http/);
  assert.throws(() => SX.cleanSearxngUrl('http://user:pw@x.example'), /password/);
});

test('SearXNG: used first when configured, searched directly; a 10-minute cache; when it is down it rests and the chain goes on without it', async () => {
  const sx = await stubServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(sxFixture()); });
  try {
    await B.saveBrowserSettings({ ...B.browserSettings(), searxngUrl: sx.base }, { test: async () => ({ ok: true }) });
    assert.deepEqual(R.engineOrder(null, ['duckduckgo', 'brave']), ['searxng', 'duckduckgo', 'brave']);
    assert.deepEqual([B.browserStatus().searxng.url, B.browserStatus().searxng.healthy], [sx.base, true], 'Admin → Browser status carries it (Phase 25)');
    assert.deepEqual(R.engineOrder('google', ['duckduckgo']), ['google', 'startpage', 'searxng', 'duckduckgo'], 'an engine the person named comes first');
    R.clearSearchCache();
    const out = await R.search('lyon france', { count: 3, freshness: 'year', lang: 'fr' });
    assert.equal(out.engine, 'SearXNG');
    assert.equal(out.results.length, 3);
    const q = new URL(sx.base + sx.hits.at(-1)).searchParams;
    assert.deepEqual([q.get('format'), q.get('time_range'), q.get('language'), q.get('q')], ['json', 'year', 'fr', 'lyon france']);
    const again = await R.search('Lyon  France', { count: 5, freshness: 'year', lang: 'fr' });
    assert.equal(again.cached, true);
    assert.equal(again.results.length, 5, 'the cache keeps the full list; count applies on the way out');
    assert.equal(sx.hits.length, 1, 'the second search came from the cache');
  } finally { await sx.close(); }
  // Down: the search fails, SearXNG rests, and the order no longer includes it.
  SX.resetSearxngHealth();
  await assert.rejects(SX.searxngSearch(sx.base, 'x'), /connection refused|fetch failed|ECONNREFUSED/i);
  assert.equal(SX.searxngHealthy(), false);
  assert.match(SX.searxngState().lastError, /refused|fetch failed/i);
  assert.equal(B.browserStatus().searxng.healthy, false);
  assert.deepEqual(R.engineOrder(null, ['duckduckgo', 'brave']), ['duckduckgo', 'brave'], 'the usual engines take over');
  SX.resetSearxngHealth();
  await B.saveBrowserSettings({ ...B.browserSettings(), searxngUrl: '' });
  assert.deepEqual(R.engineOrder(null, ['duckduckgo']), ['duckduckgo'], 'no address, no SearXNG');
  assert.equal(B.browserStatus().searxng, null);
});

test('SearXNG: Admin → Browser tests a new address before saving it; left out of the form, the saved one stays', async () => {
  await assert.rejects(B.saveBrowserSettings({ ...B.browserSettings(), searxngUrl: 'http://127.0.0.1:9' }, { test: async () => { throw new Error('nothing is listening there'); } }),
    err => err.field === 'searxngUrl' && /^SearXNG: nothing is listening there/.test(err.message));
  assert.equal(B.browserSettings().searxngUrl, '', 'a failing address is not saved');
  let tested = 0;
  const ok = async () => { tested++; return { ok: true }; };
  await B.saveBrowserSettings({ ...B.browserSettings(), searxngUrl: 'http://127.0.0.1:8888/' }, { test: ok });
  assert.equal(B.browserSettings().searxngUrl, 'http://127.0.0.1:8888');
  const { searxngUrl, ...rest } = B.browserSettings();
  await B.saveBrowserSettings({ ...rest, maxPages: 3 }, { test: ok });
  assert.equal(B.browserSettings().searxngUrl, 'http://127.0.0.1:8888', 'kept');
  await B.saveBrowserSettings({ ...B.browserSettings() }, { test: ok });
  assert.equal(tested, 1, 'an unchanged address is not tested again');
  // The real test: a JSON-less instance and a non-SearXNG server are explained.
  const noJson = await stubServer((req, res) => { res.writeHead(403); res.end('Forbidden'); });
  const notSx = await stubServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>hi</html>'); });
  try {
    await assert.rejects(SX.testSearxng(noJson.base), /add “json” to search\.formats/);
    await assert.rejects(SX.testSearxng(notSx.base), /not with JSON/);
  } finally { await noJson.close(); await notSx.close(); }
  await B.saveBrowserSettings({ ...B.browserSettings(), searxngUrl: '' });
});

// ---- Sealed profiles (decision #136) ----------------------------------------------------------------------------------------
const cookie = (name, domain, extra = {}) => ({ name, value: `v-${name}-secretvalue`, domain, path: '/', expires: Math.floor(Date.now() / 1000) + 86400 * 30,
  httpOnly: true, secure: true, sameSite: 'Lax', ...extra });

test('profiles: saved sealed (no cookie value readable on disk), read back; an old plaintext profile is sealed on first read', () => {
  const file = PR.profileFile(ann.id);
  const state = { cookies: [cookie('sessionid', '.example.com')], origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'ls-secret' }] }] };
  assert.equal(PR.saveProfile(file, state), true);
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(secrets.isSealed(disk));
  assert.doesNotMatch(disk, /secretvalue|ls-secret|example\.com/);
  assert.deepEqual(PR.loadProfile(file), state);
  // Plaintext from before sealing: read, then rewritten sealed.
  fs.writeFileSync(file, JSON.stringify(state));
  assert.deepEqual(PR.loadProfile(file), state);
  assert.ok(secrets.isSealed(fs.readFileSync(file, 'utf8')), 'migrated');
  // Tampered or sealed with another key: the browser starts fresh instead of failing.
  const sealed = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, sealed.slice(0, -6) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA') + sealed.slice(-2));
  assert.equal(PR.loadProfile(file), undefined);
  fs.writeFileSync(file, 'not json at all');
  assert.equal(PR.loadProfile(file), undefined);
  assert.equal(PR.loadProfile(path.join(paths.browserProfiles, 'missing.json')), undefined);
  // Search engines' jar is sealed the same way (withPage's profile).
  assert.equal(PR.searchProfileFile(), path.join(paths.browserProfiles, 'search.json'));
});

test('profiles: signed-in sites by registrable domain (sign-in cookies only), and forgetting one removes its cookies and storage', async () => {
  const file = PR.profileFile(ann.id);
  PR.saveProfile(file, { cookies: [
    cookie('sessionid', '.example.com'), cookie('_ga', '.example.com'), cookie('SAPISID', '.google.com'), cookie('NID', '.google.com'),
    cookie('cf_clearance', '.shop.example'), cookie('auth_token', 'news.bbc.co.uk'), cookie('user_session', 'www.bbc.co.uk'),
    cookie('old_session', '.expired.example', { expires: Math.floor(Date.now() / 1000) - 60 }), cookie('connect.sid', 'app.example.net', { expires: -1 }),
  ], origins: [{ origin: 'https://news.bbc.co.uk', localStorage: [{ name: 'a', value: 'b' }] }, { origin: 'https://example.com', localStorage: [] }] });
  const sites = PR.signedInSites(ann.id);
  assert.deepEqual(sites.map(s => s.site), ['bbc.co.uk', 'example.com', 'example.net', 'google.com']);
  assert.deepEqual(sites.find(s => s.site === 'bbc.co.uk'), { site: 'bbc.co.uk', cookies: 2, signIn: 2, expires: sites.find(s => s.site === 'bbc.co.uk').expires });
  assert.equal(sites.find(s => s.site === 'example.net').expires, null, 'a session cookie has no expiry');
  assert.equal(sites.find(s => s.site === 'example.com').signIn, 1, '_ga is not a sign-in');
  assert.ok(PR.signedInSites(ann.id, { all: true }).some(s => s.site === 'shop.example'), 'a bot-check pass is a cookie, not a sign-in');
  assert.ok(!PR.looksSignIn('_ga') && !PR.looksSignIn('cf_clearance') && !PR.looksSignIn('csrftoken') && PR.looksSignIn('li_at') && PR.looksSignIn('__Secure-3PSID'));
  const removed = await S.forgetSite(ann.id, 'https://www.bbc.co.uk/news');
  assert.equal(removed, 3, 'two cookies and one origin’s storage');
  assert.deepEqual(PR.signedInSites(ann.id).map(s => s.site), ['example.com', 'example.net', 'google.com']);
  assert.ok(!PR.loadProfile(file).origins.some(o => o.origin.includes('bbc')));
  await assert.rejects(S.forgetSite(ann.id, 'localhost'), err => err.status === 400);
  assert.equal(await S.forgetSite(ann.id, 'never-visited.example'), 0);
});
