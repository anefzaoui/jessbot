// Admin dashboard: overview, people, per-person instructions, groups, identity, permissions (P4), browser (P5),
// personality (P9). Mounted behind requireAdmin. Usage, System and Model live in admin-ops.js.
import { Router } from 'express';
import { settings, get } from '../../db/index.js';
import { doctor, securityChecks } from '../../services/system.js';
import { securityEvents } from '../../services/security-events.js';
import { weekTotalLabel } from '../../services/usage.js';
import { listUsers, getUser, setStatus } from '../../services/users.js';
import { listSessions, revokeAllSessions } from '../../services/sessions.js';
import { createInvite, listPendingInvites, revokeInvite } from '../../services/invites.js';
import { listGroups, getGroup, createGroup, groupsOfUser, addMember, removeMember } from '../../services/groups.js';
import { currentInstructions, instructionHistory, saveInstructions, INSTRUCTIONS_MAX } from '../../services/instructions.js';
import { VARIANTS, TONES, writeIdentity, EDITABLE, WORKSPACE_MAX, readWorkspaceFile, saveWorkspaceFile, workspaceVersions, workspaceVersion } from '../../services/workspace.js';
import { llmSettings, maskKey } from '../../services/llm.js';
import { audit, recentAudit } from '../../services/audit.js';
import { threadsOfUser } from '../../services/threads.js';
import { validateIdentity } from './setup.js';
import { TOOLSETS, getPolicy, setPolicy, inheritedPolicy, grantsOf, revokeGrant, DEFAULT_TASK_BUDGET, defaultTaskBudget } from '../../services/policy.js';
import { allTools } from '../../agent/tools/registry.js';
import { browserStatus, browserSettings, saveBrowserSettings, installBrowser, closeBrowser, setLicenseKey, removeLicenseKey,
  recentBrowsing, ENGINE_LABELS } from '../../browser/index.js';
import { screenshot, search } from '../../browser/read.js';
import { renderFragment } from '../../views/render.js';
import opsRoutes from './admin-ops.js';
import browserRoutes from './admin-browser.js';
import { browserExtras } from '../../services/browser-admin.js';
import lessonRoutes, { lessonsPage, proposedHouseholdCount } from './admin-lessons.js';

// ---- Policy form helpers (decision #13) -------------------------------------------------------
const LEVEL = { off: 'Off', ask: 'Ask first', allow: 'Allowed' };
function policyForm(action, own, inherited, showInherit) {
  const available = new Set(allTools().map(t => t.toolset));
  return {
    action, showInherit,
    rows: Object.entries(TOOLSETS).map(([key, t]) => ({ key, ...t, available: available.has(key),
      value: own?.toolsets?.[key] || (showInherit ? '' : 'off'), inherited: inherited ? LEVEL[inherited.toolsets[key]] : null })),
    approver: own?.approver || (showInherit ? '' : 'self'),
    inheritedApprover: inherited ? (inherited.approver === 'admin' ? 'the admin' : 'the person') : null,
    budget: own?.weekly_budget_usd ?? '', inheritedBudget: inherited ? `$${Number(inherited.weeklyBudget).toFixed(2)}` : null,
    // What one task may spend (#178; the field is Phase 25 #203): empty = inherit (or, at the top, the default).
    taskBudget: own?.task_budget_usd ?? '', inheritedTaskBudget: inherited ? taskBudgetLabel(inherited.taskBudget) : null,
    defaultTaskBudget: `$${DEFAULT_TASK_BUDGET.toFixed(2)}`,
    quietStart: own?.quiet_start || '', quietEnd: own?.quiet_end || '',
  };
}
const taskBudgetLabel = v => (Number(v) > 0 ? `$${Number(v).toFixed(2)}` : 'no cap');
const globalAsInherited = () => {
  const g = getPolicy('global') || { toolsets: {} };
  const weeklyBudget = g.weekly_budget_usd ?? 2;
  return { toolsets: g.toolsets, approver: g.approver || 'self', weeklyBudget, taskBudget: g.task_budget_usd ?? defaultTaskBudget(weeklyBudget) };
};
function parsePolicy(body) {
  const toolsets = {};
  for (const [k, v] of Object.entries(body || {})) {
    const m = k.match(/^toolsets\[(\w+)\]$/);
    if (m && v && Object.hasOwn(TOOLSETS, m[1])) toolsets[m[1]] = v; // known toolsets only
  }
  // taskBudget (#178): only when the form sends it; left out, the layer keeps what it had (policy.setPolicy).
  return { toolsets, approver: body.approver || null, weeklyBudget: body.weeklyBudget, taskBudget: body.taskBudget, quietStart: body.quietStart, quietEnd: body.quietEnd };
}
import { formPost, isAjax } from '../../lib/respond.js';
import { HttpError, badRequest, invalid, notFound } from '../../lib/errors.js';
import { oversightOn, oversightState, setOversight } from '../../services/oversight.js';
import { baseUrl } from '../../lib/origin.js';
import { createResetLink } from '../../services/password-reset.js';
import { twoFactorOn, disableTwoFactor } from '../../services/twofactor.js';

