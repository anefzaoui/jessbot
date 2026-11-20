// DEV ONLY: the styleguide's screens and simulated API for Phase 25 part D (decisions #211–#213): a thumbs-down's "What was off?"
// and "Noted" chip, the trust chip and a paused task's note in the chat; background work (the delegate step and post-back, a
// side chat's brief, overnight prep's chat, the rail's marks); overnight prep on You, Ideas ("Ready for you") and Admin → Usage;
// Admin → System's weekly self-review, How I'm doing and What's new, and the person's What's new card; the Library's kind
// filter and search; a goal's new number. Shapes follow the services the real routes use (lessons.js notedChip, sources.js
// trustChip, delegate.js backgroundOf, prep.js prepView / prepAdminView, notes.js noteView, self-review.js selfReviewPage /
// summaryFor / previewOf, whats-new.js entryView / unseenFor, library.js filtersFor, goals.js measureView), so
// `npm run ui:flows` drives the real partials and client code. State resets when one of these screens opens (What's new for
// the person keeps "seen" across reloads, as it does for real, until ?reset=1).
import * as fx from './fixtures.js';
import * as screensC from './screens-c-sim.js';
import { previewOf, KIND_LABELS } from '../agent/self-review.js';
import { filtersFor } from '../services/library.js';

const min = 60e3, hour = 36e5, day = 864e5;
const ago = ms => new Date(Date.now() - ms).toISOString();
const sqlAgo = ms => ago(ms).replace('T', ' ').slice(0, 19);
const p = html => `<p>${html}</p>`;
const ME_TABS = [['profile', 'Profile'], ['places', 'Places'], ['connections', 'Connections'], ['memory', 'Memory'], ['notifications', 'Notifications'], ['devices', 'Devices'], ['usage', 'Usage']];
const chatScreen = (thread, days, extra = {}) => ({ view: 'chat', nav: 'chat', mainClass: 'min-h-0 flex-1 overflow-hidden', thread, days,
  agent: { activity: 'resting' }, sendUrl: `/api/v1/threads/${thread.id}/messages`, ...extra });
const doneRun = (id, steps, extra = {}) => ({ id, status: 'done', startedAt: ago(30 * min), elapsedLabel: '1m 12s', steps, ...extra });

