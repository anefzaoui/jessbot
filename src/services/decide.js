// Jess's quick decisions (Phase 16, docs/JEV.md, decisions #106–#110): a "System One" decision model — TypeSafe's Jev,
// through OpenRouter's Decisions API with the same key — answers narrow questions about a state in ~0.3 s for a
// fraction of a cent: choice (one of N, with probabilities), noul (yes-probability) and score (a level on a scale).
// It never writes text. Every use has a switch, a confidence bar and a fallback: when Jev is off, fails, times out or
// isn't sure, the caller does what it did before. Safety checks only ever get stricter from it (web pages can steer it) —
// with one bounded exception: the injection check may clear a pattern match that is plainly ordinary text, and what it
// clears stays fenced and still marks the run as having read outside content (agent/injection.js, decision #120).
import { get, all, run, settings } from '../db/index.js';
import { config } from '../config/index.js';
import { llmSettings } from './llm.js';
import { recordUsage } from './usage.js';
import { badRequest } from '../lib/errors.js';
import { outboundFetch } from '../lib/outbound.js';

// What Jess uses it for (Admin → Models lists these with their switches).
export const USES = {
  checkin: { group: 'Before spending a full reply', label: 'Check-ins', iconName: 'hand-heart',
    hint: 'Is anything worth telling you right now? If not, the check-in is skipped before the full model runs.' },
  memory: { group: 'Before spending a full reply', label: 'Memory pass', iconName: 'bookmark-plus',
    hint: 'Did a quiet chat contain anything worth remembering (or a project change)? If not, the memory pass is skipped.' },
  reflect: { group: 'Before spending a full reply', label: 'Ideas & goal reviews', iconName: 'lightbulb',
    hint: 'Skips idea reflection and goal check-ins when nothing new happened, and picks which idea (if any) is worth preparing overnight.' },
  goal: { group: 'Every message', label: 'See it through', iconName: 'target',
    hint: 'Before a reply counts as finished: did it deliver what you asked for, meet every requirement, stick to figures from what was read, and only claim what was done? If not, and the next step isn’t yours, the work goes on.' },
  reminder: { group: 'Every message', label: 'Reminder answers', iconName: 'bell',
    hint: 'While a reminder waits for you: does your message say it’s done, ask to stop the reminders, or neither? In any language. If off or unsure, a word list decides.' },
  turn: { group: 'Every message', label: 'Voice, language & memories', iconName: 'sparkles',
    hint: 'Did you ask for a spoken reply? Which language? Which of your memories matter? Which skill fits, how much thinking it needs, and is it about health, law or money?' },
  page: { group: 'Browser', label: 'Page state', iconName: 'scan-eye',
    hint: 'Logins, CAPTCHAs, cookie panels, paywalls, errors and progress — in any language.' },
  risk: { group: 'Browser', label: 'Spend & send check', iconName: 'shield-check',
    hint: 'Spots buttons that pay, book or send in any language. It can only add a request for your OK, never remove one.' },
  steps: { group: 'Browser', label: 'Fast steps & autopilot', iconName: 'zap',
    hint: 'Obvious clicks and scrolls without the full model, and the autopilot that fills forms and searches in seconds. Never pays or sends.' },
  feed: { group: 'Feed', label: 'Story relevance', iconName: 'rss',
    hint: 'Scores each story against what you asked the feed for, alongside what you click.' },
  injection: { group: 'Safety', label: 'Injection check', iconName: 'shield-alert',
    hint: 'When a page, email or file seems to talk to AI assistants, is it really trying to instruct your assistant, or just a person writing to a person? If off, every match gets the warning.' },
};
export const CONFIDENCES = [0.5, 0.6, 0.7, 0.8, 0.9];
// textModel: the small, fast LLM that writes what the browser autopilot types. jev-ultrafast used Inception's Mercury
// (~0.3–0.6 s); OpenRouter stopped serving it in November 2026, so the default is Claude Haiku 5.5 (decision #255).
export const DEFAULTS = { model: 'typesafe/jev-1.13', textModel: 'anthropic/claude-haiku-5.5', confidence: 0.6, uses: Object.fromEntries(Object.keys(USES).map(k => [k, true])) };
// Earlier defaults that no provider serves any more. Saving the form used to store the default as it showed it, so a
// stored one is read as "the default" (decision #255); any other saved choice is kept as it is.
const RETIRED = { model: [], textModel: ['inception/mercury-2.5'] };
const chosen = (key, v) => { const id = String(v || '').trim(); return id && !RETIRED[key].includes(id) ? id : DEFAULTS[key]; };

