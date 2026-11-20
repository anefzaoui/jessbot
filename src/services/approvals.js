// Approvals queue (decision #14): a paused tool call waiting for a human OK.
// Routing: the person themself, or the admin when their policy says approver = admin.
// Unanswered → expires after APPROVAL_TTL and counts as denied (safe default).
import { get, all, run } from '../db/index.js';
import { publish } from '../lib/bus.js';
import { effectivePolicy, riskOf } from './policy.js';
import { getUser } from './users.js';
import { forbidden, notFound, badRequest, HttpError } from '../lib/errors.js';
import { toIso } from './chatview.js';
import { displayNameOf } from '../agent/tools/registry.js';
import { provenanceOf, taintOf } from '../agent/taint.js';
import { argText, maskShapes, shapeFlags, urlsIn } from '../lib/dlp.js';

const TTL_HOURS = Number(process.env.JESSBOT_APPROVAL_TTL_HOURS) || 24;
// The person approves what is actually sent (decision #127): previews carry the full text up to this many characters;
// anything longer says exactly where it was cut. Tools' approvalPreview return the whole text; only this caps it.
export const PREVIEW_MAX = 20_000;
// Longer than this and the card folds the preview (its first lines stay readable; "Show all" opens the rest).
export const PREVIEW_FOLD_CHARS = 600, PREVIEW_FOLD_LINES = 10;

/** The preview text, capped at PREVIEW_MAX with an explicit marker: "(cut at 20,000 of 25,310 characters)". */
export function clipPreview(text, max = PREVIEW_MAX) {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  const n = v => v.toLocaleString('en-US');
  return `${t.slice(0, max)}\n\n(cut at ${n(max)} of ${n(t.length)} characters)`;
}

// Can it be undone, and who does it reach (decision #127)? Tools may declare `undo: { possible, note }` and `reach: '…'`,
// each also as a function (args, { user, runId }): the task lets a tool look at what it acts on, e.g. browser_upload names
// the site the tab is really on (#209); otherwise the defaults follow the risk: a payment or anything sent out can't be
// taken back, a change inside the app can.
const UNDO_BY_RISK = {
  spend: { possible: false, note: 'a payment can’t be taken back from here' },
  external: { possible: false, note: 'once it has gone out, it can’t be called back' },
  write: { possible: true, note: 'you can change or delete it later' },
};
const pick = (v, args, ctx) => (typeof v === 'function' ? v(args, ctx) : v);
export function undoOf(tool, args, risk, ctx = {}) {
  const u = pick(tool.undo, args, ctx) ?? UNDO_BY_RISK[risk] ?? null;
  return u ? { possible: !!u.possible, note: u.note ? String(u.note).slice(0, 200) : null } : null;
}
export function reachOf(tool, args, risk, ctx = {}) {
  const declared = pick(tool.reach, args, ctx);
  if (declared) return String(declared).slice(0, 200);
  if (risk === 'write' || risk === 'read') return 'only you';
  if (tool.toolset === 'web') {
    const host = urlsIn(args).map(u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }).find(Boolean);
    return host ? `the website ${host}` : 'the website open in the browser';
  }
  return 'people or services outside this app';
}

// The facts a tool lays out beside its preview (decision #194): approvalFacts(args, ctx) → [{ key, label, value?, items? }].
// Each is cleaned here (short, masked like the preview), so a tool can't put a secret or a wall of text on the card.
const FACTS_MAX = 6, ITEMS_MAX = 12;
const factText = (v, n) => maskShapes(String(v ?? '').replace(/\s+/g, ' ').trim()).slice(0, n);
export function factsOf(tool, args, ctx = {}) {
  if (typeof tool.approvalFacts !== 'function') return [];
  let raw;
  try { raw = tool.approvalFacts(args, ctx); } catch { return []; } // a fact that can't be worked out is left off, never blocks the ask
  return (Array.isArray(raw) ? raw : []).slice(0, 20).flatMap(f => {
    const label = factText(f?.label, 40);
    const value = factText(f?.value, 300) || null;
    const items = (Array.isArray(f?.items) ? f.items : []).slice(0, ITEMS_MAX)
      .map(i => ({ title: factText(i?.title, 120), meta: factText(i?.meta, 80) || null, href: /^\/library\/[\w-]+$/.test(i?.href || '') ? i.href : null }))
      .filter(i => i.title);
    if (!label || (!value && !items.length)) return [];
    return [{ key: factText(f?.key, 30).replace(/[^\w-]/g, '') || 'fact', label, value, items }];
  }).slice(0, FACTS_MAX);
}

