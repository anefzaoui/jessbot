// YouTube videos in web_read (decision #135): the video's own captions as a transcript, never the media. In the page:
// ytInitialPlayerResponse gives the title, channel, length, description and the caption tracks. The person's language is
// preferred, a track written by people over the automatic one. YouTube's caption URLs now want a proof-of-origin token that
// only its own player makes, so when the plain fetch comes back empty the transcript panel is opened (a normal page action):
// its request carries the token, which then fetches the chosen track as json3. Last resort: the panel's own lines.
// The transcript is made by lib/captions.js (shared with uploaded caption files): rolling automatic lines deduplicated,
// ~30 s paragraphs with [m:ss] stamps. The parsing below is pure (fixtures in tests/fixtures/web); readYouTube() is the
// thin browser part.

import { captionsToText } from '../../lib/captions.js';

const ID = /^[A-Za-z0-9_-]{11}$/;

/** The 11-character video id of a watch / youtu.be / shorts / live / embed URL, or null. */
export function videoIdOf(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = (/^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(u.pathname) || [])[1];
  }
  return id && ID.test(id) ? id : null;
}
export const watchUrl = id => `https://www.youtube.com/watch?v=${id}`;

const base = code => String(code || '').toLowerCase().split(/[-_]/)[0];

/**
 * The caption track to read. tracks: [{ languageCode, kind ('asr' = automatic), name }]. In order: the person's language
 * written by people, then automatic; then the spoken language's own tracks (the automatic track's language is what is
 * spoken); then anything written by people; then anything.
 */
export function pickTrack(tracks = [], lang = 'en') {
  if (!tracks.length) return null;
  const want = base(lang) || 'en';
  const spoken = base(tracks.find(t => t.kind === 'asr')?.languageCode);
  const score = t => {
    const l = base(t.languageCode), manual = t.kind !== 'asr';
    if (l === want) return manual ? 6 : 5;
    if (spoken && l === spoken) return manual ? 4 : 3;
    return manual ? 2 : 1;
  };
  return [...tracks].sort((a, b) => score(b) - score(a))[0];
}

/** json3 caption text → cues [{ start, end, speaker, text }] in seconds (lib/captions.js's cue shape; appended line-break events dropped). */
export function parseJson3(text) {
  let j;
  try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch { return []; }
  return (j?.events || []).filter(e => e.segs && !e.aAppend).map(e => {
    const start = (Number(e.tStartMs) || 0) / 1000;
    return { start, end: start + (Number(e.dDurationMs) || 0) / 1000, speaker: null, text: e.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim() };
  }).filter(c => c.text);
}

/**
 * The transcript panel's lines, as the page shows them ("0:18", or "0:18 18 seconds", then the words) → cues (seconds).
 * The last resort when no caption file could be fetched.
 */
export function parsePanelLines(lines = []) {
  const cues = [];
  for (const raw of lines) {
    const m = /^\s*(\d{1,2}(?::\d{2}){1,2})\s+(?:(?:\d+\s+(?:hours?|minutes?|seconds?),?\s*)+)?([\s\S]*)$/i.exec(String(raw).replace(/\s+/g, ' '));
    if (!m || !m[2].trim()) continue;
    const start = m[1].split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
    cues.push({ start, end: start, speaker: null, text: m[2].trim() });
  }
  return cues;
}

// The transcript itself: lib/captions.js (shared with uploaded .srt/.vtt files) drops the words each rolling automatic cue
// repeats from the one before, and makes paragraphs — here capped at ~30 s, each starting with its [m:ss].
export const PARAGRAPH_SEC = 30;
export const transcriptText = cues => captionsToText(cues, { timestamps: true, maxSec: PARAGRAPH_SEC });

const count = n => (n == null || n === '' ? null : Number(n).toLocaleString('en-US'));
const duration = s => { const n = Math.round(Number(s) || 0); if (!n) return null; const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), x = String(n % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };

/**
 * The web_read document for a video. meta: { id, title, channel, lengthSeconds, viewCount, description, published,
 * live, tracks }, track: the one read (or null), cues: its cues (seconds), via: how they were read.
 */
export function renderVideo({ meta, track = null, cues = [], via = null }) {
  const url = watchUrl(meta.id);
  const facts = [meta.channel && `Video by ${meta.channel}`, duration(meta.lengthSeconds), meta.viewCount && `${count(meta.viewCount)} views`,
    meta.live && 'live stream'].filter(Boolean).join(' · ');
  const others = (meta.tracks || []).filter(t => t !== track).map(t => t.name || t.languageCode).filter(Boolean);
  const lines = [facts];
  let transcript;
  if (!meta.tracks?.length) {
    transcript = 'This video has no captions, so there is no transcript to read — only the title and description above. Say so rather than guessing what is said in it.';
  } else if (!cues.length) {
    transcript = `The video has captions (${(meta.tracks || []).map(t => t.name || t.languageCode).join(', ')}), but YouTube didn’t hand them over this time. Say so; don’t guess what is said.`;
  } else {
    const from = track ? `the ${track.kind === 'asr' ? 'automatic' : 'written'} captions (${track.name || track.languageCode})` : 'YouTube’s transcript panel';
    lines.push(`Transcript from ${from}${others.length ? `; also available: ${others.slice(0, 8).join(', ')}` : ''}.`
      + `${!track || track.kind === 'asr' ? ' Automatic captions can mishear names and numbers.' : ''}`);
    transcript = transcriptText(cues);
  }
  const desc = String(meta.description || '').trim();
  const markdown = [...lines, '', '## Description', desc ? (desc.length > 2000 ? `${desc.slice(0, 1999)}…` : desc) : '(No description.)', '',
    '## Transcript', transcript].join('\n');
  return { url, title: meta.title || `YouTube video ${meta.id}`, siteName: 'YouTube', byline: meta.channel || null, published: meta.published || null,
    modified: null, markdown, contentType: 'video', video: { id: meta.id, captions: (meta.tracks || []).length, read: track ? { lang: track.languageCode, auto: track.kind === 'asr' } : null, lines: cues.length, via } };
}

