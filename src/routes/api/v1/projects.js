// Projects API (docs/PROJECTS.md, docs/API.md). The New project card's actions answer with the re-rendered card;
// everything else answers with data, and open pages re-render from the server over the WebSocket
// (projects.changed → the rail, project.updated → the project panel), so pages never build markup.
import { Router } from 'express';
import * as P from '../../../services/projects.js';
import { threadForViewer } from '../../../services/threads.js';
import { kickoffProject } from '../../../agent/projects.js';
import { renderFragment } from '../../../views/render.js';
import { publish } from '../../../lib/bus.js';
import { audit } from '../../../services/audit.js';
import * as S from '../../../services/project-soul.js';
import { improveSoul, trySoul } from '../../../agent/project-soul.js';
import { get } from '../../../db/index.js';
import { hit } from '../../../lib/ratelimit.js';
import { invalid, tooMany } from '../../../lib/errors.js';
import { renderMarkdown } from '../../../lib/markdown.js';
import { createItem, itemView } from '../../../services/library.js';

const router = Router();
const own = (req, write = true) => P.projectForUser(req.user, req.params.id, { write });
const changed = userId => publish(userId, 'projects.changed', {}, { persist: false });
const touched = (userId, p) => publish(userId, 'project.updated', { id: p.public_id }, { persist: false });
const card = async (req, p) => {
  const proposal = p.created_run_id ? P.proposalOfRun(p.created_run_id) : null;
  return proposal ? renderFragment('projects/proposal-card', { proposal }, req.user) : null;
};

router.get('/projects', (req, res) => res.json({
  projects: P.listProjects(req.user.id).map(P.projectView), archived: P.listProjects(req.user.id, { archived: true }).map(P.projectView),
  fields: Object.entries(P.FIELDS).map(([value, f]) => ({ value, label: f.label })), icons: P.ICONS,
}));

router.get('/projects/:id', (req, res) => {
  const p = own(req, false);
  res.json({ ...P.projectPanel(p), brief: P.renderBrief(p, { ids: false }) });
});

// The New project card: Create (the draft becomes a project; Jess opens its chat) or Not now.
router.post('/projects/:id/create', async (req, res) => {
  let p = own(req);
  if (p.status === 'draft') {
    p = P.confirmDraft(p);
    kickoffProject(req.user, p);
    changed(req.user.id);
  }
  res.json({ project: P.projectView(p), href: `/projects/${p.public_id}`, cardHtml: await card(req, p) });
});
router.post('/projects/:id/dismiss', async (req, res) => {
  const p = own(req);
  P.dismissDraft(p);
  res.json({ ok: true, cardHtml: await card(req, p) });
});

// Name, icon, colour, field, one-line goal, status (drafts too — "Edit first" on the card).
router.post('/projects/:id/edit', async (req, res) => {
  const p = P.editProject(own(req), req.body || {});
  if (p.status !== 'draft') { changed(req.user.id); touched(req.user.id, p); }
  res.json({ project: P.projectView(p), cardHtml: p.status === 'draft' ? await card(req, p) : null });
});

router.delete('/projects/:id', (req, res) => {
  const p = own(req);
  P.deleteProject(p);
  audit('project.delete', { actorId: req.user.id, targetType: 'project', targetId: p.id, detail: { name: p.name } });
  changed(req.user.id);
  res.json({ ok: true, redirect: '/projects' });
});

// The brief, edited by the person: their rows are theirs (Jess never changes them).
router.post('/projects/:id/brief', (req, res) => {
  const p = own(req);
  const item = P.addItem(p, { kind: req.body?.kind, text: req.body?.text, createdBy: 'user' });
  touched(req.user.id, p);
  res.status(201).json({ item });
});
router.post('/projects/:id/brief/:itemId', (req, res) => {
  const p = own(req);
  const item = P.editItemByUser(p, req.params.itemId, { text: req.body?.text, state: req.body?.state });
  touched(req.user.id, p);
  res.json({ item });
});
router.delete('/projects/:id/brief/:itemId', (req, res) => {
  const p = own(req);
  P.deleteItem(p, req.params.itemId);
  touched(req.user.id, p);
  res.json({ ok: true });
});

