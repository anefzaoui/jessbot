// Admin, Phase 9: Usage (who spends what), System (health check, backups, logs, about) and Model (the brain's settings).
// Mounted inside routes/web/admin.js, so every route here is admin-only.
import fs from 'node:fs';
import { Router } from 'express';
import { settings } from '../../db/index.js';
import { config } from '../../config/index.js';
import { listUsers } from '../../services/users.js';
import { effectivePolicy } from '../../services/policy.js';
import { usageOverview, featureTotals } from '../../services/usage.js';
import { wishesView, wishSummary } from '../../services/wishes.js';
import { doctor, createBackup, listBackups, backupPath, aboutSystem } from '../../services/system.js';
import { recentLog, logFiles, logFilePath } from '../../lib/log.js';
import { llmSettings, testConnection, saveModelSettings, MAX_FALLBACKS, MODEL_ID, onOpenRouter, llmView, providerInput, providerOffers } from '../../services/llm.js';
import { ollamaModels } from '../../services/providers.js';
import { balanceView, refreshBalance } from '../../services/spend-watch.js';
import { prepAdminView } from '../../services/prep.js';
import { selfReviewPage, summaryFor, REVIEW_EVERY_DAYS } from '../../agent/self-review.js';
import { listEntries, importPending, MAX_LINES as WHATS_NEW_MAX_LINES } from '../../services/whats-new.js';
import { VOICES, VOICE_MODELS, DEFAULT_VOICE, SPEEDS, voiceSettings, voiceFor, autoDirection } from '../../services/voice.js';
import { VARIANTS } from '../../services/workspace.js';
import { decideSettings, usesView, recentDecisions, decideSummary, CONFIDENCES } from '../../services/decide.js';
import { imageSettings } from '../../services/images.js';
import { audit } from '../../services/audit.js';
import { renderFragment } from '../../views/render.js';
import { allSkills, setSkill, saveSkill, deleteSkill, skillView, skillReview, lintOf, skillUsage, reviewPage, reviewSummary, RECOMMENDED, CATEGORIES,
  categoryLabel } from '../../services/skills.js';
import { lintSummary } from '../../services/skill-lint.js';
import { triggerTest, estimateTriggerTest, checkTriggerTest, trackTriggerTest, lastTriggerTest } from '../../services/skill-trigger.js';
import { hit } from '../../lib/ratelimit.js';
import { allSources, adminCheckSource, adminRemoveSource } from '../../services/feed-sources.js';
import { TOOLSETS } from '../../services/policy.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { invalid, notFound, tooMany } from '../../lib/errors.js';
import { setSecret } from '../../services/stored-secrets.js';

const router = Router();
const base = { nav: 'admin' };

// ---- Usage -----------------------------------------------------------------------------------------------------
router.get('/usage', (req, res) => {
  const people = listUsers().filter(u => u.status !== 'removed')
    .map(u => ({ id: u.id, name: u.name, role: u.role, status: u.status, budget: effectivePolicy(u).weeklyBudget }));
  // The OpenRouter balance as last read (#179); a stale one is read again in the background for the next visit.
  refreshBalance().catch(() => {});
  res.render('admin/usage', { ...base, title: 'Usage', usage: usageOverview(people), balance: balanceCard(balanceView()), prep: prepAdminView() });
});

// The balance card's words (partials/admin/balance-card.hbs, Phase 25 #203) from spend-watch's balanceView().
const balanceCard = b => (b && b.balance != null ? { ...b, amount: `$${b.balance.toFixed(2)}`,
  daysLine: b.days != null ? `About ${b.days} ${b.days === 1 ? 'day' : 'days'} at this pace` : 'Not enough spending lately to say how long it lasts',
  perDayLabel: `$${(b.perDay || 0).toFixed(2)} a day over the last two weeks` } : b && { ...b, amount: null });

// "Read it now" on that card: OpenRouter is asked again (a few seconds at most), then the card and its gap note re-render.
router.get('/usage/balance', async (req, res) => {
  if (req.query.refresh === '1') await refreshBalance({ force: true });
  const balance = balanceCard(balanceView());
  const [card, gap] = await Promise.all([renderFragment('admin/balance-card', { balance }, req.user), renderFragment('admin/balance-gap', { balance }, req.user)]);
  res.json({ balance, html: card, gapHtml: gap });
});

