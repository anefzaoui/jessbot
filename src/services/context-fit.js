// Does Jessbot's prompt fit the model's context window? (#69, decision #252)
// Ollama loads a model with a context window the SERVER sets (OLLAMA_CONTEXT_LENGTH, a Modelfile's num_ctx, or a default
// of 4,096 tokens on most graphics cards) and silently drops the start of a longer prompt. Jessbot's prompt with its tool
// list is about 25,000 tokens, so with the default the model never sees its instructions or most tools, calls tools at
// random and replies "…", while the connection test (a tiny prompt) still passes. Ollama's OpenAI-compatible endpoint,
// the one Jessbot talks to, ignores a per-request num_ctx (measured, see the decision), so the fix is on the server
// (docs/guide/providers.md); Jessbot measures and says so instead of failing quietly:
//   - the connection test (setup, Admin → Models) reads the context Ollama loaded the model with (/api/ps, right after the
//     test call loaded it; else a Modelfile's num_ctx from /api/show) and compares it with this person's own prompt;
//   - before each model call of a run, a known context smaller than the request stops the run with a plain message;
//   - after each call, an Ollama that reports far fewer prompt tokens than were sent (a cut prompt) stops the run before
//     any tool it asked for runs;
//   - compaction aims below a small known context (services/context.js).
import { countTokens, rawMessageTokens, IMAGE_TOKENS } from '../lib/tokens.js';
import { outboundFetch } from '../lib/outbound.js';
import { llmState } from './llm.js';
import { buildPrompt } from '../agent/prompt.js';
import { toolSchemasFor } from '../agent/tools/registry.js';
import { enabledToolsets } from './policy.js';

/** The context the guide advises for Ollama (OLLAMA_CONTEXT_LENGTH=32768). */
export const ADVISED_CONTEXT = 32_768;
/** Room kept for the reply: a prompt that fills the window leaves the model nothing to answer with. */
export const REPLY_ROOM = 2_048;
// A provider's prompt count below this share of what was sent means the prompt was cut. Tokenizers differ from o200k by
// well under a factor of two (calibrate() in lib/tokens.js ignores ratios outside 0.5–2 for the same reason); a cut
// prompt reads far lower (Ollama with 4,096: 2,050 of 24,599).
const CUT_RATIO = 0.5;
const CUT_MIN = 4_000; // a short request can't tell a cut from a different tokenizer

/** What the admin sets on the Ollama server: one line, the same in the UI, the run's error and the log. */
export const OLLAMA_ADVICE = `Set OLLAMA_CONTEXT_LENGTH=${ADVISED_CONTEXT} where Ollama runs and restart it; on a graphics card with 8 GB also `
  + 'OLLAMA_FLASH_ATTENTION=1 and OLLAMA_KV_CACHE_TYPE=q8_0 so it still fits (docs/guide/providers.md).';

const imageCount = messages => messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(p => p?.type === 'image_url').length : 0), 0);

/** The tokens a request sends (o200k, uncalibrated): its messages and its tool list. Pictures count as IMAGE_TOKENS. */
export function requestTokens(messages, tools = []) {
  return rawMessageTokens(messages) + (tools?.length ? countTokens(JSON.stringify(tools)) : 0);
}
/** The same without pictures: what a provider's prompt count is compared with (a local model counts pictures its own way). */
export const textTokens = (messages, tools = []) => requestTokens(messages, tools) - IMAGE_TOKENS * imageCount(messages);

/** The size of this person's prompt at the start of a new chat: instructions, skills, memory blocks and the tool list. */
export function promptTokensFor(user) {
  const { messages } = buildPrompt({ user, thread: { id: 0 } });
  return requestTokens(messages, toolSchemasFor(user, { toolsets: enabledToolsets(user) }));
}

// ---- What Ollama says --------------------------------------------------------------------------------------------------
const cache = new Map(); // `${origin}|${model}` → { context, trained, source, at }
const KNOWN_FOR = 60_000;
const keyOf = (origin, model) => `${origin}|${model}`;
const sameModel = (a, b) => a === b || a === `${b}:latest` || `${a}:latest` === b;

