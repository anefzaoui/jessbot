// Policies (decision #13): what Jessbot may do for each person. Layers: everyone → each group → the person.
// Resolution: the most specific layer that sets a toolset wins; among groups the most restrictive wins.
// Settings per toolset: off (hidden from the model) · ask (reads run, anything that changes/sends/spends asks first)
// · allow (runs freely — except spend/external, which ALWAYS ask unless the person granted "always allow").
import { get, all, run } from '../db/index.js';
import { groupsOfUser } from './groups.js';
import { spentThisWeek } from './usage.js';
import { taintOf } from '../agent/taint.js';
import { urlsIn, urlRisk } from '../lib/dlp.js';

export const TOOLSETS = {
  core: { label: 'Conversation basics', description: 'Ask you questions, search your past chats, reopen stored results.' },
  memory: { label: 'Memory', description: 'Remember and recall facts about you; share a fact with a group (asks first).' },
  web: { label: 'Web', description: 'Search the web and read pages through the private browser.' },
  library: { label: 'Library', description: 'Create documents, sites and dashboards in your Library.' },
  schedule: { label: 'Schedules & alarms', description: 'Set reminders, alarms, timers and recurring tasks.' },
  goals: { label: 'Goals & ideas', description: 'Track goals, plan steps, suggest ideas.' },
  email: { label: 'Email', description: 'Read your inbox; draft and send email (sending asks first).' },
  calendar: { label: 'Calendar', description: 'Read your calendar; create or change events (asks first).' },
  files: { label: 'Files', description: 'Read files you upload and save new ones.' },
  office: { label: 'Office documents', description: 'Spreadsheets, documents, slides and PDFs.' },
  projects: { label: 'Projects', description: 'Start projects, keep their briefs and files, and work inside them.' },
  lists: { label: 'Lists', description: 'Shopping, to-do, wish and packing lists, private or shared with a group.' },
  // Off for everyone until the admin turns it on for a person or group (decision #170); each picture costs money.
  images: { label: 'Pictures', description: 'Make pictures with the image model (invitations, colouring pages, story art); each costs a little.' },
};
const RANK = { off: 0, ask: 1, allow: 2 };
export const DEFAULT_BUDGET = Number(process.env.JESSBOT_WEEKLY_BUDGET_USD) || 2;
// One task may spend at most this much unless a layer sets its own (decision #178): min($0.50, a quarter of the weekly budget).
export const DEFAULT_TASK_BUDGET = 0.5;
export const defaultTaskBudget = weekly => (weekly > 0 ? Math.min(DEFAULT_TASK_BUDGET, weekly * 0.25) : DEFAULT_TASK_BUDGET);

export function getPolicy(subjectType, subjectId = null) {
  const row = get('SELECT * FROM policies WHERE subject_type = ? AND subject_id IS ?', subjectType, subjectId);
  return row ? { ...row, toolsets: JSON.parse(row.toolsets || '{}') } : null;
}

