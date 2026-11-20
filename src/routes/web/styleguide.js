// DEV ONLY (mounted when NODE_ENV !== 'production').
//  /styleguide                 component gallery
//  /styleguide/screens/:page   real page templates rendered with fixtures
//  /styleguide/sim/api/v1/*    simulated API (realistic latency; bodies containing "fail" → error)
import fs from 'node:fs';
import { Router } from 'express';
import * as fx from '../../dev/fixtures.js';
import { presenceFor, sceneFor } from '../../services/presence.js';
import { renderMarkdown } from '../../lib/markdown.js';
import * as listsSim from '../../dev/lists-sim.js';
import * as youSim from '../../dev/you-sim.js';
import * as screensC from '../../dev/screens-c-sim.js';
import * as screensB from '../../dev/screens-b-sim.js';
import * as screensD from '../../dev/screens-d-sim.js';

const router = Router();
const SIM = '/styleguide/sim';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Every styleguide response: demo user + populated shell + simulated API base.
router.use((req, res, next) => {
  res.locals.user = fx.user;
  res.locals.shell = fx.shell();
  res.locals.apiBase = SIM;
  // Demo the living presence: ?variant=female|male|neutral, ?time=dawn|day|dusk|night, ?weather=clear|rain|…
  res.locals.bot = { ...res.locals.bot, name: 'Jess', variant: req.query.variant || 'female' };
  const p = presenceFor({ bot: res.locals.bot, user: fx.user });
  const time = req.query.time || p.time, weather = req.query.weather || 'clear';
  res.locals.presence = { ...p, time, weather, scene: sceneFor({ time, weather }), pinned: !!req.query.time };
  next();
});

router.get('/', (req, res) => {
  res.render('styleguide', {
    title: 'Styleguide', nav: 'styleguide',
    fx: {
      activities: ['resting', 'thinking', 'searching', 'reading', 'writing', 'editing', 'creating', 'fetching', 'remembering', 'waiting', 'error', 'offline'],
      runningRun: fx.runningRun, erroredRun: fx.erroredRun, doneRun: fx.doneRun, waitingRun: fx.waitingRun, rtl: fx.rtl,
      approval: fx.approvalsPage.pending[0], question: fx.pendingQuestion,
      post: fx.feed.sections[0].posts[0], idea: fx.ideas.items[0], goal: fx.goals.active[0],
      libraryItem: fx.library.items[0], job: fx.upcomingPage.jobs[0],
      activityItems: fx.activityPage.days[0].items.slice(0, 3),
    },
  });
});

