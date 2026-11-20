// Admin → System and Usage data (Phase 19 part B, docs/API.md): the wish log (#181), the OpenRouter balance (#179),
// overnight prep's nightly cap (#199), the weekly self-review and "How I'm doing" (#208), and What's new in Jess (#210).
// Admin only, except each person's own unseen What's new notes. The screens are Phase 25.
import { Router } from 'express';
import { wishesView, deleteWish } from '../../../services/wishes.js';
import { balanceView, refreshBalance } from '../../../services/spend-watch.js';
import { audit } from '../../../services/audit.js';
import { prepSettings, savePrepSettings } from '../../../services/prep.js';
import { forbidden, notFound } from '../../../lib/errors.js';
import { selfReviewSettings, saveSelfReviewSettings, recentReviews, runSelfReview, approveProposal, rejectProposal, summaryFor,
  pendingProposals, ownerOf, REVIEW_EVERY_DAYS } from '../../../agent/self-review.js';
import { listEntries, saveLines, publishEntry, discardEntry, draftLines, importPending, importChangelog, unseenFor, markSeen } from '../../../services/whats-new.js';

const router = Router();
const adminOnly = req => { if (req.user.role !== 'admin') throw forbidden('Only the admin can see this.'); };

// "Asked for, can't do yet": the most asked first.
router.get('/admin/wishes', (req, res) => {
  adminOnly(req);
  res.json({ wishes: wishesView({ limit: Math.min(100, Number(req.query.limit) || 30) }) });
});

router.delete('/admin/wishes/:id', (req, res) => {
  adminOnly(req);
  if (!deleteWish(Number(req.params.id))) throw notFound('That wish is already gone.');
  audit('wish.delete', { actorId: req.user.id, targetType: 'wish', targetId: req.params.id });
  res.json({ ok: true });
});

// "Balance $23.67 ≈ 12 days" (cached; ?refresh=1 reads OpenRouter again, a few seconds at most).
router.get('/admin/balance', async (req, res) => {
  adminOnly(req);
  if (req.query.refresh === '1') await refreshBalance({ force: true });
  res.json({ balance: balanceView() });
});

// Overnight prep (#199): what one person's preparation may spend per night (default $0.05; $0 turns it off for everyone).
router.get('/admin/prep', (req, res) => {
  adminOnly(req);
  res.json({ prep: prepSettings() });
});

router.put('/admin/prep', (req, res) => {
  adminOnly(req);
  const prep = savePrepSettings({ dailyCap: req.body?.dailyCap });
  audit('settings.prep', { actorId: req.user.id, targetType: 'settings', targetId: 'prep', detail: prep });
  res.json({ ok: true, prep });
});

// ---- The weekly self-review (#208) ----------------------------------------------------------------------------------------
// The switch (off by default), the latest reviews with their proposals, and this week's numbers so far.
router.get('/admin/self-review', (req, res) => {
  adminOnly(req);
  res.json({ settings: selfReviewSettings(), pending: pendingProposals(), reviews: recentReviews(Math.min(20, Number(req.query.limit) || 5)) });
});

router.put('/admin/self-review', (req, res) => {
  adminOnly(req);
  const s = saveSelfReviewSettings({ enabled: req.body?.enabled });
  audit('settings.self_review', { actorId: req.user.id, targetType: 'settings', targetId: 'selfReview', detail: s });
  res.json({ ok: true, settings: s });
});

// "How I'm doing": the last `days` (1–31, default 7), computed now (no model).
router.get('/admin/self-review/summary', (req, res) => {
  adminOnly(req);
  res.json({ summary: summaryFor(req.query.days || REVIEW_EVERY_DAYS) }); // + days, spendLabel (Phase 25 #212)
});

// Run now (the admin, any time; budget-checked on the owner): waits for the one model call, a few seconds.
router.post('/admin/self-review/run', async (req, res) => {
  adminOnly(req);
  const review = await runSelfReview({ owner: ownerOf(), origin: 'admin' });
  audit('self_review.run', { actorId: req.user.id, targetType: 'self_review', targetId: review.id });
  res.json({ ok: true, review });
});

router.post('/admin/self-review/proposals/:id/approve', (req, res) => {
  adminOnly(req);
  res.json({ ok: true, proposal: approveProposal(req.user, req.params.id) });
});

router.post('/admin/self-review/proposals/:id/reject', (req, res) => {
  adminOnly(req);
  res.json({ ok: true, proposal: rejectProposal(req.user, req.params.id, { reason: req.body?.reason }) });
});

// ---- What's new in Jess (#210) --------------------------------------------------------------------------------------------
router.get('/admin/whats-new', (req, res) => {
  adminOnly(req);
  importPending();
  importChangelog();
  res.json({ entries: listEntries(Math.min(30, Number(req.query.limit) || 10)) });
});

router.put('/admin/whats-new/:id', (req, res) => {
  adminOnly(req);
  res.json({ ok: true, entry: saveLines(req.params.id, req.body?.lines) });
});

router.post('/admin/whats-new/:id/redraft', async (req, res) => {
  adminOnly(req);
  res.json({ ok: true, entry: await draftLines(req.params.id, { user: req.user }) });
});

router.post('/admin/whats-new/:id/publish', (req, res) => {
  adminOnly(req);
  const entry = publishEntry(req.params.id);
  audit('whats_new.publish', { actorId: req.user.id, targetType: 'whats_new', targetId: entry.id });
  res.json({ ok: true, entry });
});

router.post('/admin/whats-new/:id/discard', (req, res) => {
  adminOnly(req);
  res.json({ ok: true, entry: discardEntry(req.params.id) });
});

// Everyone: the published notes they haven't seen (the card, Phase 25), and "seen" once they closed it.
router.get('/whats-new', (req, res) => res.json({ entries: unseenFor(req.user) }));
router.post('/whats-new/:id/seen', (req, res) => res.json(markSeen(req.user, req.params.id)));

export default router;
