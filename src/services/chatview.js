// Chat view models (contracts in partials/chat/message.hbs, run-steps.hbs, question-card.hbs, ask-dock.hbs).
// A reply bubble belongs to a RUN: final text (or the live draft) + its steps + its question.
import { get, all } from '../db/index.js';
import { attachmentViews } from './library.js';
import { renderMarkdown } from '../lib/markdown.js';
import { userMessageHtml } from '../lib/code.js';
import { runView } from './runs.js';
import { questionsOfRun, questionView, getQuestion } from './questions.js';
import { latestForRun, approvalView } from './approvals.js';
import { proposalOfRun, projectById } from './projects.js';
import { proposalView as soulProposalView } from './project-soul.js';
import { replyVoice, noteOf } from './voice.js';
import { splitFollowUps } from '../lib/follow-ups.js';
import { SIMPLER_TEXT } from './reply-actions.js';
import { reminderCard } from './alarms.js';
import { notedFor } from './lessons.js';

export const toIso = v => (v ? new Date(/[TZ]/.test(v) ? v : v.replace(' ', 'T') + 'Z').toISOString() : null);

const soulProposalOfRun = runId => {
  const p = get('SELECT * FROM project_soul_proposals WHERE run_id = ? ORDER BY id DESC LIMIT 1', runId);
  const project = p && projectById(p.project_id);
  return project ? soulProposalView(p, project) : null;
};

export function assistantView(r) {
  const final = get(`SELECT * FROM messages WHERE run_id = ? AND role = 'assistant' AND tool_calls IS NULL ORDER BY id DESC LIMIT 1`, r.id);
  const text = final?.content || r.draft || '';
  const q = questionsOfRun(r.id).at(-1);
  // What she said before using tools or pausing ("I'll look that up…", "Quick question first:") — shown above the steps.
  const lead = all(`SELECT content FROM messages WHERE run_id = ? AND role = 'assistant' AND tool_calls IS NOT NULL AND trim(content) != '' ORDER BY id`, r.id)
    .map(m => m.content).join('\n\n');
  const a = latestForRun(r.id);
  // A finished reply that ends with follow-up questions (#196): the page shows its body and the questions as chips; `markdown`
  // (copy, listen, the API) keeps the whole text.
  const fu = final ? splitFollowUps(text) : { body: text, items: [] };
  return {
    id: final ? `m${final.id}` : `r${r.id}`, messageId: final?.id || null, runId: r.id, role: 'assistant',
    html: fu.body ? renderMarkdown(fu.body) : '', markdown: text || null, followUps: fu.items, simplerText: final ? SIMPLER_TEXT : null, raw: !final && r.draft ? r.draft : null, createdAt: toIso(final?.created_at || r.started_at),
    run: runView(r), question: q ? questionView(q) : null, leadHtml: lead ? renderMarkdown(lead) : '', approval: a ? approvalView(a) : null, feedback: final?.feedback || null,
    proposal: proposalOfRun(r.id), // a project she drafted in this reply (its New project card)
    soulProposal: soulProposalOfRun(r.id), // a change to the project soul she proposed in this reply
    voice: final ? replyVoice(r, final.id) : null, // her voice note of this reply (player), or { pending } while it is made
    reminder: reminderCard(r), // a reminder note's card: Done and its nudges, or a consent request's Yes / No (#205)
    noted: final ? notedFor(r.user_id, final.id) : null, // what a thumbs-down on it taught: the "Noted: …" chip (#211)
  };
}

// A person's text is shown as typed; only code (fenced, or clearly pasted code) becomes a coloured code block.
export const userView = m => ({ id: `m${m.id}`, messageId: m.id, role: 'user', text: m.content, html: userMessageHtml(m.content), createdAt: toIso(m.created_at), delivery: 'sent',
  attachments: m.attachments ? attachmentViews(m.attachments) : null, voice: noteOf(m.id) }); // voice: their voice note (player + transcript)

function dayLabel(iso, timeZone) {
  const fmt = d => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const d = new Date(iso), today = fmt(new Date()), yesterday = fmt(new Date(Date.now() - 864e5));
  if (fmt(d) === today) return 'Today';
  if (fmt(d) === yesterday) return 'Yesterday';
  return new Intl.DateTimeFormat('en', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(d);
}

// Latest ~limit items of a thread, grouped by day in the viewer's timezone.
export function timeline(thread, viewer, { limit = 80 } = {}) {
  const tz = viewer.timezone || undefined;
  const users = all(`SELECT * FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY id DESC LIMIT ?`, thread.id, limit);
  const runRows = all(`SELECT * FROM runs WHERE thread_id = ? AND hidden = 0 ORDER BY id DESC LIMIT ?`, thread.id, limit);
  const items = [
    ...users.map(m => ({ at: toIso(m.created_at), order: m.id * 2, view: userView(m) })),
    ...runRows.map(r => ({ at: toIso(r.started_at), order: (r.trigger_message_id || 0) * 2 + 1, view: assistantView(r) })),
  ].sort((a, b) => (a.at === b.at ? a.order - b.order : a.at < b.at ? -1 : 1)).slice(-limit);

  const days = [];
  for (const it of items) {
    const label = dayLabel(it.at, tz);
    if (days.at(-1)?.label !== label) days.push({ label, messages: [] });
    days.at(-1).messages.push(it.view);
  }
  // Only a question whose run is waiting for it can be answered (a stopped run's question is over).
  const pending = get(`SELECT q.id FROM questions q JOIN runs r ON r.id = q.run_id AND r.status = 'waiting'
    WHERE q.thread_id = ? AND q.status = 'pending' ORDER BY q.id DESC LIMIT 1`, thread.id);
  const running = !!get(`SELECT 1 FROM runs WHERE thread_id = ? AND status IN ('queued', 'running', 'waiting')`, thread.id);
  return { days, pendingQuestion: pending ? questionView(getQuestion(pending.id)) : null, running };
}