async function ollamaJson(root, path, body) {
  const res = await outboundFetch(`${root}${path}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }, { trustedOrigin: root }); // the admin's own address
  if (!res.ok) throw new Error(`Ollama answered ${res.status} at ${path}.`);
  return res.json();
}

/**
 * The context window Ollama uses for a model → { context, trained, source } (numbers or null):
 *   context: what it loaded the model with (/api/ps: `context_length` of the running model), else a Modelfile's num_ctx
 *            (/api/show `parameters`); null when neither says (the model isn't loaded and the server's default applies,
 *            which no API reports).
 *   trained: the most the model was trained for (/api/show `model_info`, `<arch>.context_length`).
 *   source:  'loaded' | 'modelfile' | null.
 * Never throws: an Ollama that doesn't answer gives nulls. A known answer is kept for a minute (it is read before every
 * step of a run); `fresh` reads it again.
 */
export async function ollamaContext(baseUrl, model, { fresh = false } = {}) {
  let root;
  try { root = new URL(String(baseUrl)).origin; } catch { return { context: null, trained: null, source: null }; }
  const key = keyOf(root, model);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < KNOWN_FOR) return hit;
  const [ps, show] = await Promise.all([
    ollamaJson(root, '/api/ps').catch(() => null),
    ollamaJson(root, '/api/show', { model }).catch(() => null),
  ]);
  const running = (ps?.models || []).find(m => sameModel(m.name, model) || sameModel(m.model, model));
  const loaded = Number(running?.context_length) || null;
  const modelfile = Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(String(show?.parameters || ''))?.[1]) || null;
  const trainedKey = Object.keys(show?.model_info || {}).find(k => k.endsWith('.context_length'));
  const out = { context: loaded || modelfile, trained: Number(show?.model_info?.[trainedKey]) || null,
    source: loaded ? 'loaded' : modelfile ? 'modelfile' : null, at: Date.now() };
  if (out.context) cache.set(key, out); else cache.delete(key); // unknown: asked again next time (the model may load)
  return out;
}

/** The last known context of the model in use (a sync read of the cache, for compaction), else null. */
export function knownContext() {
  const s = llmState();
  if (s.provider !== 'ollama') return null;
  let root;
  try { root = new URL(s.baseUrl).origin; } catch { return null; }
  return cache.get(keyOf(root, s.model))?.context || null;
}
/** Forget what was read (after a cut prompt: the server may have been restarted with another setting). */
export const forgetContext = () => cache.clear();

/** The context of the model in use, when the provider reports one (Ollama), else null (OpenRouter and other services
 *  answer a request that is too long with an error instead of cutting it). */
export async function currentContext({ fresh = false } = {}) {
  const s = llmState();
  if (s.provider !== 'ollama') return null;
  return (await ollamaContext(s.baseUrl, s.model, { fresh })).context;
}

// ---- The checks ---------------------------------------------------------------------------------------------------------
const thousands = n => Number(n).toLocaleString('en-US');

/** Too small for `tokens` (plus room for the reply)? → null when it fits or the context is unknown, else
 *  { context, tokens, message } with a message for the person and the log. */
export function fitOf(tokens, context) {
  if (!context || !tokens || tokens + REPLY_ROOM <= context) return null;
  return { context, tokens, message: `The model’s context window is too small for my instructions: Ollama gives it ${thousands(context)} tokens `
    + `and this needs about ${thousands(tokens + REPLY_ROOM)}, so it would only see part of them. The admin can fix it on the Ollama server `
    + `(OLLAMA_CONTEXT_LENGTH=${ADVISED_CONTEXT}; see the guide’s page on model providers), then press Retry.` };
}

/** Was the prompt cut? The provider's own count (`reported`) far below what was sent (`sent`, textTokens). */
export const promptWasCut = ({ sent, reported }) => !!reported && sent >= CUT_MIN && reported < sent * CUT_RATIO;
export function cutMessage({ sent, reported }) {
  return `The model only read ${thousands(reported)} of the about ${thousands(sent)} tokens I sent: its context window is too small, so it `
    + `lost my instructions and I stopped before acting on its answer. The admin can fix it on the Ollama server `
    + `(OLLAMA_CONTEXT_LENGTH=${ADVISED_CONTEXT}; see the guide’s page on model providers), then press Retry.`;
}

/**
 * For the connection test (setup, Admin → Models), right after its call loaded the model: the context Ollama gave it and
 * this person's prompt → null for another provider, else { context, trained, source, tokens, fits, advised, warning }.
 * `warning` (a plain sentence, or null) says what to set when the context is too small, or below the advised size, or
 * unknown.
 */
export async function connectionFit(user) {
  const s = llmState();
  if (s.provider !== 'ollama') return null;
  const ctx = await ollamaContext(s.baseUrl, s.model, { fresh: true });
  const tokens = user ? promptTokensFor(user) : null;
  const need = tokens ? tokens + REPLY_ROOM : ADVISED_CONTEXT;
  const fits = ctx.context ? ctx.context >= need : null;
  let warning = null;
  if (ctx.context && !fits) {
    warning = `Ollama runs ${s.model} with a context of ${thousands(ctx.context)} tokens, but Jessbot’s instructions and tools need about `
      + `${thousands(need)}: it would see only part of them and act at random. ${OLLAMA_ADVICE}`;
  } else if (ctx.context && ctx.context < ADVISED_CONTEXT) {
    warning = `Ollama runs ${s.model} with a context of ${thousands(ctx.context)} tokens: enough for a new chat, not for a long one. ${OLLAMA_ADVICE}`;
  } else if (!ctx.context) {
    warning = `Ollama didn’t say how much context it gives ${s.model}. Its default (4,096 tokens on most graphics cards) is far too small for `
      + `Jessbot. ${OLLAMA_ADVICE}`;
  }
  if (ctx.trained && need > ctx.trained) {
    warning = `${s.model} was trained for ${thousands(ctx.trained)} tokens of context, and Jessbot’s instructions and tools need about `
      + `${thousands(need)}. Pick a model with a longer context (qwen2.5, llama3.1 and most current models have 32,768 or more).`;
  }
  if (warning) console.warn(`[llm] context: ${warning}`);
  return { context: ctx.context, trained: ctx.trained, source: ctx.source, tokens, fits, advised: ADVISED_CONTEXT, warning };
}
