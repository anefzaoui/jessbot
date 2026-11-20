// Subtitle / caption files (.srt, .vtt) → a readable transcript (decision #142). Shared by uploads (meeting transcripts from
// Zoom, Teams, Meet) and any reader of video captions (e.g. a YouTube reader): cue numbers and timings go, markup goes
// (<v Speaker>, <c>, <i>, karaoke timestamps, {\an8}), the rolling captions of auto-subtitles are de-duplicated (each cue
// repeats the tail of the last one), and consecutive lines of one speaker become one paragraph. Pure functions.

const TIMING = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const secs = (h, m, s, ms) => Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + Number(String(ms).padEnd(3, '0')) / 1000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

/** Does this text look like SRT or WebVTT? */
export const looksLikeCaptions = text => /^\s*WEBVTT/.test(String(text || '')) || TIMING.test(String(text || '').split(/\r?\n/).slice(0, 12).find(l => l.includes('-->')) || '');

/**
 * Parse cues → [{ start, end, speaker, text }] (seconds; speaker from <v Name>, else null). NOTE / STYLE / REGION blocks
 * and the WEBVTT header are skipped.
 */
export function parseCues(input) {
  const blocks = String(input || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    const i = lines.findIndex(l => TIMING.test(l.trim()));
    if (i < 0) continue; // header, NOTE, STYLE, REGION, stray text
    const t = TIMING.exec(lines[i].trim());
    let speaker = null;
    const text = lines.slice(i + 1).map(l => {
      const v = /<v(?:\.[^\s>]+)?\s+([^>]+)>/i.exec(l);
      if (v) speaker = v[1].trim();
      return decode(l.replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '').replace(/<\/?[a-z][^>]*>/gi, '').replace(/\{\\[^}]*\}/g, ''))
        .replace(/\s+/g, ' ').trim();
    }).filter(Boolean).join(' ').trim();
    if (text) cues.push({ start: secs(t[1], t[2], t[3], t[4]), end: secs(t[5], t[6], t[7], t[8]), speaker, text });
  }
  return cues;
}

// A leading "Name: " as a speaker label, when the same label starts several cues (Zoom writes "Alex Rivera: hello").
const LABEL = /^([\p{L}][\p{L}\p{M}\p{N} .'’-]{0,40}?):\s+(.+)$/u;
function labelSpeakers(cues) {
  const counts = new Map();
  for (const c of cues) { const m = !c.speaker && LABEL.exec(c.text); if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1); }
  const labels = new Set([...counts].filter(([, n]) => n >= 2).map(([k]) => k));
  return cues.map(c => {
    const m = !c.speaker && LABEL.exec(c.text);
    return m && labels.has(m[1]) ? { ...c, speaker: m[1], text: m[2] } : c;
  });
}

// The words `next` adds after `prev`: the longest tail of prev that `next` starts with is dropped (rolling captions).
const words = s => s.split(/\s+/).filter(Boolean);
const norm = w => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function newPart(prevWords, next) {
  const nw = words(next);
  const max = Math.min(prevWords.length, nw.length);
  for (let k = max; k > 0; k--) {
    let same = true;
    for (let j = 0; j < k; j++) if (norm(prevWords[prevWords.length - k + j]) !== norm(nw[j])) { same = false; break; }
    if (same) return nw.slice(k);
  }
  return nw;
}

const stamp = s => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60); return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`; };

/**
 * Cues → paragraphs [{ start, end, speaker, text }]: one per speaker turn; a long silence (gapSec) or a long paragraph
 * (maxChars, cut after a sentence) also starts a new one; maxSec caps a paragraph's span (a video transcript in ~30 s
 * blocks, each with its time). input: SRT/VTT text, or cues [{ start, end, speaker, text }] in seconds.
 */
export function transcriptParagraphs(input, { gapSec = 6, maxChars = 900, maxSec = Infinity } = {}) {
  const cues = labelSpeakers(typeof input === 'string' ? parseCues(input) : input);
  const paras = [];
  let cur = null, tail = [];
  for (const c of cues) {
    const speakerChange = c.speaker && c.speaker !== cur?.speaker;
    const turn = /^(>>|-\s)/.test(c.text); // ">>" / "- " mark a new speaker in broadcast and film captions
    const text = c.text.replace(/^(>>|-)\s*/, '');
    const add = cur && !speakerChange && !turn ? newPart(tail, text) : words(text);
    if (!add.length) { if (cur) cur.end = Math.max(cur.end, c.end); continue; }
    const long = cur && cur.text.length > maxChars && /[.!?…؟]$/.test(cur.text);
    if (!cur || speakerChange || turn || c.start - cur.end > gapSec || long || c.start - cur.start >= maxSec) {
      cur = { start: c.start, end: c.end, speaker: c.speaker || (turn ? null : cur?.speaker ?? null), text: add.join(' ') };
      paras.push(cur);
    } else {
      cur.text += ` ${add.join(' ')}`;
      cur.end = Math.max(cur.end, c.end);
    }
    tail = words(text).slice(-30);
  }
  return paras;
}

/** SRT / VTT text (or cues) → a readable transcript. timestamps: start each paragraph with [m:ss]. */
export function captionsToText(input, { timestamps = false, gapSec, maxChars, maxSec } = {}) {
  return transcriptParagraphs(input, { gapSec, maxChars, maxSec })
    .map(p => `${timestamps ? `[${stamp(p.start)}] ` : ''}${p.speaker ? `${p.speaker}: ` : ''}${p.text}`).join('\n\n');
}

/** { cues, minutes, speakers } for a one-line description ("Transcript · 42 min · 3 speakers"). */
export function captionStats(input) {
  const cues = labelSpeakers(parseCues(input));
  const end = cues.reduce((a, c) => Math.max(a, c.end), 0);
  return { cues: cues.length, minutes: Math.round(end / 60), speakers: new Set(cues.map(c => c.speaker).filter(Boolean)).size };
}
