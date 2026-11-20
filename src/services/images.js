// Pictures (Phase 22, decisions #169–#170): make_image draws with an image model through the same OpenRouter endpoint and
// key (llm.js generateImage → POST <base>/images). Owner: "an OpenRouter image model makes pictures (invitations, colouring
// pages, story art). Off by default, per-person toggle, cost in the budget meter". So:
//  - off until the admin picks a model (Admin → Models, settings 'images'); the tool is then offered only to people whose
//    'images' toolset is on (policy.js; off for everyone unless the admin turns it on for a person or a group);
//  - every picture's cost is estimated BEFORE the call (the model's published price, else what it cost here lately, else
//    a cautious flat figure) and refused when it would take the person past this week's budget; the real cost the
//    provider reports is what gets recorded (purpose 'image'), so the budget meter and Admin → Usage show it;
//  - no likeness of a real person unless it's the requester (they said so) or their own photo of people who agreed: the
//    call must say who is shown, and "someone else" is always refused; a source picture must be the person's OWN;
//  - the picture is kept byte-for-byte in their Library ('image', source "Made by Jess", the prompt as its description,
//    the details in its meta sidecar), linked to the picture it was made from.
import { APIError } from 'openai';
import { imageSize } from 'image-size';
import { get, settings } from '../db/index.js';
import { llmSettings, generateImage } from './llm.js';
import { recordUsage, spentThisWeek } from './usage.js';
import { taskCapRefusal } from './spend-watch.js';
import { effectivePolicy } from './policy.js';
import { createFileItem, itemForUser, readBytes } from './library.js';
import { outboundFetch } from '../lib/outbound.js';
import { sniff } from './uploads.js';
import { badRequest, invalid } from '../lib/errors.js';

// Shapes: what the tool offers → aspect ratios the models know. A model that lacks one gets its nearest listed ratio.
export const IMAGE_SIZES = { square: '1:1', portrait: '2:3', landscape: '3:2', wide: '16:9', tall: '9:16' };
// Style presets, written into the prompt (a colouring page has to be line art whatever the prompt forgets to say).
export const IMAGE_STYLES = {
  colouring_page: 'A black-and-white colouring page: clean, thick, closed black outlines on a plain white background, large simple '
    + 'shapes, no shading, no grey, no colour, no fill.',
  cartoon: 'A bright, friendly cartoon illustration with clean lines and flat colours.',
  watercolour: 'A soft watercolour painting with gentle washes of colour and visible paper texture.',
  storybook: 'A warm children’s storybook illustration, detailed and gentle, with soft light.',
  photo: 'A natural, realistic photograph.',
  sticker: 'A die-cut sticker design: bold outline, simple shapes, vivid colours, plain white background.',
  flat: 'A modern flat vector illustration with a limited colour palette and no gradients.',
};
// Who the picture shows (required on every call; see the tool's description). someone_else is always refused.
export const DEPICTS = ['no_real_people', 'requester', 'consenting_people', 'someone_else'];
export const PROMPT_MAX = 2000;
export const SOURCE_MAX_BYTES = 10 * 1048576;
const SOURCE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);
export const FALLBACK_ESTIMATE = 0.1;   // USD, when neither a price nor history is known (cautious: most cost $0.01–0.06)
const PICTURE_MEGAPIXELS = 1.05;         // what these models make by default (1024 × 1024 and its shape variants)
const IMAGE_TOKENS = 1600;               // a picture as token-priced models count it (Gemini 1K ≈ 1290, OpenAI medium ≈ 1056)
const PROMPT_TOKENS = 400;
export const MADE_BY = 'Made by Jess';

const DAY_MS = 864e5;
const infoCache = new Map(); // `${baseUrl}|${model}` → { at, info }

// ---- Settings (Admin → Models) ----------------------------------------------------------------------------------------
/** { model: '' | 'vendor/model', checked } — empty = pictures are off. checked: what the last save found (Admin → Models shows
 *  it after a reload, Phase 25 #203): { price: { label, source } | null, warning, at } or null. */
export const imageSettings = () => {
  const s = settings.get('images', {}) || {};
  const model = String(s.model || '').trim();
  return { model, checked: model && s.checked?.model === model ? { price: s.checked.price ?? null, warning: s.checked.warning ?? null, at: s.checked.at } : null };
};
export const imageModel = () => imageSettings().model || null;