/**
 * Pause a call for a person's OK. risk: the gate's effective risk (policy.assess; a riskCheck or the outbound guard may
 * have raised it); raised: the same, older name. why: the gate's line when it asks where it otherwise wouldn't have.
 * Stored with it: provenance (what the task read first, agent/taint.js), secret-looking things in the call (lib/dlp.js,
 * masked in the preview too), undo and reach.
 */
export function createApproval({ run: r, user, tool, args, toolCallId, raised = null, risk: gateRisk = null, why = null }) {
  const policy = effectivePolicy(user);
  const admin = get(`SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1`);
  const approverId = policy.approver === 'admin' && user.role !== 'admin' && admin ? admin.id : user.id;
  const risk = gateRisk || raised || riskOf(tool, args, { user, runId: r.id }); // raised: the decision model found it pays or sends
  // ctx: whose request it is, so a preview can check ownership (never shows the title of someone else's Library item).
  const ctx = { user, runId: r.id };
  const title = tool.approvalTitle ? tool.approvalTitle(args, ctx) : `Use ${tool.name}`;
  const preview = clipPreview(maskShapes(tool.approvalPreview ? tool.approvalPreview(args, ctx) : JSON.stringify(args, null, 2)));
  const flags = shapeFlags(argText(args));
  const undo = undoOf(tool, args, risk, ctx);
  const facts = factsOf(tool, args, ctx);
  const provenance = provenanceOf(r.id);
  const { lastInsertRowid } = run(
    `INSERT INTO approvals (run_id, thread_id, user_id, approver_id, tool_call_id, tool, risk, title, preview, args, expires_at,
       provenance, ask_reason, flags, undoable, undo_note, reach, facts, provenance_level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+${TTL_HOURS} hours'), ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.id, r.thread_id, user.id, approverId, toolCallId, tool.name, risk, maskShapes(title).slice(0, 200), preview, JSON.stringify(args),
    provenance, why ? String(why).slice(0, 300) : null, flags.length ? JSON.stringify(flags) : null,
    undo ? (undo.possible ? 1 : 0) : null, undo?.note || null, reachOf(tool, args, risk, ctx), facts.length ? JSON.stringify(facts) : null,
    provenance ? taintOf(r.id).level : null);
  return getApproval(Number(lastInsertRowid));
}

export const getApproval = id => get('SELECT * FROM approvals WHERE id = ?', id) || null;
export const pendingCount = userId => get(`SELECT COUNT(*) AS n FROM approvals WHERE approver_id = ? AND status = 'pending'`, userId).n;
export const latestForRun = runId => get('SELECT * FROM approvals WHERE run_id = ? ORDER BY id DESC LIMIT 1', runId) || null;

export function approvalView(a, viewer) {
  if (!a) return null;
  const requester = viewer && a.user_id !== viewer.id ? getUser(a.user_id) : null;
  let flags = [], facts = [];
  try { flags = JSON.parse(a.flags || '[]'); } catch { /* none */ }
  try { facts = JSON.parse(a.facts || '[]'); } catch { /* none */ }
  return {
    id: a.id, title: a.title, tool: a.tool, toolLabel: displayNameOf(a.tool), risk: a.risk, preview: a.preview, requestedAt: toIso(a.created_at),
    status: a.status, scope: a.scope, requester: requester ? { name: requester.name } : null,
    threadHref: viewer && a.user_id === viewer.id ? `/chat/${a.thread_id}` : null,
    // Decision #124–#127: what the task read first, why it asks, secret-looking things in it, undo and reach.
    previewChars: a.preview ? a.preview.length : 0, provenance: a.provenance || null, askReason: a.ask_reason || null, flags,
    // #194: how outside content marked the task when it asked (high: some of it was written to steer AI assistants), and the
    // tool's facts (who, what's attached, a picture's shape). Rows from before migration 048: 'low' when there's a provenance.
    provenanceLevel: a.provenance ? (a.provenance_level === 'high' ? 'high' : 'low') : null, facts,
    // The preview is long: the card shows the start and a "Show all" (the full text is always there).
    previewLong: !!a.preview && (a.preview.length > PREVIEW_FOLD_CHARS || a.preview.split('\n').length > PREVIEW_FOLD_LINES),
    // The panel and the history show less: past four lines (or ~250 characters) they fold too.
    previewFoldsCompact: !!a.preview && (a.preview.length > 250 || a.preview.split('\n').length > 4),
    undo: a.undoable == null ? null : { possible: !!a.undoable, note: a.undo_note || null }, reach: a.reach || null,
    reachShown: !!a.reach && !facts.some(f => f.key === 'to'), // an email's "To" fact already says who it reaches
    // After outside content, "Allow for this task" no longer covers what asked (policy.assess): the card doesn't offer it.
    taskScope: !a.provenance,
    // Why an expired request closed (Phase 19): the card says "Expired: you moved on" rather than "denied automatically".
    closedReason: a.status === 'expired' ? a.closed_reason || 'timeout' : null, resultLabel: resultLabel(a),
  };
}

// The line a decided card shows (UI copy: no em-dashes, #116).
const CLOSED = { timeout: 'Expired, not done', moved_on: 'Expired: you moved on, so it was not done', run_closed: 'Closed: that task had ended, not done' };
export function resultLabel(a) {
  if (!a || a.status === 'pending') return null;
  if (a.status === 'expired') return CLOSED[a.closed_reason] || CLOSED.timeout;
  return a.status === 'approved' ? 'Approved' : 'Denied';
}

export const pendingFor = viewer => all(`SELECT * FROM approvals WHERE approver_id = ? AND status = 'pending' ORDER BY id DESC`, viewer.id).map(a => approvalView(a, viewer));
export const historyFor = (viewer, limit = 20) => all(`SELECT * FROM approvals WHERE (approver_id = ? OR user_id = ?) AND status != 'pending' ORDER BY id DESC LIMIT ?`, viewer.id, viewer.id, limit).map(a => approvalView(a, viewer));

// Record a decision. Returns the updated row (the caller resumes the run).
export function decideApproval(id, decider, { decision, scope = 'once', reason = null }) {
  const a = getApproval(Number(id));
  if (!a) throw notFound('That request is gone.');
  if (a.approver_id !== decider.id && decider.role !== 'admin') throw forbidden('This request is waiting for someone else.');
  // Closed with its task (a new message, Stop, a failure): deciding it now can't run anything, so say so plainly instead
  // of showing "Approved" for a call that will never happen (Phase 19).
  if (a.status === 'expired' && a.closed_reason === 'moved_on') throw closedError(a, 'This request closed when you sent a new message, so nothing was done. Ask me again in the chat if you still want it.');
  if (a.status === 'expired' && a.closed_reason === 'run_closed') throw closedError(a, 'That task had already ended, so this request closed and nothing was done. Ask me again in the chat if you still want it.');
  if (a.status !== 'pending') throw badRequest(`Already ${a.status}.`);
  if (get('SELECT status FROM runs WHERE id = ?', a.run_id)?.status !== 'waiting') {
    const closed = closeApproval(a, 'run_closed');
    throw closedError(closed, 'That task had already ended, so this request closed and nothing was done. Ask me again in the chat if you still want it.');
  }
  const status = decision === 'approve' ? 'approved' : 'denied';
  const sc = ['once', 'task', 'always'].includes(scope) ? scope : 'once';
  run(`UPDATE approvals SET status = ?, scope = ?, reason = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`,
    status, status === 'approved' ? sc : null, reason ? String(reason).slice(0, 300) : null, decider.id, a.id);
  if (status === 'approved' && sc !== 'once') {
    run('INSERT INTO approval_grants (user_id, tool, run_id, created_by) VALUES (?, ?, ?, ?)', a.user_id, a.tool, sc === 'task' ? a.run_id : null, decider.id);
  }
  const updated = getApproval(a.id);
  announce(updated);
  return updated;
}

// Tell the requester and the approver (every screen) — cards and badges update live.
export function announce(a) {
  for (const uid of new Set([a.user_id, a.approver_id])) {
    publish(uid, 'approval.updated', { approvalId: a.id, status: a.status, closedReason: a.status === 'expired' ? a.closed_reason || 'timeout' : null,
      label: resultLabel(a), pendingCount: pendingCount(uid) }, { threadId: a.thread_id, runId: a.run_id });
  }
}

// A 409 with code approval_closed: a page showing a stale card paints it closed (not back to "pending").
const closedError = (a, message) => new HttpError(409, message, { code: 'approval_closed' });

export const expiredApprovals = () =>
  all(`SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= datetime('now')`);

/** Nobody decided in time (TTL): treated as denied. */
export const expireApproval = a => closeApproval(a, 'timeout');

/** Close a pending request without a decision. reason: 'timeout' | 'moved_on' (a new message) | 'run_closed' (its task ended). */
export function closeApproval(a, reason = 'timeout') {
  run(`UPDATE approvals SET status = 'expired', closed_reason = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'`, reason, a.id);
  const updated = getApproval(a.id);
  announce(updated);
  return updated;
}

/** Every pending request of a run, closed with it. Returns the closed rows (the loop tells the model about each). */
export function closeApprovalsOfRun(runId, reason) {
  return all(`SELECT * FROM approvals WHERE run_id = ? AND status = 'pending'`, runId).map(a => closeApproval(a, reason));
}

/** Record the intent right before an approved call goes out: a restart after this point is an unknown outcome. */
export function markExecuting(id) {
  run(`UPDATE approvals SET executing_at = datetime('now') WHERE id = ?`, id);
  return getApproval(id);
}