// ---- The chat: a thumbs-down, the trust chip, a paused task ---------------------------------------------------------------
const sources = { checked: 4, found: 9, sites: 3, newestDays: 2, label: 'Checked 4 sources · 3 sites · newest 2 days old', items: [
  { url: 'https://www.sncf-connect.com/en-en/train-ticket/paris-lyon', host: 'sncf-connect.com', title: 'Paris to Lyon trains', date: null, kind: 'read' },
  { url: 'https://www.thetrainline.com/en/train-times/paris-to-lyon', host: 'thetrainline.com', title: 'Paris to Lyon train times and tickets', date: ago(2 * day).slice(0, 10), kind: 'read' },
  { url: 'https://www.ouigo.com/en', host: 'ouigo.com', title: 'OUIGO low-cost trains', date: ago(9 * day).slice(0, 10), kind: 'read' },
  { url: 'https://www.sncf-connect.com/en-en/help/luggage', host: 'sncf-connect.com', title: 'Luggage on board', date: null, kind: 'read' },
  { url: 'https://www.seat61.com/France.htm', host: 'seat61.com', title: 'Train travel in France', date: null, kind: 'found' },
] };
let noted; // lessonId → status
const resetFeedback = () => { noted = { 701: 'proposed', 703: 'active' }; };
function feedbackDays() {
  return [{ label: 'Today', messages: [
    { id: 'fu1', role: 'user', text: 'Which train should we take to Lyon on Friday?', createdAt: ago(50 * min) },
    { id: 'fm1', role: 'assistant', messageId: 7101, createdAt: ago(49 * min), feedback: 'down',
      html: p('There are 14 trains on Friday. Here is every one of them with its price, its duration, the number of changes, the station it leaves from, the seat classes and the luggage rules…'),
      noted: { text: 'Noted: When I compare options for you, lead with my pick and keep it to a few lines (not every option)', rule: 'When I compare options for you, lead with my pick and keep it to a few lines (not every option)', lessonId: 701, keep: true },
      run: doneRun('fr1', [{ id: 's1', iconName: 'search', label: 'Searched “Paris Lyon train Friday”', status: 'ok', durationLabel: '3s' }]) },
    { id: 'fu2', role: 'user', text: 'Shorter please. Just the best one.', createdAt: ago(40 * min) },
    { id: 'fm2', role: 'assistant', messageId: 7102, createdAt: ago(39 * min), simplerText: 'Explain that again more simply, with the bit of context I’m missing.',
      html: p('Take the <strong>17:04 TGV from Gare de Lyon</strong>: 1 h 56 min, direct, €39 each if you book today. You’d be at the apartment by 19:30, in time for dinner.'),
      run: doneRun('fr2', [{ id: 's1', iconName: 'globe', label: 'Read Paris to Lyon trains', detail: 'sncf-connect.com', status: 'ok', durationLabel: '4s' },
        { id: 's2', iconName: 'globe', label: 'Read Paris to Lyon train times', detail: 'thetrainline.com', status: 'ok', durationLabel: '3s' }], { sources }) },
    { id: 'fu3', role: 'user', text: 'And what about the Saturday market?', createdAt: ago(20 * min) },
    { id: 'fm3', role: 'assistant', messageId: 7104, createdAt: ago(19 * min),
      html: p('The Saint-Antoine market runs Tuesday to Sunday, 6:00 to 13:00, along the Saône. Go before 10 for the bread stalls.'),
      noted: { text: 'Noted: Say opening hours in 24-hour time', rule: 'Say opening hours in 24-hour time', lessonId: 703, keep: false },
      run: doneRun('fr3', []) },
    { id: 'fm5', role: 'assistant', messageId: 7105, createdAt: ago(10 * min), html: p('It opens at 6:00 and the bread stalls sell out by 10.'), run: doneRun('fr5', []) },
    { id: 'fm4', role: 'assistant', createdAt: ago(3 * min), html: p('I’ve paused <strong>Pharmacy stock check</strong>: it failed 3 times in a row (last time: the pharmacy site didn’t load). Resume it in <a href="/upcoming">Upcoming</a> when it should run again, or tell me what to change.'),
      run: { id: 'fr4', status: 'done', startedAt: ago(3 * min), steps: [], origin: 'schedule', originLabel: 'Pharmacy stock check', scheduleId: 'j8', errorKind: 'paused', schedulePaused: true } },
  ] }];
}
const chipFor = (lessonId, note) => {
  const rule = note ? 'When I suggest a train, give the one I’d take and why, in two lines' : 'When I suggest a train, lead with the one I’d take and keep it short';
  return { text: `Noted: ${rule}`, rule, lessonId, keep: !note };
};

// ---- What's new, the person's card ----------------------------------------------------------------------------------------
const WN_PUBLISHED = { id: 41, lines: ['You can press thumbs-down and tell me what was off: I keep a rule for next time, if you want it.',
  'Long jobs can run in the background in their own side chat, and the result comes back to your chat.',
  'Turn on overnight prep and I’ll prepare one of your ideas as a first draft while you sleep.',
  'The Library search looks inside your files now, not only at their names.',
  'Goals can count a number for you: a weight, runs a week, pages read.'], publishedAt: sqlAgo(2 * hour) };
const seen = new Set();

// ---- Background work --------------------------------------------------------------------------------------------------------
const DESKS_BRIEF = 'Compare three standing desks for Alex’s home office.\n\nConstraints: under €450 each, a desktop of at least 140 × 70 cm, '
  + 'a motor quiet enough for calls (under 50 dB), delivery to Lyon or pickup in Paris before 15 October.\n\n'
  + 'He prefers a dark wood top and dislikes crossbars that hit his knees. Done looks like: a one-page comparison in the Library '
  + '(price, size, noise, warranty, delivery), my pick with one line why, and the links.';
