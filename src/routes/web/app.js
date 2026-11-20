// App pages — every page is its own route. Pages whose data services land in later phases render their real
// empty state; the shapes passed here are the contracts documented at the top of each template.
import { Router } from 'express';
import { CHAT_SUGGESTIONS, GOAL_CATEGORIES, GOAL_EXAMPLES } from '../../content/starters.js';
import { goalsData, goalDetail, goalForUser } from '../../services/goals.js';
import { ideasData, markSeen } from '../../services/ideas.js';
import { busyGoals, busyKind } from '../../agent/goals.js';
import { listSessions } from '../../services/sessions.js';
import { nowFor } from '../../services/now.js';
import { mainThread, createSideThread, threadForViewer, contextStats } from '../../services/threads.js';
import { timeline } from '../../services/chatview.js';
import { shellFor } from '../../services/shell.js';
import { getUser } from '../../services/users.js';
import { listForUser, listEpisodes, listTidies } from '../../services/memory.js';
import { personLessonsView } from '../../services/lessons.js';
import { groupsOfUser } from '../../services/groups.js';
import { signedInSites } from '../../browser/profiles.js';
import { weeklyUsage } from '../../services/usage.js';
import { effectivePolicy } from '../../services/policy.js';
import { PRESETS, connectionsOf, connectionView } from '../../services/connections.js';
import { notFound } from '../../lib/errors.js';
import { activityDays, todaySummary } from '../../services/activity.js';
import { pendingFor, historyFor } from '../../services/approvals.js';
import { paths } from '../../config/index.js';
import { pictureFile } from '../../services/assistant-pictures.js';
import { upcomingData, upcomingPanel, checkinsView } from '../../services/upcoming.js';
import { placesOf, placeView } from '../../services/places.js';
import { weatherOf, describe as describeWeather } from '../../services/weather.js';

const weatherSummary = user => { const w = weatherOf(user); return w?.forecast ? describeWeather(w.forecast) : null; };
import { alarmForUser, alarmView } from '../../services/alarms.js';
import { renderFragment } from '../../views/render.js';
import { iconFor, validHost } from '../../services/favicons.js';
import { feedData, feedFilters, mutesList, COVERS as FEED_COVERS } from '../../services/feed.js';
import { readingDiet } from '../../services/feed-rank.js';
import { isRunning as isFeedRunning } from '../../agent/feed.js';
import { sourcesPage } from '../../services/feed-sources.js';
import * as P from '../../services/projects.js';
import { listsPage, listDetail } from '../../services/lists.js';
import { busyLookupsFor } from '../../services/calendar.js';
import { drawHistory } from '../../services/draws.js';
import { backgroundOf } from '../../agent/tools/delegate.js';
import { unseenFor } from '../../services/whats-new.js';
import { prepView } from '../../services/prep.js';
import { notesFor } from '../../services/notes.js';
import { adminMayView, oversightOn } from '../../services/oversight.js';
import { twoFactorState } from '../../services/twofactor.js';
import { MIN_PASSWORD } from '../../services/passwords.js';

const router = Router();

const page = (view, nav, data = {}) => (req, res) => res.render(view, { nav, ...data });

router.get('/', (req, res) => res.redirect('/chat'));