/**
 * Save the image model (empty = off). A non-empty id is looked up on the endpoint's image model list first (free, no
 * picture made): unknown there → a field error; the list unreachable (offline, another endpoint) → saved with a warning.
 * → { settings, price: { label, source } | null, warning }.
 */
export async function saveImageSettings({ model } = {}) {
  const id = String(model ?? '').trim();
  if (id && !/^[\w.-]+\/[\w.:-]+$/.test(id)) throw invalid({ model: 'Use an image model id like black-forest-labs/flux.2-klein-4b, or leave it empty for off.' });
  let warning = null, price = null;
  if (id) {
    const info = await modelInfo(id, { fresh: true });
    if (info?.missing) throw invalid({ model: `“${id}” isn’t an image model on this endpoint. OpenRouter lists them at openrouter.ai/models?output_modalities=image.` });
    if (!info) warning = 'Saved, but the image model list couldn’t be reached to check this id; the first picture will tell.';
    else { const e = await estimateImageCost(id); price = { label: `about ${dollars(e.cost)} a picture`, source: e.source }; }
  }
  settings.set('images', { model: id, checked: id ? { model: id, price, warning, at: new Date().toISOString() } : null });
  return { settings: imageSettings(), price, warning };
}

// ---- The model's price and parameters (OpenRouter: GET <base>/images/models/<id>/endpoints; free, cached a day) ---------
async function modelInfo(model, { fresh = false } = {}) {
  const { baseUrl } = llmSettings();
  const key = `${baseUrl}|${model}`;
  const hit = infoCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < (hit.info ? DAY_MS : 10 * 60e3)) return hit.info;
  let info = null;
  try {
    const res = await outboundFetch(`${baseUrl.replace(/\/$/, '')}/images/models/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`,
      { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } }, { trustedOrigin: baseUrl });
    if (res.status === 404) info = { missing: true };
    else if (res.ok) info = parseEndpoints(await res.json());
  } catch { /* offline, or an endpoint without this list */ }
  infoCache.set(key, { at: Date.now(), info });
  return info;
}

// Every provider's prices (the highest per kind, to stay on the safe side) and the parameter values ALL of them accept.
function parseEndpoints(body) {
  const endpoints = Array.isArray(body?.endpoints) ? body.endpoints : [];
  const pricing = new Map();
  for (const e of endpoints) {
    for (const p of Array.isArray(e.pricing) ? e.pricing : []) {
      const cost = Number(p.cost_usd);
      if (!p.billable || !p.unit || !Number.isFinite(cost) || cost < 0) continue;
      const k = `${p.billable}|${p.unit}`;
      pricing.set(k, Math.max(pricing.get(k) || 0, cost));
    }
  }
  const common = name => {
    const lists = endpoints.map(e => e.supported_parameters?.[name]?.values).filter(Array.isArray);
    return lists.length ? lists.reduce((a, b) => a.filter(v => b.includes(v))) : null;
  };
  return { pricing, aspectRatios: common('aspect_ratio')?.filter(v => v !== 'auto') ?? null, outputFormats: common('output_format') };
}

const ratioOf = r => { const [w, h] = String(r).split(':').map(Number); return w > 0 && h > 0 ? w / h : null; };
/** The aspect ratio to ask for: the wanted one, or the model's nearest listed one (by shape). */
export function pickAspectRatio(wanted, listed) {
  if (!listed?.length || listed.includes(wanted)) return wanted;
  const target = Math.log(ratioOf(wanted));
  return listed.filter(ratioOf).sort((a, b) => Math.abs(Math.log(ratioOf(a)) - target) - Math.abs(Math.log(ratioOf(b)) - target))[0] || wanted;
}

/**
 * What one picture will cost, before making it → { cost, source: 'list' | 'history' | 'fallback' }. A price per image or
 * per megapixel is exact; a price per token is a guess, so what this model actually cost here lately comes first then.
 */
