// Embeddings behind one small interface (docs/CONTEXT-AND-MEMORY.md, decision #95): OpenRouter's
// openai/text-embedding-3-small at 512 dimensions by default (verified 2026-09-25: ~0.6 s, $0.02 per million tokens).
// Vectors are normalised Float32, so cosine = dot product. If embeddings fail, callers fall back to word search (BM25);
// a failure pauses embedding calls for a few minutes instead of failing every search.
import { settings } from '../db/index.js';
import { getClient, llmState } from './llm.js';
import { PROVIDERS } from './providers.js';
import { recordUsage } from './usage.js';

// The model: the admin's setting, JESSBOT_EMBED_MODEL, else the provider's usual one (#11; none for an unknown service:
// memories are then found by their words).
export const embedModel = () => ({
  model: settings.get('embeddings', {})?.model || process.env.JESSBOT_EMBED_MODEL || PROVIDERS[llmState().provider].embedModel,
  dims: Number(settings.get('embeddings', {})?.dims || process.env.JESSBOT_EMBED_DIMS || 512),
});

let pausedUntil = 0;
const BATCH = 64;

/** texts → normalised Float32Array[] (same order), or null when embeddings are unavailable right now. */
export async function embed(texts, { userId = null, signal } = {}) {
  if (!texts.length) return [];
  if (Date.now() < pausedUntil || process.env.JESSBOT_EMBED_OFF === '1') return null; // tests run offline
  const { model, dims } = embedModel();
  if (!model) return null;
  const out = [];
  try {
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map(t => String(t).slice(0, 8000));
      const res = await getClient().embeddings.create({ model, input: batch, dimensions: dims }, { signal });
      recordUsage({ userId, purpose: 'embed', model, usage: { prompt_tokens: res.usage?.prompt_tokens || 0, completion_tokens: 0, cost: res.usage?.cost } });
      for (const d of res.data.sort((a, b) => a.index - b.index)) out.push(normalise(Float32Array.from(d.embedding)));
    }
    return out;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    pausedUntil = Date.now() + 5 * 60e3;
    console.warn('[embed] unavailable for 5 min:', err.status || '', String(err.message).slice(0, 160));
    return null;
  }
}

function normalise(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
export const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
export const toBlob = v => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = buf => new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
export const __test = { resume: () => { pausedUntil = 0; }, normalise };
