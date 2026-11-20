// Cost accounting: one row per model call, from the provider's reported usage (OpenRouter returns cost in USD).
// Weeks start Monday 00:00 UTC. Budgets come from the person's effective policy (services/policy.js; 0 = no limit) —
// callers pass it in, so the meter and the gate that stops runs always agree.
import { get, all, run } from '../db/index.js';

// model: the model that ANSWERED (services/llm.js answeredBy); fallback: it came from the fallback chain (decision #179).
export function recordUsage({ userId = null, runId = null, purpose = 'chat', model, usage, fallback = false }) {
  if (!usage) return;
  run(`INSERT INTO usage_events (user_id, run_id, purpose, model, prompt_tokens, completion_tokens, cached_tokens, cost, fallback)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  userId, runId, purpose, model, usage.prompt_tokens || 0, usage.completion_tokens || 0,
  usage.prompt_tokens_details?.cached_tokens || 0, Number(usage.cost) || 0, fallback ? 1 : 0);
}

/** What these runs (a task and its earlier attempts) have cost so far, in USD: the per-task cap (decision #178). */
export const spentOnRuns = runIds => (runIds.length
  ? get(`SELECT COALESCE(SUM(cost), 0) AS c FROM usage_events WHERE run_id IN (${runIds.map(() => '?').join(',')})`, ...runIds).c : 0);

// This Monday (today when it is Monday). ('weekday 1' alone jumps forward to the NEXT Monday.)
const WEEK_START = "date('now', '-6 days', 'weekday 1')";
const money = (v, digits = 2) => `$${(Number(v) || 0).toFixed(digits)}`;

export const spentThisWeek = userId =>
  get(`SELECT COALESCE(SUM(cost), 0) AS c FROM usage_events WHERE user_id = ? AND at >= ${WEEK_START}`, userId).c;

/** Everyone's spend this week, as a label (Admin → Overview). */
export const weekTotalLabel = () => money(get(`SELECT COALESCE(SUM(cost), 0) AS c FROM usage_events WHERE at >= ${WEEK_START}`).c);

/** Last `n` days as bars ({ label, value, pct, valueLabel }), oldest first. where/params narrow the rows. */
function dailySeries(n, where = '1 = 1', params = []) {
  const rows = all(`SELECT date(at) AS d, SUM(cost) AS c FROM usage_events WHERE ${where} AND at >= date('now', ?) GROUP BY d`, ...params, `-${n - 1} days`);
  const byDay = new Map(rows.map(r => [r.d, r.c]));
  const series = Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.now() - (n - 1 - i) * 864e5);
    return { key: d.toISOString().slice(0, 10), label: d.toLocaleDateString('en', n > 7 ? { day: 'numeric' } : { weekday: 'short' }), value: byDay.get(d.toISOString().slice(0, 10)) || 0 };
  });
  const max = Math.max(...series.map(s => s.value), 1e-9);
  return series.map(s => ({ ...s, pct: Math.round((s.value / max) * 100), valueLabel: money(s.value, 3) }));
}

/** One person's week: meter, daily bars, costliest tasks. budget: their effective weekly budget (0 = no limit). */
export function weeklyUsage(userId, budget) {
  const spent = spentThisWeek(userId);
  const limited = budget > 0;
  const ratio = limited ? spent / budget : 0;
  return {
    limited, pct: limited ? Math.min(100, Math.round(ratio * 100)) : 0,
    spentLabel: money(spent), budgetLabel: limited ? money(budget) : 'No limit', resetsLabel: 'Resets Monday',
    label: !limited ? 'No weekly limit' : ratio >= 1 ? 'Used up — resets Monday' : ratio > 0.8 ? 'Running low this week' : 'Resets Monday · plenty left',
    days: dailySeries(7, 'user_id = ?', [userId]).map(({ label, pct, valueLabel }) => ({ label, pct, valueLabel })),
    top: all(`SELECT r.id, COALESCE(m.content, 'Chat') AS title, SUM(u.cost) AS c FROM usage_events u
              LEFT JOIN runs r ON r.id = u.run_id LEFT JOIN messages m ON m.id = r.trigger_message_id
              WHERE u.user_id = ? AND u.at >= ${WEEK_START} GROUP BY u.run_id ORDER BY c DESC LIMIT 3`, userId)
      .map(t => ({ title: String(t.title).slice(0, 60), costLabel: money(t.c, 3) })),
  };
}

// Every purpose recorded anywhere (recordUsage callers). 'goals' is what goal jobs record; 'goal' is kept for old rows.
const PURPOSE_LABELS = { chat: 'Chats', summary: 'Chat summaries', extract: 'Memory', feed: 'Feed', goals: 'Goals', goal: 'Goals', ideas: 'Ideas', image: 'Pictures',
  project: 'Projects', embed: 'Search index', voice: 'Voice (speaking)', transcribe: 'Voice notes (listening)', decide: 'Quick decisions', ocr: 'Reading scans',
  self_review: 'Weekly self-review', whats_new: 'What’s new notes', test: 'Tests' };

/**
 * Pictures and scan reading over the last `days` (Admin → Usage and the Pictures card in Admin → Models, Phase 25 #203):
 * { image, ocr } → { count, cost, costLabel, people, countLabel }. A picture is one call; reading a scan is one call per batch
 * of pages, so its count is model calls, not pages.
 */
export function featureTotals(days = 30) {
  const rows = all(`SELECT purpose, COUNT(*) AS n, COALESCE(SUM(cost), 0) AS c, COUNT(DISTINCT user_id) AS people FROM usage_events
    WHERE purpose IN ('image', 'ocr') AND at >= date('now', ?) GROUP BY purpose`, `-${days - 1} days`);
  const of = (key, one, many) => {
    const r = rows.find(x => x.purpose === key) || { n: 0, c: 0, people: 0 };
    return { count: r.n, cost: r.c, costLabel: money(r.c, r.c > 0 && r.c < 0.1 ? 3 : 2), people: r.people, countLabel: `${r.n} ${r.n === 1 ? one : many}` };
  };
  return { image: of('image', 'picture', 'pictures'), ocr: of('ocr', 'model call', 'model calls') };
}

/**
 * Everyone, for Admin → Usage. people: [{ id, name, role, budget }] with their effective budgets.
 * Returns totals (this week, last 30 days), per person, by purpose, by model, fallbacks, pictures and scans (features), 30
 * daily bars and the costliest tasks.
 */
export function usageOverview(people) {
  const week = get(`SELECT COALESCE(SUM(cost), 0) AS c, COUNT(*) AS n FROM usage_events WHERE at >= ${WEEK_START}`);
  const month = get(`SELECT COALESCE(SUM(cost), 0) AS c, COUNT(*) AS n, COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t
    FROM usage_events WHERE at >= date('now', '-29 days')`);
  const perWeek = new Map(all(`SELECT user_id, SUM(cost) AS c FROM usage_events WHERE at >= ${WEEK_START} GROUP BY user_id`).map(r => [r.user_id, r.c]));
  const perMonth = new Map(all(`SELECT user_id, SUM(cost) AS c FROM usage_events WHERE at >= date('now', '-29 days') GROUP BY user_id`).map(r => [r.user_id, r.c]));
  const share = rows => { const total = rows.reduce((a, r) => a + r.c, 0) || 1e-9; return rows.map(r => ({ ...r, pct: Math.round((r.c / total) * 100), costLabel: money(r.c, 3) })); };
  return {
    weekLabel: money(week.c), weekCalls: week.n, monthLabel: money(month.c), monthCalls: month.n,
    monthTokens: month.t >= 1e6 ? `${(month.t / 1e6).toFixed(1)}M` : `${Math.round(month.t / 1e3)}k`,
    people: people.map(p => {
      const spent = perWeek.get(p.id) || 0;
      const limited = p.budget > 0;
      const ratio = limited ? spent / p.budget : 0;
      return { ...p, spentLabel: money(spent), monthLabel: money(perMonth.get(p.id) || 0), budgetLabel: limited ? money(p.budget) : 'No limit',
        pct: limited ? Math.min(100, Math.round(ratio * 100)) : 0, limited, tone: ratio >= 1 ? 'bad' : ratio > 0.8 ? 'warn' : 'ok' };
    }).sort((a, b) => (perWeek.get(b.id) || 0) - (perWeek.get(a.id) || 0)),
    purposes: share(all(`SELECT purpose AS key, SUM(cost) AS c FROM usage_events WHERE at >= date('now', '-29 days') GROUP BY purpose ORDER BY c DESC`))
      .map(r => ({ ...r, label: PURPOSE_LABELS[r.key] || r.key })),
    models: share(all(`SELECT COALESCE(model, 'unknown') AS key, SUM(cost) AS c, COUNT(*) AS n FROM usage_events WHERE at >= date('now', '-29 days')
      GROUP BY model ORDER BY c DESC LIMIT 6`)).map(r => ({ ...r, label: r.key })),
    // Calls a fallback model answered (decision #179): "Answered by a fallback 3×" (the screen is Phase 25).
    fallbacks: (() => {
      const rows = all(`SELECT model, COUNT(*) AS n FROM usage_events WHERE fallback = 1 AND at >= date('now', '-29 days') GROUP BY model ORDER BY n DESC`);
      const n = rows.reduce((a, r) => a + r.n, 0);
      return { count: n, label: n ? `Answered by a fallback ${n}×` : null, byModel: rows.map(r => ({ model: r.model, count: r.n })) };
    })(),
    features: featureTotals(),
    days: dailySeries(30),
    top: all(`SELECT u.run_id, r.thread_id, us.name AS person, COALESCE(m.content, 'Background task') AS title, SUM(u.cost) AS c, MAX(u.at) AS at
              FROM usage_events u LEFT JOIN runs r ON r.id = u.run_id LEFT JOIN messages m ON m.id = r.trigger_message_id
              LEFT JOIN users us ON us.id = u.user_id
              WHERE u.at >= date('now', '-29 days') AND u.run_id IS NOT NULL GROUP BY u.run_id ORDER BY c DESC LIMIT 8`)
      .map(t => ({ title: String(t.title).replace(/\s+/g, ' ').slice(0, 90), person: t.person || '—', costLabel: money(t.c, 3), threadId: t.thread_id, at: t.at })),
  };
}
