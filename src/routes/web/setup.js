// First-run wizard. Each step is its own route; progress is saved, so refresh/restart resumes where you left off.
import { Router } from 'express';
import { settings } from '../../db/index.js';
import { STEPS, currentStep, isSetupComplete, markStep, completeSetup, claimCodeIfNeeded, checkClaimCode } from '../../services/setup.js';
import { createUser, countUsers } from '../../services/users.js';
import { createSession, deviceLabel } from '../../services/sessions.js';
import { llmSettings, testConnection, maskKey } from '../../services/llm.js';
import { VARIANTS, TONES, writeIdentity } from '../../services/workspace.js';
import { listGroups, createGroup } from '../../services/groups.js';
import { createInvite, listPendingInvites } from '../../services/invites.js';
import { audit } from '../../services/audit.js';
import { presenceFor } from '../../services/presence.js';
import { setEnvVar } from '../../lib/envfile.js';
import { setSessionCookie } from '../../middleware/auth.js';
import { formPost, isAjax } from '../../lib/respond.js';
import { invalid, forbidden } from '../../lib/errors.js';
import { hit } from '../../lib/ratelimit.js';
import { config } from '../../config/index.js';
import { browserStatus, browserSettings, installBrowser } from '../../browser/index.js';
import { renderFragment } from '../../views/render.js';

const router = Router();
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

// Common view data: stepper state + layout.
function stepData(step, extra = {}) {
  const s = settings.get('setup', { done: [] });
  return {
    layout: 'base', title: 'Set up', bodyClass: 'min-h-dvh bg-canvas text-ink antialiased',
    step, steps: STEPS.map((x, i) => ({ ...x, n: i + 1, current: x.key === step, done: s.done.includes(x.key) || (x.key === 'account' && countUsers() > 0) })),
    ...extra,
  };
}

router.use((req, res, next) => {
  if (isSetupComplete()) return res.redirect(req.user ? '/chat' : '/login');
  // Meet her during setup: the living presence uses the chosen look, or the original Jess until one is picked.
  const bot = { ...res.locals.bot, variant: settings.get('bot', {}).variant || 'female' };
  res.locals.presence = presenceFor({ bot, user: req.user });
  // After the account exists, only the owner may continue the wizard.
  const needsOwner = countUsers() > 0 && !['/', '/account'].includes(req.path);
  if (needsOwner && req.user?.role !== 'admin') return res.redirect('/login?next=/setup');
  next();
});

router.get('/', (req, res) => res.redirect(`/setup/${currentStep()}`));

// ---- 1. Owner account ---------------------------------------------------------
const accountData = req => stepData('account', { needsClaim: !isLocal(req) && !!claimCodeIfNeeded(), values: {} });

router.get('/account', (req, res) => {
  if (countUsers()) return res.redirect('/setup/model');
  res.render('setup-account', accountData(req));
});

router.post('/account', formPost('setup-account', accountData, async (req, res) => {
  if (countUsers()) return { redirect: '/setup/model' };
  if (!hit(`setup:${req.ip}`, { limit: 10, windowMs: 15 * 60e3 }).allowed) throw forbidden('Too many attempts. Wait a few minutes.');
  if (!isLocal(req) && !checkClaimCode(req.body.claim)) throw invalid({ claim: 'That code doesn’t match the one printed in the server console.' });
  const user = await createUser({ ...req.body, role: 'admin', timezone: req.body.timezone || null });
  const token = createSession(user.id, { device: deviceLabel(req.get('user-agent')), ip: req.ip });
  setSessionCookie(req, res, token);
  markStep('account');
  audit('setup.account', { actorId: user.id, ip: req.ip });
  return { redirect: '/setup/model' };
}));

// ---- 2. Brain (model connection) ---------------------------------------------
const modelData = () => {
  const s = llmSettings();
  return stepData('model', { llm: { baseUrl: s.baseUrl, model: s.model, hasKey: !!s.apiKey, maskedKey: maskKey(s.apiKey) },
    modelDone: settings.get('setup', { done: [] }).done.includes('model'), values: {} });
};

router.get('/model', (req, res) => res.render('setup-model', modelData()));

// Save settings, then run a real completion. Always JSON (the page shows the result inline).
router.post('/model/test', async (req, res) => {
  const { apiKey, model, baseUrl } = req.body;
  if (apiKey?.trim()) setEnvVar('OPENROUTER_KEY', apiKey.trim());
  // Keep what else the admin chose (fallbacks, background model: Admin → Models, #179): only these two change here.
  settings.set('llm', { ...(settings.get('llm', {}) || {}), baseUrl: baseUrl?.trim() || config.llm.baseUrl, model: model?.trim() || config.llm.model });
  const result = await testConnection();
  if (result.ok) markStep('model');
  audit('setup.model_test', { actorId: req.user.id, detail: { ok: result.ok, model: result.model, error: result.error } });
  res.json(result);
});

