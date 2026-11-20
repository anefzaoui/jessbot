// Admin → Personality → Lessons (decisions #186, #188; the screen is Phase 25 #203): the owner reviews household lessons.
// Household lessons wait here as proposals until approved; the owner can edit, reject, retire, write one, or promote one
// that keeps coming back into AGENTS.md (a versioned save). People's personal lessons are theirs and never listed here.
// The page itself is GET /admin/personality/lessons (admin.js, beside the other Personality tabs); these are its JSON
// actions. Every action answers { ok, lesson } and, with ?fragment=1, `html`: the lesson's card rendered from the page's
// own partial (one source of markup). Mounted behind requireAdmin (admin.js).
import { Router } from 'express';
import { get } from '../../db/index.js';
import { listHouseholdLessons, approveLesson, rejectLesson, retireLesson, editHouseholdLesson, createOwnerLesson, promoteLesson, PROMOTE,
  RETIRE_DAYS } from '../../services/lessons.js';
import { audit } from '../../services/audit.js';
import { renderFragment } from '../../views/render.js';

const router = Router();

const SOURCE_LABELS = { pushed: 'From a task that needed pushing', owner: 'Added by an admin', said: 'From something someone said', thumbs_down: 'From a thumbs-down' };
const STATUSES = ['proposed', 'active', 'retired', 'promoted', 'rejected'];

// The task a lesson came from: a link only when that chat is the viewer's own (a member's chats stay theirs); else who and when.
function withRun(l, viewer) {
  const r = l.runId ? get('SELECT r.id, r.thread_id, r.user_id, r.origin_label, r.started_at FROM runs r WHERE r.id = ?', l.runId) : null;
  return { ...l, run: r ? { id: r.id, at: r.started_at, label: r.origin_label || null, href: r.user_id === viewer.id ? `/chat/${r.thread_id}` : null } : null };
}
/** partials/admin/lesson-card.hbs contract: the lesson view plus its run, where it came from and what can be done to it. */
export function lessonCard(l, viewer) {
  const x = withRun(l, viewer);
  const fromName = x.fromName !== undefined ? x.fromName
    : get('SELECT u.name FROM lessons l JOIN users u ON u.id = l.user_id WHERE l.id = ?', x.id)?.name || null;
  return { ...x, fromName, sourceLabel: SOURCE_LABELS[x.source] || null, open: ['proposed', 'active'].includes(x.status),
    promoteNeeds: `${PROMOTE.hits} times in ${PROMOTE.runs} different tasks within ${PROMOTE.days} days`, retireDays: RETIRE_DAYS };
}
export const proposedHouseholdCount = () => get(`SELECT COUNT(*) AS n FROM lessons WHERE scope = 'household' AND status = 'proposed'`).n;

/** The page's data: every household lesson as a card (proposals first), counts per status, and the filter it opens with
 *  (?status=; the page filters in place, so every card is always there). */
export function lessonsPage(viewer, { status = null } = {}) {
  const all = listHouseholdLessons({}).map(l => lessonCard(l, viewer));
  const filter = STATUSES.includes(status) ? status : 'all';
  const counts = Object.fromEntries(STATUSES.map(s => [s, all.filter(l => l.status === s).length]));
  return { lessons: all, filter, counts, total: all.length,
    retireSuggested: all.filter(l => l.retireSuggested).length, promotable: all.filter(l => l.promotable && l.open).length };
}

const pick = (b = {}) => Object.fromEntries(['rule', 'why', 'domain'].filter(k => b[k] !== undefined).map(k => [k, b[k]]));
const done = async (req, res, action, lesson) => {
  audit(`admin.lesson.${action}`, { actorId: req.user.id, targetType: 'lesson', targetId: String(lesson.id) });
  const card = lessonCard(lesson, req.user);
  res.json({ ok: true, lesson: card, waiting: proposedHouseholdCount(),
    ...(req.query.fragment === '1' ? { html: await renderFragment('admin/lesson-card', { lesson: card }, req.user) } : {}) });
};

// ?status=proposed|active|retired|promoted|rejected|all (default all, proposals first).
router.get('/lessons/list', (req, res) => {
  const lessons = listHouseholdLessons({ status: req.query.status || null }).map(l => withRun(l, req.user));
  res.json({ lessons, proposed: lessons.filter(l => l.status === 'proposed').length, retireSuggested: lessons.filter(l => l.retireSuggested).length });
});
router.post('/lessons', (req, res) => done(req, res, 'create', createOwnerLesson(req.user, pick(req.body))));
router.patch('/lessons/:id', (req, res) => done(req, res, 'edit', editHouseholdLesson(req.user, req.params.id, pick(req.body))));
router.post('/lessons/:id/approve', (req, res) => done(req, res, 'approve', approveLesson(req.user, req.params.id, pick(req.body))));
router.post('/lessons/:id/reject', (req, res) => done(req, res, 'reject', rejectLesson(req.user, req.params.id)));
router.post('/lessons/:id/retire', (req, res) => done(req, res, 'retire', retireLesson(req.user, req.params.id)));
router.post('/lessons/:id/promote', (req, res) => done(req, res, 'promote', promoteLesson(req.user, req.params.id)));

export default router;
