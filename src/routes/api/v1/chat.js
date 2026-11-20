// Chat API (docs/API.md). Responses carry server-rendered fragments so the page never builds markup itself.
import { Router } from 'express';
import { get, run as sql } from '../../../db/index.js';
import { mainThread, createSideThread, threadForViewer, renameThread, deleteThread, threadsOfUser, setOffRecord } from '../../../services/threads.js';
import { findByClientId, deletionPlan, deleteMessages, addMessage } from '../../../services/messages.js';
import { forgetFact } from '../../../services/memory.js';
import { audit } from '../../../services/audit.js';
import { getRun } from '../../../services/runs.js';
import { assistantView, userView, timeline } from '../../../services/chatview.js';
import { questionForUser, validateAnswers, saveAnswers, questionView, describeAnswers, expireQuestion } from '../../../services/questions.js';
import { cancelRun, resumeWithAnswer, resumeAfterApproval, startTurn, retryRun } from '../../../agent/loop.js';
import { decideApproval, pendingCount, pendingFor, historyFor } from '../../../services/approvals.js';
import { itemForUser, modelImage } from '../../../services/library.js';
import { activityDays, todaySummary } from '../../../services/activity.js';
import { compact } from '../../../services/context.js';
import { publish } from '../../../lib/bus.js';
import { hit } from '../../../lib/ratelimit.js';
import { postMortem, withdrawGuess } from '../../../agent/lessons.js'; // also registers the pushed-task lesson hook
import { invalid, notFound, badRequest } from '../../../lib/errors.js';
import { SIMPLER_TEXT, addSimplerNote, lastNudgeAt, nudgeAllowed } from '../../../services/reply-actions.js';

const router = Router();
const MAX_TEXT = 20_000;

const fragment = (res, partial, data) => new Promise((resolve, reject) =>
  res.render('fragment', { layout: false, partial, data, ...data }, (err, html) => (err ? reject(err) : resolve(html))));

const resolveThread = (req, write) => (req.params.id === 'main'
  ? { thread: mainThread(req.user.id), asAdmin: false }
  : threadForViewer(req.params.id, req.user, { write, ip: req.ip }));

// The person's chats (main first) and one chat's history as data — what an app needs to draw a conversation (#87).
router.get('/threads', (req, res) => {
  mainThread(req.user.id); // exists from the first visit on
  res.json({ threads: threadsOfUser(req.user.id).map(t => ({ id: t.kind === 'main' ? 'main' : t.id, kind: t.kind, title: t.kind === 'main' ? 'Main' : t.title, offRecord: !!t.no_memory,
    // Follow-up questions (#196): when a reply here last ended with them, and whether one may now (the main chat: once a day).
    lastNudgeAt: lastNudgeAt(t.id), nudgeAllowed: nudgeAllowed(t.id),
    lastActivityAt: t.last_activity_at ? new Date(`${t.last_activity_at.replace(' ', 'T')}Z`).toISOString() : null })) });
});

// Latest `limit` messages (≤ 200), oldest first. Assistant messages carry markdown + html, their run's steps, and any
// pending question / approval; user messages carry their text and attached files.
router.get('/threads/:id/messages', (req, res) => {
  const { thread } = resolveThread(req, false);
  const t = timeline(thread, req.user, { limit: Math.min(200, Math.max(1, Number(req.query.limit) || 80)) });
  res.json({ threadId: thread.kind === 'main' ? 'main' : thread.id, running: t.running, pendingQuestion: t.pendingQuestion,
    messages: t.days.flatMap(d => d.messages.map(m => ({ ...m, day: d.label }))) });
});