const SCREENS = {
  chat: () => ({ view: 'chat', nav: 'chat', mainClass: 'min-h-0 flex-1 overflow-hidden',
    thread: { id: 'main', title: 'Main', isMain: true }, days: fx.chatDays(), agent: fx.shell().agent,
    pendingQuestion: fx.pendingQuestion, running: true, sendUrl: '/api/v1/threads/main/messages', now: fx.now }),
  'run-states': () => ({ view: 'chat', nav: 'chat', mainClass: 'min-h-0 flex-1 overflow-hidden', thread: { id: 'main', title: 'Main', isMain: true },
    days: fx.runStates, agent: fx.shell().agent, sendUrl: '/api/v1/threads/main/messages', projectOptions: fx.projectOptionsDemo }),
  // A side chat with the off-the-record switch (Phase 25); its POST goes to the simulated API (src/dev/you-sim.js).
  'side-chat': () => ({ view: 'chat', nav: 'chat', mainClass: 'min-h-0 flex-1 overflow-hidden',
    thread: { id: 't7', title: 'Birthday surprise for Maya', isMain: false, offRecord: false }, days: fx.chatDays().slice(-1), agent: fx.shell().agent,
    sendUrl: '/api/v1/threads/t7/messages', now: fx.now }),
  'side-chat-off': () => ({ view: 'chat', nav: 'chat', mainClass: 'min-h-0 flex-1 overflow-hidden',
    thread: { id: 't7', title: 'Birthday surprise for Maya', isMain: false, offRecord: true }, days: fx.chatDays().slice(-1), agent: fx.shell().agent,
    sendUrl: '/api/v1/threads/t7/messages', now: fx.now }),
  voice: () => ({ view: 'chat', nav: 'chat', mainClass: 'min-h-0 flex-1 overflow-hidden', thread: { id: 'main', title: 'Main', isMain: true },
    days: fx.voiceStates, agent: fx.shell().agent, sendUrl: '/api/v1/threads/main/messages' }),
  'admin-model': () => ({ view: 'admin/model', nav: 'admin', ...fx.adminModel }),
  'admin-personality': () => ({ view: 'admin/personality', nav: 'admin', ...fx.adminPersonality }),
  'chat-empty': () => ({ view: 'chat', nav: 'chat', mainClass: 'min-h-0 flex-1 overflow-hidden',
    thread: { id: 'fresh', isMain: true }, days: [], agent: { activity: 'resting' },
    sendUrl: '/api/v1/threads/fresh/messages', suggestions: fx.CHAT_SUGGESTIONS, now: fx.now }),
  feed: () => ({ view: 'feed', nav: 'feed', feed: fx.feed }),
  projects: () => ({ view: 'projects', nav: 'chat', ...fx.projects }),
  project: () => ({ view: 'chat', nav: 'chat', mainClass: 'min-h-0 flex-1 overflow-hidden', hidePanel: true,
    thread: { id: 't9', title: 'Home woodwork', isMain: false }, days: fx.chatDays().slice(-1), agent: fx.shell().agent,
    project: fx.projectPanel.project, panel: fx.projectPanel, projectOptions: fx.projectOptionsDemo, sendUrl: '/api/v1/threads/t9/messages' }),
  'project-files': () => ({ view: 'chat', nav: 'chat', mainClass: 'min-h-0 flex-1 overflow-hidden', hidePanel: true, panelTab: 'files',
    thread: { id: 't9', title: 'Home woodwork', isMain: false }, days: [], agent: fx.shell().agent, project: fx.projectPanel.project, panel: fx.projectPanel,
    projectOptions: fx.projectOptionsDemo, sendUrl: '/api/v1/threads/t9/messages' }),
  'project-soul': () => ({ view: 'chat', nav: 'chat', mainClass: 'min-h-0 flex-1 overflow-hidden', hidePanel: true, panelTab: 'soul',
    thread: { id: 't9', title: 'Home woodwork', isMain: false }, agent: fx.shell().agent, project: fx.projectPanel.project, panel: fx.projectPanel,
    projectOptions: fx.projectOptionsDemo, sendUrl: '/api/v1/threads/t9/messages',
    days: [{ label: 'Today', messages: [{ id: 'msp', role: 'assistant', createdAt: new Date().toISOString(), html: '<p>Got it — I’d like to make that a standing check.</p>', soulProposal: fx.projectSoul.proposal }] }] }),
  'project-proposal': () => {
    const days = fx.chatDays();
    const last = days.at(-1);
    const proposal = { id: 'mprop', role: 'assistant', createdAt: new Date().toISOString(),
      html: '<p>Here’s your project — press <strong>Create</strong> and I’ll open it.</p>', proposal: fx.projectProposal };
    return { view: 'chat', nav: 'chat', mainClass: 'min-h-0 flex-1 overflow-hidden', thread: { id: 'main', title: 'Main', isMain: true }, agent: fx.shell().agent,
      days: [...days.slice(0, -1), { ...last, messages: [...last.messages, proposal] }], projectOptions: fx.projectOptionsDemo, sendUrl: '/api/v1/threads/main/messages' };
  },
  'feed-sources': () => { screensC.resetScreensC(); return { view: 'feed-sources', nav: 'feed', sources: fx.feedSources, mutes: screensC.mutesData() }; },
  'admin-feed-sources': () => ({ view: 'admin/feed-sources', nav: 'admin', ...fx.adminFeedSources }),
  ideas: () => ({ view: 'ideas', nav: 'ideas', ideas: fx.ideas }),
  goals: () => ({ view: 'goals', nav: 'goals', goals: fx.goals }),
  goal: () => ({ view: 'goal', nav: 'goals', goal: fx.goalDetail, categories: fx.GOAL_CATEGORIES }),
  // The second intake round's dock ("A couple more", #196).
  'goal-round2': () => ({ view: 'goal', nav: 'goals', categories: fx.GOAL_CATEGORIES,
    goal: { ...fx.goalDetail, intakeRound: 2, pendingQuestion: { ...fx.goalDetail.pendingQuestion, id: 'q3', round: 2, questions: fx.goalDetail.pendingQuestion.questions.slice(0, 2) } } }),
  'goal-new': () => ({ view: 'goal-new', nav: 'goals', categories: fx.GOAL_CATEGORIES, examples: fx.GOAL_EXAMPLES }),
  library: () => ({ view: 'library', nav: 'library', library: fx.library }),
  'library-item': () => ({ view: 'library-item', nav: 'library', mainClass: 'min-h-0 flex-1 overflow-hidden', item: fx.libraryDoc }),
  'library-audio': () => ({ view: 'library-item', nav: 'library', mainClass: 'min-h-0 flex-1 overflow-hidden', item: fx.libraryAudio }),
  'library-ics': () => ({ view: 'library-item', nav: 'library', mainClass: 'min-h-0 flex-1 overflow-hidden', item: fx.libraryIcs }),
  'library-form': () => ({ view: 'library-item', nav: 'library', mainClass: 'min-h-0 flex-1 overflow-hidden', item: fx.libraryForm }),
  // Part B (#196): a scan to read, one being read, OCR text, a picture Jess made, a document being read aloud.
  'library-scan': () => ({ view: 'library-item', nav: 'library', mainClass: 'min-h-0 flex-1 overflow-hidden', item: screensB.libraryScreens.scan }),
  'library-reading': () => ({ view: 'library-item', nav: 'library', mainClass: 'min-h-0 flex-1 overflow-hidden', item: screensB.libraryScreens.reading }),
  'library-ocr': () => ({ view: 'library-item', nav: 'library', mainClass: 'min-h-0 flex-1 overflow-hidden', item: screensB.libraryScreens.ocr }),
  'library-picture': () => ({ view: 'library-item', nav: 'library', mainClass: 'min-h-0 flex-1 overflow-hidden', item: screensB.libraryScreens.picture }),
  'library-listening': () => ({ view: 'library-item', nav: 'library', mainClass: 'min-h-0 flex-1 overflow-hidden', item: screensB.libraryScreens.listening }),
  'library-slides': () => ({ view: 'library-item', nav: 'library', mainClass: 'min-h-0 flex-1 overflow-hidden', item: fx.librarySlides() }),
  activity: () => ({ view: 'activity', nav: 'chat', activity: fx.activityPage }),
  approvals: () => ({ view: 'approvals', nav: 'chat', approvals: fx.approvalsPage }),
  // Every state of the approval card (Phase 25 part B): folded letter, suspected injection, a picture, a closed request, history.
  'approvals-states': () => ({ view: 'approvals', nav: 'chat', approvals: fx.approvalsStatesPage }),
  // Admin → Skills and one skill's review with its trigger test (Phase 25 part B; src/dev/screens-b-sim.js).
  'admin-skills': () => ({ view: 'admin/skills', nav: 'admin', ...screensB.skillsPage() }),
  'admin-browser': () => { screensB.resetBrowser(); return { view: 'admin/browser', nav: 'admin', ...screensB.adminBrowserPage() }; },
  'skill-review': () => { screensB.resetScreensB(); return { view: 'admin/skill-review', nav: 'admin', review: screensB.skillReview(), lastTest: null }; },
  upcoming: () => ({ view: 'upcoming', nav: 'chat', upcoming: fx.upcomingPage }),
  // Lists: every open resets the simulated household (src/dev/lists-sim.js), so screenshots and flows start the same.
  lists: () => { listsSim.resetLists(); return { view: 'lists', nav: 'lists', page: listsSim.listsPage() }; },
  'lists-empty': () => { listsSim.resetLists({ empty: true }); return { view: 'lists', nav: 'lists', page: listsSim.listsPage() }; },
  list: () => { listsSim.resetLists(); return { view: 'list', nav: 'lists', detail: listsSim.listDetail(1) }; },
  'list-todo': () => { listsSim.resetLists(); return { view: 'list', nav: 'lists', detail: listsSim.listDetail(2) }; },
  'list-wish': () => { listsSim.resetLists(); return { view: 'list', nav: 'lists', detail: listsSim.listDetail(3) }; },
  // You: the Memory and Connections tabs with the Phase 25 parts (dates, import, conversations, busy sharing, sites).
  'me-memory': () => { youSim.resetYou(); return meScreen('memory'); },
  'me-connections': () => { youSim.resetYou(); return meScreen('connections'); },
  me: () => ({ view: 'me', nav: 'me', me: fx.me, tab: 'profile', tabs: [['profile', 'Profile'], ['places', 'Places'], ['memory', 'Memory'], ['notifications', 'Notifications'], ['devices', 'Devices'], ['usage', 'Usage']].map(([key, label]) => ({ key, label })) }),
  // Phase 25 part C (src/dev/screens-c-sim.js): Admin → Models / Usage / System / Overview / Groups / Lessons, You → Memory's
  // lessons and tidy, the Feed's diet and a gone story, reminder cards in the chat.
  ...screensC.SCREENS,
  // Phase 25 part D (src/dev/screens-d-sim.js): thumbs-down and Noted, background work, overnight prep, the self-review and What's
  // new, the Library's kind chips (it replaces the plain 'library' screen and adds this part's cards to Admin → System / Usage).
  ...screensD.SCREENS,
};