export async function estimateImageCost(model, { sources = 0, info } = {}) {
  info ??= await modelInfo(model);
  const p = (billable, unit) => info?.pricing?.get(`${billable}|${unit}`);
  const inputs = (p('input_image', 'token') || 0) * IMAGE_TOKENS * sources + (p('input_image', 'megapixel') || 0) * PICTURE_MEGAPIXELS * sources
    + (p('input_image', 'image') || 0) * sources + (p('input_text', 'token') || 0) * PROMPT_TOKENS;
  const exact = p('output_image', 'image') ?? (p('output_image', 'megapixel') != null ? p('output_image', 'megapixel') * PICTURE_MEGAPIXELS : null);
  if (exact != null) return { cost: exact + inputs, source: 'list' };
  const h = get(`SELECT AVG(cost) AS c FROM usage_events WHERE purpose = 'image' AND model = ? AND cost > 0 AND at >= date('now', '-29 days')`, model);
  if (h?.c > 0) return { cost: h.c, source: 'history' };
  const perToken = p('output_image', 'token');
  if (perToken != null) return { cost: perToken * IMAGE_TOKENS + inputs, source: 'list' };
  return { cost: FALLBACK_ESTIMATE, source: 'fallback' };
}

/** "$0.015" under ten cents, "$0.12" above. */
export const dollars = v => { const n = Number(v) || 0; return `$${n >= 0.1 ? n.toFixed(2) : n.toFixed(3)}`; };