// Send a message → user bubble + a queued reply bubble; the run streams over the WebSocket.
router.post('/threads/:id/messages', async (req, res) => {
  // "Simpler" on a reply (#196): the visible turn is the canned sentence (unless the app sent its own words) and a hidden note
  // asks for plain words; the note is added server side, never taken from the client.
  const simpler = req.body?.simpler === true;
  const text = String(req.body?.text ?? '').trim() || (simpler ? SIMPLER_TEXT : '');
  // Attached files: the person's own Library items (uploads), at most six, in order.
  const attachments = [...new Set((Array.isArray(req.body?.attachments) ? req.body.attachments : []).map(String))].slice(0, 6);
  const files = attachments.map(id => itemForUser(req.user, id, { write: true }));
  if (!text && !attachments.length) throw invalid({ text: 'Type a message first.' });
  if (text.length > MAX_TEXT) throw invalid({ text: `That's a lot — keep it under ${MAX_TEXT.toLocaleString()} characters.` });
  const { thread } = resolveThread(req, true);
  const clientId = String(req.body?.clientId || '').slice(0, 64) || null;
  // An image from before model copies existed gets its copy now, so the reply's first model call already sends it (#201).
  // Awaited before the clientId check, which stays in the same tick as startTurn (no double turn from a retried send).
  await Promise.all(files.filter(i => i.type === 'image').map(i => modelImage(i)));

  // Idempotent: a retried send with the same clientId returns the original.
  const existing = findByClientId(thread.id, clientId);
  if (existing) {
    const r = get('SELECT * FROM runs WHERE trigger_message_id = ? ORDER BY id DESC LIMIT 1', existing.id);
    return res.json({ messageHtml: await fragment(res, 'chat/message', userView(existing)),
      runHtml: r ? await fragment(res, 'chat/message', assistantView(r)) : null, runId: r?.id, threadId: thread.id });
  }

  if (simpler) addSimplerNote(thread.id, addMessage);
  const { msg, run: r } = startTurn({ user: req.user, thread, text, clientId, attachments });
  res.json({
    messageHtml: await fragment(res, 'chat/message', userView(msg)),
    runHtml: await fragment(res, 'chat/message', assistantView(getRun(r.id))),
    runId: r.id, threadId: thread.id,
  });
});

router.post('/runs/:id/cancel', (req, res) => {
  const r = getRun(Number(req.params.id));
  if (!r || r.user_id !== req.user.id) throw notFound('That task is gone.');
  res.json({ ok: cancelRun(r.id) });
});

// Retry a failed/cancelled run: a fresh run for the same message.
router.post('/runs/:id/retry', async (req, res) => {
  const old = getRun(Number(req.params.id));
  if (!old || old.user_id !== req.user.id) throw notFound('That task is gone.');
  if (!['error', 'cancelled'].includes(old.status)) throw badRequest('That task is still going.');
  if (old.hidden) throw badRequest('That was already retried — the newer reply is below.');
  // The new run REPLACES the failed one (hidden everywhere, so its error bubble and Retry button can't linger; open pages
  // swap it in place). Same trigger message, so the #114 guard spans both attempts: nothing that went out is redone.
  const { run: r, runHtml } = await retryRun(old.id);
  res.json({ runId: r.id, oldRunId: old.id, runHtml });
});

// Answers for ask_user → saved, card swapped to "answered", the paused run continues.
router.post('/questions/:id/answer', async (req, res) => {
  const q = questionForUser(req.params.id, req.user);
  if (q.status === 'expired') throw badRequest('That question is closed — just tell me in the chat.');
  if (q.status !== 'pending') throw badRequest('That question was already answered.');
  if (getRun(q.run_id)?.status !== 'waiting') { // its reply was stopped: nothing is waiting for the answer any more
    expireQuestion(q.id);
    throw badRequest('That reply was stopped, so this question is closed — just tell me in the chat.');
  }
  const answers = validateAnswers(q, req.body?.answers);
  const saved = saveAnswers(q.id, answers);
  const text = describeAnswers(saved).map(a => `${a.header} — ${a.question}: ${a.display}`).join('\n');
  resumeWithAnswer(saved.run_id, saved.tool_call_id, `The person answered:\n${text}`);
  res.json({ ok: true, cardHtml: await fragment(res, 'chat/question-card', questionView(saved)) });
});

// Approvals: decide → the paused run continues (approved: the exact stored call runs; denied: the model is told).
router.post('/approvals/:id', async (req, res) => {
  const a = decideApproval(req.params.id, req.user, { decision: req.body?.decision, scope: req.body?.scope, reason: req.body?.reason });
  resumeAfterApproval(a.id).catch(e => console.error('[approvals] resume failed', e));
  res.json({ status: a.status, pendingCount: pendingCount(req.user.id) });
});
router.get('/approvals', (req, res) => res.json({ pending: pendingFor(req.user), history: historyFor(req.user) }));
router.get('/activity', (req, res) => res.json({ days: activityDays(req.user, { days: Math.min(Number(req.query.days) || 14, 90) }), today: todaySummary(req.user) }));

