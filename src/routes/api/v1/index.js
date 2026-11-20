// JSON API v1 — used by the web UI's in-house JS and by the future Android app (Bearer token).
// Documented in docs/API.md. Errors: { error, errors? } with a proper HTTP status.
import { Router } from 'express';
import { authenticate } from '../../web/auth.js';
import { createSession, revokeSession, listSessions } from '../../../services/sessions.js';
import { updateProfile, getUser } from '../../../services/users.js';
import { audit } from '../../../services/audit.js';
import { requireSetup, requireAuth } from '../../../middleware/auth.js';
import { notFound, invalid, tooMany } from '../../../lib/errors.js';
import { renderMarkdown } from '../../../lib/markdown.js';
import { hit } from '../../../lib/ratelimit.js';
import { listForUser, editFact, forgetFact, restoreFact, setPinned, listEpisodes } from '../../../services/memory.js';
import { previewImport, confirmImport } from '../../../services/memory-import.js';
import chatRoutes from './chat.js';
import libraryRoutes from './library.js';
import timeRoutes from './time.js';
import placeRoutes from './places.js';
import feedRoutes from './feed.js';
import goalRoutes from './goals.js';
import browserRoutes from './browser.js';
import uploadRoutes from './uploads.js';
import connectionRoutes from './connections.js';
import projectRoutes from './projects.js';
import voiceRoutes from './voice.js'; // also registers the spoken-reply hook (agent/voice.js)
import decideRoutes from './decide.js';
import listRoutes from './lists.js';
import imageRoutes from './images.js';
import systemRoutes from './system.js';
import lessonRoutes from './lessons.js';
import { oversightOn } from '../../../services/oversight.js';

const router = Router();
router.use(requireSetup);
// ?fragment=1 (the You page): the same data plus `html`, rendered from the page's own partial (one source of markup).
const fragment = (res, partial, data) => new Promise((resolve, reject) =>
  res.render('fragment', { layout: false, partial, data, ...data }, (err, html) => (err ? reject(err) : resolve(html))));

// ---- Auth ---------------------------------------------------------------------------
router.post('/auth/login', async (req, res) => {
  const user = await authenticate(req, req.body);
  const token = createSession(user.id, { kind: 'app', device: String(req.body.device || 'Android app').slice(0, 60), ip: req.ip });
  res.json({ token, user: getUser(user.id) });
});

router.use(requireAuth);

router.post('/auth/logout', (req, res) => {
  revokeSession(req.session.id, req.user.id);
  audit('auth.logout', { actorId: req.user.id, ip: req.ip });
  res.json({ ok: true });
});

// ---- Me -----------------------------------------------------------------------------
// adminsCanRead (decision #219): whether admins may read this person's chats and files (the apps show it, like the web).
router.get('/me', (req, res) => res.json({ user: req.user, adminsCanRead: req.user.role !== 'admin' && oversightOn() }));

router.post('/me/profile', (req, res) => {
  const user = updateProfile(req.user.id, req.body);
  audit('user.profile', { actorId: req.user.id });
  res.json({ ok: true, user });
});

router.get('/me/sessions', (req, res) => res.json({ sessions: listSessions(req.user.id, req.session.id) }));

router.post('/me/sessions/:id/revoke', (req, res) => {
  if (!revokeSession(Number(req.params.id), req.user.id)) throw notFound('That session is already signed out.');
  audit('session.revoke', { actorId: req.user.id, targetType: 'session', targetId: req.params.id });
  res.json({ ok: true });
});

// ---- Memory ("What I remember about you") -----------------------------------------------------
router.get('/me/memories', async (req, res) => {
  const memories = listForUser(req.user);
  res.json({ memories, ...(req.query.fragment === '1' ? { html: await fragment(res, 'me/memory-list', { memories }) } : {}) });
});
router.patch('/me/memories/:id', (req, res) => res.json({ ok: true, memory: editFact(req.user, req.params.id, req.body?.text) }));
router.delete('/me/memories/:id', (req, res) => { forgetFact(req.user, req.params.id); res.json({ ok: true }); });
router.post('/me/memories/:id/restore', (req, res) => res.json({ ok: true, memory: restoreFact(req.user, req.params.id) }));
router.post('/me/memories/:id/pin', (req, res) => { setPinned(req.user, req.params.id, !!req.body?.pinned); res.json({ ok: true }); });
// Import (decision #156): a paste or a .vcf's text → candidates to confirm (nothing saved), then save the chosen ones.
router.post('/me/memories/import/preview', async (req, res) => {
  const l = hit(`mem-import:${req.user.id}`, { limit: 60, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany('Too many imports at once. Give it a minute.');
  const preview = previewImport(req.user, { text: req.body?.text, filename: req.body?.filename });
  res.json({ ...preview, ...(req.query.fragment === '1' ? { html: await fragment(res, 'me/import-preview', { preview }) } : {}) });
});
router.post('/me/memories/import', async (req, res) => res.json({ ok: true, ...(await confirmImport(req.user, req.body?.items)) }));
router.get('/me/episodes', (req, res) => res.json({ episodes: listEpisodes(req.user, { limit: Number(req.query.limit) || 100 }) }));

// ---- Markdown preview (the editors' Preview tab, Phase 15): the same renderer as chat, nothing saved ------------------
router.post('/markdown/preview', (req, res) => {
  const l = hit(`md-preview:${req.user.id}`, { limit: 240, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany('Too many previews — give it a minute.');
  const text = String(req.body?.text ?? '');
  if (text.length > 200_000) throw invalid({ text: 'That’s too long to preview.' });
  res.json({ html: renderMarkdown(text) });
});

router.use('/', chatRoutes);
router.use('/', libraryRoutes);
router.use('/', timeRoutes);
router.use('/', placeRoutes);
router.use('/', listRoutes);
router.use('/', feedRoutes);
router.use('/', goalRoutes);
router.use('/', browserRoutes);
router.use('/', uploadRoutes);
router.use('/', connectionRoutes);
router.use('/', projectRoutes);
router.use('/', voiceRoutes);
router.use('/', decideRoutes);
router.use('/', imageRoutes);
router.use('/', systemRoutes);
router.use('/', lessonRoutes);

// Unknown API routes → JSON 404 (never the HTML error page).
router.use((req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));

export default router;