function backgroundMainDays() {
  return [{ label: 'Today', messages: [
    { id: 'bu1', role: 'user', text: 'Can you compare a few standing desks for my office? No rush.', createdAt: ago(3 * hour) },
    { id: 'bm1', role: 'assistant', messageId: 7201, runId: 8101, createdAt: ago(3 * hour), html: p('I’m on it in the background and will post here when it’s done.'),
      run: doneRun(8101, [{ id: 's1', iconName: 'rocket', label: 'Started “Compare 3 standing desks” in the background', detail: 'Side chat “Working on: Compare 3 standing desks”',
        href: '/styleguide/screens/side-chat-background', status: 'ok', durationLabel: '1s', tool: 'delegate' }]) },
    { id: 'bm2', role: 'assistant', messageId: 7202, runId: 8103, createdAt: ago(40 * min),
      html: p('Done in the background: <strong>Compare 3 standing desks</strong>. The Flexispot E7 is the one: €429, 140 × 70 cm, 45 dB, and it delivers to Lyon. <a href="/styleguide/screens/side-chat-background">Open the side chat</a> · <a href="/styleguide/screens/library-item">Standing desks compared</a>'),
      run: { id: 8103, status: 'done', startedAt: ago(40 * min), steps: [], origin: 'delegate_report', originLabel: 'Background task' } },
    { id: 'bm3', role: 'assistant', messageId: 7203, runId: 8104, createdAt: ago(10 * min),
      html: p('Good morning. While you were away, my background work left a note: <strong>Overnight prep:</strong> I prepared “Fence permit: the checklist and the forms” overnight, for your idea “Finish the fence permit application”. <a href="/styleguide/screens/library-item">Open</a>'),
      run: { id: 8104, status: 'done', startedAt: ago(10 * min), steps: [], origin: 'checkin', originLabel: 'Notes' } },
  ] }];
}
const sideDeskDays = () => [{ label: 'Today', messages: [
  { id: 'sd1', role: 'assistant', messageId: 7301, runId: 8102, createdAt: ago(45 * min),
    html: p('The Flexispot E7 is the one: €429, 140 × 70 cm, 45 dB, and it delivers to Lyon.') + p('I compared it with the IKEA Mittzon (quieter, but no dark top) and the Fezibo Pro (cheaper, but 58 dB). The full comparison is in your Library: <a href="/styleguide/screens/library-item">Standing desks compared</a>.'),
    run: doneRun(8102, [{ id: 's1', iconName: 'search', label: 'Searched “standing desk 140x70 quiet motor”', status: 'ok', durationLabel: '3s' },
      { id: 's2', iconName: 'globe', label: 'Read Flexispot E7 specifications', detail: 'flexispot.eu', status: 'ok', durationLabel: '5s' },
      { id: 's3', iconName: 'file-plus', label: 'Saved “Standing desks compared”', status: 'ok', durationLabel: '2s' }],
    { origin: 'delegate', originLabel: 'Compare 3 standing desks', parentRunId: 8101, elapsedLabel: '6m 40s',
      sources: { ...sources, label: 'Checked 6 sources · 4 sites · newest 5 days old', checked: 6, sites: 4, newestDays: 5 } }) },
] }];
const sidePrepDays = () => [{ label: 'Yesterday', messages: [
  { id: 'sp1', role: 'assistant', messageId: 7401, runId: 8201, createdAt: ago(9 * hour),
    html: p('I prepared “Fence permit: the checklist and the forms”: the zoning rules for your street, the four documents the city asks for, and the two fields that timed out last time.'),
    run: doneRun(8201, [{ id: 's1', iconName: 'search', label: 'Searched “fence permit residential height limit”', status: 'ok', durationLabel: '2s' },
      { id: 's2', iconName: 'file-plus', label: 'Saved “Fence permit: the checklist and the forms”', status: 'ok', durationLabel: '2s' }],
    { origin: 'prep', originLabel: 'Finish the fence permit application', elapsedLabel: '2m 05s' }) },
] }];

// ---- Overnight prep ----------------------------------------------------------------------------------------------------------
let prep;
const resetPrep = () => { prep = { value: 'off', dailyCap: 0.05 }; };
const prepView = () => ({ value: prep.value, capLabel: `$${prep.dailyCap.toFixed(2)}`, quiet: '22:00 to 07:30', stopped: null,
  last: { title: 'Fence permit: the checklist and the forms', ideaTitle: 'Finish the fence permit application', href: '/styleguide/screens/library-item', at: ago(9 * hour) } });
