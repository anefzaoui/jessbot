// Skill trigger test (Phase 23, decision #173): does a skill's description make Jess open it for the requests it is for,
// and not for the near-misses? For each test request the configured chat model sees the real skills block (skillsBlockOf:
// every active skill a person with every toolset would have, plus the skill under test even while it waits for review)
// and is asked, 3 times, "Which skill, if any, would you load first?". The answer is matched to a skill name in plain code;
// the rate per request says whether the description works. The cost is shown before anything runs (dryRun), each call is
// recorded in usage (purpose `skill_trigger_test`), and an optional "suggest a better description" is one more call that
// is given the failures and told to generalise to kinds of intent. The suggestion is returned, never applied.
import { settings } from '../db/index.js';
import { getClient, llmSettings } from './llm.js';
import { recordUsage } from './usage.js';
import { modelPrice, estimateCost, dollars } from './model-price.js';
import { countTokens } from '../lib/tokens.js';
import { HttpError, invalid } from '../lib/errors.js';
import { allSkills, skillsBlockOf, triggerQueriesOf, DESCRIPTION_MAX } from './skills.js';
import { botName } from './bot.js';

export const TRIGGER_RUNS = 3;
export const TRIGGER_MAX_QUERIES = 10;
const QUERY_CHARS = 300;
const ANSWER_TOKENS = 120; // estimate per call: a name, plus the little reasoning a low effort spends
const SUGGEST_TOKENS = 600;
const CONCURRENCY = 4;
export const QUESTION = 'Which skill, if any, would you load first? Answer with the name or none.';
const PURPOSE = 'skill_trigger_test';

/** The first skill name the answer mentions (whole names only), 'none', or 'unclear'. */
export function parseChoice(answer, names) {
  const t = ` ${String(answer || '').toLowerCase().replace(/[`*_"“”‘’'.,!?:;()[\]{}<>]/g, ' ')} `;
  let best = null;
  for (const n of names) {
    const i = t.search(new RegExp(`(?<![a-z0-9-])${n.replace(/-/g, '\\-')}(?![a-z0-9-])`));
    if (i >= 0 && (!best || i < best.i || (i === best.i && n.length > best.n.length))) best = { n, i };
  }
  if (best) return best.n;
  return /\bnone\b|\bno skill\b|\bno\b/.test(t) ? 'none' : 'unclear';
}

// Everything a run (or its estimate) needs: the skill, the block, the requests, the messages per request.
function plan(name, { queries, runs = TRIGGER_RUNS } = {}) {
  const list = allSkills();
  const s = list.find(x => x.name === String(name));
  if (!s) throw invalid({ name: 'No such skill.' });
  if (s.status === 'broken') throw invalid({ name: `This skill is broken: ${s.problems.join(' ')}` });
  const n = Number(runs);
  if (!Number.isInteger(n) || n < 1 || n > TRIGGER_RUNS) throw invalid({ runs: `1 to ${TRIGGER_RUNS} runs per request.` });
  let qs;
  if (queries != null && (!Array.isArray(queries) || queries.length)) {
    if (!Array.isArray(queries)) throw invalid({ queries: 'A list of requests.' });
    qs = queries.map(q => (typeof q === 'string' ? { text: q, expect: 'use' } : { text: q?.text, expect: q?.expect }))
      .map(q => ({ text: String(q.text ?? '').replace(/\s+/g, ' ').trim(), expect: q.expect === 'skip' ? 'skip' : 'use' })).filter(q => q.text);
    if (qs.some(q => q.text.length > QUERY_CHARS)) throw invalid({ queries: `Keep each request under ${QUERY_CHARS} characters.` });
  } else qs = triggerQueriesOf(s);
  if (!qs.length) throw invalid({ queries: 'This skill has no test requests yet: type a few (and a near-miss or two).' });
  if (qs.length > TRIGGER_MAX_QUERIES) throw invalid({ queries: `At most ${TRIGGER_MAX_QUERIES} requests at a time.` });
  // The representative person has every toolset, so every active skill competes; the one under test joins even in review.
  const pool = list.filter(x => x.status === 'active' || x.name === s.name);
  const bot = botName();
  const system = `You are ${bot}, a household assistant.\n\n${skillsBlockOf(pool)}`;
  const messagesFor = q => [{ role: 'system', content: system }, { role: 'user', content: `Someone asks you: “${q.text}”\n\n${QUESTION}` }];
  return { s, pool, names: pool.map(x => x.name), queries: qs, runs: n, messagesFor, system };
}