// taskBudget (decision #178): '' or null = inherit, 0 = no cap for one task; left out (undefined) = keep what the layer had,
// so a form without the field never wipes it.
export function setPolicy(subjectType, subjectId, { toolsets, approver, weeklyBudget, taskBudget, quietStart, quietEnd }, actorId) {
  const clean = {};
  for (const [k, v] of Object.entries(toolsets || {})) if (TOOLSETS[k] && RANK[v] !== undefined) clean[k] = v;
  const hhmm = v => (/^\d{2}:\d{2}$/.test(v || '') ? v : null);
  const money = (v, max) => { const n = v === '' || v == null ? null : Math.max(0, Math.min(max, Number(v))); return Number.isFinite(n) ? n : null; };
  const budget = money(weeklyBudget, 1000);
  const perTask = taskBudget === undefined ? getPolicy(subjectType, subjectId)?.task_budget_usd ?? null : money(taskBudget, 100);
  run(`INSERT INTO policies (subject_type, subject_id, toolsets, approver, weekly_budget_usd, task_budget_usd, quiet_start, quiet_end, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(subject_type, subject_id) DO UPDATE SET toolsets = excluded.toolsets, approver = excluded.approver,
         weekly_budget_usd = excluded.weekly_budget_usd, task_budget_usd = excluded.task_budget_usd, quiet_start = excluded.quiet_start,
         quiet_end = excluded.quiet_end, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  subjectType, subjectId, JSON.stringify(clean), ['self', 'admin'].includes(approver) ? approver : null,
  budget, perTask, hhmm(quietStart), hhmm(quietEnd), actorId);
  return getPolicy(subjectType, subjectId);
}

// One resolver for both views: with the person's own layer (effective) or without it (inherited, for the admin UI).
function resolve(user, { includeUser }) {
  const global = getPolicy('global') || { toolsets: {} };
  const groups = groupsOfUser(user.id).map(g => getPolicy('group', g.id)).filter(Boolean);
  const mine = includeUser ? getPolicy('user', user.id) : null;
  const toolsets = {};
  for (const key of Object.keys(TOOLSETS)) {
    let v = global.toolsets[key] || 'off';
    const fromGroups = groups.map(g => g.toolsets[key]).filter(Boolean);
    if (fromGroups.length) v = fromGroups.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
    if (mine?.toolsets[key]) v = mine.toolsets[key];
    toolsets[key] = v;
  }
  const pick = f => mine?.[f] ?? groups.map(g => g[f]).find(x => x != null) ?? global[f] ?? null;
  const weeklyBudget = pick('weekly_budget_usd') ?? DEFAULT_BUDGET;
  const perTask = pick('task_budget_usd');
  return {
    toolsets,
    approver: pick('approver') || 'self',
    weeklyBudget,
    // What one task may spend (0 = no cap); taskBudgetSet: a layer chose it (else the default from the weekly budget).
    taskBudget: perTask ?? defaultTaskBudget(weeklyBudget), taskBudgetSet: perTask != null,
    quietStart: pick('quiet_start') || '22:00', quietEnd: pick('quiet_end') || '07:30',
  };
}

export const effectivePolicy = user => resolve(user, { includeUser: true });

/** This week's spend has reached the person's budget (0 = unlimited). Background jobs and new runs stop. */
export const overBudget = user => { const b = effectivePolicy(user).weeklyBudget; return b > 0 && spentThisWeek(user.id) >= b; };
// What a person would get WITHOUT their own override (shown as "Inherit (…)" in the admin UI).
export const inheritedPolicy = user => resolve(user, { includeUser: false });

export const enabledToolsets = user => new Set(Object.entries(effectivePolicy(user).toolsets).filter(([, v]) => v !== 'off').map(([k]) => k));

// allow | ask | off for one concrete call. Grants: "always" (run_id NULL) or "this task" (same run).
/** A call's risk (read|write|spend|external). Risk functions may look at live state (e.g. the clicked element's real name). */
export const riskOf = (tool, args, { user = null, runId = null } = {}) => (typeof tool.risk === 'function' ? tool.risk(args, { user, runId }) : tool.risk);

/** Does this call keep acting after the task ends (a schedule, a repeating reminder, a memory in every prompt)?
 *  tool.persistent: true | (args, { user, runId }) → boolean. */
export const persistentOf = (tool, args, { user = null, runId = null } = {}) =>
  (typeof tool.persistent === 'function' ? !!tool.persistent(args, { user, runId }) : !!tool.persistent);

// Opening a URL can send data out (decision #126): a data-catching host always asks; a URL carrying data (a long or coded
// value, an email address) asks after the task read outside content — unless the person typed that value, or the exact
// URL came in a result read in this chat (a link followed, not one she composed). "This chat", not only this task: a story
// link from feed_stories in one turn, opened in the next ("read me the second one"), or a Retry's earlier attempt, is still a
// link she saw verbatim (the same last 400 messages the link check uses, loop.js seenUrls).
const seenInChat = (runId, url) => !!get(`SELECT 1 FROM (SELECT content FROM messages WHERE thread_id = (SELECT thread_id FROM runs WHERE id = ?)
  AND role IN ('tool', 'user') ORDER BY id DESC LIMIT 400) WHERE instr(content, ?) > 0 LIMIT 1`, runId, url);
function outboundRisk(args, runId, tainted) {
  const urls = urlsIn(args);
  if (!urls.length) return null;
  const trigger = runId ? get('SELECT m.content FROM runs r JOIN messages m ON m.id = r.trigger_message_id WHERE r.id = ?', runId) : null;
  const theirWords = trigger?.content || '';
  for (const url of urls) {
    const r = urlRisk(url, { theirWords });
    if (!r) continue;
    if (r.kind === 'exfil') return r;
    const seen = theirWords.includes(url) || (runId != null && seenInChat(runId, url));
    if (tainted && !seen) return r;
  }
  return null;
}

/**
 * The gate for one concrete call (decisions #13/#14, #124, #126) → { verdict: allow|ask|off, risk, why, taint }.
 *  - Off → off. Reads run. spend/external ask unless granted ("always" = run_id NULL, "this task" = same run); writes ask
 *    when the toolset is on "ask".
 *  - raised: a stricter risk from the tool's riskCheck (the decision model reading the page, #108). It can only add an ask.
 *  - Outbound URLs (web toolset): see outboundRisk. Raised to external; no grant covers it.
 *  - Taint (#124, agent/taint.js): after the task read outside content (low), grants no longer cover spend/external calls
 *    or persistent writes, and persistent writes ask. After a suspected injection (high), every change asks.
 *  - why: one line for the card when it asks where it otherwise wouldn't have.
 */
export function assess(user, tool, args, runId, { raised = null } = {}) {
  const setting = effectivePolicy(user).toolsets[tool.toolset] || 'off';
  if (setting === 'off') return { verdict: 'off', risk: null, why: null, taint: 'none' };
  const taint = runId ? taintOf(runId).level : 'none';
  const tainted = taint !== 'none';
  let risk = raised === 'spend' || raised === 'external' ? raised : riskOf(tool, args, { user, runId });
  const url = tool.toolset === 'web' ? outboundRisk(args, runId, tainted) : null;
  if (url) {
    return { verdict: 'ask', risk: risk === 'spend' ? 'spend' : 'external', taint,
      why: `Asking first because ${url.why}${url.kind === 'data' ? ', and this task read outside content first' : ''}.` };
  }
  const outward = risk === 'spend' || risk === 'external';
  const persistent = risk === 'write' && persistentOf(tool, args, { user, runId });
  let needsAsk = outward || (setting === 'ask' && risk === 'write'), why = null;
  if (!needsAsk && risk === 'write' && taint === 'high') {
    needsAsk = true; why = 'Something this task read was written to AI assistants, so every change asks first.';
  } else if (!needsAsk && persistent && tainted) {
    needsAsk = true; why = 'This keeps working after this task ends, and the task read outside content first.';
  }
  if (!needsAsk) return { verdict: 'allow', risk, why: null, taint };
  const grant = get(`SELECT run_id FROM approval_grants WHERE user_id = ? AND tool = ? AND (run_id IS NULL OR run_id = ?) ORDER BY run_id IS NULL`, user.id, tool.name, runId);
  const grantsCount = !tainted || (!outward && !persistent && taint !== 'high');
  if (grant && grantsCount) return { verdict: 'allow', risk, why: null, taint };
  if (grant && !why) why = `You allowed this ${grant.run_id == null ? 'with “Always allow”' : 'for this task'}, but this task read outside content first, so it asks again.`;
  return { verdict: 'ask', risk, why, taint };
}

/** allow | ask | off for one concrete call (the verdict of assess). */
export const decide = (user, tool, args, runId, opts) => assess(user, tool, args, runId, opts).verdict;

export const grantsOf = userId => all('SELECT * FROM approval_grants WHERE user_id = ? AND run_id IS NULL ORDER BY id DESC', userId);
export const revokeGrant = (userId, id) => run('DELETE FROM approval_grants WHERE id = ? AND user_id = ?', id, userId).changes > 0;
