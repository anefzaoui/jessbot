// LLM access through any OpenAI-compatible endpoint (default: OpenRouter + openai/gpt-6-luna).
// Model/base URL live in settings (editable in setup + admin); the key lives only in .env.
import OpenAI from 'openai';
import { config } from '../config/index.js';
import { settings } from '../db/index.js';
import { recordUsage } from './usage.js';
import { invalid } from '../lib/errors.js';
import { boundFetch } from '../lib/outbound.js';
import { readSecret } from './stored-secrets.js';
import { PROVIDERS, currentProvider, providerFor, supports, featureSupport } from './providers.js';

let client, clientKey;

// fallbacks: models tried in order when the main one is down, rate-limited, over its context or refuses (decision #179);
// background: an optional (cheaper) model for JSON jobs (compaction, memory, feed, goals), retried once on the main one.
// The key: the operator's environment wins (never stored); otherwise the key entered in setup or Admin → Model, sealed
// (#10), and only for the address it was entered for (#11: `keyFor`), so switching to another service never sends it the
// old one. Ollama never gets a key: it needs none, and the server may be anyone's on the network.
const originOf = u => { try { return new URL(u).origin; } catch { return ''; } };
export function llmSettings() {
  const s = settings.get('llm', {});
  const baseUrl = s.baseUrl || config.llm.baseUrl;
  const envKey = process.env.OPENROUTER_KEY || process.env.LLM_API_KEY || '';
  const ollama = currentProvider(baseUrl) === 'ollama';
  const storedFits = !s.keyFor || s.keyFor === originOf(baseUrl);
  return {
    baseUrl,
    model: s.model || config.llm.model,
    apiKey: ollama ? '' : envKey || (storedFits ? readSecret('llm.apiKey') : ''),
    keySource: envKey ? 'environment' : 'sealed',
    fallbacks: modelList(s.fallbacks),
    background: String(s.background || '').trim(),
  };
}

/** llmSettings() plus the provider (#11, services/providers.js): provider, needsKey, ready (a key, or none needed). */
export function llmState() {
  const s = llmSettings();
  const provider = currentProvider(s.baseUrl);
  const needsKey = PROVIDERS[provider].needsKey && !(provider === 'compatible' && isLocalUrl(s.baseUrl));
  return { ...s, provider, providerLabel: PROVIDERS[provider].label, needsKey, ready: !!s.apiKey || !needsKey };
}
/** What the provider picker shows (partials/setup/provider-fields.hbs), for setup and Admin → Models. */
export function llmView() {
  const s = llmState();
  return { baseUrl: s.baseUrl, model: s.model, hasKey: !!s.apiKey, maskedKey: maskKey(s.apiKey), keySource: s.keySource,
    provider: s.provider, providerLabel: s.providerLabel, needsKey: s.needsKey, ready: s.ready,
    providers: Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label, summary: p.summary,
      baseUrl: p.id === s.provider ? s.baseUrl : p.baseUrl, needsKey: p.needsKey, features: featureSupport(p.id) })) };
}

/**
 * The provider and address a form sent → { provider, baseUrl, model } or throws invalid() with field errors. An empty
 * address is the provider's own (OpenRouter's, Ollama's on this machine); another service needs one. An empty model is
 * OpenRouter's default there; elsewhere it must be given.
 */
export function providerInput(body = {}) {
  const errors = {};
  let baseUrl = String(body.baseUrl || '').trim();
  const provider = PROVIDERS[body.provider] ? body.provider : providerFor(baseUrl || config.llm.baseUrl);
  if (provider === 'openrouter') baseUrl = PROVIDERS.openrouter.baseUrl; // its features depend on its address
  baseUrl ||= PROVIDERS[provider].baseUrl;
  if (!baseUrl) errors.baseUrl = 'Enter the service’s address.';
  else { try { if (!/^https?:$/.test(new URL(baseUrl).protocol)) throw new Error(); } catch { errors.baseUrl = 'That isn’t a web address.'; } }
  const model = String(body.model || '').trim() || (provider === 'openrouter' ? config.llm.model : '');
  if (!model) errors.model = provider === 'ollama' ? 'Pick one of the models Ollama has.' : 'Enter the model’s name.';
  else if (!MODEL_ID.test(model)) errors.model = 'Use a model id like openai/gpt-6-luna or qwen2.5:7b.';
  if (Object.keys(errors).length) throw invalid(errors);
  return { provider, baseUrl: baseUrl.replace(/\/+$/, ''), model };
}