async function costOf(p, { suggest = false } = {}) {
  const { model } = llmSettings();
  const calls = p.queries.length * p.runs;
  const promptTokens = p.queries.reduce((sum, q) => sum + p.messagesFor(q).reduce((a, m) => a + countTokens(m.content, model) + 4, 0), 0) * p.runs
    + (suggest ? countTokens(p.system, model) + 400 : 0);
  const completionTokens = calls * ANSWER_TOKENS + (suggest ? SUGGEST_TOKENS : 0);
  const price = await modelPrice(model);
  const cost = estimateCost(price, { promptTokens, completionTokens });
  return { model, calls: calls + (suggest ? 1 : 0), promptTokens, completionTokens, cost, costLabel: dollars(cost), priceSource: price?.source || null };
}

/** Throws the same field errors a run would (so a route can refuse a bad request before it counts against a limit). */
export function checkTriggerTest(name, opts = {}) { plan(name, opts); }

/** What a trigger test would cost, before it runs (nothing is called but the price list). */
export async function estimateTriggerTest(name, opts = {}) {
  const p = plan(name, opts);
  return { skill: p.s.name, status: p.s.status, runs: p.runs, queries: p.queries, competing: p.pool.length, estimate: await costOf(p, opts) };
}

// A small pool: the calls are independent, and a few at a time keeps a 30-call test well under a minute.
async function pooled(jobs, n = CONCURRENCY) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

/**
 * Run the trigger test. → { skill, model, runs, results: [{ text, expect, answers[], hits, rate, ok }], summary: { total,
 * passed, failed, errors }, cost, costLabel, estimate, suggestion? }. rate = share of runs that chose this skill; ok = most
 * runs did (expect 'use') or didn't ('skip'). suggest: true → one more call for a better description when any failed.
 */
export async function triggerTest(name, { queries, runs, suggest = false, user = null, signal } = {}) {
  const p = plan(name, { queries, runs });
  const estimate = await costOf(p, { suggest });
  const { model } = llmSettings();
  const reasoning = { effort: settings.get('llm', {}).reasoning || 'low' }; // as the chat itself routes
  let spent = 0, promptTokens = 0, completionTokens = 0, firstError = null;
  const call = async (messages, extra = {}) => {
    const res = await getClient().chat.completions.create({ model, reasoning, messages, ...extra }, { signal });
    recordUsage({ userId: user?.id ?? null, purpose: PURPOSE, model, usage: res.usage });
    spent += Number(res.usage?.cost) || 0;
    promptTokens += res.usage?.prompt_tokens || 0;
    completionTokens += res.usage?.completion_tokens || 0;
    return res.choices?.[0]?.message?.content || '';
  };
  const jobs = p.queries.flatMap((q, qi) => Array.from({ length: p.runs }, () => async () => {
    try {
      return { qi, answer: parseChoice(await call(p.messagesFor(q), { max_tokens: 600 }), p.names) };
    } catch (err) {
      if (signal?.aborted) throw err;
      firstError ||= err;
      return { qi, answer: 'error' };
    }
  }));
  const answers = await pooled(jobs);
  const errors = answers.filter(a => a.answer === 'error').length;
  if (errors === answers.length) throw new HttpError(502, `The model didn’t answer: ${firstError?.message || 'unknown error'}`);
  const results = p.queries.map((q, qi) => {
    const mine = answers.filter(a => a.qi === qi).map(a => a.answer);
    const counted = mine.filter(a => a !== 'error');
    const hits = counted.filter(a => a === p.s.name).length;
    const rate = counted.length ? hits / counted.length : 0;
    return { text: q.text, expect: q.expect, answers: mine, hits, rate: Number(rate.toFixed(2)), ok: counted.length > 0 && (q.expect === 'use' ? rate > 0.5 : rate < 0.5) };
  });
  const failed = results.filter(r => !r.ok);
  const out = { skill: p.s.name, model, runs: p.runs, results, summary: { total: results.length, passed: results.length - failed.length, failed: failed.length, errors }, estimate };
  if (suggest && failed.length) out.suggestion = await suggestDescription(p, failed, call);
  if (!spent) { // an endpoint that doesn't report cost: price what was used
    const price = await modelPrice(model);
    spent = estimateCost(price, { promptTokens, completionTokens }) ?? 0;
  }
  return { ...out, cost: Number(spent.toFixed(6)), costLabel: dollars(spent) };
}