const ME_TABS = [['profile', 'Profile'], ['places', 'Places'], ['connections', 'Connections'], ['memory', 'Memory'], ['notifications', 'Notifications'], ['devices', 'Devices'], ['usage', 'Usage']];
function meScreen(tab) {
  return { view: 'me', nav: 'me', tab, me: fx.me, tabs: ME_TABS.map(([key, label]) => ({ key, label })) };
}

// The part D screens' admin fragments (/admin/system/self-review, …/summary, …/whats-new); anything else falls through.
router.all('/sim/admin/*splat', async (req, res, next) => {
  const out = await screensD.screensDAdmin(req.method, `/admin/${req.params.splat.join('/')}`, req.query, req.body || {}, (partial, data) => renderFragment(res, partial, data));
  if (!out) return next();
  await sleep(350 + Math.random() * 400);
  res.status(out.status || 200).json(out.body);
});

// The part C screens' admin JSON (/admin/model/test, /admin/lessons/…, /admin/usage/balance); anything else falls through.
router.all('/sim/admin/*splat', async (req, res, next) => {
  const out = await screensC.screensCAdmin(req.method, `/admin/${req.params.splat.join('/')}`, req.query, req.body || {}, (partial, data) => renderFragment(res, partial, data));
  if (!out) return next();
  await sleep(450 + Math.random() * 450);
  res.status(out.status || 200).json(out.body);
});