// ---- The source picture: theirs only ---------------------------------------------------------------------------------
function sourcePicture(user, id) {
  const item = itemForUser(user, String(id).replace(/^\/?library\//, ''));
  // Admins may VIEW anyone's items (#36), but a picture is only ever made from the person's own.
  if (item.owner_id !== user.id) throw badRequest('Only their own pictures can be used: that one is in someone else’s Library.');
  if (item.type !== 'image' || !SOURCE_EXTS.has(item.ext)) throw badRequest(`“${item.title}” isn’t a PNG, JPEG or WebP picture, so it can’t be used as the source.`);
  if (item.size_bytes > SOURCE_MAX_BYTES) throw badRequest(`“${item.title}” is too large to send to the image model (the limit is 10 MB).`);
  const bytes = readBytes(item);
  return { item, url: `data:${item.mime};base64,${bytes.toString('base64')}` };
}

// What went wrong at the provider, in plain words (safety filters included: they are respected, never worked around).
function providerError(err) {
  if (err?.name === 'AbortError' || err?.constructor?.name === 'APIUserAbortError') return badRequest('Stopped before the picture was made.');
  const status = err instanceof APIError ? err.status : err?.status;
  const said = String(err?.error?.message || err?.message || '').replace(/^\d{3}\s+/, '').slice(0, 300);
  if (status === 402) return badRequest('The picture wasn’t made: the model account is out of credits (the admin can top it up).');
  if (status === 429) return badRequest('The picture wasn’t made: the image model is busy right now (rate limited). Try again in a minute.');
  if (status === 403 || /safety|moderat|content polic|flagged|filter|not allowed|prohibited/i.test(said)) {
    return badRequest(`The image model refused this picture (its safety rules): ${said || 'no reason given'}. Tell them plainly; don't reword the prompt to get around it.`);
  }
  if (status === 404) return badRequest(`The picture wasn’t made: the image model “${imageModel()}” wasn’t found (the admin can change it in Admin → Models).`);
  if (err?.code === 'ETIMEDOUT' || /timed? ?out/i.test(said)) return badRequest('The picture wasn’t made: the image model took too long to answer.');
  return badRequest(`The picture wasn’t made: the image model failed${status ? ` (${status})` : ''}: ${said || 'unknown error'}.`);
}

const titleFrom = prompt => {
  const t = String(prompt).replace(/\s+/g, ' ').trim();
  return t.length <= 60 ? t : `${t.slice(0, 60).replace(/\s+\S*$/, '')}…`;
};

/**
 * Make one picture and keep it in the person's Library → { item, cost, costLabel, estimate, model, aspectRatio, width,
 * height, ms }. Throws a plain-worded 400 for anything refused or failed (nothing is spent before the call; a call the
 * provider billed is recorded even when its answer is unusable).
 */
export async function makeImage(user, { prompt, size = 'square', style = null, sourceImageId = null, depicts, title = null,
  threadId = null, runId = null, signal } = {}) {
  const model = imageModel();
  if (!model) throw badRequest('Pictures are off: the admin hasn’t chosen an image model (Admin → Models).');
  const text = String(prompt || '').trim();
  if (!text) throw badRequest('Say what the picture should show (prompt).');
  if (text.length > PROMPT_MAX) throw badRequest(`The prompt is too long (${text.length} characters; at most ${PROMPT_MAX}). Keep what matters for the picture.`);
  if (!DEPICTS.includes(depicts)) throw badRequest(`Say who the picture shows (depicts: ${DEPICTS.join(', ')}).`);
  if (depicts === 'someone_else') {
    throw badRequest('Not made: I don’t make pictures that look like a real person other than the one asking, unless it’s their own photo '
      + 'of people who agreed. Offer a made-up character instead, or a picture without that person.');
  }
  if (!IMAGE_SIZES[size]) throw badRequest(`Unknown size “${size}” (use ${Object.keys(IMAGE_SIZES).join(', ')}).`);
  if (style != null && style !== '' && !IMAGE_STYLES[style]) throw badRequest(`Unknown style “${style}” (use ${Object.keys(IMAGE_STYLES).join(', ')}, or none).`);
  const source = sourceImageId ? sourcePicture(user, sourceImageId) : null;

  // The budget, before anything is spent: this week's spend plus the estimate must fit.
  const info = await modelInfo(model);
  const estimate = await estimateImageCost(model, { sources: source ? 1 : 0, info });
  const budget = effectivePolicy(user).weeklyBudget;
  if (budget > 0) {
    const spent = spentThisWeek(user.id);
    if (spent + estimate.cost > budget) {
      throw badRequest(`Not made: this picture would cost about ${dollars(estimate.cost)}, and only ${dollars(Math.max(0, budget - spent))} is left `
        + `of this week’s ${dollars(budget)} budget (it resets on Monday). Nothing was spent. The admin can raise the budget.`);
    }
  }
  // …and inside a task, what is left of that task's own spend cap (decision #178).
  const capped = taskCapRefusal(runId, user, estimate.cost, 'this picture');
  if (capped) throw badRequest(capped);

  const aspectRatio = pickAspectRatio(IMAGE_SIZES[size], info?.aspectRatios);
  const outputFormat = info?.outputFormats?.includes('png') ? 'png' : null;
  const fullPrompt = [style ? IMAGE_STYLES[style] : null, source ? 'Work from the attached picture.' : null, text].filter(Boolean).join(' ');
  const started = Date.now();
  let res;
  try {
    res = await generateImage({ model, prompt: fullPrompt, aspectRatio, outputFormat, inputImages: source ? [source.url] : [], signal });
  } catch (err) { throw providerError(err); }

  // Recorded as soon as the provider answers: the reported cost, or the estimate when this endpoint reports none.
  const reported = res?.usage?.cost;
  const cost = reported != null && Number.isFinite(Number(reported)) ? Number(reported) : estimate.cost;
  recordUsage({ userId: user.id, runId, purpose: 'image', model, usage: { ...(res?.usage || {}), cost } });

  const b64 = res?.data?.find(d => d?.b64_json)?.b64_json;
  if (!b64) throw badRequest('The image model answered without a picture (it may have declined). Nothing was saved.');
  const buffer = Buffer.from(b64, 'base64');
  const kind = await sniff(buffer);
  if (kind?.type !== 'image') throw badRequest('The image model sent back something that isn’t a picture. Nothing was saved.');
  let dims = {};
  try { dims = imageSize(buffer); } catch { /* size unknown: still a picture sniff recognised */ }
  const item = createFileItem({
    user, title: String(title || '').trim() || titleFrom(text), type: 'image', ext: kind.ext, mime: kind.mime, buffer,
    description: text, sourceLabel: MADE_BY, threadId, runId, sourceItemId: source?.item.id ?? null,
    meta: { prompt: text, style: style || null, size, aspectRatio, depicts, model, cost, estimate: estimate.cost, width: dims.width ?? null,
      height: dims.height ?? null, source: source?.item.public_id ?? null },
  });
  return { item, cost, costLabel: dollars(cost), estimate: estimate.cost, model, aspectRatio, width: dims.width ?? null, height: dims.height ?? null,
    ms: Date.now() - started };
}

/** Forget the cached model lists (tests). */
export const resetImageInfo = () => infoCache.clear();