function renderChat(req, res, thread, { asAdmin = false, project = null } = {}) {
  const owner = asAdmin ? getUser(thread.user_id) : req.user;
  const view = timeline(thread, req.user);
  res.locals.shell = shellFor(req.user, { activeThreadId: thread.id });
  res.render('chat', {
    nav: 'chat', title: thread.kind === 'main' ? 'Chat' : thread.title, mainClass: 'min-h-0 flex-1 overflow-hidden',
    project: project ? P.projectView(project) : null, panel: project ? P.projectPanel(project) : null, hidePanel: !!project,
    projectOptions: P.projectOptions(),
    thread: { id: thread.id, title: thread.title, isMain: thread.kind === 'main', offRecord: !!thread.no_memory },
    ...view, agent: res.locals.shell.agent,
    sendUrl: `/api/v1/threads/${thread.id}/messages`,
    suggestions: view.days.length ? null : CHAT_SUGGESTIONS,
    readOnly: asAdmin, viewingAs: asAdmin ? owner : null, context: contextStats(thread),
    memberNotice: req.user.role !== 'admin' && oversightOn(), now: asAdmin ? null : nowFor(req.user),
    // Phase 25 (#212): a background task's side chat says what it was asked and where from; the main chat shows What's new in
    // Jess once (the card's Got it marks it seen, #213).
    background: thread.kind === 'side' ? backgroundOf(thread.id) : null,
    whatsNew: thread.kind === 'main' && !asAdmin ? unseenFor(req.user) : [],
  });
}

