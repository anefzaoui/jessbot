// Long runs that go round in circles (Phase 19 part B, decision #177). Plain code over the run's own steps and calls, no
// model: the dead-end detector (a nudge to change route, ≤ 2 per run), the repeated-read breaker (the same state-independent
// read a third time isn't run), the error streak (one re-plan), a code-built checkpoint every 15 steps, and the anchor that
// keeps the request in the prompt's tail on long runs ("The task you're on" + what already failed).

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
export const MAX_DEAD_END_CHECKS = 2;
export const DEAD_END_GAP = 5;           // steps between two dead-end checks
export const CHECKPOINT_EVERY = 15;      // steps
export const ANCHOR_FROM = 6;            // steps before the tail carries "The task you're on"
export const DEAD_END_LABEL = 'Dead end check: trying a different route'; // the visible step (the weekly self-review counts them)

// ---- Words of a search query (for "the same search again") ----------------------------------------------------------
const STOP = new Set('a an and are at be by for from how in is it of on or the to what when where which who with vs de la le les des du et en un une للبحث في من على عن'.split(' '));
export const queryWords = q => new Set((String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => !STOP.has(w)));
/** How much two searches share: |A∩B| / max(|A|, |B|) (1 = same words). */
export function overlap(a, b) {
  const A = queryWords(a), B = queryWords(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}

/**
 * Is the run stuck? steps: the run's steps ({ tool, target, status }); searches: its web_search queries, oldest first.
 * → { reason, detail } or null. Checked before each full model call.
 *   - failing: ≥ 4 of the last 6 steps went wrong;
 *   - same-site: the same tool on the same site ≥ 4 times in the last 8 steps, none of them a success;
 *   - same-search: the last 3 searches share ≥ 80% of their words (the newest in the last 3 steps).
 */
export function stuckSignal({ steps = [], searches = [] } = {}) {
  const tools = steps.filter(s => s.status !== 'run' && s.status !== 'wait');
  const last6 = tools.slice(-6);
  const bad6 = last6.filter(s => s.status === 'bad').length;
  if (last6.length >= 4 && bad6 >= 4) return { reason: 'failing', detail: `${bad6} of the last ${last6.length} steps went wrong` };
  const last8 = tools.slice(-8);
  const groups = new Map();
  for (const s of last8) {
    if (!s.tool || !s.target) continue;
    const k = `${s.tool}|${s.target}`;
    const g = groups.get(k) || { n: 0, ok: 0, tool: s.tool, target: s.target };
    g.n++; if (s.status === 'ok') g.ok++;
    groups.set(k, g);
  }
  const same = [...groups.values()].find(g => g.n >= 4 && !g.ok);
  if (same) return { reason: 'same-site', detail: `${same.n} tries of ${same.tool} on ${same.target} in the last ${last8.length} steps, none worked` };
  const recent = tools.slice(-3).some(s => s.tool === 'web_search');
  const q = searches.slice(-3);
  if (recent && q.length === 3 && overlap(q[0], q[1]) >= 0.8 && overlap(q[1], q[2]) >= 0.8 && overlap(q[0], q[2]) >= 0.8) {
    return { reason: 'same-search', detail: `the last 3 searches were nearly the same (“${clip(q[2], 80)}”)` };
  }
  return null;
}

/** The system message a dead-end check adds (the loop also shows a visible step). */
export const deadEndNudge = signal => `[Dead end check] ${signal.detail}. Stop and think before the next step: name the assumption that has `
  + 'been wrong (in one line), then switch to a route that doesn’t share it: the site’s own search or URL parameters, open_search, '
  + 'another source, browser_autopilot for a form, or hand over to the person if the next step is truly theirs. Don’t repeat what just failed.';

// ---- The repeated-read breaker --------------------------------------------------------------------------------------
// Reads whose answer doesn't depend on what the browser shows right now (so a third identical call can't learn anything new).
// Browser page tools are left out on purpose: the same click on a changed page is a different step.
export const STATE_FREE_READS = new Set(['web_search', 'web_read', 'recall', 'search_history', 'library_read', 'library_list', 'email_list',
  'email_read', 'calendar_events', 'project_search', 'read_offloaded', 'get_weather']);
export const REPEAT_LIMIT = 2;
const stable = v => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v);
/** The identity of a state-independent read (null for anything else). web_search: its words, lowercased and in order. */
export function readKey(name, args = {}) {
  if (!STATE_FREE_READS.has(name)) return null;
  if (name === 'web_search') {
    const { query, ...rest } = args || {};
    return `web_search|${[...queryWords(query)].join(' ')}|${JSON.stringify(stable(rest))}`;
  }
  return `${name}|${JSON.stringify(stable(args || {}))}`;
}
export const REPEAT_REFUSAL = 'Already done twice in this task — result above. Use what it returned, or change the query, the page or the '
  + 'approach: the same call again would give the same answer.';

// ---- The error streak -----------------------------------------------------------------------------------------------
/** The last 4 tool results were all errors: one re-plan (per run). results: tool result texts, oldest first. */
export const errorStreak = results => results.length >= 4 && results.slice(-4).every(c => /^Error:/.test(String(c)));
export const REPLAN = '[Several steps failed in a row] The last 4 steps all returned errors. Don’t push the same way again: re-plan from '
  + 'what you know (a different tool, a different site, simpler steps), or, if you need something only the person can give, ask them '
  + 'with ask_user.';

// ---- Checkpoints and the anchor -------------------------------------------------------------------------------------
const stepLine = s => `${s.label}${s.target && !String(s.label).includes(s.target) ? ` (${s.target})` : ''}`;
/** Up to n failed steps, newest last: "Read example.com (example.com)". */
export const failedSteps = (steps, n = 8) => steps.filter(s => s.status === 'bad').slice(-n).map(s => clip(stepLine(s), 120));

/** Every CHECKPOINT_EVERY steps: what was asked and what's done, built in code. */
export function checkpoint({ request, steps }) {
  const ok = steps.filter(s => s.status === 'ok').slice(-10).map(s => clip(stepLine(s), 100));
  const failed = failedSteps(steps, 5);
  return [`[Checkpoint: ${steps.length} steps in]`, `The request: “${clip(request, 600)}”`,
    `Done so far: ${ok.length ? ok.join('; ') : 'nothing that worked yet'}.`,
    failed.length ? `Failed: ${failed.join('; ')}.` : null,
    'Check you are still working toward exactly that request. If you already have what they asked for, reply now; if not, take the '
      + 'shortest route to it.'].filter(Boolean).join('\n');
}

/** The prompt tail's anchor on long runs (≥ ANCHOR_FROM steps): the request, and what already failed. */
export function taskBlock({ request, steps }) {
  if (!request || steps.length < ANCHOR_FROM) return null;
  const failed = failedSteps(steps, 8);
  return [`## The task you're on\n“${clip(request, 600)}${String(request).length > 600 ? '…' : ''}”`,
    failed.length ? `Already tried and failed:\n${failed.map(f => `- ${f}`).join('\n')}` : null].filter(Boolean).join('\n');
}