router.get('/screens/:page', (req, res, next) => {
  const make = SCREENS[req.params.page];
  if (!make) return next();
  const { view, ...data } = make(req.query); // a few screens read ?type=, ?reset=1
  res.render(view, { title: `${req.params.page} (demo)`, ...data });
});

// ---- Simulated API -----------------------------------------------------------
// res.render (not app.render) so fragments get res.locals (bot, presence) — identical to full-page renders.
const renderFragment = (res, partial, data) => new Promise((resolve, reject) =>
  res.render('fragment', { layout: false, partial, data, ...data }, (err, html) => (err ? reject(err) : resolve(html))));

// Upcoming re-renders its body and the panel after a change (alarms.js refreshUpcoming): the demo data again.
router.get('/sim/upcoming/fragments', async (req, res) => {
  res.json({ body: await renderFragment(res, 'upcoming-body', { upcoming: fx.upcomingPage }),
    panel: await renderFragment(res, 'upcoming-panel', { upcoming: fx.shell().panel.upcoming }) });
});

// The take-over viewer (#196): a demo page as the tab, with the site and a trust warning. The stream is one frame.
const DEMO_FRAME = new URL('../../../public/img/demo/book-weeks.webp', import.meta.url);
router.get('/sim/api/v1/threads/:id/browser/stream.mjpg', async (req, res) => {
  const buf = await fs.promises.readFile(DEMO_FRAME);
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=jbframe', 'Cache-Control': 'no-store' });
  res.end(Buffer.concat([Buffer.from(`--jbframe\r\nContent-Type: image/webp\r\nContent-Length: ${buf.length}\r\n\r\n`), buf, Buffer.from('\r\n--jbframe--\r\n')]));
});
router.get('/sim/api/v1/threads/:id/browser/frame.jpg', (req, res) => res.type('webp').sendFile(DEMO_FRAME.pathname.replace(/^\/(\w:)/, '$1')));
router.get('/sim/api/v1/threads/:id/browser', (req, res) => res.json({ open: true, url: 'https://paypa1-secure.example/signin?next=%2Fsummary',
  title: 'Log in to your account', site: 'paypa1-secure.example',
  warnings: ['The name looks like paypal.com with a 1 in place of the l.', 'The password box on this page is sent without encryption (http).'] }));

