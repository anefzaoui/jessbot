// Spend watch (Phase 19 part B, decisions #178 and #179): what one task may spend, alerts before a weekly budget runs out,
// an admin alert on an unusual day or a provider that keeps failing, and the OpenRouter balance.
//   - task cap: policy `taskBudget` (default min($0.50, weekly × 0.25)); the loop checks it before every model call;
//   - budget alerts: 75 / 90 / 100 % of the weekly budget, each once per week per person (a push);
//   - admin alerts: a day that costs more than max($0.50, 3× the 14-day median), once a day; 5 provider errors in a row;
//   - balance: /api/v1/credits (what's left on the account) and /api/v1/key (this key's limit and usage), cached, read by
//     the doctor and Admin → Usage ("Balance $23.67 ≈ 12 days"; a warning under 7 days; the provider's week vs what was
//     recorded here, when they differ by more than 10%).
import { get, all, settings } from '../db/index.js';
import { effectivePolicy } from './policy.js';
import { spentThisWeek, spentOnRuns } from './usage.js';
import { notify } from './notify.js';
import { outboundFetch } from '../lib/outbound.js';
import { llmSettings, onOpenRouter } from './llm.js';
import { config } from '../config/index.js';
import { trimEndChars } from '../lib/text-safe.js';

const money = n => `$${(Number(n) || 0).toFixed(2)}`;
const admins = () => all(`SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id`).map(u => u.id);
// This Monday as a key (UTC, like usage.js's week).
const weekKey = (now = new Date()) => { const d = new Date(now); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

// ---- The per-task cap ------------------------------------------------------------------------------------------------
/** What one task may spend for this person, in USD (0 = no cap). */
export const taskBudget = user => effectivePolicy(user).taskBudget;

/** What this run may spend: its own cap when it has one (overnight prep: what is left of the night's cap, #199), else the
 *  person's per-task cap. */
export const runCap = (r, user) => (r?.spend_cap != null ? Number(r.spend_cap) : taskBudget(user));

/** What's left of a task's cap → { cap, spent, left } (left: Infinity with no cap or no task). */
export function taskBudgetLeft(runId, user) {
  const cap = runId ? runCap(get('SELECT spend_cap FROM runs WHERE id = ?', runId), user) : taskBudget(user);
  if (!runId || !(cap > 0)) return { cap, spent: 0, left: Infinity };
  const spent = spentOnRuns([runId]);
  return { cap, spent, left: Math.max(0, cap - spent) };
}

/** A paid call inside a task (a picture, reading a scan) that would take it past its cap: the refusal line, else null.
 *  Checked by those services before they spend anything, next to their weekly-budget check. */
export function taskCapRefusal(runId, user, cost, what = 'this') {
  const t = taskBudgetLeft(runId, user);
  if (t.left === Infinity || (cost ?? 0) <= t.left) return null;
  return `Not done: ${what} would cost about $${(Number(cost) || 0).toFixed(3)}, and this task has ${money(t.left)} left of its ${money(t.cap)} limit for one `
    + 'task. Nothing was spent. Tell them; asking again in a new message starts a fresh limit.';
}

// ---- Weekly budget alerts --------------------------------------------------------------------------------------------
export const ALERT_LEVELS = [0.75, 0.9, 1];
/** A push when the person's spend this week crosses 75 %, 90 % or 100 % of their budget, each once per week. Returns the
 *  level announced now (or null). */
export function checkBudgetAlerts(user, now = new Date()) {
  const budget = effectivePolicy(user).weeklyBudget;
  if (!(budget > 0)) return null;
  const ratio = spentThisWeek(user.id) / budget;
  const level = [...ALERT_LEVELS].reverse().find(l => ratio >= l);
  if (!level) return null;
  const key = `spend-alert:${user.id}`;
  const week = weekKey(now);
  const last = settings.get(key, null);
  if (last?.week === week && last.level >= level) return null;
  settings.set(key, { week, level });
  const pct = Math.round(level * 100);
  notify(user.id, { kind: 'message', title: level >= 1 ? 'This week’s budget is used up' : `You’ve used ${pct}% of this week’s budget`,
    body: level >= 1 ? `${money(budget)} this week. New tasks wait until Monday, or the admin can raise it in Admin → People.`
      : `${money(spentThisWeek(user.id))} of ${money(budget)}. It resets on Monday.`, href: '/me/usage', tag: `budget-${week}-${pct}` });
  return level;
}

// ---- A day far above normal (admin) ----------------------------------------------------------------------------------
/** { spent, median, day } when `offset` days ago (UTC) cost more than max(floor, 3× the median of the 14 days before it),
 *  else null. Needs a week of history first. Shared with the doctor's check (system.js, floor $0.25). */
export function spendSpike(now = new Date(), { offset = 0, floor = 0.5 } = {}) {
  const day = n => new Date(now.getTime() - n * 864e5).toISOString().slice(0, 10);
  const first = get('SELECT MIN(at) AS at FROM usage_events')?.at;
  if (!first || first.slice(0, 10) > day(offset + 7)) return null;
  const costs = new Map(all('SELECT date(at) AS d, SUM(cost) AS c FROM usage_events WHERE at >= ? GROUP BY d', day(offset + 15)).map(r => [r.d, r.c]));
  const spent = costs.get(day(offset)) || 0;
  const base = Array.from({ length: 14 }, (_, i) => costs.get(day(offset + 1 + i)) || 0).sort((a, b) => a - b);
  const median = (base[6] + base[7]) / 2;
  return spent > floor && spent > 3 * median ? { spent, median, day: day(offset) } : null;
}

/** Push the admins once a day when today is far above normal. Returns the spike (or null). */
export function checkSpendSpike(now = new Date()) {
  const s = spendSpike(now, { floor: 0.5 });
  if (!s || settings.get('spend-spike-alert', null) === s.day) return null;
  settings.set('spend-spike-alert', s.day);
  for (const id of admins()) {
    notify(id, { kind: 'message', title: 'Unusual spending today', href: '/admin/usage', tag: `spend-spike-${s.day}`,
      body: `${money(s.spent)} so far, ${s.median > 0 ? `${(s.spent / s.median).toFixed(1)}× ` : 'far above '}the usual ${money(s.median)} a day. Admin → Usage shows who and which task.` });
  }
  return s;
}

// ---- Provider errors in a row (admin) --------------------------------------------------------------------------------
export const ERROR_STREAK = 5;
let streak = 0, alerted = false;
/** Every chat call's outcome: 5 provider errors in a row push the admins once (until a call works again). */
export function providerOutcome(ok, err = null) {
  if (ok) { streak = 0; alerted = false; return 0; }
  streak++;
  if (streak >= ERROR_STREAK && !alerted) {
    alerted = true;
    const why = String(err?.message || err || 'unknown error').slice(0, 140);
    for (const id of admins()) {
      notify(id, { kind: 'message', title: 'The model keeps failing', href: '/admin/model', tag: 'provider-errors',
        body: `${ERROR_STREAK} calls in a row failed (last: ${why}). Check the key, the credits and the model in Admin → Models; a fallback model helps.` });
    }
  }
  return streak;
}
export const __test = { resetStreak: () => { streak = 0; alerted = false; } };

// ---- OpenRouter balance ----------------------------------------------------------------------------------------------
const BALANCE_KEY = 'openrouter-balance';
const BALANCE_MS = 6 * 3600e3;
const num = v => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Read the account's credits and the key's limit and usage from OpenRouter; cached in settings. Never throws. */
export async function refreshBalance({ force = false, now = new Date() } = {}) {
  const cur = settings.get(BALANCE_KEY, null);
  if (!force && cur?.at && now - new Date(cur.at) < BALANCE_MS) return cur;
  const { baseUrl, apiKey } = llmSettings();
  if (!apiKey || !onOpenRouter(baseUrl)) return null;
  const base = trimEndChars(baseUrl, '/');
  const fetchJson = async p => {
    try {
      const res = await outboundFetch(`${base}/${p}`, { headers: { Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': config.publicUrl, 'X-Title': 'Jessbot' },
        signal: AbortSignal.timeout(8000) }, { trustedOrigin: base });
      return res.ok ? (await res.json())?.data || null : null;
    } catch { return null; }
  };
  const [credits, key] = await Promise.all([fetchJson('credits'), fetchJson('key')]);
  if (!credits && !key) return cur;
  const out = {
    at: now.toISOString(),
    credits: credits ? { total: num(credits.total_credits), used: num(credits.total_usage) } : null, // 403 without a management key
    key: key ? { limit: num(key.limit), remaining: num(key.limit_remaining), usage: num(key.usage), daily: num(key.usage_daily),
      weekly: num(key.usage_weekly), monthly: num(key.usage_monthly) } : null,
  };
  settings.set(BALANCE_KEY, out);
  return out;
}

/** What the admin sees: { balance, days, label, warn, gap, recordedWeek, providerWeek, at } or null when unknown. */
export function balanceView() {
  const b = settings.get(BALANCE_KEY, null);
  if (!b) return null;
  const left = [b.credits && b.credits.total != null && b.credits.used != null ? b.credits.total - b.credits.used : null,
    b.key?.limit != null ? b.key.remaining : null].filter(v => v != null);
  const balance = left.length ? Math.max(0, Math.min(...left)) : null;
  const perDay = (get(`SELECT COALESCE(SUM(cost), 0) AS c FROM usage_events WHERE at >= date('now', '-13 days')`).c || 0) / 14;
  const days = balance != null && perDay > 0 ? Math.floor(balance / perDay) : null;
  const recordedWeek = get(`SELECT COALESCE(SUM(cost), 0) AS c FROM usage_events WHERE at >= date('now', '-6 days', 'weekday 1')`).c || 0;
  const providerWeek = b.key?.weekly ?? null;
  const gapRatio = providerWeek != null && Math.max(providerWeek, recordedWeek) > 0.05
    ? Math.abs(providerWeek - recordedWeek) / Math.max(providerWeek, recordedWeek) : 0;
  return {
    balance, days, perDay, at: b.at, recordedWeek, providerWeek,
    label: balance == null ? null : `Balance ${money(balance)}${days != null ? ` ≈ ${days} day${days === 1 ? '' : 's'}` : ''}`,
    warn: days != null && days < 7,
    gap: gapRatio > 0.1 ? `OpenRouter counts ${money(providerWeek)} for this key this week; ${money(recordedWeek)} was recorded here`
      + `${providerWeek > recordedWeek ? ' (another app or install may use the same key)' : ''}.` : null,
  };
}