export function decideSettings() {
  const s = settings.get('decide', {}) || {};
  return {
    model: chosen('model', s.model),
    textModel: chosen('textModel', s.textModel),
    confidence: CONFIDENCES.includes(Number(s.confidence)) ? Number(s.confidence) : DEFAULTS.confidence,
    uses: { ...DEFAULTS.uses, ...(s.uses || {}) },
  };
}

export const MODEL_ID = /^~?[\w.-]+\/[\w.:-]+$/; // vendor/model, OpenRouter's shape (a leading ~ for its "latest" aliases)

export function saveDecideSettings(input = {}) {
  const cur = decideSettings();
  const model = String(input.model ?? cur.model).trim();
  const textModel = String(input.textModel ?? cur.textModel).trim();
  for (const m of [model, textModel]) if (!MODEL_ID.test(m)) throw badRequest(`"${m}" doesn't look like a model id (vendor/model).`);
  const confidence = input.confidence === undefined ? cur.confidence : Number(input.confidence);
  if (!CONFIDENCES.includes(confidence)) throw badRequest(`Confidence must be one of ${CONFIDENCES.join(', ')}.`);
  const uses = { ...cur.uses };
  for (const k of Object.keys(USES)) if (input.uses && k in input.uses) uses[k] = input.uses[k] === true || input.uses[k] === 'true' || input.uses[k] === 'on';
  // A model left at its default is stored as "the default" (empty), so it follows a later change of default (decision #255).
  settings.set('decide', { model: model === DEFAULTS.model ? '' : model, textModel: textModel === DEFAULTS.textModel ? '' : textModel, confidence, uses });
  return decideSettings();
}

// OpenRouter's Decisions API lives next to its chat API: …/api/v1 → …/api/alpha/decisions.
function endpoint() {
  const { baseUrl, apiKey } = llmSettings();
  if (!apiKey || !/openrouter\.ai/i.test(baseUrl)) return null; // only OpenRouter serves it with our key
  return { url: new URL('../alpha/decisions', baseUrl.replace(/\/?$/, '/')).href, apiKey };
}

/** Is this use switched on (and reachable)? Tests run offline (JESSBOT_DECIDE_OFF=1). */
export const enabled = use => process.env.JESSBOT_DECIDE_OFF !== '1' && !!endpoint() && decideSettings().uses[use] !== false;
export const threshold = () => decideSettings().confidence;

// ---- Questions -----------------------------------------------------------------------------------------------------
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
export const noul = (instructions, criteria) => ({ type: 'noul', instructions, ...(criteria ? { criteria } : {}) });
export const score = (instructions, levels) => ({ type: 'score', instructions, criteria: levels });