/** Does the current provider offer this feature (services/providers.js FEATURES)? true only when it surely does. */
export const providerOffers = feature => supports(feature, llmState().provider) === true;
// A server on this machine or the network (LM Studio, a local vLLM): such servers usually take any key or none.
const isLocalUrl = u => { try { return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|host\.docker\.internal)/.test(new URL(u).hostname); } catch { return false; } };

export const MAX_FALLBACKS = 3;
export const MODEL_ID = /^[\w.-]+\/[\w.:-]+$|^[\w.:-]+$/;
/** A list of model ids from text ("a/b, c/d" or one per line) or an array: trimmed, unique, at most MAX_FALLBACKS. */
export const modelList = v => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map(x => String(x).trim()).filter(Boolean))]
  .slice(0, MAX_FALLBACKS);
export const onOpenRouter = (baseUrl = llmSettings().baseUrl) => /openrouter\.ai/i.test(String(baseUrl));

/** The model part of a request. On OpenRouter the fallback chain rides along as `models` (the main model first, then the
 *  fallbacks; for the background model: it, then the main model and its fallbacks), capped at four. Elsewhere just `model`. */
export function modelChoice(model) {
  const s = llmSettings();
  const chain = [...new Set([model, ...(model === s.model ? [] : [s.model]), ...s.fallbacks])].slice(0, MAX_FALLBACKS + 1);
  return onOpenRouter(s.baseUrl) && chain.length > 1 ? { model, models: chain } : { model };
}

/** Which model answered a request for `requested` (the response's `model`) → { model, fallback }. A fallback is a model of
 *  the chain other than the one asked for; anything else (a dated alias of the same model, a server that doesn't say) is
 *  the requested model. */
export function answeredBy(requested, answered) {
  const a = String(answered || '').trim();
  const s = llmSettings();
  const chain = [s.model, ...s.fallbacks].filter(m => m !== requested);
  const hit = a && !a.startsWith(requested) ? chain.find(m => a === m || a.startsWith(`${m}-`) || a.startsWith(`${m}:`)) : null;
  return hit ? { model: hit, fallback: true } : { model: requested, fallback: false };
}

// ---- Prompt caching (decision #202) ---------------------------------------------------------------------------------------
// OpenAI, Gemini, DeepSeek and most others cache a repeated prompt prefix on their own. Anthropic models cache only up to an
// explicit `cache_control` breakpoint (at most four per request; OpenRouter passes them through in the content-array form).
// prompt.js assembles stable → volatile, so two breakpoints cover it: the end of the stable system message (with the tool
// list before it: the same all day) and the end of the conversation before the volatile tail, so the next step of a run and
// the next message read the turns back from the cache. Default 5-minute lifetime: a write costs 1.25× the input price, a read
// 0.1×; OpenRouter keeps a conversation on the provider that holds its cache. Other models get the messages untouched.
// Measured (claude-haiku-4.5 through OpenRouter, 2026-09-26): OpenRouter moves every system message into Anthropic's system
// prompt, which comes before all turns, so a trailing system tail (new every step: it holds the time) changed the prefix of
// every call: 8,302 of 8,308 prompt tokens written to the cache on each call and none ever read. Sent as a user message after
// the turns (labelled as the app's), the second call read 8,278 of 8,316 from the cache.
export const cachesByBreakpoint = model => /^~?anthropic\//.test(String(model || ''));
const EPHEMERAL = Object.freeze({ type: 'ephemeral' });
export const APP_TAIL_LABEL = '(From the app, not written by them: the context for your next reply. Their messages are the ones above.)';

// The content part a breakpoint goes on: the message's last part (a text or a picture), or its text as one part.
const markable = m => (typeof m.content === 'string' ? m.content.trim() !== '' : Array.isArray(m.content) && m.content.length > 0);
function withBreakpoint(m) {
  const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content.map(p => ({ ...p }));
  parts[parts.length - 1] = { ...parts.at(-1), cache_control: EPHEMERAL };
  return { ...m, content: parts };
}

/**
 * The request's messages with Anthropic cache breakpoints when any of `models` (the model asked for, the one that answered
 * last) is an Anthropic model: one on the first system message, one on the last conversation message before the trailing
 * system message (the per-step tail) that has content (an assistant message that only calls tools has none; the one before
 * it is used), and that tail sent as a user message starting with APP_TAIL_LABEL (see above). Otherwise the same array,
 * untouched. Never modifies its input.
 */
