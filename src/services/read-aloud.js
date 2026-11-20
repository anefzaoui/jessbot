// Reading a Library item aloud (decision #142, the Listen button #196): one service for the make_audio tool and the Library
// viewer's Listen, so both check the same budget and length, record the same way (services/voice.js readAloud) and save the
// same audio item. The viewer's Listen runs in the background as a job per item: its progress arrives over the socket
// (`library.listen`) and survives a refresh (GET /api/v1/library/:id/listen reads it back).
import { readAloud, spokenParagraphs, chunkForSpeech, estimateMinutes, pronunciations, MAX_AUDIO_MINUTES } from './voice.js';
import { readText, readContent, textOf, createFileItem, itemView } from './library.js';
import { overBudget } from './policy.js';
import { renderMarkdown } from '../lib/markdown.js';
import { publish } from '../lib/bus.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { botName } from './bot.js';

/** The text an item's read-aloud reads (its own text; a page's visible text). Pictures and audio have none. */
export function textToRead(item) {
  if (item.type === 'image' || item.type === 'audio') throw badRequest(`“${item.title}” has no text to read (it’s ${item.type === 'image' ? 'a picture' : 'audio already'}).`);
  return item.type === 'html' ? textOf('html', readContent(item)) : readText(item);
}

const clock = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/**
 * Record `text` (or an item's text) and save it to the person's Library → { item (the audio item row), view, length ("6:12"),
 * partial, made, parts, stopped, error }. onProgress(i, n) before each part. Throws (400) when there's nothing to read, it's
 * over the length limit, or the week's budget is used up — before anything is spent.
 */
export async function recordAloud(user, { item = null, text = null, title = null, threadId = null, runId = null, project = null, signal, onProgress } = {}) {
  const words = item ? textToRead(item) : String(text || '');
  const name = String(title || item?.title || words.split('\n').find(l => l.trim()) || 'Read aloud').replace(/^#+\s*/, '').trim().slice(0, 100);
  const out = await readAloud(words, { user, runId, project, signal, onProgress });
  const length = clock(out.durationMs);
  const partial = out.made < out.parts;
  const saved = createFileItem({
    user, title: partial ? `${name} (part)` : name, type: 'audio', ext: 'wav', mime: 'audio/wav', buffer: out.wav,
    text: out.script, preview: renderMarkdown(out.script), meta: { durationMs: out.durationMs, peaks: out.peaks, voice: out.voice, parts: out.made },
    description: `Read aloud · ${length}${partial ? ` · ${out.made} of ${out.parts} parts` : ''}`, threadId, runId, sourceLabel: `Read aloud by ${botName()}`,
    sourceItemId: item?.id ?? null,
  });
  return { item: saved, view: itemView(saved), length, partial, made: out.made, parts: out.parts, stopped: out.stopped, error: out.error || null };
}

/** What listening to an item would take, before anything is recorded → { minutes, minutesLabel, parts, limit, tooLong,
 *  overBudget }. Nothing is spent. */
export function listenEstimate(user, item) {
  const paragraphs = spokenParagraphs(textToRead(item), { names: pronunciations() });
  const words = paragraphs.join(' ');
  if (!words) throw badRequest('There’s nothing in it to read out: it’s all code, tables or images.');
  const minutes = estimateMinutes(words);
  return { minutes: Math.max(1, Math.round(minutes)), minutesLabel: minutes < 1.5 ? 'about a minute' : `about ${Math.round(minutes)} minutes`,
    parts: chunkForSpeech(paragraphs).length, limit: MAX_AUDIO_MINUTES, tooLong: minutes > MAX_AUDIO_MINUTES, overBudget: overBudget(user) };
}

// ---- The viewer's Listen: one background job per item --------------------------------------------------------------------
const jobs = new Map(); // `${userId}:${publicId}` → job
const KEEP_MS = 30 * 60e3; // a finished job is shown for half an hour, then the audio item speaks for itself
const keyOf = (user, item) => `${user.id}:${item.public_id}`;

/** The item's Listen job for this person: { status: recording|done|failed, part, parts, startedAt, audio?, partial?, error? } or null. */
export function listenJob(user, item) {
  const j = jobs.get(keyOf(user, item));
  if (j && j.status !== 'recording' && Date.now() - j.endedAt > KEEP_MS) { jobs.delete(keyOf(user, item)); return null; }
  return j ? { ...j } : null;
}

/**
 * Start recording an item for its owner → the job (202). Refused before anything runs: 409 while one is recording, 400 when
 * it's too long or the budget is used up (the estimate says so first). record: recordAloud (tests pass a fake).
 */
export function startListen(user, item, { record = recordAloud } = {}) {
  const key = keyOf(user, item);
  if (jobs.get(key)?.status === 'recording') throw new HttpError(409, 'It’s already being recorded: the progress is on its page.');
  const est = listenEstimate(user, item);
  if (est.tooLong) throw badRequest(`That’s ${est.minutesLabel} of listening; the limit is ${est.limit}. Ask me in the chat to read one part (a chapter or a section).`);
  if (est.overBudget) throw badRequest('This week’s budget is used up, so nothing can be recorded now. It resets on Monday.');
  const job = { status: 'recording', part: 0, parts: est.parts, minutesLabel: est.minutesLabel, startedAt: new Date().toISOString() };
  jobs.set(key, job);
  const tell = () => publish(user.id, 'library.listen', { id: item.public_id, job: { ...job } });
  (async () => {
    try {
      const out = await record(user, { item, onProgress: (i, n) => { job.part = i; job.parts = n; tell(); } });
      Object.assign(job, { status: 'done', endedAt: Date.now(), partial: out.partial, audio: { id: out.view.id, href: out.view.href, title: out.view.title, length: out.length } });
      publish(user.id, 'library.created', { item: out.view });
    } catch (err) {
      Object.assign(job, { status: 'failed', endedAt: Date.now(), error: String(err.message || err).split('\n')[0].slice(0, 300) });
    }
    tell();
  })();
  return { ...job };
}

export const resetListenJobs = () => jobs.clear(); // tests