// ---- System ----------------------------------------------------------------------------------------------------
const levelOf = q => (['info', 'warn', 'error'].includes(q) ? q : 'warn');
router.get('/system', (req, res) => {
  const level = levelOf(req.query.level);
  res.render('admin/system', {
    ...base, title: 'System', health: doctor(), backups: listBackups(), about: aboutSystem(),
    // "Asked for, can't do yet" (#181; the screen is #203): the most asked first. Removing one is DELETE /api/v1/admin/wishes/:id.
    wishes: { list: wishesView({ limit: 50 }), ...wishSummary() },
    log: { level, lines: recentLog({ level, limit: 300 }), files: logFiles() },
    // Phase 25 (#212–#213): the weekly self-review, "How I'm doing", What's new in Jess.
    review: selfReviewPage(), summary: summaryFor(REVIEW_EVERY_DAYS), whatsNew: whatsNewPage(),
  });
});

// The three Phase 25 parts re-render on their own (one source of markup): after Run now (and while a review runs), a period
// switch, and a What's new publish or discard. The actions themselves are /api/v1/admin/self-review… and …/whats-new… (docs/API.md).
const whatsNewPage = () => { importPending(); return { entries: listEntries(10), maxLines: WHATS_NEW_MAX_LINES }; };
router.get('/system/self-review', async (req, res) => {
  const review = selfReviewPage();
  res.json({ running: review.running, pending: review.pending, html: await renderFragment('admin/self-review', { review }, req.user) });
});
router.get('/system/summary', async (req, res) => {
  const summary = summaryFor(req.query.days);
  res.json({ days: summary.days, html: await renderFragment('admin/how-im-doing', { summary }, req.user) });
});
router.get('/system/whats-new', async (req, res) => {
  res.json({ html: await renderFragment('admin/whats-new', { whatsNew: whatsNewPage() }, req.user) });
});

// The health card, re-run on demand.
router.get('/system/health', async (req, res) => {
  const health = doctor();
  res.json({ status: health.status, html: await renderFragment('admin/health', { health }, req.user) });
});

router.post('/system/backups', async (req, res) => {
  const b = await createBackup('manual');
  audit('system.backup', { actorId: req.user.id, detail: { name: b.name, size: b.size } });
  res.json({ ok: true, backup: b, html: await renderFragment('admin/backups', { backups: listBackups() }, req.user) });
});

router.get('/system/backups/:name', (req, res) => {
  const file = backupPath(req.params.name);
  if (!file) throw notFound('That backup is gone.');
  audit('system.backup_download', { actorId: req.user.id, detail: { name: req.params.name } });
  res.download(file, req.params.name);
});

// Live tail: lines after `after` (the page polls while it's open).
router.get('/system/logs', (req, res) => {
  const lines = recentLog({ level: levelOf(req.query.level), q: req.query.q, after: Number(req.query.after) || 0, limit: 300 });
  res.json({ lines });
});

router.get('/system/logs/:file', (req, res) => {
  const file = logFilePath(req.params.file);
  if (!file || !fs.existsSync(file)) throw notFound('That log file is gone.');
  res.download(file, req.params.file);
});

// ---- Model -----------------------------------------------------------------------------------------------------
const modelView = () => {
  const s = llmSettings();
  return { ...llmView(), keyWord: 'Replace the key', defaultBaseUrl: config.llm.baseUrl,
    fallbacks: s.fallbacks.join(', '), fallbackList: s.fallbacks, background: s.background, maxFallbacks: MAX_FALLBACKS,
    onOpenRouter: onOpenRouter(s.baseUrl), offers: { voice: providerOffers('voice'), decisions: providerOffers('decisions'), images: providerOffers('images') } };
};
// Her voice (docs/VOICE.md): which models speak and listen, which voice (Auto = the one that matches her identity) and how.
const voiceView = () => {
  const s = voiceSettings();
  const variant = settings.get('bot', {}).variant || 'female';
  const auto = VOICES.find(v => v.id === (DEFAULT_VOICE[variant] || DEFAULT_VOICE.female));
  return {
    ...s, speaking: voiceFor(s), autoVoice: auto, variantLabel: (VARIANTS[variant] || VARIANTS.female).label.toLowerCase(),
    autoDirection: autoDirection(), models: VOICE_MODELS, speeds: SPEEDS.map(v => ({ value: v, selected: v === s.speed })),
    voices: VOICES.map(v => ({ ...v, selected: s.voice === v.id, matches: v.fits === variant })),
  };
};
// Quick decisions (docs/JEV.md): the decision model, a switch per use, the confidence bar, and what it decided lately.
const decideView = () => {
  const s = decideSettings();
  return { ...s, summary: decideSummary(), groups: usesView(), recent: recentDecisions(25),
    confidences: CONFIDENCES.map(v => ({ value: v, pct: Math.round(v * 100), selected: v === s.confidence })) };
};
router.get('/model', (req, res) => res.render('admin/model', { ...base, title: 'Models', llm: modelView(), voice: voiceView(), decide: decideView(),
  images: { ...imageSettings(), usage: featureTotals().image }, values: {} }));

