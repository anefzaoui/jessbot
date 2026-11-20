// Model providers (#11, docs/guide/providers.md): where Jessbot's models come from. Chat, tools and every background job only
// need an OpenAI-compatible chat endpoint with tool calls; some features use services only OpenRouter offers under one key
// (the decision model, voice, pictures, reading scans, live prices and the balance). Those are switched off with any other
// provider, and the app says so instead of failing on each use.
//   openrouter  — one key, hundreds of models, every feature (the default);
//   ollama      — models on this computer or the local network; no key, nothing leaves the network, free and slower;
//   compatible  — any other OpenAI-compatible service (OpenAI, a LiteLLM or vLLM box, LM Studio…).
import { settings } from '../db/index.js';
import { outboundFetch } from '../lib/outbound.js';

export const PROVIDERS = {
  openrouter: { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true,
    model: 'openai/gpt-6-luna', embedModel: 'openai/text-embedding-3-small',
    summary: 'One key for hundreds of models. Every feature works. Pay as you go, usually cents a day.' },
  ollama: { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false,
    model: '', embedModel: 'nomic-embed-text',
    summary: 'Models running on this computer or your network. Free and private; slower, and some features are off.' },
  compatible: { id: 'compatible', label: 'Another OpenAI-compatible service', baseUrl: '', needsKey: true,
    model: '', embedModel: '',
    summary: 'OpenAI, LM Studio, a LiteLLM or vLLM server… Chat works; features that need OpenRouter are off.' },
};

/** Which provider a base URL is, when none was chosen (installs from before #11, LLM_BASE_URL). */
export function providerFor(baseUrl) {
  const u = String(baseUrl || '');
  if (/openrouter\.ai/i.test(u)) return 'openrouter';
  if (/:11434(\/|$)/.test(u) || /ollama/i.test(u)) return 'ollama';
  return 'compatible';
}

/** The provider in use: the admin's choice (the picker saves it with a matching address; choosing OpenRouter always
 *  saves OpenRouter's), else what the address says (installs from before #11, LLM_BASE_URL). */
export function currentProvider(baseUrl) {
  const chosen = settings.get('llm', {})?.provider;
  return PROVIDERS[chosen] ? chosen : providerFor(baseUrl);
}

// What each feature needs, and what happens without it. `on`: true | false | 'model' (works when the endpoint serves a
// suitable model). The same table is in docs/guide/providers.md.
export const FEATURES = [
  { id: 'chat', label: 'Chat, tools, tasks, goals, the feed, projects', icon: 'message-circle',
    on: { openrouter: true, ollama: 'model', compatible: true },
    without: 'Needs a model that can call tools and follow long instructions: with Ollama, 7B or larger (qwen2.5:7b, llama3.1:8b). Smaller ones connect but get lost.' },
  { id: 'fallbacks', label: 'Fallback models', icon: 'list-ordered',
    on: { openrouter: true, ollama: false, compatible: false },
    without: 'Only the main model answers; when it is down, the reply fails and can be retried.' },
  { id: 'embeddings', label: 'Memory search by meaning', icon: 'brain',
    on: { openrouter: true, ollama: 'model', compatible: 'model' },
    without: 'With an embedding model on the endpoint (Ollama: nomic-embed-text). Without one, memories are found by their words.' },
  { id: 'decisions', label: 'Quick decisions (skips needless work, fast browsing steps)', icon: 'zap',
    on: { openrouter: true, ollama: false, compatible: false },
    without: 'Off: the full model or plain rules decide instead, a little slower and costlier.' },
  { id: 'voice', label: 'Voice notes (speaking and listening)', icon: 'audio-lines',
    on: { openrouter: true, ollama: false, compatible: false },
    without: 'Off: replies are text only, and voice notes can’t be sent.' },
  { id: 'images', label: 'Making pictures', icon: 'image',
    on: { openrouter: true, ollama: false, compatible: false },
    without: 'Off: the picture tool isn’t offered.' },
  { id: 'ocr', label: 'Reading scans and photos of text', icon: 'scan-text',
    on: { openrouter: true, ollama: false, compatible: false },
    without: 'Off: a scanned PDF or a photo has no text to search; the model still sees pictures you attach if it can.' },
  { id: 'prices', label: 'Spending caps in dollars', icon: 'wallet',
    on: { openrouter: true, ollama: true, compatible: false },
    without: 'The service doesn’t report what each call cost, so weekly and per-task budgets can’t count spending. (Ollama is free.)' },
  { id: 'balance', label: 'Low-balance warning', icon: 'gauge',
    on: { openrouter: true, ollama: false, compatible: false },
    without: 'Off: check your balance on the provider’s site.' },
];

/** Whether a feature works with a provider: true | false | 'model'. */
export const supports = (feature, provider) => FEATURES.find(f => f.id === feature)?.on[provider] ?? false;

/** The table for one provider, for the setup step and Admin → Model. */
export const featureSupport = provider => FEATURES.map(f => ({ id: f.id, label: f.label, icon: f.icon, on: f.on[provider],
  note: f.on[provider] === true ? null : f.without }));

/** The models an Ollama server has installed → [{ name, size }] (newest first), or throws with a plain reason. */
export async function ollamaModels(baseUrl) {
  const root = new URL(String(baseUrl || PROVIDERS.ollama.baseUrl)).origin; // /api/tags lives beside /v1
  let res;
  try {
    res = await outboundFetch(`${root}/api/tags`, { signal: AbortSignal.timeout(5000) }, { trustedOrigin: root }); // the admin's own address
  } catch (err) {
    throw new Error(`Ollama didn’t answer at ${root} (${String(err.message).split('\n')[0]}). Is it running?`);
  }
  if (!res.ok) throw new Error(`Ollama answered ${res.status} at ${root}.`);
  const data = await res.json().catch(() => ({}));
  // Embedding models (nomic-embed-text, mxbai-embed…: BERT families) can't chat: left out of the list.
  const embedding = m => /embed/i.test(m.name) || (m.details?.families || [m.details?.family]).some(f => /bert/i.test(String(f || '')));
  return (data.models || []).filter(m => !embedding(m)).map(m => ({ name: m.name, size: m.size || 0, modifiedAt: m.modified_at || null }))
    .sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
}
