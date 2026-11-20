// Token estimates (o200k_base, pure JS) calibrated against the provider's reported usage.
// The provider's `usage.prompt_tokens` is ground truth; a moving correction ratio per model keeps budgets accurate
// even if a model's tokenizer differs (GPT-6 Luna's is unverified — see docs/CONTEXT-AND-MEMORY.md).
import { countTokens as o200k } from 'gpt-tokenizer/encoding/o200k_base';

const ratio = new Map(); // model → multiplier applied to raw o200k counts

const rawText = text => (text ? o200k(String(text)) : 0);
// A picture counts as IMAGE_TOKENS whatever its size in bytes: providers bill pictures by their pixels (a 1568 px model copy,
// decision #201, measured at about 1,550 tokens on Claude; at most 1,105 on OpenAI's high detail), and its base64 is not text
// the model reads (counted as text, one attached photo read as hundreds of thousands of tokens). Content parts (pictures,
// cache breakpoints, #202) count by what they hold.
export const IMAGE_TOKENS = 1600;
const rawPart = p => (p?.type === 'text' ? rawText(p.text) : p?.type === 'image_url' ? IMAGE_TOKENS : rawText(JSON.stringify(p ?? '')));
const rawContent = c => (typeof c === 'string' ? rawText(c) : Array.isArray(c) ? c.reduce((n, p) => n + rawPart(p), 0) : c == null ? 0 : rawText(JSON.stringify(c)));
const rawMessages = messages => messages.reduce((n, m) => n + 4 + rawContent(m.content)
  + (m.tool_calls ? rawText(JSON.stringify(m.tool_calls)) : 0), 0);

export const countTokens = (text, model) => Math.ceil(rawText(text) * (ratio.get(model) || 1));
export const countMessages = (messages, model) => Math.ceil(rawMessages(messages) * (ratio.get(model) || 1));
export const rawMessageTokens = rawMessages;

// After a call: blend actual/raw into the model's ratio (EMA). Outliers (images, odd providers) are ignored.
export function calibrate(model, rawEstimate, actual) {
  if (!rawEstimate || !actual) return;
  const r = actual / rawEstimate;
  if (r < 0.5 || r > 2) return;
  ratio.set(model, (ratio.get(model) || 1) * 0.8 + r * 0.2);
}