// One model's tiny test call (Phase 25 #203): each fallback row and the background model show whether it answers before
// the admin saves. Saving still tests every NEW one itself (saveModelSettings); this is the row's own state.
router.post('/model/test', async (req, res) => {
  const model = String(req.body?.model || '').trim();
  if (!MODEL_ID.test(model)) throw invalid({ model: 'Use a model id like anthropic/claude-sonnet.' });
  const l = hit(`model-test:${req.user.id}`, { limit: 20, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany(`That’s a lot of tests: try again in ${Math.ceil(l.retryInMs / 60e3)} min.`);
  const out = await testConnection({ model });
  res.json({ ...out, model, answered: out.model ?? null, cost: out.cost ?? null });
});

// The models an Ollama server has (the picker's model list).
router.get('/model/ollama', async (req, res) => {
  try { res.json({ models: (await ollamaModels(String(req.query.baseUrl || ''))).map(m => m.name) }); }
  catch (err) { res.json({ models: [], error: err.message }); }
});

// Save, then prove it with a real (tiny) call. The key is written to the install's .env only when a new one is given.
router.post('/model', async (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim();
  if (apiKey && (apiKey.length < 20 || /\s/.test(apiKey))) throw invalid({ apiKey: 'That doesn’t look like an API key.' });
  const { provider, baseUrl, model } = providerInput(req.body); // 422 with field errors (provider, address, model)
  const before = llmSettings();
  if (apiKey) setSecret('llm.apiKey', apiKey); // sealed in the database (#10), never written to .env
  // The main model and address are saved as before; the fallback chain and the background model (#179) only once each new
  // one answered a tiny call (422 { errors: { fallbacks | background } } otherwise, those two left as they were).
  if (apiKey) settings.set('llm', { ...(settings.get('llm', {}) || {}), keyFor: new URL(baseUrl).origin }); // this address only (#11)
  const s = await saveModelSettings({ model, baseUrl, provider, fallbacks: req.body?.fallbacks, background: req.body?.background });
  const result = await testConnection();
  audit('admin.model', { actorId: req.user.id, detail: { provider, model, baseUrl, keyChanged: !!apiKey, ok: result.ok, from: before.model, fallbacks: s.fallbacks,
    background: s.background || null } });
  res.json({ ...result, llm: modelView() });
});

// ---- Skills (decision #84; review data #121) ------------------------------------------------------------------------
const skillsPage = (req, extra = {}) => {
  const list = allSkills();
  const usage = skillUsage();
  const skills = list.map(sk => {
    const findings = lintOf(sk, list), view = skillView(sk);
    return { ...view, html: renderMarkdown(sk.body), raw: sk.origin === 'yours' ? sk.body : null, lint: lintSummary(findings),
      checks: reviewSummary(findings), usage: usage.get(sk.name) || { count: 0, lastUsedAt: null }, categoryLabel: categoryLabel(view.category) };
  });
  const count = pred => skills.filter(pred).length;
  // Phase 25 (#195): the filters (status, origin, category, with counts) and the recommended core set still to switch on.
  const categories = [...CATEGORIES.map(c => ({ key: c.key, label: c.label })), { key: 'yours', label: 'Yours' }, { key: 'other', label: 'Other' }]
    .map(c => ({ ...c, count: count(s => s.category === c.key) })).filter(c => c.count);
  const recommended = RECOMMENDED.map(n => skills.find(s => s.name === n)).filter(Boolean);
  return { ...base, title: 'Skills', skills,
    review: count(sk => sk.status === 'review'), broken: count(sk => sk.status === 'broken'),
    statusCounts: { all: skills.length, active: count(s => s.status === 'active'), review: count(s => s.status === 'review'), off: count(s => s.status === 'off'), broken: count(s => s.status === 'broken') },
    origins: { builtIn: count(s => s.origin === 'built-in'), yours: count(s => s.origin === 'yours') }, categories,
    recommended: { total: recommended.length, on: recommended.filter(s => s.status === 'active').length, waiting: recommended.filter(s => s.status !== 'active') },
    toolsetOptions: Object.entries(TOOLSETS).map(([value, t]) => ({ value, label: t.label })), ...extra };
};
router.get('/skills', (req, res) => res.render('admin/skills', skillsPage(req)));

// The review screen (Phase 25, #195): one skill's findings, what changed since approval, usage, who drafted it, the trigger test.
router.get('/skills/:name', (req, res) => {
  const review = reviewPage(req.params.name, req.user);
  res.render('admin/skill-review', { ...base, title: `Skill: ${review.skill.name}`, review, lastTest: lastTriggerTest(review.skill.name) });
});

// The review screen's data for one skill: findings, the diff since approval, usage, who proposed it (docs/API.md).
router.get('/skills/:name/review', (req, res) => res.json(skillReview(req.params.name, req.user)));

// Trigger test (#173): { queries?: [{ text, expect: 'use'|'skip' }], runs?: 1–3, suggest?: bool, dryRun?: bool }. A dry run
// returns the requests and the estimated cost without calling the model; a real run spends tokens, so it is rate-limited.
router.post('/skills/:name/trigger-test', async (req, res) => {
  const b = req.body || {};
  const opts = { queries: b.queries, runs: b.runs ?? undefined, suggest: b.suggest === true };
  if (b.dryRun === true) return res.json(await estimateTriggerTest(req.params.name, opts));
  checkTriggerTest(req.params.name, opts); // a bad request is refused before it counts against the limit
  if (lastTriggerTest(req.params.name)?.status === 'running') return res.status(409).json({ error: 'A test of this skill is already running: its result shows here when it’s done.' });
  const l = hit(`skill-trigger:${req.user.id}`, { limit: 6, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany(`That’s a lot of testing: try again in ${Math.ceil(l.retryInMs / 60e3)} min.`);
  // Tracked (#195): a review page reloaded while it runs picks it up from GET …/trigger-test.
  const { estimate } = await estimateTriggerTest(req.params.name, opts);
  const out = await trackTriggerTest(req.params.name, { calls: estimate.calls },
    () => triggerTest(req.params.name, { ...opts, user: req.user, signal: AbortSignal.timeout(180_000) }));
  audit('skill.trigger_test', { actorId: req.user.id, detail: { name: out.skill, requests: out.summary.total, passed: out.summary.passed, cost: out.cost } });
  res.json(out);
});

// The last trigger test of a skill: { status: running|done|error, startedAt, finishedAt?, calls, result?, error? } or null.
router.get('/skills/:name/trigger-test', (req, res) => res.json({ test: lastTriggerTest(req.params.name) }));

// Approve = switch on exactly the folder as it is now (its checksum is recorded); disable = switch off. A skill with a
// serious finding answers 409 { code: 'lint_bad' } unless the body says { force: true } ("approve anyway").
for (const [action, on] of [['approve', true], ['disable', false]]) {
  router.post(`/skills/:name/${action}`, (req, res) => {
    const force = req.body?.force === true;
    const sk = setSkill(req.params.name, on, req.user.id, { force });
    audit(`skill.${action}`, { actorId: req.user.id, detail: { name: sk.name, checksum: sk.checksum.slice(0, 12), ...(on && force ? { forced: true } : {}) } });
    res.json({ ok: true, skill: skillView(sk) });
  });
}

router.post('/skills', (req, res) => {
  const b = req.body || {};
  const force = b.force === true;
  const sk = saveSkill({ name: String(b.name || '').trim(), description: b.description, body: b.body, toolsets: [].concat(b.toolsets || []) }, req.user.id, { force });
  audit('skill.save', { actorId: req.user.id, detail: { name: sk.name, ...(force ? { forced: true } : {}) } });
  res.json({ ok: true, skill: skillView(sk) });
});

router.delete('/skills/:name', (req, res) => {
  deleteSkill(req.params.name);
  audit('skill.delete', { actorId: req.user.id, detail: { name: req.params.name } });
  res.json({ ok: true });
});

// ---- Feed sources (decision #89): every source on this install, who follows it, and whether it answers ---------------
const feedSourcesPage = () => {
  const sources = allSources();
  return { ...base, title: 'Feed sources', sources, counts: {
    total: sources.length, failing: sources.filter(s => s.state === 'failing').length,
    followers: new Set(sources.flatMap(s => s.followerNames)).size, items: sources.reduce((n, s) => n + (s.items || 0), 0),
  } };
};
router.get('/feed-sources', (req, res) => res.render('admin/feed-sources', feedSourcesPage()));

router.post('/feed-sources/:id/check', async (req, res) => {
  const out = await adminCheckSource(req.params.id, { signal: AbortSignal.timeout(60000) });
  res.json({ source: out.source, added: out.added, html: await renderFragment('admin/feed-source-row', { source: out.source }, req.user) });
});

router.delete('/feed-sources/:id', (req, res) => {
  const out = adminRemoveSource(req.params.id);
  audit('feed.source.remove', { actorId: req.user.id, targetType: 'feed_source', targetId: Number(req.params.id), detail: out });
  res.json({ ok: true, ...out });
});

export default router;