const notes = () => ({
  pending: [
    { id: 91, text: 'The Flexispot E7 drops to €399 on Friday if you can wait two days.', priority: 'normal', kind: 'note', href: null, sourceLabel: 'Compare 3 standing desks', createdAt: sqlAgo(50 * min), deliveredAt: null },
    { id: 92, text: 'The permit office closes at noon on Fridays: send the form before then.', priority: 'high', kind: 'note', href: null, sourceLabel: 'Permit office appointment slots', createdAt: sqlAgo(2 * hour), deliveredAt: null },
  ],
  delivered: [
    { id: 90, text: 'Ready for you: I prepared “Fence permit: the checklist and the forms” overnight, for your idea “Finish the fence permit application”.', priority: 'normal', kind: 'prep',
      href: '/styleguide/screens/library-item', sourceLabel: 'Overnight prep', createdAt: sqlAgo(10 * hour), deliveredAt: sqlAgo(3 * hour) },
  ],
});
const readyIdea = { ...fx.ideas.items[2], id: 'i3', prepared: { itemId: 'l9', title: 'Fence permit: the checklist and the forms', type: 'md', href: '/styleguide/screens/library-item',
  readyAt: ago(2 * hour), chatHref: '/styleguide/screens/side-chat-prep' } };
const prepAdmin = () => ({ dailyCap: prep.dailyCap, capLabel: `$${prep.dailyCap.toFixed(2)}`, maxCap: 1, people: [{ id: 1, name: 'Alex Rivera' }, { id: 2, name: 'Maya' }],
  nights: 11, drafts: 8, spent: 0.41, spentLabel: '$0.41' });

// ---- Admin → System: the self-review, How I'm doing, What's new -----------------------------------------------------------
const AGENTS_LINE = '- When a site asks for a login, stop and ask them first.';
const proposal = (id, kind, title, why, change, evidence, target = null) => ({ id, reviewId: 5, kind, kindLabel: KIND_LABELS[kind], title, why, change,
  preview: previewOf(kind, change, target), evidence, target, status: 'pending', reason: null, result: null, decidedAt: null, createdAt: sqlAgo(6 * hour) });
const ev = (runId, label, person, h) => ({ runId, href: `/styleguide/screens/chat#run-${runId}`, label, person, at: sqlAgo(h * hour) });
let review;
function resetReview() {
  review = { enabled: true, running: false, proposals: [
    proposal(51, 'agents_rule', 'Lead with the pick when comparing', 'Three thumbs-down this week were on long comparisons; each time the next message asked for "just the best one".',
      { section: '## How I answer', text: 'When comparing options, lead with the one I’d pick and why in one line; the full list goes in the Library.' },
      [ev(8101, 'A chat', 'Alex', 30), ev(8102, 'A background task', 'Alex', 26), ev(8110, 'A chat', 'Maya', 50)]),
    proposal(52, 'removal', 'Drop a rule nobody hits', 'No task in the last four weeks came near it, and it adds a line to every prompt.',
      { find: '- Before sending a fax, check the number twice.' }, []),
    proposal(53, 'instruction', 'Maya wants prices in yen', 'Two of Maya’s tasks had to be redone to convert euros to yen.',
      { user_id: 2, text: 'Give prices in Japanese yen first, euros in brackets.' }, [ev(8111, 'A scheduled task', 'Maya', 70)], { id: 2, name: 'Maya' }),
  ] };
}
const reviewPage = () => ({ settings: { enabled: review.enabled }, pending: review.proposals.filter(x => x.status === 'pending').length, running: review.running, everyDays: 7,
  latest: review.running ? null : { id: 5, origin: 'weekly', status: 'done', period: { start: sqlAgo(7 * day + 6 * hour), end: sqlAgo(6 * hour) }, note: 'Left out: “Stop using the fax rule”: the line to remove isn’t in AGENTS.md exactly once',
    createdAt: sqlAgo(6 * hour), finishedAt: sqlAgo(6 * hour), proposals: review.proposals },
  earlier: [{ id: 4, origin: 'weekly', status: 'nothing', period: {}, createdAt: sqlAgo(7 * day + 6 * hour), proposals: [] },
    { id: 3, origin: 'admin', status: 'done', period: {}, createdAt: sqlAgo(14 * day), proposals: [{ status: 'approved' }, { status: 'rejected' }] }] });