// The assistant's pictures the admin uploaded (#7, services/assistant-pictures.js): everyone signed in sees them; only the
// current upload of a slot is served. The URL keeps the built-in art's shape, "<base>/<frame>[-256].webp", so the avatar
// and the sky code build both the same way; every frame of an uploaded avatar is its one picture.
router.get('/assistant-pictures/:pic/:frame', (req, res) => {
  const m = /^[a-z-]+?(-256)?\.webp$/.exec(req.params.frame);
  const file = m && pictureFile(`${req.params.pic}${m[1] || ''}.webp`);
  if (!file) throw notFound('That picture is gone.');
  res.set({ 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.sendFile(file, { headers: { 'Content-Type': 'image/webp' } }, err => { if (err && !res.headersSent) res.status(404).end(); });
});

// Web screenshots (web_screenshot): only the person they were taken for, or an admin.
router.get('/shots/:file', (req, res) => {
  const m = /^u(\d+)-[a-f0-9]{16}\.jpg$/.exec(req.params.file);
  if (!m || (Number(m[1]) !== req.user.id && !adminMayView(req.user))) throw notFound('That screenshot is gone.');
  res.sendFile(req.params.file, { root: paths.shots, maxAge: '7d', immutable: true }, err => { if (err && !res.headersSent) res.status(404).end(); });
});

// Site icons for run steps (services/favicons.js): cached, or a lettered badge. Any signed-in person (public icons).
router.get('/favicons/:host', async (req, res) => {
  const host = String(req.params.host).toLowerCase();
  if (!validHost(host)) throw notFound();
  const icon = await iconFor(host);
  // A real icon keeps for a week; a badge only for an hour (the icon may turn up later, e.g. from a page's <link rel=icon>).
  res.set('Cache-Control', `private, max-age=${icon.file ? 604800 : 3600}`);
  if (icon.file) return res.sendFile(icon.file);
  res.type('image/svg+xml').send(icon.badge);
});

router.get('/chat', (req, res) => renderChat(req, res, mainThread(req.user.id)));
router.get('/chat/new', (req, res) => res.redirect(`/chat/${createSideThread(req.user.id).id}`));
router.get('/chat/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw notFound();
  const { thread, asAdmin } = threadForViewer(req.params.id, req.user, { ip: req.ip });
  const project = P.projectOfThread(thread.id);
  if (project && project.status !== 'draft') return res.redirect(`/projects/${project.public_id}`); // a project chat lives at its project
  renderChat(req, res, thread, { asAdmin });
});

// Projects (docs/PROJECTS.md): the list, and each project — its continuous chat with the brief and files beside it.
router.get('/projects', (req, res) => res.render('projects', {
  nav: 'chat', title: 'Projects', projects: P.listProjects(req.user.id).map(P.projectView), archived: P.listProjects(req.user.id, { archived: true }).map(P.projectView),
}));
router.get('/projects/rail', async (req, res) => {
  const shell = shellFor(req.user, { activeThreadId: Number(req.query.thread) || null });
  res.json({ html: await renderFragment('projects/rail-list', { projects: shell.projects }, req.user) });
});
router.get('/projects/:id/panel', async (req, res) => {
  const p = P.projectForUser(req.user, req.params.id);
  const panel = P.projectPanel(p);
  const [aside, sheet] = await Promise.all([renderFragment('projects/panel', { panel, prefix: 'aside' }, req.user),
    renderFragment('projects/panel', { panel, prefix: 'sheet', inSheet: true }, req.user)]);
  res.json({ aside, sheet });
});
router.get('/projects/:id', (req, res) => {
  const p = P.projectForUser(req.user, req.params.id);
  if (p.status === 'draft') throw notFound('That project hasn’t been created yet — press Create on its card.');
  const { thread, asAdmin } = threadForViewer(p.thread_id, req.user, { ip: req.ip });
  renderChat(req, res, thread, { asAdmin, project: p });
});

router.get('/feed', (req, res) => {
  const data = feedData(req.user, feedFilters(req.query));
  res.render('feed', {
    nav: 'feed', title: 'Feed', feed: { greeting: nowFor(req.user), ...data, working: isFeedRunning(req.user.id), diet: data.home ? dietCard(req.user) : null },
  });
});

// "Your reading diet" (#193; the card is Phase 25 #204): on the Feed's home once there is enough to say, once a month (the
// card carries its month; dismissing it hides it until the next one, public/js/feed-tools.js).
function dietCard(user) {
  const diet = readingDiet(user);
  if (!diet.enough) return null;
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: user.timezone || undefined, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
  return { ...diet, month, topics: diet.topics.slice(0, 5), sources: diet.sources.slice(0, 4) };
}

// Where the stories come from, per topic — see, add, remove, pause (decision #89); OPML and muted words (Phase 25 #204).
router.get('/feed/sources', (req, res) => res.render('feed-sources', { nav: 'feed', title: 'Your sources', sources: sourcesPage(req.user),
  mutes: mutesList(req.user) }));

// Story covers (downloaded once, content-addressed). Any signed-in person may load them: they're public images.
router.get('/feed/covers/:file', (req, res) => {
  if (!/^[a-f0-9]{20}.(jpg|png|webp|gif|avif)$/.test(req.params.file)) throw notFound();
  res.sendFile(req.params.file, { root: FEED_COVERS, maxAge: '30d', immutable: true }, err => { if (err && !res.headersSent) res.status(404).end(); });
});

router.get('/ideas', (req, res) => {
  const ideas = ideasData(req.user);
  markSeen(req.user);
  res.render('ideas', { nav: 'ideas', title: 'Ideas', ideas });
});

router.get('/goals', (req, res) => res.render('goals', { nav: 'goals', title: 'Goals', goals: goalsData(req.user, busyGoals()) }));
router.get('/goals/new', page('goal-new', 'goals', { title: 'New goal', categories: GOAL_CATEGORIES, examples: GOAL_EXAMPLES }));
router.get('/goals/:id', (req, res) => {
  const g = goalForUser(req.user, req.params.id);
  res.render('goal', { nav: 'goals', title: g.title, goal: goalDetail(g, { busy: busyKind(g.id) }), categories: GOAL_CATEGORIES });
});


// Family lists (decision #139): the index, and each list at its own address (the phone's way in, and a deep link).
router.get('/lists', (req, res) => res.render('lists', { nav: 'lists', title: 'Lists', page: listsPage(req.user) }));
router.get('/lists/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw notFound();
  const detail = listDetail(req.user, req.params.id);
  res.render('list', { nav: 'lists', title: detail.list.title, detail });
});

router.get('/activity', (req, res) => res.render('activity', {
  nav: 'chat', title: 'Activity', activity: { today: todaySummary(req.user), days: activityDays(req.user), draws: drawHistory(req.user, 8) }, // draws: #196
}));
router.get('/approvals', (req, res) => res.render('approvals', {
  nav: 'chat', title: 'Approvals', approvals: { pending: pendingFor(req.user), history: historyFor(req.user) },
}));
router.get('/upcoming', (req, res) => res.render('upcoming', { nav: 'chat', title: 'Upcoming', upcoming: upcomingData(req.user) }));

