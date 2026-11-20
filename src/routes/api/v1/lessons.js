// Lessons and the weekly memory tidy, the person's side (decisions #186–#189; docs/API.md). The screens are Phase 25 (You →
// Memory: "How I work with you" and the tidy's changes with Undo). The owner's review of household lessons is under /admin.
import { Router } from 'express';
import { listPersonLessons, personLessonsView, editPersonLesson, deletePersonLesson } from '../../../services/lessons.js';
import { listTidies, undoTidyChange } from '../../../services/memory.js';
import { renderFragment } from '../../../views/render.js';
import { notFound } from '../../../lib/errors.js';

const router = Router();

// ---- Their lessons ------------------------------------------------------------------------------------------------------
// ?fragment=1 (You → Memory, Phase 25 #204): the same data plus `html`, the section's own partial (one source of markup).
router.get('/me/lessons', async (req, res) => {
  if (req.query.fragment !== '1') return res.json({ lessons: listPersonLessons(req.user) });
  const lessons = personLessonsView(req.user);
  res.json({ lessons, html: await renderFragment('me/lessons', { lessons }, req.user) });
});
// Edit wording ({ rule, why }), keep a proposed one ({ status: 'active' }) or retire one ({ status: 'retired' }).
router.patch('/me/lessons/:id', (req, res) => {
  const b = req.body || {};
  const input = Object.fromEntries(['rule', 'why', 'status'].filter(k => b[k] !== undefined).map(k => [k, b[k]]));
  res.json({ ok: true, lesson: editPersonLesson(req.user, req.params.id, input) });
});
// The "Keep" on a thumbs-down's "Noted: …" chip.
router.post('/me/lessons/:id/keep', (req, res) => res.json({ ok: true, lesson: editPersonLesson(req.user, req.params.id, { status: 'active' }) }));
// Removed for good; { reject: true } on a proposal (the chip's "No") keeps it only so the same guess isn't made again.
router.delete('/me/lessons/:id', (req, res) => res.json(deletePersonLesson(req.user, req.params.id, { reject: req.body?.reject === true || req.query.reject === '1' })));

// ---- The weekly memory tidy -------------------------------------------------------------------------------------------
router.get('/me/memory-tidies', (req, res) => res.json({ tidies: listTidies(req.user, { limit: Number(req.query.limit) || 10 }) }));
// ?fragment=1: plus `html`, the tidy's card on You → Memory (partials/me/tidy.hbs), re-rendered after an Undo.
router.get('/me/memory-tidies/:id', async (req, res) => {
  const [tidy] = listTidies(req.user, { id: req.params.id });
  if (!tidy) throw notFound('That tidy no longer exists.');
  res.json({ tidy, ...(req.query.fragment === '1' ? { html: await renderFragment('me/tidy', { tidy, open: true }, req.user) } : {}) });
});
router.post('/me/memory-tidies/changes/:id/undo', (req, res) => res.json(undoTidyChange(req.user, req.params.id)));

export default router;