router.post('/model', (req, res) => {
  if (req.body.skip) markStep('model');
  res.redirect(settings.get('setup', { done: [] }).done.includes('model') ? '/setup/browser' : '/setup/model');
});

// ---- 2b. Internet (CloakBrowser, decision #15) ------------------------------------------
// The ~500 MB download runs in the background: the owner can continue while it finishes.
const browserData = () => stepData('browser', { status: browserStatus(), settings: browserSettings(), installAction: '/setup/browser/install' });

router.get('/browser', (req, res) => res.render('setup-browser', browserData()));

router.get('/browser/status', async (req, res) => {
  const data = browserData();
  res.json({ status: data.status, statusHtml: await renderFragment('admin/browser-status', data, req.user) });
});

router.post('/browser/install', (req, res) => {
  installBrowser();
  audit('browser.install', { actorId: req.user.id, detail: { from: 'setup' } });
  res.json({ ok: true, status: browserStatus() });
});

router.post('/browser', (req, res) => {
  markStep('browser');
  res.redirect('/setup/identity');
});

// ---- 3. Identity ----------------------------------------------------------------
const identityData = () => stepData('identity', {
  variants: Object.entries(VARIANTS).map(([value, v]) => ({ value, ...v })),
  tones: Object.entries(TONES).map(([value, t]) => ({ value, ...t })),
  values: { name: 'Jess', variant: 'female', tone: 'warm', pronouns: '', description: '', ...settings.get('bot', {}) },
});

router.get('/identity', (req, res) => res.render('setup-identity', identityData()));

router.post('/identity', formPost('setup-identity', identityData, req => {
  const bot = validateIdentity(req.body);
  settings.set('bot', bot);
  writeIdentity(bot);
  markStep('identity');
  audit('setup.identity', { actorId: req.user.id, detail: { name: bot.name, variant: bot.variant } });
  return { redirect: '/setup/people' };
}));

export function validateIdentity(body) {
  const errors = {};
  const name = String(body.name || '').trim();
  if (!name) errors.name = 'Give me a name.';
  else if (name.length > 24) errors.name = 'Keep it under 24 characters.';
  const description = String(body.description || '').trim();
  if (description.length > 160) errors.description = 'Keep it to one short sentence (160 characters).';
  if (!VARIANTS[body.variant]) errors.variant = 'Pick how I look.';
  if (!TONES[body.tone]) errors.tone = 'Pick a tone.';
  const pronouns = String(body.pronouns || '').trim() || VARIANTS[body.variant]?.pronouns;
  if (pronouns && pronouns.length > 20) errors.pronouns = 'Keep pronouns short, like “she/her”.';
  if (Object.keys(errors).length) throw invalid(errors);
  return { name, description, variant: body.variant, tone: body.tone, pronouns };
}

// ---- 4. People ------------------------------------------------------------------
const peopleData = req => stepData('people', {
  groups: listGroups(), invites: listPendingInvites(), publicUrl: `${req.protocol}://${req.get('host')}`, values: {},
});

router.get('/people', (req, res) => res.render('setup-people', peopleData(req)));

router.post('/people/group', formPost('setup-people', peopleData, req => {
  const g = createGroup({ name: req.body.name });
  audit('group.create', { actorId: req.user.id, targetType: 'group', targetId: g.id });
  return { redirect: '/setup/people', json: { group: g } };
}));

router.post('/people/invite', formPost('setup-people', peopleData, (req, res) => {
  const { token } = createInvite({ ...req.body, groupId: Number(req.body.groupId) || null, invitedBy: req.user.id });
  audit('user.invite', { actorId: req.user.id, detail: { name: req.body.name, role: req.body.role } });
  const link = `${req.protocol}://${req.get('host')}/invite/${token}`;
  // The link can't be shown again (only its hash is stored), so the no-JS path renders it right away.
  if (!isAjax(req)) return res.render('setup-people', { ...peopleData(req), newLink: link, newLinkName: req.body.name });
  return { json: { link, name: req.body.name } };
}));

router.post('/finish', (req, res) => {
  markStep('people');
  completeSetup();
  audit('setup.complete', { actorId: req.user.id });
  res.redirect('/chat?welcome=1');
});

export default router;