// ---- The project soul (decision #93): Jess's expertise here. Every save is a version; AI and Jess only propose. -------
const soulOf = p => ({ ...S.soulView(p), editable: S.editableFields(S.activeSoul(p)?.fields || {}) });
function slowDown(req, what, limit) {
  const l = hit(`soul-${what}:${req.user.id}`, { limit, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany(`That's a lot of tries — again in ${Math.ceil(l.retryInMs / 60e3)} min.`);
}
router.get('/projects/:id/soul', (req, res) => res.json(soulOf(own(req, false))));
router.post('/projects/:id/soul', (req, res) => {
  const p = own(req);
  const version = S.saveSoul(p, req.body?.fields || {}, { by: 'user', note: 'Edited by you' });
  touched(req.user.id, p);
  res.json({ version });
});
router.post('/projects/:id/soul/improve', async (req, res) => {
  slowDown(req, 'improve', 8);
  const p = own(req);
  const proposal = await improveSoul(req.user, p);
  touched(req.user.id, p);
  res.status(201).json({ proposal: S.proposalView(proposal, p) });
});
router.post('/projects/:id/soul/proposals/:proposalId', async (req, res) => {
  const p = own(req);
  const decision = req.body?.decision;
  if (!['accept', 'reject'].includes(decision)) throw invalid({ decision: 'Accept or reject.' });
  const out = S.decideProposal(p, req.params.proposalId, decision === 'accept');
  touched(req.user.id, p);
  const prop = S.proposalView(get('SELECT * FROM project_soul_proposals WHERE id = ?', Number(req.params.proposalId)), P.projectById(p.id));
  res.json({ ...out, cardHtml: await renderFragment('projects/soul-proposal', { proposal: prop }, req.user) });
});
router.post('/projects/:id/soul/restore/:version', (req, res) => {
  const p = own(req);
  const version = S.restoreVersion(p, req.params.version);
  touched(req.user.id, p);
  res.json({ version });
});
router.post('/projects/:id/soul/forget', (req, res) => {
  const p = own(req);
  const cur = S.activeSoul(p);
  const note = String(req.body?.note || '');
  if (!cur || !cur.fields.learned.includes(note)) throw invalid({ note: 'That note is already gone.' });
  const version = S.saveSoul(p, { ...cur.fields, learned: cur.fields.learned.filter(x => x !== note) }, { by: 'user', note: `Forgot: ${note}`.slice(0, 300) });
  touched(req.user.id, p);
  res.json({ version });
});
// A preview: how she'd answer one question with the current soul, or with a pending proposal.
router.post('/projects/:id/soul/try', async (req, res) => {
  slowDown(req, 'try', 20);
  const p = own(req, false);
  const question = String(req.body?.question || '').trim();
  if (!question) throw invalid({ question: 'Ask something first.' });
  let fields = S.activeSoul(p)?.fields || {};
  if (req.body?.proposalId) {
    const prop = get(`SELECT * FROM project_soul_proposals WHERE id = ? AND project_id = ?`, Number(req.body.proposalId), p.id);
    if (!prop) throw invalid({ question: 'That proposal is gone.' });
    fields = JSON.parse(prop.fields);
  }
  const answer = await trySoul(req.user, p, fields, question);
  res.json({ answer, html: renderMarkdown(answer) });
});

// Save one of her replies in the project chat as a project file (a plan, a cut list, an analysis worth keeping).
router.post('/projects/:id/save-message', (req, res) => {
  const p = own(req);
  const m = get(`SELECT * FROM messages WHERE id = ? AND thread_id = ? AND role = 'assistant' AND tool_calls IS NULL`, Number(req.body?.messageId), p.thread_id);
  if (!m || !String(m.content || '').trim()) throw invalid({ messageId: 'That reply is gone.' });
  const first = String(m.content).split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').trim()).find(Boolean) || 'Saved reply';
  const item = createItem({ user: req.user, title: first.slice(0, 70), type: 'md', content: m.content, description: 'Saved from the project chat',
    sourceLabel: 'Saved reply', threadId: p.thread_id });
  P.linkItem(p, item.id);
  res.status(201).json({ item: itemView(item) });
});

// "Make this a project": a side chat keeps its history and becomes a project.
router.post('/threads/:id/make-project', (req, res) => {
  const { thread } = threadForViewer(req.params.id, req.user, { write: true });
  const p = P.projectFromThread(req.user, thread, req.body || {});
  changed(req.user.id);
  res.status(201).json({ project: P.projectView(p), redirect: `/projects/${p.public_id}` });
});

export default router;