// Live refresh of the Upcoming page body and the panel list (one source of markup: the same partials).
router.get('/upcoming/fragments', async (req, res) => {
  const [body, panel] = await Promise.all([
    renderFragment('upcoming-body', { upcoming: upcomingData(req.user) }, req.user),
    renderFragment('upcoming-panel', { upcoming: upcomingPanel(req.user) }, req.user),
  ]);
  res.json({ body, panel });
});

// A ringing alarm's dock card (for alarm.ring frames and page loads).
router.get('/alarms/:id/ring', async (req, res) => {
  const a = alarmForUser(req.user, req.params.id);
  res.json({ html: a.status === 'ringing' ? await renderFragment('alarm-ring', alarmView(a), req.user) : null });
});

// The tidy to show on You → Memory: the one asked for (open, with a note if it's gone), else the latest one of the last two
// weeks that changed something (folded). → { tidy, open, missing } or null.
function memoryTidy(user, id) {
  if (id != null && id !== '') {
    const [tidy] = /^\d+$/.test(String(id)) ? listTidies(user, { id }) : [];
    return tidy ? { tidy, open: true } : { tidy: null, missing: true };
  }
  const [last] = listTidies(user, { limit: 1 });
  const fresh = last && Date.now() - new Date(`${String(last.at).replace(' ', 'T')}Z`).getTime() < 14 * 864e5 && last.changes.length;
  return fresh ? { tidy: last, open: false } : null;
}

// You: real tabs, each its own address (/me/places …); /me opens the profile.
const ME_TABS = [['profile', 'Profile'], ['places', 'Places'], ['connections', 'Connections'], ['memory', 'Memory'], ['notifications', 'Notifications'], ['devices', 'Sign-in & devices'], ['usage', 'Usage']];
router.get(['/me', '/me/:tab'], (req, res) => {
  const tab = req.params.tab || 'profile';
  if (!ME_TABS.some(([k]) => k === tab)) throw notFound();
  res.render('me', {
    nav: 'me', title: `You · ${ME_TABS.find(([k]) => k === tab)[1]}`, tab, tabs: ME_TABS.map(([key, label]) => ({ key, label })),
    readByAdmins: req.user.role !== 'admin' && oversightOn(), // the "admins can read your chats" note (#219)
    minPassword: MIN_PASSWORD, recoveryUsed: req.query.recovery === 'used', // sign-in (#230)
    me: { profile: req.user, memories: listForUser(req.user), episodes: listEpisodes(req.user, { limit: 60 }), groups: groupsOfUser(req.user.id),
      // Phase 25 (#204): "How I work with you" and the weekly tidy (?tidy=<id> from its Activity item opens that one).
      lessons: personLessonsView(req.user), tidy: memoryTidy(req.user, req.query.tidy),
      busyLookups: busyLookupsFor(req.user), // who looked at my availability (#196)
      sites: signedInSites(req.user.id).map(x => ({ ...x, iconUrl: `/favicons/${encodeURIComponent(x.site)}` })), sessions: listSessions(req.user.id, req.session.id), twoFactor: twoFactorState(req.user.id), usage: weeklyUsage(req.user.id, effectivePolicy(req.user).weeklyBudget),
      checkins: checkinsView(req.user), places: placesOf(req.user).map(placeView), weather: weatherSummary(req.user),
      prep: prepView(req.user), notes: notesFor(req.user, { delivered: 8 }), // overnight prep and notes for later (#212)
      connections: { email: connectionsOf(req.user, 'email').map(connectionView), calendar: connectionsOf(req.user, 'calendar').map(connectionView) },
      presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label, email: !!v.email, calendar: !!v.calendar, help: v.help, url: v.calendar?.url || '' }])) },
  });
});

export default router;