// ---- The call ------------------------------------------------------------------------------------------------------
let logged = 0;
function log(use, { userId = null, runId = null, outcome = null, confidence = null, acted = 1, fallback = null, ms = null, cost = 0 }) {
  const id = Number(run(`INSERT INTO decisions (use, user_id, run_id, outcome, confidence, acted, fallback, ms, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    use, userId, runId, outcome ? String(outcome).slice(0, 200) : null, confidence, acted ? 1 : 0, fallback, ms, cost).lastInsertRowid);
  if (++logged % 200 === 0) run(`DELETE FROM decisions WHERE at < datetime('now', '-30 days')`);
  return id;
}

/** Say what a decision led to (Admin → Models → recent decisions). acted=false: the old logic decided instead. */
export function note(id, outcome, { confidence = null, acted = true, fallback = null } = {}) {
  if (!id) return;
  run('UPDATE decisions SET outcome = ?, confidence = COALESCE(?, confidence), acted = ?, fallback = ? WHERE id = ?',
    String(outcome || '').slice(0, 200), confidence, acted ? 1 : 0, acted ? null : (fallback || 'unsure'), id);
}

/** Log what the fallback decided when Jev wasn't asked (off or unreachable), so the decisions log still shows it (e.g. the
 *  message sense's keyword routing, #177). */
export const logFallback = (use, { userId = null, runId = null, outcome, fallback = 'off' } = {}) =>
  log(use, { userId, runId, outcome, acted: 0, fallback });

/**
 * Ask Jev. Returns { answers, ms, cost, id } — or null when the use is off, or on any failure (the caller falls back).
 * questions: { key: choice(...) | noul(...) | score(...) }. state: string or object with named fields (text only).
 */
export async function decide(use, { state, questions, user = null, runId = null, timeoutMs = 2500, signal } = {}) {
  if (use !== 'try' && !enabled(use)) return null;
  const ep = endpoint();
  if (!ep || (use === 'try' && process.env.JESSBOT_DECIDE_OFF === '1')) return null;
  const { model } = decideSettings();
  const started = Date.now();
  const body = JSON.stringify({ model, state, questions, user: user ? `jessbot-u${user.id}` : undefined });
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = timeoutMs - (Date.now() - started);
    if (left < 150) break;
    try {
      const res = await outboundFetch(ep.url, {
        method: 'POST', body,
        headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': config.publicUrl, 'X-Title': 'Jessbot' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left),
      }, { trustedOrigin: ep.url });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.answers) {
        lastErr = Object.assign(new Error(json?.error?.message || `HTTP ${res.status}`), { status: res.status });
        if ([429, 500, 502, 503, 524, 529].includes(res.status)) { await new Promise(r => setTimeout(r, 200)); continue; }
        break;
      }
      const ms = Date.now() - started;
      const cost = Number(json.usage?.cost) || 0;
      recordUsage({ userId: user?.id ?? null, runId, purpose: 'decide', model,
        usage: { prompt_tokens: json.usage?.input_tokens || 0, completion_tokens: json.usage?.output_tokens || 0, cost } });
      return { answers: json.answers, ms, cost, id: log(use, { userId: user?.id, runId, ms, cost }) };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  const timedOut = lastErr?.name === 'TimeoutError' || lastErr?.name === 'AbortError';
  console.warn(`[decide] ${use}: ${timedOut ? 'timed out' : String(lastErr?.message || 'failed').slice(0, 160)} — using the fallback`);
  log(use, { userId: user?.id, runId, outcome: timedOut ? 'timed out' : String(lastErr?.message || 'error').slice(0, 120), acted: 0,
    fallback: timedOut ? 'timeout' : 'error', ms: Date.now() - started });
  return null;
}

// ---- Reading answers -----------------------------------------------------------------------------------------------
/** A yes-probability (noul), or null. */
export const yes = a => (a && Number.isFinite(Number(a.noul)) ? Number(a.noul) : null);
/** { pick, p, confidence } for a choice: p is the pick's own probability. */
export const picked = a => (a?.choice != null ? { pick: String(a.choice), p: Number(a.probabilities?.[a.choice] ?? a.confidence ?? 0), confidence: Number(a.confidence ?? 0) } : null);
/** A score as 0–1 across its levels (score / (levels - 1)), or null. */
export const level = (a, levels) => (a && Number.isFinite(Number(a.score)) ? Math.max(0, Math.min(1, Number(a.score) / Math.max(1, levels - 1))) : null);

// ---- Admin → Models ------------------------------------------------------------------------------------------------
const money = v => `$${(Number(v) || 0).toFixed(v >= 0.01 ? 2 : 4)}`;
/** Per use: switch, and today's count / average time / cost. */
export function usesView() {
  const s = decideSettings();
  const stats = new Map(all(`SELECT use, COUNT(*) AS n, AVG(ms) AS ms, SUM(cost) AS cost, SUM(acted) AS acted FROM decisions
    WHERE at >= datetime('now', '-1 day') GROUP BY use`).map(r => [r.use, r]));
  const groups = [];
  for (const [key, u] of Object.entries(USES)) {
    const st = stats.get(key);
    let g = groups.find(x => x.label === u.group);
    if (!g) groups.push(g = { label: u.group, uses: [] });
    g.uses.push({ key, ...u, on: s.uses[key] !== false,
      stats: st ? `${st.n} in the last day · ${Math.round(st.ms || 0)} ms · ${money(st.cost)}${st.n - st.acted ? ` · ${st.n - st.acted} handed back` : ''}` : 'Nothing yet today' });
  }
  return groups;
}

const FALLBACK_LABELS = { error: 'failed — old logic', timeout: 'too slow — old logic', unsure: 'unsure — old logic', off: 'off' };
export function recentDecisions(limit = 25) {
  return all('SELECT * FROM decisions ORDER BY id DESC LIMIT ?', limit).map(d => ({
    id: d.id, use: d.use, label: USES[d.use]?.label || (d.use === 'try' ? 'Try it' : d.use), iconName: USES[d.use]?.iconName || 'flask-conical',
    outcome: d.outcome || '—', confidence: d.confidence == null ? null : Math.round(d.confidence * 100), acted: !!d.acted,
    fallback: d.fallback ? FALLBACK_LABELS[d.fallback] || d.fallback : null, ms: d.ms, at: d.at,
  }));
}

export const decideSummary = () => {
  const s = decideSettings();
  const on = Object.values(s.uses).filter(Boolean).length;
  const day = get(`SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS c FROM decisions WHERE at >= datetime('now', '-1 day')`);
  return { model: s.model, on, total: Object.keys(USES).length, today: day.n, todayCost: money(day.c), reachable: !!endpoint() };
};