const summary = days => {
  const k = days === 30 ? 4 : 1;
  return { days, runs: { total: 58 * k, done: 51 * k, errored: 3 * k, stopped: 1 * k }, thumbs: { up: 14 * k, down: 3 * k }, pushes: { total: 9 * k, runs: 6 * k, deliveredAfter: 5 * k },
    deadEndChecks: 2 * k, repeatsRefused: 1 * k, checkins: { sent: 12 * k, silent: 7 * k, skipped: 2 * k }, spendUsd: 2.84 * k, spendLabel: `$${(2.84 * k).toFixed(2)}`,
    failedSteps: 11 * k, declinedApprovals: 2 * k, wishes: { n: 3, asks: 7 },
    proposedLessons: [{ id: 11, rule: 'On leboncoin.fr, sort by date before reading prices', recurrences: 3 }, { id: 12, rule: 'When booking trains, check the return leg too', recurrences: 2 }] };
};
let entries;
const resetEntries = () => {
  entries = [
    { id: 42, release: '3e7cc9b', status: 'draft', publishedAt: null, createdAt: sqlAgo(1 * hour),
      subjects: ['Phase 25: the thumbs-down asks what was off', 'Phase 25: decisions #211-#213', 'Phase 22: delegate to the background, overnight prep, notes for later', 'Phase 25: tests for the part D screens'],
      lines: ['Press thumbs-down and tell me what was off: I keep a rule for next time, if you want it.', 'Long jobs can run in the background and report back to your chat.'] },
    { id: 41, release: 'b2f6335', status: 'published', publishedAt: sqlAgo(2 * day), createdAt: sqlAgo(2 * day + hour),
      subjects: ['Phase 25: the approval card and Admin → Skills review', 'Phase 25: FEATURES records the screens'], lines: ['Approval requests say plainly who a message reaches and whether it can be undone.'] },
  ];
};

// ---- Goals: a new number -------------------------------------------------------------------------------------------------------
const measureOf = b => {
  const label = String(b.label || '').trim(), s = b.start ?? null, t = b.target ?? null, pw = b.per_week ?? null;
  if (label.length < 2) return { error: 'Give the number a short name, like "Weight" or "Runs".' };
  if (t == null && pw == null) return { error: 'A measure needs a target, a number per week, or both.' };
  if (s != null && t != null && Number(s) === Number(t)) return { error: 'The start and the target are the same number.' };
  if (fx.goalDetail.measures.some(m => m.label.toLowerCase() === label.toLowerCase())) return { error: `This goal already counts “${label}”.` };
  const unit = b.unit ? ` ${b.unit}` : '';
  return { measure: { id: 900 + Math.floor(Math.random() * 99), label, unit: b.unit || null, start: s, target: t, direction: s != null && t != null && t < s ? 'down' : 'up',
    perWeek: pw, latest: null, latestAt: null, progress: s != null && t != null ? 0 : null, thisWeek: pw ? 0 : null, weekLabel: pw ? `0 of ${pw} this week` : null, points: [],
    line: [t != null ? `${s ?? '?'} to ${t}${unit}` : null, pw ? `${pw} a week` : null].filter(Boolean).join(' · ') + ' · nothing logged yet' } };
};

// ---- Screens ----------------------------------------------------------------------------------------------------------------
export function resetScreensD() { resetFeedback(); resetPrep(); resetReview(); resetEntries(); }
resetScreensD();
const fresh = make => query => { resetScreensD(); if (query?.reset) seen.clear(); return make(query || {}); };
const meNotifications = () => ({ view: 'me', nav: 'me', tab: 'notifications', tabs: ME_TABS.map(([key, label]) => ({ key, label })),
  me: { ...fx.me, checkins: fx.upcomingPage.checkins, prep: prepView(), notes: notes() } });