// One call: the failures in, a better "what it's for and when" out (kinds of intent, not the test phrasings).
async function suggestDescription(p, failed, call) {
  const others = p.pool.filter(x => x.name !== p.s.name).slice(0, 80).map(x => `- ${x.name}: ${x.description}`).join('\n');
  const lines = failed.map(r => `- “${r.text}” ${r.expect === 'use' ? 'should open it' : 'should NOT open it'}; the answers were: ${r.answers.join(', ')}`).join('\n');
  const system = 'You improve the description that decides when an assistant opens a skill (know-how for a kind of task). A good '
    + 'description says what the skill is for and the situations that call for it, in the words people use, and is clearly '
    + 'different from the other skills. Generalise from the failures to kinds of intent: do not paste the test requests or list '
    + `phrasings, and never summarise the steps. At most ${DESCRIPTION_MAX} characters. Answer in JSON: `
    + '{"description": "…", "why": "one sentence on what changed"}.';
  const content = `Skill: ${p.s.name}\nCurrent description: ${p.s.description}\n\nFailures:\n${lines}\n\nThe other skills:\n${others || '(none)'}`;
  let j;
  try { j = JSON.parse(await call([{ role: 'system', content: system }, { role: 'user', content }], { max_tokens: 1200, response_format: { type: 'json_object' } })); }
  catch { return null; } // an unreadable answer: the test results still stand
  const description = String(j?.description || '').replace(/\s+/g, ' ').trim();
  if (!description) return null;
  return { description, why: String(j?.why || '').trim().slice(0, 300), length: description.length, fits: description.length <= DESCRIPTION_MAX };
}

// ---- The last test per skill (Phase 25, decision #195) ---------------------------------------------------------------
// A real test takes up to a minute and spends money, so the review page must not lose it to a refresh: the last one per
// skill is kept here (in memory: a restart forgets it, as it forgets the request itself) and GET …/trigger-test reads it.
const lastTests = new Map(); // name → { status: running|done|error, startedAt, finishedAt?, calls, result?, error? }
export const lastTriggerTest = name => lastTests.get(String(name)) || null;

/** Run `work` (a triggerTest promise factory) as this skill's tracked test → its result. One at a time per skill (409). */
export async function trackTriggerTest(name, { calls = null } = {}, work) {
  const key = String(name);
  if (lastTests.get(key)?.status === 'running') throw new HttpError(409, 'A test of this skill is already running: its result shows here when it’s done.');
  const startedAt = new Date().toISOString();
  lastTests.set(key, { status: 'running', startedAt, calls });
  if (lastTests.size > 200) lastTests.delete(lastTests.keys().next().value);
  try {
    const result = await work();
    lastTests.set(key, { status: 'done', startedAt, finishedAt: new Date().toISOString(), calls, result });
    return result;
  } catch (err) {
    lastTests.set(key, { status: 'error', startedAt, finishedAt: new Date().toISOString(), calls, error: err.message, code: err.status || 500 });
    throw err;
  }
}
export const resetTriggerTests = () => lastTests.clear(); // tests
