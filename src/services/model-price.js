// What a model call will cost, before it is made (decision #163: OCR shows its cost before it spends anything).
// OpenRouter publishes every model's price at GET <base>/models ({ data: [{ id, pricing: { prompt, completion, image } }] },
// USD per token and per image, as strings); it is read once a day per endpoint, with a short timeout. When that isn't
// available (another OpenAI-compatible endpoint, offline), the price is inferred from what this model actually cost here
// over the last 30 days (usage_events: dollars per token, prompt and completion blended). Neither → null: say it's unknown.
import { get } from '../db/index.js';
import { llmSettings } from './llm.js';

const DAY_MS = 864e5;
const lists = new Map(); // baseUrl → { at, models: Map id → pricing, params: Map id → supported_parameters } (a failed fetch: 10 minutes)

async function modelList(baseUrl) {
  const hit = lists.get(baseUrl);
  if (hit && Date.now() - hit.at < (hit.models ? DAY_MS : 10 * 60e3)) return hit;
  let models = null, params = null;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (res.ok) {
      const body = await res.json();
      const data = Array.isArray(body?.data) ? body.data : [];
      models = new Map(data.filter(m => m?.id && m.pricing).map(m => [m.id, m.pricing]));
      params = new Map(data.filter(m => m?.id && Array.isArray(m.supported_parameters)).map(m => [m.id, m.supported_parameters]));
      if (!models.size) models = params = null;
    }
  } catch { /* offline, or not an endpoint that lists prices */ }
  const entry = { at: Date.now(), models, params };
  lists.set(baseUrl, entry);
  return entry;
}
const priceList = async baseUrl => (await modelList(baseUrl)).models;

/** Does the endpoint say this model takes a reasoning effort (OpenRouter's supported_parameters has "reasoning")? true / false,
 *  or null when it can't tell (another endpoint, offline). The per-message effort (decision #177) is only sent when true. */
export async function supportsReasoning(model = llmSettings().model, { baseUrl = llmSettings().baseUrl } = {}) {
  const list = (await modelList(baseUrl)).params?.get(model);
  return list ? list.includes('reasoning') : null;
}

const num = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

/**
 * Dollars per unit for a model → { prompt, completion, image, source: 'list' | 'history' } or null.
 * prompt / completion: per token; image: per image (0 when the model charges images as tokens).
 */
export async function modelPrice(model = llmSettings().model, { baseUrl = llmSettings().baseUrl } = {}) {
  const listed = (await priceList(baseUrl))?.get(model);
  if (listed) return { prompt: num(listed.prompt), completion: num(listed.completion), image: num(listed.image), source: 'list' };
  const h = get(`SELECT COALESCE(SUM(cost), 0) AS c, COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t FROM usage_events
    WHERE model = ? AND cost > 0 AND at >= date('now', '-29 days')`, model);
  if (h.t > 0 && h.c > 0) { const per = h.c / h.t; return { prompt: per, completion: per, image: 0, source: 'history' }; }
  return null;
}

/** Estimated dollars for { promptTokens, completionTokens, images } at a price (null when the price is unknown). */
export const estimateCost = (price, { promptTokens = 0, completionTokens = 0, images = 0 } = {}) =>
  (price ? promptTokens * price.prompt + completionTokens * price.completion + images * price.image : null);

/** "$0.004" / "$0.012" / "$0.01" / "$1.20": amounts under 10 cents keep a third decimal when it says something. */
export function dollars(v) {
  if (v == null) return 'unknown';
  const n = Number(v);
  return `$${n >= 0.1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3).replace(/0$/, '') : n.toFixed(3)}`;
}

/** Forget the fetched price lists (tests). */
export const resetPrices = () => lists.clear();