export const SCREENS = {
  'chat-feedback': fresh(() => chatScreen({ id: 'main', title: 'Main', isMain: true }, feedbackDays())),
  'chat-whats-new': fresh(() => chatScreen({ id: 'main', title: 'Main', isMain: true }, fx.chatDays().map(d => ({ ...d, messages: d.messages.filter(m => !m.question || m.question.status !== 'pending') })),
    { whatsNew: seen.has(WN_PUBLISHED.id) ? [] : [WN_PUBLISHED], now: fx.now })),
  'chat-background': fresh(() => chatScreen({ id: 'main', title: 'Main', isMain: true }, backgroundMainDays())),
  'side-chat-background': fresh(() => chatScreen({ id: 'sc4', title: 'Working on: Compare 3 standing desks', isMain: false }, sideDeskDays(), {
    background: { kind: 'delegate', title: 'Compare 3 standing desks', brief: DESKS_BRIEF, skill: 'buying-guide', startedAt: ago(52 * min), status: 'done',
      from: { href: '/styleguide/screens/chat-background#run-8101', label: 'your main chat' } } })),
  'side-chat-prep': fresh(() => chatScreen({ id: 'sc5', title: 'Prepared overnight: Fence permit checklist', isMain: false }, sidePrepDays(), {
    background: { kind: 'prep', title: 'Finish the fence permit application', startedAt: ago(9 * hour), status: 'done',
      idea: { title: 'Finish the fence permit application', why: fx.ideas.items[2].why }, item: { title: 'Fence permit: the checklist and the forms', href: '/styleguide/screens/library-item' } } })),
  'ideas-ready': fresh(() => ({ view: 'ideas', nav: 'ideas', ideas: { ...fx.ideas, items: fx.ideas.items.map(i => (i.id === 'i3' ? readyIdea : i)), ready: [readyIdea], prep: 'ideas' } })),
  'me-notifications': fresh(() => meNotifications()),
  'admin-system-running': fresh(() => { review.running = true; return { ...screensC.SCREENS['admin-system'](), review: reviewPage(), summary: summary(7), whatsNew: { entries, maxLines: 6 } }; }),
  // Part C's screens with this part's cards on them.
  'admin-system': fresh(() => ({ ...screensC.SCREENS['admin-system'](), review: reviewPage(), summary: summary(7), whatsNew: { entries, maxLines: 6 } })),
  'admin-usage': fresh(() => ({ ...screensC.SCREENS['admin-usage'](), prep: prepAdmin() })),
  // The Library with its kind chips (?type= picks one, as on the real page).
  library: query => ({ view: 'library', nav: 'library', library: { ...fx.library, filters: filtersFor(fx.library.items, query.type || null) } }),
};