/** The parts of ytInitialPlayerResponse we use (a JSON-safe subset) → meta for renderVideo. Pure. */
export function videoMeta(pr, id) {
  const d = pr?.videoDetails || {};
  const mf = pr?.microformat?.playerMicroformatRenderer || {};
  const tracks = (pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).map(t => ({
    baseUrl: t.baseUrl, languageCode: t.languageCode, kind: t.kind || null,
    name: t.name?.simpleText || t.name?.runs?.map(r => r.text).join('') || t.languageCode,
  }));
  return { id: d.videoId || id, title: d.title || mf.title?.simpleText || null, channel: d.author || mf.ownerChannelName || null,
    lengthSeconds: d.lengthSeconds || mf.lengthSeconds || null, viewCount: d.viewCount || mf.viewCount || null,
    description: d.shortDescription ?? mf.description?.simpleText ?? '', published: mf.publishDate || mf.uploadDate || null,
    live: !!d.isLiveContent, playable: pr?.playabilityStatus?.status || null, tracks };
}

// ---- The browser part -----------------------------------------------------------------------------------------------------
const PANEL_SEGMENTS = 'ytd-transcript-segment-renderer, transcript-segment-view-model';

async function fetchTrackText(page, track, pot) {
  const url = `${track.baseUrl}&fmt=json3${pot ? `&potc=1&pot=${encodeURIComponent(pot)}&c=WEB` : ''}`;
  return page.evaluate(async u => { try { const r = await fetch(u, { credentials: 'include' }); return r.ok ? await r.text() : ''; } catch { return ''; } }, url);
}

/** Open the description's "Show transcript" panel (a person's click) → the proof-of-origin token its request carried. */
async function openTranscriptPanel(page, tokenOf) {
  await page.locator('#description-inline-expander #expand, tp-yt-paper-button#expand').first().click({ timeout: 6000 }).catch(() => {});
  await page.locator('ytd-video-description-transcript-section-renderer button, button[aria-label*="transcript" i]').first().click({ timeout: 6000 }).catch(() => {});
  for (let i = 0; i < 30 && !tokenOf(); i++) await page.waitForTimeout(300);
  return tokenOf();
}

/**
 * Read a video page. withPage: browser/index.js withPage; lang: the person's language (ISO code). Throws when the page
 * isn't a readable video page (read.js then falls back to the generic reader).
 */
export async function readYouTube(url, { withPage, signal, lang = 'en', dismissConsent }) {
  const id = videoIdOf(url);
  if (!id) throw new Error('not a YouTube video address');
  return withPage(async page => {
    let pot = null;
    page.on('request', r => {
      const m = /\/api\/timedtext\?[^#]*[?&]pot=([^&]+)/.exec(r.url());
      if (m) pot = decodeURIComponent(m[1]);
    });
    await page.goto(watchUrl(id), { waitUntil: 'domcontentloaded', timeout: 30000 });
    // The EU consent screen comes first on a fresh browser: decline, and YouTube sends us on to the video.
    if (/^consent\./.test(new URL(page.url()).hostname) && dismissConsent) {
      await dismissConsent(page);
      await page.waitForURL(u => !/^consent\./.test(u.hostname), { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
    const pr = await page.evaluate(() => {
      const p = window.ytInitialPlayerResponse;
      return p ? JSON.parse(JSON.stringify({ videoDetails: p.videoDetails, microformat: p.microformat, captions: p.captions, playabilityStatus: { status: p.playabilityStatus?.status } })) : null;
    }).catch(() => null);
    if (!pr?.videoDetails) throw new Error('the video page had no player data');
    const meta = videoMeta(pr, id);
    const track = pickTrack(meta.tracks, lang);
    let cues = [], via = null;
    if (track) {
      cues = parseJson3(await fetchTrackText(page, track, null));
      if (cues.length) via = 'captions';
      if (!cues.length) {
        const token = await openTranscriptPanel(page, () => pot);
        if (token) { cues = parseJson3(await fetchTrackText(page, track, token)); if (cues.length) via = 'captions (with the player’s token)'; }
        if (!cues.length) {
          await page.waitForSelector(PANEL_SEGMENTS, { timeout: 8000 }).catch(() => {});
          const lines = await page.evaluate(sel => [...document.querySelectorAll(sel)].map(s => s.innerText), PANEL_SEGMENTS).catch(() => []);
          cues = parsePanelLines(lines);
          if (cues.length) via = 'transcript panel';
        }
      }
    }
    // The track actually read, when the panel had to be used (it shows the video's default track).
    return renderVideo({ meta, track: via === 'transcript panel' ? null : track, cues, via });
  }, { signal });
}