// Side chats
router.post('/threads', (req, res) => {
  const t = createSideThread(req.user.id, req.body?.title || 'New side chat');
  res.json({ ok: true, threadId: t.id, redirect: `/chat/${t.id}` });
});
router.post('/threads/:id/rename', (req, res) => {
  const { thread } = resolveThread(req, true);
  renameThread(thread, req.body?.title);
  res.json({ ok: true });
});
// Off the record (decision #123): nothing from this chat becomes a memory while it's on. Side chats only.
router.post('/threads/:id/off-record', (req, res) => {
  const { thread } = resolveThread(req, true);
  if (typeof req.body?.on !== 'boolean') throw invalid({ on: 'Say on: true or on: false.' });
  const t = setOffRecord(thread, req.body.on);
  res.json({ ok: true, offRecord: !!t.no_memory });
});
router.post('/threads/:id/delete', (req, res) => {
  const { thread } = resolveThread(req, true);
  deleteThread(thread);
  res.json({ ok: true, redirect: '/chat' });
});

// Force a compaction now (the context meter's "Compact now").
router.post('/threads/:id/compact', async (req, res) => {
  const { thread } = resolveThread(req, true);
  const done = await compact(thread);
  res.json({ ok: true, compacted: done, message: done ? 'Older parts of this chat are now summarized.' : 'Nothing to summarize yet — this chat is still short.' });
});

// Deleting a message (decision #50): preview what goes (replies, memories learned from it), then delete for real.
function planFor(req) {
  const plan = deletionPlan(req.user, req.params.id);
  if (!plan) throw notFound('That message is already gone.');
  if (plan.runIds.length && get(`SELECT 1 FROM runs WHERE id IN (${plan.runIds.map(() => '?').join(',')}) AND status IN ('queued', 'running', 'waiting')`, ...plan.runIds)) {
    throw badRequest('Jess is still working on this — stop the reply first, then delete it.');
  }
  return plan;
}

router.get('/messages/:id/deletion', (req, res) => {
  const plan = planFor(req);
  res.json({ role: plan.message.role, replies: plan.replies, memories: plan.memories, messageIds: plan.messageIds, runIds: plan.runIds });
});

router.delete('/messages/:id', (req, res) => {
  const plan = planFor(req);
  deleteMessages(plan);
  let forgotten = 0;
  if (req.body?.forgetMemories) for (const m of plan.memories) { try { forgetFact(req.user, m.id, `user:${req.user.id}`); forgotten++; } catch { /* already gone */ } }
  audit('message.delete', { actorId: req.user.id, targetType: 'thread', targetId: plan.threadId, detail: { messages: plan.messageIds.length, forgotten } });
  publish(req.user.id, 'messages.deleted', { messageIds: plan.messageIds, runIds: plan.runIds }, { threadId: plan.threadId });
  res.json({ ok: true, messageIds: plan.messageIds, runIds: plan.runIds, forgotten });
});

// Thumbs up / down (+ an optional "What was off?" `note` with a thumbs-down). A thumbs-down on a reply gets one cheap
// post-mortem (decision #187): { ok, lesson, chip: { text: "Noted: …", rule, lessonId, keep }, html } when there is something to
// learn (keep: it's a guess, waiting for their Keep; html: partials/chat/noted-chip), else lesson, chip and html are null. Taking
// it back withdraws a guess they never kept. { noteFirst: true } (the chat asks "What was off?" first, #211): the thumbs-down is
// saved now and nothing else happens ({ waiting: true }); the post-mortem runs when they send their words or skip.
router.post('/messages/:id/feedback', async (req, res) => {
  const m = get(`SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ? AND t.user_id = ?`, Number(req.params.id), req.user.id);
  if (!m) throw notFound();
  const fb = ['up', 'down'].includes(req.body?.feedback) ? req.body.feedback : null;
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000) : '';
  sql('UPDATE messages SET feedback = ? WHERE id = ?', fb, m.id);
  const none = { ok: true, lesson: null, chip: null, html: null };
  if (fb !== 'down') { withdrawGuess(req.user, m.id); return res.json(none); }
  if (req.body?.noteFirst === true) return res.json({ ...none, waiting: true });
  if (m.role !== 'assistant' || !hit(`lesson-pm:${req.user.id}`, { limit: 30, windowMs: 3600e3 }).allowed) return res.json(none);
  let out = { lesson: null };
  try { out = await postMortem({ user: req.user, message: m, note, signal: AbortSignal.timeout(25_000) }); }
  catch (err) { console.warn('[lessons] post-mortem:', err.message); } // the thumbs-down itself is saved either way
  const chip = out.lesson ? out.chip || null : null;
  res.json({ ok: true, lesson: out.lesson || null, chip, html: chip ? await fragment(res, 'chat/noted-chip', { noted: chip }) : null });
});

export default router;