// ---- Simulated API ------------------------------------------------------------------------------------------------------------
const invalid = errors => ({ status: 422, body: { error: 'Validation failed', errors } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** /api/v1/… calls of these screens → { status?, body } or null. render(partial, data) → html. */
export async function screensDApi(method, path, query, body, render) {
  const fb = /^\/messages\/(\d+)\/feedback$/.exec(path);
  if (fb && method === 'POST') {
    const id = Number(fb[1]);
    const none = { ok: true, lesson: null, chip: null, html: null };
    if (body.feedback !== 'down') { if (noted[702] === 'proposed') delete noted[702]; return { body: none }; }
    if (body.noteFirst) return { body: { ...none, waiting: true } };
    if (id !== 7102) return { body: none }; // nothing general to learn from this one
    const note = String(body.note || '').trim();
    noted[702] = note ? 'active' : 'proposed';
    const chip = chipFor(702, note);
    return { body: { ok: true, lesson: { id: 702, rule: chip.rule, status: noted[702] }, chip, html: await render('chat/noted-chip', { noted: chip }) } };
  }
  const ml = /^\/me\/lessons\/(70\d)(\/keep)?$/.exec(path);
  if (ml) {
    const id = Number(ml[1]);
    if (!noted[id]) return { status: 404, body: { error: 'That lesson no longer exists.' } };
    if (ml[2] && method === 'POST') { noted[id] = 'active'; return { body: { ok: true, lesson: { id, status: 'active' } } }; }
    if (method === 'DELETE') { if (body.reject && noted[id] === 'proposed') noted[id] = 'rejected'; else delete noted[id]; return { body: { ok: true } }; }
  }
  const wn = /^\/whats-new\/(\d+)\/seen$/.exec(path);
  if (wn && method === 'POST') { seen.add(Number(wn[1])); return { body: { ok: true } }; }
  if (path === '/whats-new' && method === 'GET') return { body: { entries: seen.has(WN_PUBLISHED.id) ? [] : [WN_PUBLISHED] } };
  if (path === '/me/prep' && method === 'PUT') {
    if (!['off', 'ideas'].includes(body.prep)) return invalid({ prep: 'Choose off or ideas.' });
    prep.value = body.prep;
    return { body: { ok: true, prep: prep.value, view: prepView() } };
  }
  if (path === '/admin/prep' && method === 'PUT') {
    const cap = Number(body.dailyCap);
    if (body.dailyCap === '' || !Number.isFinite(cap) || cap < 0 || cap > 1) return invalid({ dailyCap: 'Between $0 and $1.00 a night per person ($0 turns overnight prep off for everyone).' });
    prep.dailyCap = Math.round(cap * 1000) / 1000;
    return { body: { ok: true, prep: { dailyCap: prep.dailyCap } } };
  }
  if (path === '/admin/self-review' && method === 'PUT') { review.enabled = body.enabled === true; return { body: { ok: true, settings: { enabled: review.enabled } } }; }
  if (path === '/admin/self-review/run' && method === 'POST') {
    review.running = true;
    await sleep(1200);
    resetReview();
    return { body: { ok: true, review: reviewPage().latest } };
  }
  const pr = /^\/admin\/self-review\/proposals\/(\d+)\/(approve|reject)$/.exec(path);
  if (pr && method === 'POST') {
    const x = review.proposals.find(y => y.id === Number(pr[1]));
    if (!x) return { status: 404, body: { error: 'That proposal is gone.' } };
    if (x.status !== 'pending') return { status: 409, body: { error: `It was already ${x.status}.` } };
    x.status = pr[2] === 'approve' ? 'approved' : 'rejected';
    x.decidedAt = sqlAgo(0);
    if (x.status === 'approved') x.result = x.kind === 'instruction' ? 'Added to Maya’s instructions (a new version).' : 'AGENTS.md saved (version 14; Admin → Personality → History can restore the one before).';
    else x.reason = String(body.reason || '').trim().slice(0, 300) || null;
    return { body: { ok: true, proposal: x } };
  }
  const we = /^\/admin\/whats-new\/(\d+)(?:\/(redraft|publish|discard))?$/.exec(path);
  if (we) {
    const e = entries.find(y => y.id === Number(we[1]));
    if (!e) return { status: 404, body: { error: 'That release note is gone.' } };
    if (!we[2] && method === 'PUT') {
      const lines = (Array.isArray(body.lines) ? body.lines : String(body.lines || '').split('\n')).map(l => String(l).replace(/\s*—\s*/g, ': ').trim()).filter(Boolean);
      if (lines.length > 6) return invalid({ lines: 'At most 6 lines.' });
      e.lines = lines;
      return { body: { ok: true, entry: e } };
    }
    if (we[2] === 'redraft') { await sleep(900); e.lines = ['You can tell me what was off when you press thumbs-down.', 'Long jobs run in the background and report back.', 'Overnight prep drafts one idea while you sleep.']; return { body: { ok: true, entry: e } }; }
    if (we[2] === 'publish') {
      if (e.status === 'published') return { status: 409, body: { error: 'It is already published.' } };
      if (!e.lines.length) return invalid({ lines: 'Write at least one line first.' });
      e.status = 'published'; e.publishedAt = sqlAgo(0);
      return { body: { ok: true, entry: e } };
    }
    if (we[2] === 'discard') { e.status = 'discarded'; return { body: { ok: true, entry: e } }; }
  }
  if (path === '/library' && method === 'GET' && query.query) {
    const words = String(query.query).toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const inside = { l1: 'openings endgame blunders', l2: 'research products', l7: 'lyon trains apartment' }; // "what's inside" the demo files
    const items = fx.library.items.map(i => ({ i, n: words.filter(w => `${i.title} ${inside[i.id] || ''}`.toLowerCase().includes(w)).length }))
      .filter(x => x.n).sort((a, b) => b.n - a.n).map(x => x.i);
    return { body: { items } };
  }
  const gm = /^\/goals\/([^/]+)\/measures$/.exec(path);
  if (gm && method === 'POST') {
    const out = measureOf(body);
    if (out.error) return invalid({ measure: out.error });
    return { status: 201, body: { measure: out.measure, html: await render('goal-measure', { ...out.measure, goalId: gm[1] }) } };
  }
  if (/^\/schedules\/[^/]+\/resume$/.test(path) && method === 'POST') return { body: { schedule: { id: 'j8', paused: false } } };
  return null;
}

/** /admin/… calls (the web routes' fragments) → { status?, body } or null. */
export async function screensDAdmin(method, path, query, body, render) {
  if (path === '/admin/system/self-review' && method === 'GET') {
    review.running = false;
    const page = reviewPage();
    return { body: { running: page.running, pending: page.pending, html: await render('admin/self-review', { review: page }) } };
  }
  if (path === '/admin/system/summary' && method === 'GET') {
    const days = Number(query.days) === 30 ? 30 : 7;
    return { body: { days, html: await render('admin/how-im-doing', { summary: summary(days) }) } };
  }
  if (path === '/admin/system/whats-new' && method === 'GET') return { body: { html: await render('admin/whats-new', { whatsNew: { entries, maxLines: 6 } }) } };
  // Admin → System's live log polls every few seconds while the page is open (admin-system.js): nothing new in the demo.
  if (path === '/admin/system/logs' && method === 'GET') return { body: { lines: [] } };
  return null;
}