export function withPromptCache(messages, models = []) {
  if (!Array.isArray(messages) || !models.some(cachesByBreakpoint)) return messages;
  const out = messages.slice();
  const system = out.findIndex(m => m.role === 'system');
  let end = out.length - 1;
  const tail = end > system && system >= 0 && out[end].role === 'system' && typeof out[end].content === 'string';
  if (tail) {
    out[end] = { role: 'user', content: `${APP_TAIL_LABEL}\n\n${out[end].content}` };
    end--; // rebuilt every step (it holds the time): never cached
  }
  const marks = system >= 0 && markable(out[system]) ? [system] : [];
  for (let i = end; i > Math.max(system, -1); i--) if (markable(out[i])) { marks.push(i); break; }
  for (const i of marks) out[i] = withBreakpoint(out[i]);
  return out;
}

export const maskKey = key => (key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '');

// Request fields only OpenRouter understands (#11). Other services reject them (OpenAI: an unknown argument) or read them
// their own way (Ollama turns `reasoning` into "thinking", which most local models refuse with a 400), so they are taken
// out of the body for every other provider: one place, whatever call made the request.
const OPENROUTER_ONLY = ['reasoning', 'models', 'provider', 'transforms', 'plugins'];
export function withoutOpenRouterFields(f) {
  return (url, init = {}) => {
    if (typeof init.body === 'string' && init.body.startsWith('{')) {
      try {
        const body = JSON.parse(init.body);
        if (OPENROUTER_ONLY.some(k => k in body)) {
          for (const k of OPENROUTER_ONLY) delete body[k];
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch { /* not JSON: sent as it is */ }
    }
    return f(url, init);
  };
}

export function getClient() {
  const { baseUrl, apiKey: key, needsKey, provider } = llmState();
  const apiKey = key || (needsKey ? '' : 'no-key-needed'); // the OpenAI client insists on one
  const cacheKey = `${baseUrl}|${apiKey}|${provider}`;
  if (!client || clientKey !== cacheKey) {
    client = new OpenAI({
      baseURL: baseUrl, apiKey, timeout: 60_000, maxRetries: 2,
      // The admin's provider may be local (Ollama, a LAN box); anything it redirects to is held to the public-only rule (#221).
      fetch: provider === 'openrouter' ? boundFetch({ trustedOrigin: baseUrl }) : withoutOpenRouterFields(boundFetch({ trustedOrigin: baseUrl })),
      defaultHeaders: { 'HTTP-Referer': config.publicUrl, 'X-OpenRouter-Title': 'Jessbot', 'X-Title': 'Jessbot' },
    });
    clientKey = cacheKey;
  }
  return client;
}

/** One model call that must answer in JSON (feed, goals, ideas…). Usage is recorded under `purpose`. background: false keeps
 *  it on the main model (something the person asked for and waits on, like "Improve with AI"). */
export async function askJson(user, system, content, { purpose, maxTokens = 2000, signal, background = true } = {}) {
  return jsonJob({ userId: user?.id ?? null, purpose, maxTokens, signal, background, messages: [{ role: 'system', content: system }, { role: 'user', content }] });
}

/** Raised when a model's JSON answer can't be read (err.code 'bad_json'), after the retry on the main model. */
export class BadJsonError extends Error {
  constructor() { super('The model returned something unreadable — try again.'); this.code = 'bad_json'; }
}

/**
 * A JSON job (decision #179): compaction, memory extraction, the feed, goals, ideas. It runs on the background model when the
 * admin set one (Admin → Models), and a failure there (an error, or JSON that can't be read) gets ONE retry on the main
 * model, so a cheap model can never make these jobs fail silently. Usage records the model that answered.
 * → the parsed object (withMeta: { data, usage, model }, the model that answered); throws the provider's error, or BadJsonError.
 */
export async function jsonJob({ userId = null, runId = null, purpose, messages, maxTokens = 2000, signal, background = true, withMeta = false } = {}) {
  const s = llmSettings();
  const attempt = async model => {
    const res = await getClient().chat.completions.create({
      ...modelChoice(model), max_tokens: maxTokens, response_format: { type: 'json_object' }, reasoning: { effort: 'low' }, messages,
    }, { signal });
    const by = answeredBy(model, res.model);
    recordUsage({ userId, runId, purpose, model: by.model, fallback: by.fallback, usage: res.usage });
    let data;
    try { data = JSON.parse(res.choices?.[0]?.message?.content ?? ''); } catch { throw new BadJsonError(); }
    return withMeta ? { data, usage: res.usage || null, model: by.model } : data;
  };
  const first = background && s.background && s.background !== s.model ? s.background : s.model;
  try {
    return await attempt(first);
  } catch (err) {
    if (first === s.model || signal?.aborted) throw err;
    console.warn(`[llm] ${purpose}: the background model ${first} failed (${String(err.message).slice(0, 120)}); trying the main model once`);
    return attempt(s.model);
  }
}

/**
 * One picture from an image model (decision #169): OpenRouter's images endpoint, POST <base>/images, on the same key.
 * → { data: [{ b64_json, media_type }], usage: { prompt_tokens, completion_tokens, cost } }. inputImages: data: or https:
 * URLs of pictures to work from. Never retried: a timeout may still have made (and billed) the picture.
 */
export function generateImage({ model, prompt, aspectRatio = null, outputFormat = null, inputImages = [], signal } = {}) {
  const body = { model, prompt, n: 1 };
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (outputFormat) body.output_format = outputFormat;
  if (inputImages.length) body.input_references = inputImages.map(url => ({ type: 'image_url', image_url: { url } }));
  return getClient().post('/images', { body, signal, timeout: 180_000, maxRetries: 0 });
}

// Real round-trip used by setup/admin: proves the key, the model id and the endpoint all work.
export async function testConnection({ model } = {}) {
  const s = llmSettings();
  if (!llmState().ready) return { ok: false, error: 'No API key yet.' };
  const started = Date.now();
  try {
    const res = await getClient().chat.completions.create({
      model: model || s.model,
      messages: [
        { role: 'system', content: 'You are a connectivity check. Reply with exactly: Ready.' },
        { role: 'user', content: 'Are you there?' },
      ],
      max_tokens: 200,
      reasoning: { effort: 'minimal' },
    });
    return {
      ok: true, ms: Date.now() - started, model: res.model || model || s.model,
      reply: res.choices?.[0]?.message?.content?.trim() || '(empty reply)',
      cost: res.usage?.cost ?? null, tokens: res.usage?.total_tokens ?? null,
    };
  } catch (err) {
    const status = err.status || err.response?.status;
    const hint = status === 401 ? 'The API key was rejected.'
      : status === 402 ? 'The account is out of credits.'
        : status === 404 ? `The model "${model || s.model}" wasn't found on this endpoint.`
          : status === 429 ? 'Rate limited — try again in a moment.'
            : err.code === 'ENOTFOUND' || err.cause?.code === 'ENOTFOUND' ? "Can't reach the endpoint — check the URL and your internet."
              : err.message;
    return { ok: false, ms: Date.now() - started, error: hint, status };
  }
}

/**
 * Admin → Models save (decision #179): the main model and address are saved (and tested by the caller, as before); the
 * fallback chain (≤ MAX_FALLBACKS ids, text or a list) and the background model only once each NEW one answered its own tiny
 * call. A bad id or a model that doesn't answer → 422 { errors: { fallbacks | background } } with those two left as they were.
 * → the saved llmSettings().
 */
export async function saveModelSettings({ model, baseUrl, provider = undefined, fallbacks = undefined, background = undefined }) {
  const before = llmSettings();
  const cur = settings.get('llm', {}) || {};
  settings.set('llm', { ...cur, baseUrl, model, ...(provider ? { provider } : {}), fallbacks: before.fallbacks.filter(m => m !== model), background: before.background === model ? '' : before.background });
  const errors = {};
  const raw = fallbacks === undefined ? before.fallbacks : (Array.isArray(fallbacks) ? fallbacks : String(fallbacks || '').split(/[\s,]+/)).map(String).filter(Boolean);
  const list = modelList(raw).filter(m => m !== model);
  const bg = background === undefined ? before.background : String(background || '').trim();
  if (raw.length > MAX_FALLBACKS) errors.fallbacks = `At most ${MAX_FALLBACKS} fallback models.`;
  else if (list.some(m => !MODEL_ID.test(m))) errors.fallbacks = 'Use model ids like anthropic/claude-sonnet, separated by commas.';
  if (bg && !MODEL_ID.test(bg)) errors.background = 'Use a model id like openai/gpt-6-mini, or leave it empty.';
  if (!Object.keys(errors).length) {
    const fresh = [...list.filter(m => !before.fallbacks.includes(m)).map(m => ['fallbacks', m]), ...(bg && bg !== before.background && bg !== model ? [['background', bg]] : [])];
    for (const [field, m, t] of await Promise.all(fresh.map(async ([f, m]) => [f, m, await testConnection({ model: m })]))) {
      if (!t.ok) errors[field] = `${errors[field] ? `${errors[field]} ` : ''}${m} didn’t answer: ${t.error}`;
    }
  }
  if (Object.keys(errors).length) throw invalid(errors);
  settings.set('llm', { ...(settings.get('llm', {}) || {}), fallbacks: list, background: bg === model ? '' : bg });
  return llmSettings();
}