// Admin routes the part B screens call (skills: approve, the trigger test), simulated the same way.
router.all('/sim/admin/*splat', async (req, res) => {
  await sleep(400 + Math.random() * 500);
  const adminPath = `/admin/${req.params.splat.join('/')}`;
  const out = await screensB.screensBApi(req.method, adminPath, req.body || {})
    || await screensB.browserAdminApi(req.method, adminPath, req.body || {}, (partial, data) => renderFragment(res, partial, data));
  if (!out) return res.status(404).json({ error: 'Not simulated.' });
  res.status(out.status || 200).json(out.body);
});

router.all('/sim/api/v1/*splat', async (req, res) => {
  const path = '/' + req.params.splat.join('/');
  await sleep(500 + Math.random() * 600);
  if (JSON.stringify(req.body || {}).toLowerCase().includes('fail')) {
    return res.status(503).json({ error: 'Simulated failure — the model provider timed out.' });
  }

  if (/^\/threads\/[^/]+\/messages$/.test(path)) {
    const now = new Date().toISOString();
    return res.json({
      messageHtml: await renderFragment(res, 'chat/message', { id: `m${Date.now()}`, role: 'user', text: req.body.text, createdAt: now }),
      runHtml: await renderFragment(res, 'chat/message', { id: `m${Date.now() + 1}`, role: 'assistant', createdAt: now,
        run: { id: `r${Date.now()}`, status: 'queued', startedAt: now, steps: [] } }),
    });
  }
  const answer = path.match(/^\/questions\/([^/]+)\/answer$/);
  if (answer) {
    const answers = (req.body.answers || []).map(a => ({
      header: a.questionId, display: [].concat(a.value).map(v => (v === '__other__' ? a.other : v)).join(', '),
    }));
    return res.json({ cardHtml: await renderFragment(res, 'chat/question-card', {
      id: answer[1], status: 'answered', questions: answers.map(a => ({ header: a.header })), answers }) });
  }
  const partD = await screensD.screensDApi(req.method, path, req.query, req.body || {}, (partial, data) => renderFragment(res, partial, data)); // #211–#213
  if (partD) return res.status(partD.status || 200).json(partD.body);
  const lists = await listsSim.listsApi(req.method, path, req.query, req.body || {}, (partial, data) => renderFragment(res, partial, data));
  if (lists) return res.status(lists.status || 200).json(lists.body);
  const partB = await screensB.screensBApiV1(req.method, path, req.body || {}); // reading a scan, Listen (#196)
  if (partB) return res.status(partB.status || 200).json(partB.body);
  const you = await youSim.youApi(req.method, path, req.query, req.body || {}, (partial, data) => renderFragment(res, partial, data));
  if (you) return res.status(you.status || 200).json(you.body);
  const partC = await screensC.screensCApi(req.method, path, req.query, req.body || {}, (partial, data) => renderFragment(res, partial, data));
  if (partC) return res.status(partC.status || 200).json(partC.body);
  const libItem = /^\/library\/([^/]+)$/.exec(path);
  if (libItem && req.method === 'PATCH') { // the viewer's title + description (services/library.js describeItem)
    const title = String(req.body.title ?? '').trim();
    if (!title) return res.status(422).json({ error: 'Validation failed', errors: { title: 'Give it a title.' } });
    return res.json({ item: { id: libItem[1], title, description: String(req.body.description ?? '').replace(/\s+/g, ' ').trim() || null } });
  }
  // A request that closed while the page was open (a new message moved on): the card paints it closed, not back to pending.
  if (path.startsWith('/approvals/ap-closed')) {
    return res.status(409).json({ error: 'This request closed when you sent a new message, so nothing was done. Ask me again in the chat if you still want it.', code: 'approval_closed' });
  }
  // Goals (#196): a measure's new reading comes back as its card; a step's order answers with what it now waits for.
  const logM = /^\/goals\/[^/]+\/measures\/([^/]+)\/logs$/.exec(path);
  if (logM) {
    const m = fx.goalDetail.measures.find(x => String(x.id) === logM[1]);
    const value = Number(req.body.value);
    const points = [...m.points, { at: new Date().toISOString(), value }].slice(-30);
    const measure = { ...m, latest: value, latestAt: new Date().toISOString(), points, thisWeek: m.perWeek ? m.thisWeek + 1 : null,
      weekLabel: m.perWeek ? `${m.thisWeek + 1} of ${m.perWeek} this week` : null, progress: m.target ? Math.round(((value - m.start) / (m.target - m.start)) * 100) : null };
    return res.status(201).json({ measure, progress: measure.progress, html: await renderFragment(res, 'goal-measure', { ...measure, goalId: 'g1' }) });
  }
  const stepM = /^\/goals\/[^/]+\/tasks\/([^/]+)$/.exec(path);
  if (stepM && Array.isArray(req.body.after)) {
    if (req.body.after.includes('pl3') && stepM[1] === 'pl1') return res.status(422).json({ error: 'Validation failed', errors: { after: 'That order goes round in a circle: a step would end up waiting for itself.' } });
    const titles = req.body.after.map(id => fx.goalDetail.plan.find(p => p.id === id)?.title).filter(Boolean);
    return res.json({ ok: true, task: { id: stepM[1], enabled: true, status: 'todo', queued: titles.length > 0, after: titles.length ? titles : null, afterIds: req.body.after } });
  }
  if (/^\/schedules\/[^/]+\/run$/.test(path)) return res.json({ ok: true, runId: 'r99', threadId: 'main' }); // Run it now (#196)
  if (path.startsWith('/approvals/')) return res.json({ status: req.body.decision === 'approve' ? 'approved' : 'denied', pendingCount: 1 });
  if (path === '/ideas/generate') return res.json({ itemsHtml: await renderFragment(res, 'idea-card', { ...fx.ideas.items[1], id: `i${Date.now()}`, isNew: true }) });
  if (/^\/ideas\/[^/]+\/dismiss$/.test(path)) return res.json({ ok: true, state: req.body.reason === 'not_now' ? 'snoozed' : 'dismissed' }); // #196
  if (/^\/ideas\/[^/]+\/start$/.test(path)) return res.json({ redirect: '/styleguide/screens/chat' });
  if (path === '/goals') return res.json({ redirect: '/styleguide/screens/goal' });
  if (path === '/markdown/preview') return res.json({ html: renderMarkdown(String(req.body.text || '')) });
  if (path === '/feed/prompt' && !String(req.body.prompt || '').trim()) {
    return res.status(422).json({ error: 'Validation failed', errors: { prompt: 'Tell me at least one thing you want to see.' } });
  }
  res.json({ ok: true });
});

export default router;
