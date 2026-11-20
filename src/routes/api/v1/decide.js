// Quick decisions (docs/JEV.md, docs/API.md): the admin's switches and confidence bar, a playground to try the decision
// model, and the recent decisions list. Admin only.
import { Router } from 'express';
import { decide, choice, noul, score, saveDecideSettings, recentDecisions } from '../../../services/decide.js';
import { audit } from '../../../services/audit.js';
import { forbidden, invalid, tooMany, badRequest } from '../../../lib/errors.js';
import { hit } from '../../../lib/ratelimit.js';

const router = Router();
const adminOnly = req => { if (req.user.role !== 'admin') throw forbidden('Only the admin can change quick decisions.'); };
const fragment = (res, partial, data) => new Promise((resolve, reject) =>
  res.render('fragment', { layout: false, partial, data, ...data }, (err, html) => (err ? reject(err) : resolve(html))));

router.post('/admin/decide', (req, res) => {
  adminOnly(req);
  const s = saveDecideSettings(req.body || {});
  audit('decide.settings', { actorId: req.user.id, detail: { model: s.model, confidence: s.confidence, off: Object.keys(s.uses).filter(k => !s.uses[k]) } });
  res.json({ ok: true, settings: s });
});

// Try it: one question about a state, answered live → { answer, ms, cost }.
router.post('/admin/decide/try', async (req, res) => {
  adminOnly(req);
  const l = hit(`decide-try:${req.user.id}`, { limit: 60, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany('Give it a minute before the next try.');
  const state = String(req.body?.state || '').trim().slice(0, 8000);
  const question = String(req.body?.question || '').trim().slice(0, 600);
  const kind = String(req.body?.kind || 'choice');
  const options = String(req.body?.options || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 20);
  const errors = {};
  if (!state) errors.state = 'Describe what’s going on first.';
  if (!question) errors.question = 'Ask one question.';
  if (kind !== 'noul' && options.length < 2) errors.options = kind === 'score' ? 'Give at least two levels, lowest first.' : 'Give at least two options, one per line.';
  if (Object.keys(errors).length) throw invalid(errors);
  const q = kind === 'noul' ? noul(question) : kind === 'score' ? score(question, options)
    : choice(question, Object.fromEntries(options.map((o, i) => [`o${i + 1}`, o])));
  const out = await decide('try', { user: req.user, state, questions: { q }, timeoutMs: 8000 });
  if (!out) throw badRequest('The decision model didn’t answer — check the key and model id in Admin → Models, then try again.');
  const a = out.answers.q || {};
  const label = key => (kind === 'choice' ? options[Number(String(key).slice(1)) - 1] : kind === 'score' ? options[Number(key)] : key);
  const bars = kind === 'noul' ? [{ label: 'Yes', p: Number(a.noul) || 0, top: (Number(a.noul) || 0) >= 0.5 }, { label: 'No', p: 1 - (Number(a.noul) || 0), top: (Number(a.noul) || 0) < 0.5 }]
    : Object.entries(a.probabilities || {}).map(([k, p]) => ({ label: label(k), p: Number(p) || 0,
      top: kind === 'choice' ? k === a.choice : Number(k) === Math.round(Number(a.score) || 0) })).sort((x, y) => (kind === 'score' ? 0 : y.p - x.p));
  const summary = kind === 'noul' ? `${Math.round((Number(a.noul) || 0) * 100)}% yes`
    : kind === 'score' ? `${label(Math.round(Number(a.score) || 0))} (score ${Number(a.score).toFixed(2)})` : `${label(a.choice)}`;
  res.json({ summary, confidence: a.confidence ?? null, bars, ms: out.ms, cost: out.cost });
});

router.get('/admin/decide/recent', async (req, res) => {
  adminOnly(req);
  const decisions = recentDecisions(25);
  res.json({ decisions, html: await fragment(res, 'admin/decisions-list', { decisions }) });
});

export default router;