const router = Router();
const base = { nav: 'admin' };

router.get('/', (req, res) => {
  const users = listUsers();
  const llm = llmSettings();
  res.render('admin/overview', {
    ...base, title: 'Admin',
    stats: {
      people: users.length, active: users.filter(u => u.status === 'active').length,
      invites: listPendingInvites().length, groups: listGroups().length,
    },
    llm: { model: llm.model, hasKey: !!llm.apiKey, maskedKey: maskKey(llm.apiKey) },
    health: doctor(),
    ops: {
      week: weekTotalLabel(),
      running: get(`SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running')`).n,
      waiting: get(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`).n,
    },
    audit: recentAudit(12),
    // Phase 25 (#203): the standing security checks and what the guards stopped lately (metadata only, never excerpts).
    security: { checks: securityChecks(), events: securityEvents() },
  });
});

// ---- People -----------------------------------------------------------------------
const peopleData = () => ({
  ...base, title: 'People', users: listUsers().map(u => ({ ...u, groups: groupsOfUser(u.id) })),
  invites: listPendingInvites(), groups: listGroups(),
  everyone: currentInstructions('global'), instructionsMax: INSTRUCTIONS_MAX, values: {},
  oversight: oversightState(), // decision #219
});

router.get('/people', (req, res) => res.render('admin/people', peopleData()));

// Reading other people's chats and files (decision #219): off unless the admin turns it on; everyone is told when it is.
router.post('/oversight', (req, res) => {
  const on = req.body?.readChats === true || req.body?.readChats === 'on' || req.body?.readChats === 'true';
  const state = setOversight(on, req.user.id);
  res.json({ ok: true, oversight: state });
});

router.post('/people/invite', formPost('admin/people', peopleData, (req, res) => {
  const { token } = createInvite({ ...req.body, groupId: Number(req.body.groupId) || null, invitedBy: req.user.id });
  audit('user.invite', { actorId: req.user.id, detail: { name: req.body.name, role: req.body.role } });
  const link = `${baseUrl(req)}/invite/${token}`; // PUBLIC_URL when set, never a forged Host (#220)
  if (!isAjax(req)) return res.render('admin/people', { ...peopleData(), newLink: link, newLinkName: req.body.name });
  return { json: { link, name: req.body.name } };
}));

router.post('/invites/:id/revoke', formPost('admin/people', peopleData, req => {
  if (!revokeInvite(Number(req.params.id))) throw notFound('That invite no longer exists.');
  audit('invite.revoke', { actorId: req.user.id, targetType: 'invite', targetId: req.params.id });
  return { redirect: '/admin/people' };
}));

router.post('/everyone/instructions', formPost('admin/people', peopleData, req => {
  const changed = saveInstructions('global', null, req.body.body, req.user.id);
  if (changed) audit('instructions.save', { actorId: req.user.id, targetType: 'global' });
  return { redirect: '/admin/people', json: { changed } };
}));

// ---- One person -------------------------------------------------------------------
const personData = req => {
  const person = getUser(Number(req.params.id));
  if (!person) throw notFound('No such person.');
  return {
    ...base, title: person.name, person, groups: listGroups(), memberOf: groupsOfUser(person.id).map(g => g.id),
    instructions: currentInstructions('user', person.id), history: instructionHistory('user', person.id),
    sessions: listSessions(person.id), instructionsMax: INSTRUCTIONS_MAX, isSelf: person.id === req.user.id, values: {},
    threads: oversightOn() ? threadsOfUser(person.id) : [], oversight: oversightOn(),
    policy: policyForm(`/admin/policy/user/${person.id}`, getPolicy('user', person.id), inheritedPolicy(person), true),
    grants: grantsOf(person.id), twoFactorOn: twoFactorOn(person.id),
  };
};

router.get('/people/:id', (req, res) => res.render('admin/person', personData(req)));

router.post('/people/:id/instructions', formPost('admin/person', personData, req => {
  const id = Number(req.params.id);
  if (!getUser(id)) throw notFound();
  const changed = saveInstructions('user', id, req.body.body, req.user.id);
  if (changed) audit('instructions.save', { actorId: req.user.id, targetType: 'user', targetId: id });
  return { redirect: `/admin/people/${id}`, json: { changed } };
}));

router.post('/people/:id/groups', formPost('admin/person', personData, req => {
  const id = Number(req.params.id);
  const wanted = new Set([].concat(req.body.groups || []).map(Number));
  for (const g of listGroups()) wanted.has(g.id) ? addMember(g.id, id) : removeMember(g.id, id);
  audit('user.groups', { actorId: req.user.id, targetType: 'user', targetId: id, detail: { groups: [...wanted] } });
  return { redirect: `/admin/people/${id}` };
}));

router.post('/people/:id/status', formPost('admin/person', personData, req => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw badRequest("You can't disable your own account.");
  const status = req.body.status === 'disabled' ? 'disabled' : 'active';
  setStatus(id, status);
  if (status === 'disabled') revokeAllSessions(id);
  audit(`user.${status === 'disabled' ? 'disable' : 'enable'}`, { actorId: req.user.id, targetType: 'user', targetId: id });
  return { redirect: `/admin/people/${id}` };
}));

// Sign-in help (decision #230): a one-time password reset link to hand over, and turning off two-step sign-in for someone
// who lost their phone and their recovery codes. Both sign the person out everywhere (the reset when it is used).
router.post('/people/:id/reset-link', (req, res) => {
  const person = getUser(Number(req.params.id));
  if (!person) throw notFound('No such person.');
  if (person.id === req.user.id) throw badRequest('Change your own password on You → Sign-in & devices.');
  const { url, expiresAt } = createResetLink(person.id, { createdBy: req.user.id, base: baseUrl(req) }); // PUBLIC_URL when set (#220)
  res.json({ ok: true, link: url, name: person.name, expiresAt });
});

router.post('/people/:id/2fa-off', formPost('admin/person', personData, req => {
  const id = Number(req.params.id);
  if (!getUser(id)) throw notFound();
  if (id === req.user.id) throw badRequest('Turn off your own two-step sign-in on You → Sign-in & devices.');
  if (twoFactorOn(id)) disableTwoFactor(id, { actorId: req.user.id, ip: req.ip });
  return { redirect: `/admin/people/${id}` };
}));

// ---- Groups -----------------------------------------------------------------------
const groupsData = () => ({ ...base, title: 'Groups', groups: listGroups().map(g => ({ ...g, instructions: currentInstructions('group', g.id),
  policy: policyForm(`/admin/policy/group/${g.id}`, getPolicy('group', g.id), globalAsInherited(), true) })), instructionsMax: INSTRUCTIONS_MAX, values: {} });

router.get('/groups', (req, res) => res.render('admin/groups', groupsData()));

router.post('/groups', formPost('admin/groups', groupsData, req => {
  const g = createGroup(req.body);
  audit('group.create', { actorId: req.user.id, targetType: 'group', targetId: g.id });
  return { redirect: '/admin/groups' };
}));

router.post('/groups/:id/instructions', formPost('admin/groups', groupsData, req => {
  const id = Number(req.params.id);
  if (!getGroup(id)) throw notFound();
  const changed = saveInstructions('group', id, req.body.body, req.user.id);
  if (changed) audit('instructions.save', { actorId: req.user.id, targetType: 'group', targetId: id });
  return { redirect: '/admin/groups', json: { changed } };
}));

// ---- Permissions (policies) ------------------------------------------------------------
router.get('/tools', (req, res) => res.render('admin/tools', {
  ...base, title: 'Permissions',
  policy: policyForm('/admin/policy/global', getPolicy('global'), null, false),
  tools: allTools().map(t => ({ name: t.name, toolset: TOOLSETS[t.toolset]?.label || t.toolset, description: t.description,
    risk: typeof t.risk === 'function' ? 'depends' : t.risk })).sort((a, b) => a.toolset.localeCompare(b.toolset) || a.name.localeCompare(b.name)),
}));

router.post('/policy/:type{/:id}', (req, res) => {
  const type = req.params.type;
  if (!['global', 'group', 'user'].includes(type)) throw notFound();
  const id = type === 'global' ? null : Number(req.params.id);
  if (type === 'user' && !getUser(id)) throw notFound();
  if (type === 'group' && !getGroup(id)) throw notFound();
  setPolicy(type, id, parsePolicy(req.body), req.user.id);
  audit('policy.save', { actorId: req.user.id, targetType: type, targetId: id });
  res.json({ ok: true });
});

router.post('/people/:id/grants/:grantId/revoke', (req, res) => {
  if (!revokeGrant(Number(req.params.id), Number(req.params.grantId))) throw notFound('That permission was already removed.');
  audit('grant.revoke', { actorId: req.user.id, targetType: 'user', targetId: req.params.id });
  res.json({ ok: true });
});

// ---- Personality: SOUL.md / AGENTS.md / MEMORY.md with history (decision #53) ------------
const FILE_KEYS = { soul: 'SOUL.md', rules: 'AGENTS.md', notes: 'MEMORY.md' };
// The tabs over Personality (partials/admin/personality-nav.hbs): the three files, then Lessons with its waiting count.
const personalityTabs = key => ({
  files: Object.entries(FILE_KEYS).map(([k, n]) => ({ key: k, name: n, label: EDITABLE[n].label, active: k === key })),
  lessonsActive: key === 'lessons', lessonsWaiting: proposedHouseholdCount(),
});
const personalityData = key => {
  const name = FILE_KEYS[key];
  return {
    ...base, title: 'Personality', fileKey: key, fileName: name, file: EDITABLE[name], max: WORKSPACE_MAX, ...personalityTabs(key),
    body: readWorkspaceFile(name), versions: workspaceVersions(name), values: {},
  };
};

router.get(['/soul', '/personality'], (req, res) => res.redirect('/admin/personality/soul'));
// Household lessons (decisions #186, #188; the screen is Phase 25 #203). Its JSON actions live in admin-lessons.js.
router.get('/personality/lessons', (req, res) => res.render('admin/lessons', { ...base, title: 'Lessons', ...personalityTabs('lessons'),
  lessons: lessonsPage(req.user, { status: req.query.status }) }));
router.get('/personality/:key', (req, res) => {
  if (!FILE_KEYS[req.params.key]) throw notFound();
  res.render('admin/personality', personalityData(req.params.key));
});

router.post('/personality/:key', (req, res) => {
  const name = FILE_KEYS[req.params.key];
  if (!name) throw notFound();
  let out;
  try { out = saveWorkspaceFile(name, req.body?.body, { authorId: req.user.id, bot: { name: 'Jessbot', ...settings.get('bot', {}) } }); }
  catch (err) { if (err.status === 422) throw invalid({ body: err.message }); throw err; }
  if (out.changed) audit('workspace.save', { actorId: req.user.id, detail: { file: name } });
  res.json({ ok: true, changed: out.changed, versionsHtml: null });
});

router.post('/personality/:key/restore/:id', (req, res) => {
  const name = FILE_KEYS[req.params.key];
  const v = workspaceVersion(req.params.id);
  if (!name || !v || v.file !== name) throw notFound('That version is gone.');
  saveWorkspaceFile(name, v.body, { authorId: req.user.id, note: `restored #${v.id}`, bot: { name: 'Jessbot', ...settings.get('bot', {}) } });
  audit('workspace.restore', { actorId: req.user.id, detail: { file: name, version: v.id } });
  res.json({ ok: true, redirect: `/admin/personality/${req.params.key}` });
});

router.get('/personality/:key/versions/:id', (req, res) => {
  const v = workspaceVersion(req.params.id);
  if (!v || v.file !== FILE_KEYS[req.params.key]) throw notFound();
  res.type('text/plain; charset=utf-8').send(v.body);
});

// ---- Identity (post-setup edits) ---------------------------------------------------
const identityData = () => ({
  ...base, title: 'Identity',
  variants: Object.entries(VARIANTS).map(([value, v]) => ({ value, ...v })),
  tones: Object.entries(TONES).map(([value, t]) => ({ value, ...t })),
  values: { ...settings.get('bot', {}) },
});

router.get('/identity', (req, res) => res.render('admin/identity', identityData()));

router.post('/identity', formPost('admin/identity', identityData, req => {
  const bot = validateIdentity(req.body);
  settings.set('bot', bot);
  writeIdentity(bot);
  audit('identity.save', { actorId: req.user.id, detail: { name: bot.name, variant: bot.variant } });
  return { redirect: '/admin/identity', json: { bot } };
}));

// ---- Browser (Phase 5, decisions #15/#43) ------------------------------------------------
const browserData = () => ({
  ...base, title: 'Browser', status: browserStatus(), recent: recentBrowsing(),
  settings: browserSettings(), engines: Object.entries(ENGINE_LABELS).map(([value, label]) => ({ value, label })),
  maxPagesOptions: [1, 2, 3, 4], idleOptions: [1, 5, 15, 30, 60],
  extras: browserExtras(), // Phase 25 (#195): sites with blocking off, which deep links work, learned recipes, office previews
});
const asUserError = err => (err instanceof HttpError ? err : badRequest(err.message.split('\n')[0]));

router.get('/browser', (req, res) => res.render('admin/browser', browserData()));
router.get('/browser/status', async (req, res) => {
  const data = { status: browserStatus(), recent: recentBrowsing(), settings: browserSettings() };
  res.json({ status: data.status, statusHtml: await renderFragment('admin/browser-status', data, req.user),
    recentHtml: await renderFragment('admin/browser-recent', data, req.user) });
});

router.post('/browser/install', (req, res) => {
  installBrowser();
  audit('browser.install', { actorId: req.user.id });
  res.json({ ok: true, status: browserStatus() });
});

// The browser engine (decision #218). Only the engine changes; every other browser setting stays as it is.
router.post('/browser/engine', async (req, res) => {
  const engine = String(req.body?.engine || '');
  if (!browserStatus().engines.some(e => e.id === engine)) throw invalid({ engine: 'Pick one of the listed browsers.' });
  const s = await saveBrowserSettings({ ...browserSettings(), engine });
  audit('browser.engine', { actorId: req.user.id, detail: { engine: s.engine } });
  res.json({ ok: true, redirect: '/admin/browser', status: browserStatus() });
});

router.post('/browser/restart', async (req, res) => {
  await closeBrowser();
  res.json({ ok: true, status: browserStatus() });
});

router.post('/browser/settings', async (req, res) => {
  let s;
  try { s = await saveBrowserSettings(req.body || {}); } catch (err) {
    if (err.field) throw invalid({ [err.field]: err.message }); // a SearXNG address that didn't answer (decision #138)
    throw err;
  }
  audit('browser.settings', { actorId: req.user.id, detail: s });
  res.json({ ok: true, settings: s });
});

router.post('/browser/license', async (req, res) => {
  try { await setLicenseKey(req.body?.key); } catch (err) { throw invalid({ key: err.message }); }
  installBrowser(); // a key switches to the newer build: fetch it now, not in the middle of someone's chat
  audit('browser.license', { actorId: req.user.id, detail: { action: 'set' } });
  res.json({ ok: true, status: browserStatus() });
});

router.post('/browser/license/remove', async (req, res) => {
  await removeLicenseKey();
  audit('browser.license', { actorId: req.user.id, detail: { action: 'remove' } });
  res.json({ ok: true, status: browserStatus() });
});

// Test drive: the same code paths Jess uses (screenshot / search), run as the admin.
router.post('/browser/test', async (req, res) => {
  const t = Date.now();
  try {
    const shot = await screenshot(req.body?.url || 'https://example.com', { userId: req.user.id });
    res.json({ ...shot, ms: Date.now() - t });
  } catch (err) { throw asUserError(err); }
});

router.post('/browser/search', async (req, res) => {
  const t = Date.now();
  try {
    const out = await search(req.body?.query, { count: 6 });
    res.json({ ...out, ms: Date.now() - t });
  } catch (err) { throw asUserError(err); }
});

// Browser: recipes, ad blocking per site, office previews (Phase 25, #195).
router.use(browserRoutes);
// Usage, System, Model (Phase 9).
router.use(opsRoutes);
// Household lessons (Phase 20, decision #186).
router.use(lessonRoutes);

export default router;
