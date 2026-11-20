// DEV ONLY: the styleguide's screens and simulated API for Phase 25 part C (decisions #203–#205): Admin → Models (fallback
// rows, background model, Pictures), Usage (balance, fallbacks, pictures and scans), System (the wish log), Overview
// (security), Groups (per-task budget), Personality → Lessons; You → Memory (lessons, the weekly tidy); the Feed's sources
// (OPML, muted words), reading diet and a gone story; and the reminder cards in the chat. Shapes follow the services the
// real routes use (usage.js, spend-watch.js, wishes.js, security-events.js, admin-lessons.js lessonCard, lessons.js,
// memory.js listTidies, feed.js mutesList, feed-rank.js readingDiet, alarms.js reminderCard), so `npm run ui:flows` drives
// the real partials and client code. State resets whenever one of these screens opens.
import * as fx from './fixtures.js';

const min = 60e3, hour = 36e5, day = 864e5;
const ago = ms => new Date(Date.now() - ms).toISOString();
const sqlAgo = ms => ago(ms).replace('T', ' ').slice(0, 19);
const clone = v => JSON.parse(JSON.stringify(v));
const clock = ms => new Date(Date.now() + ms).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });

// ---- Admin → Models --------------------------------------------------------------------------------------------------
// A model id containing "down" doesn't answer (the row shows why); anything else answers in about a second.
const modelScreen = () => ({ ...fx.adminModel,
  llm: { ...fx.adminModel.llm, fallbackList: ['anthropic/claude-sonnet-4.6', 'google/gemini-3-flash'], fallbacks: 'anthropic/claude-sonnet-4.6, google/gemini-3-flash',
    background: 'openai/gpt-6-mini', maxFallbacks: 3, onOpenRouter: true },
  images: { model: 'black-forest-labs/flux.2-klein-4b', checked: { price: { label: 'about $0.015 a picture', source: 'list' }, warning: null, at: ago(3 * day) },
    usage: { count: 14, cost: 0.21, costLabel: '$0.210', people: 2, countLabel: '14 pictures' } } });

// ---- Admin → Usage -----------------------------------------------------------------------------------------------------
const money = (v, d = 2) => `$${v.toFixed(d)}`;
function usageScreen() {
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.now() - (29 - i) * day);
    const value = [0.12, 0.3, 0.08, 0.41, 0.22, 0.05, 0.6][i % 7] * (0.6 + (i / 40));
    return { key: d.toISOString().slice(0, 10), label: String(d.getDate()), value, valueLabel: money(value, 3) };
  });
  const max = Math.max(...days.map(d => d.value));
  const share = (rows) => { const t = rows.reduce((a, r) => a + r.c, 0); return rows.map(r => ({ ...r, pct: Math.round((r.c / t) * 100), costLabel: money(r.c, 3) })); };
  return {
    usage: {
      weekLabel: '$2.84', weekCalls: 412, monthLabel: '$9.61', monthCalls: 1873, monthTokens: '6.2M',
      people: [
        { id: 1, name: 'Alex Rivera', role: 'admin', spentLabel: '$2.10', budgetLabel: '$5.00', monthLabel: '$6.90', pct: 42, limited: true, tone: 'ok' },
        { id: 2, name: 'Maya', role: 'member', spentLabel: '$0.74', budgetLabel: '$1.00', monthLabel: '$2.71', pct: 74, limited: true, tone: 'ok' },
      ],
      purposes: share([{ key: 'chat', label: 'Chats', c: 6.1 }, { key: 'feed', label: 'Feed', c: 1.4 }, { key: 'image', label: 'Pictures', c: 0.21 }, { key: 'ocr', label: 'Reading scans', c: 0.08 }, { key: 'extract', label: 'Memory', c: 0.5 }]),
      models: share([{ key: 'openai/gpt-6-luna', label: 'openai/gpt-6-luna', c: 7.2, n: 1510 }, { key: 'openai/gpt-6-mini', label: 'openai/gpt-6-mini', c: 1.3, n: 301 }, { key: 'anthropic/claude-sonnet-4.6', label: 'anthropic/claude-sonnet-4.6', c: 0.4, n: 3 }]),
      fallbacks: { count: 3, label: 'Answered by a fallback 3×', byModel: [{ model: 'anthropic/claude-sonnet-4.6', count: 3 }] },
      features: { image: { count: 14, cost: 0.21, costLabel: '$0.210', people: 2, countLabel: '14 pictures' },
        ocr: { count: 6, cost: 0.08, costLabel: '$0.080', people: 1, countLabel: '6 model calls' } },
      days: days.map(d => ({ ...d, pct: Math.round((d.value / max) * 100) })),
      top: [{ title: 'Plan the Lyon weekend: trains, the apartment, a bouchon', person: 'Alex Rivera', costLabel: '$0.412', threadId: 't1' },
        { title: 'Read the scanned lease and list what we must fix', person: 'Maya', costLabel: '$0.188', threadId: null }],
    },
    balance: balance(),
  };
}
let balanceReads = 0;
const balance = () => ({ balance: 4.62, days: 5 + (balanceReads % 2), perDay: 0.82, at: ago(balanceReads ? 5e3 : 3 * hour), recordedWeek: 2.84, providerWeek: 3.9,
  amount: '$4.62', daysLine: `About ${5 + (balanceReads % 2)} days at this pace`, perDayLabel: '$0.82 a day over the last two weeks', warn: true,
  gap: 'OpenRouter counts $3.90 for this key this week; $2.84 was recorded here (another app or install may use the same key).' });

// ---- Admin → System, the wish log ----------------------------------------------------------------------------------------
let wishes = [];
const resetWishes = () => {
  wishes = [
    { id: 1, text: 'Book me a taxi to the airport for Friday morning', count: 4, person: 'Alex Rivera', firstSeen: sqlAgo(20 * day), lastSeen: sqlAgo(2 * day) },
    { id: 2, text: 'Turn the living room lights off at 11', count: 2, person: 'Maya', firstSeen: sqlAgo(9 * day), lastSeen: sqlAgo(1 * day) },
    { id: 3, text: 'اطلب لي بيتزا من المطعم المعتاد', count: 1, person: 'Maya', firstSeen: sqlAgo(3 * hour), lastSeen: sqlAgo(3 * hour) },
  ];
};
const wishData = () => ({ list: wishes, wishes: wishes.length, asks: wishes.reduce((n, w) => n + w.count, 0) });
const systemScreen = () => ({
  health: { status: 'warn', summary: 'Working, with things to look at', checkedAt: ago(min), checks: [
    { id: 'db', label: 'Database', status: 'ok', detail: 'Healthy · 51 migrations · 38 MB' },
    { id: 'balance', label: 'OpenRouter balance', status: 'warn', detail: 'Balance $4.62 ≈ 5 days', fix: 'Top up on openrouter.ai before it runs out.' },
    { id: 'backup', label: 'Backups', status: 'ok', detail: 'Last full backup 3 h ago', href: '#backups' }] },
  backups: [{ name: 'jessbot-2026-09-26.zip', full: true, at: ago(3 * hour), sizeLabel: '41 MB' }],
  about: { version: '0.25.0', commit: 'b2f6335', node: '24.4.0', host: '127.0.0.1', port: 3738, uptime: 5400, dataDir: '/srv/jessbot/data/dev' },
  log: { level: 'warn', lines: [{ seq: 1, at: ago(20 * min), level: 'warn', text: '[feed] a source took 9 s to answer' }], files: [] },
  wishes: wishData(),
});

// ---- Admin → Overview, security ---------------------------------------------------------------------------------------------
const overviewScreen = () => ({
  stats: { people: 3, active: 3, invites: 0, groups: 1 },
  llm: { model: 'openai/gpt-6-luna', hasKey: true, maskedKey: 'sk-or-…9f2c' },
  health: { status: 'warn', summary: 'Working, with things to look at', checks: [{ id: 'balance', label: 'OpenRouter balance', status: 'warn', detail: 'about 5 days left' }] },
  ops: { week: '$2.84', running: 1, waiting: 0 },
  audit: [
    { action: 'injection_suspected', actor_name: 'Maya', detail: { source: 'email_read', from: 'deals@shop-example.com' }, at: sqlAgo(2 * hour) },
    { action: 'admin.model', actor_name: 'Alex Rivera', detail: {}, at: sqlAgo(5 * hour) },
    { action: 'secret_blocked', actor_name: 'Alex Rivera', detail: { tool: 'email_send', secret: 'OpenAI API key' }, at: sqlAgo(26 * hour) },
  ],
  security: {
    checks: [
      { id: 'local-network', label: 'Local network', status: 'ok', detail: 'Blocked: nothing Jess opens can reach devices on this network', href: '/admin/browser' },
      { id: 'grants', label: 'Always-allowed actions', status: 'warn', detail: 'Maya: always allow “Send email”', fix: 'Revoke any you don’t need on the person’s page in Admin → People.', href: '/admin/people/2' },
      { id: 'secret-key', label: 'Password key', status: 'ok', detail: 'Saved passwords are sealed with this install’s key' },
      { id: 'skill-lint', label: 'Skill warnings', status: 'ok', detail: 'No active skill has a serious warning', href: '/admin/skills' },
      { id: 'injection', label: 'Hidden instructions', status: 'warn', detail: '5 suspected in the last 7 days (email_read 4, web_read 1); latest from deals@shop-example.com' },
      { id: 'spend', label: 'Spending', status: 'ok', detail: 'No unusual spending this week' },
    ],
    events: { days: 30, total: 7,
      injections: { total: 6, more: 0, groups: [
        { tool: 'email_read', toolLabel: 'Read email', from: 'deals@shop-example.com', count: 4, lastAt: ago(2 * hour), people: ['Maya'], hidden: 3 },
        { tool: 'web_read', toolLabel: 'Read a page', from: 'recipes-example.net', count: 2, lastAt: ago(4 * day), people: ['Alex Rivera', 'Maya'], hidden: 0 }] },
      secrets: { total: 1, more: 0, groups: [{ tool: 'email_send', toolLabel: 'Send email', kinds: 'OpenAI API key', count: 1, lastAt: ago(26 * hour), people: ['Alex Rivera'] }] } },
  },
});

// ---- Admin → Groups (the per-task budget field) --------------------------------------------------------------------------
const TOOLSET_ROWS = [['web', 'Web', 'Search and read the web.'], ['email', 'Email', 'Read and send email.'], ['images', 'Pictures', 'Make pictures with the image model (invitations, colouring pages, story art); each costs a little.']];
const groupsScreen = () => ({ groups: [{ id: 1, name: 'Family', description: 'Everyone at home', members: 3, instructions: null,
  policy: { action: '/admin/policy/group/1', showInherit: true,
    rows: TOOLSET_ROWS.map(([key, label, description]) => ({ key, label, description, available: true, value: key === 'images' ? 'ask' : '', inherited: 'Off' })),
    approver: '', inheritedApprover: 'the person', budget: '', inheritedBudget: '$2.00', taskBudget: '0.25', inheritedTaskBudget: '$0.50', defaultTaskBudget: '$0.50',
    quietStart: '22:00', quietEnd: '07:30' } }], instructionsMax: 4000, values: {} });

// ---- Admin → Personality → Lessons ---------------------------------------------------------------------------------------
const PROMOTE_NEEDS = '3 times in 2 different tasks within 30 days';
const lessonOf = (l) => ({ scope: 'household', why: null, domain: null, uses: 0, lastUsedAt: null, retireSuggested: false, retireDays: 90, promotable: false,
  recent: { hits: 1, tasks: 1 }, promoteNeeds: PROMOTE_NEEDS, run: null, fromName: null, sourceLabel: 'From a task that needed pushing', source: 'pushed', createdAt: sqlAgo(3 * day), ...l,
  open: ['proposed', 'active'].includes(l.status) });
let lessons = [];
const resetLessons = () => {
  lessons = [
    lessonOf({ id: 11, status: 'proposed', rule: 'When a booking site shows prices without tax, add the tax before comparing.', why: 'Two hotels looked cheaper than they were.',
      domain: 'booking.com', fromName: 'Maya', run: { id: 90, at: sqlAgo(1 * day), label: null, href: null }, recent: { hits: 2, tasks: 2 } }),
    lessonOf({ id: 12, status: 'active', rule: 'Confirm the restaurant’s time zone, not ours, before booking a table.', uses: 6, lastUsedAt: sqlAgo(2 * day),
      recent: { hits: 4, tasks: 3 }, promotable: true, run: { id: 71, at: sqlAgo(12 * day), label: null, href: '#' } }),
    lessonOf({ id: 13, status: 'active', rule: 'For school forms, ask which child before filling anything in.', uses: 1, lastUsedAt: sqlAgo(120 * day), retireSuggested: true, source: 'owner', sourceLabel: 'Added by an admin' }),
    lessonOf({ id: 14, status: 'retired', rule: 'Always open the parcel site in English.', uses: 3 }),
  ];
};
const lessonsPageData = () => {
  const S = ['proposed', 'active', 'retired', 'promoted', 'rejected'];
  return { lessons, filter: 'all', total: lessons.length, counts: Object.fromEntries(S.map(s => [s, lessons.filter(l => l.status === s).length])),
    retireSuggested: lessons.filter(l => l.retireSuggested).length, promotable: lessons.filter(l => l.promotable && l.open).length };
};
const lessonsScreen = () => ({ files: [{ key: 'soul', name: 'SOUL.md', label: 'Soul' }, { key: 'rules', name: 'AGENTS.md', label: 'Operating rules' }, { key: 'notes', name: 'MEMORY.md', label: 'Shared notes' }],
  lessonsActive: true, lessonsWaiting: lessons.filter(l => l.status === 'proposed').length, lessons: lessonsPageData() });

// ---- You → Memory: their lessons and the weekly tidy ---------------------------------------------------------------------
let myLessons = [], tidy = null;
const resetMe = () => {
  myLessons = [
    { id: 21, status: 'proposed', rule: 'Give temperatures in Celsius.', why: 'You corrected a forecast in Fahrenheit.', sourceLabel: 'From a thumbs-down', uses: 0, lastUsedAt: null, retireSuggested: false, domain: null },
    { id: 22, status: 'active', rule: 'Keep weekday answers to a few lines; go into detail on weekends.', why: null, sourceLabel: 'You told me', uses: 31, lastUsedAt: ago(2 * hour), retireSuggested: false, domain: null },
    { id: 23, status: 'active', rule: 'On sncf-connect.com, pick the seat by the window.', why: null, sourceLabel: 'You told me', uses: 2, lastUsedAt: ago(100 * day), retireSuggested: true, domain: 'sncf-connect.com' },
    { id: 24, status: 'retired', rule: 'Sign emails to the school with both our names.', why: null, sourceLabel: 'You told me', uses: 4, lastUsedAt: ago(200 * day), retireSuggested: false, domain: null },
  ];
  tidy = { id: 5, at: sqlAgo(2 * day), status: 'done', merged: 1, archived: 2, changes: [
    { id: 51, op: 'merge', why: 'Both say the same thing about the car.', undone: false,
      before: [{ id: 101, text: 'The car’s MOT is due in March.', dateLabel: null }, { id: 102, text: 'MOT for the Clio: March.', dateLabel: null }],
      after: { id: 103, text: 'The Clio’s MOT is due in March.' } },
    { id: 52, op: 'archive', why: 'The trip is over.', undone: false, before: [{ id: 104, text: 'Flight to Lisbon on 2 August.', dateLabel: '2 Aug 2026' }], after: null },
    { id: 53, op: 'archive', why: 'The appointment has passed.', undone: false, before: [{ id: 105, text: 'Keiko’s eye test at 4 pm.', dateLabel: '12 Sep 2026, 16:00' }], after: null },
  ] };
};
const ME_TABS = [['profile', 'Profile'], ['places', 'Places'], ['connections', 'Connections'], ['memory', 'Memory'], ['notifications', 'Notifications'], ['devices', 'Devices'], ['usage', 'Usage']];
const meLessonsScreen = () => ({ view: 'me', nav: 'me', tab: 'memory', tabs: ME_TABS.map(([key, label]) => ({ key, label })),
  me: { ...fx.me, lessons: clone(myLessons), tidy: { tidy: clone(tidy), open: true } } });

// ---- Feed: sources (OPML, mutes), the diet, a gone story ----------------------------------------------------------------
let mutes = null;
const resetMutes = () => { mutes = { topics: [{ value: 'Celebrity', at: ago(9 * day) }], sources: [{ value: 'tabloid-example.com', at: ago(20 * day) }], words: [{ value: 'spoiler', at: ago(3 * day) }], limits: { words: 100 } }; };
export const mutesData = () => clone(mutes);
const diet = () => ({ days: 30, month: new Date().toISOString().slice(0, 7), enough: true, stories: 46, minutes: 132, liked: 9, saved: 4,
  topics: [{ label: 'Markets', count: 19, share: 41 }, { label: 'AI releases', count: 14, share: 30 }, { label: 'Books', count: 8, share: 17 }, { label: 'Running', count: 5, share: 11 }],
  sources: [{ name: 'Reuters', count: 12, share: 26 }, { name: 'The Verge', count: 7, share: 15 }, { name: 'FT', count: 5, share: 11 }],
  variety: { topics: 4, sources: 11, score: 0.86, label: 'varied' },
  suggestion: { kind: 'one_topic', text: 'Most of what you read was Markets and AI. Want a new topic next to them?' } });

// ---- Chat: reminder cards --------------------------------------------------------------------------------------------------
const reminderAlarm = (over = {}) => ({ id: 301, kind: 'reminder', iconName: 'bell', noun: 'Reminder', label: 'Take your evening pills', status: 'scheduled', live: true,
  fireAt: new Date(Date.now() + 12 * min).toISOString(), whenLabel: 'today at ' + clock(12 * min), repeatLabel: null,
  followUp: { everyMin: 15, max: 3, sent: 1, awaiting: true, untilLabel: null, escalateTo: { id: 2, name: 'Maya', consent: 'granted' }, escalated: false, closedHow: null,
    line: `Nudge 1 of 3 · next at ${clock(12 * min)}`, closed: null, lastPostId: 902 }, ...over });
let alarm = null, consentStatus = 'pending';
const resetReminders = () => { alarm = reminderAlarm(); consentStatus = 'pending'; };
function reminderDays() {
  const note = (id, createdAt, html, reminder) => ({ id: `m${id}`, messageId: id, role: 'assistant', createdAt, html,
    run: { id: `r${id}`, status: 'done', origin: 'reminder', originLabel: 'Reminder', startedAt: createdAt, steps: [] }, reminder });
  const closedAlarm = { ...reminderAlarm({ id: 302, label: 'Put the bins out', status: 'done', live: false }),
    followUp: { ...reminderAlarm().followUp, awaiting: false, sent: 2, escalateTo: null, line: null, lastPostId: 905,
      closed: { how: 'card', label: 'Done', done: true, at: ago(50 * min), canMarkDone: false } } };
  return [{ label: 'Today', messages: [
    note(901, ago(20 * min), '<p><strong>Reminder:</strong> Take your evening pills</p><p>Tell me when it’s done and I’ll stop. Until then I’ll check back every 15 minutes.</p>',
      { kind: 'reminder', alarm: clone(alarm), level: 0, messageId: 901, latest: false }),
    note(902, ago(4 * min), '<p><strong>Still on your list:</strong> Take your evening pills</p>', { kind: 'reminder', alarm: clone(alarm), level: 1, messageId: 902, latest: true }),
    note(905, ago(55 * min), '<p><strong>Just checking:</strong> Put the bins out. Done yet?</p>', { kind: 'reminder', alarm: closedAlarm, level: 2, messageId: 905, latest: true }),
    note(910, ago(2 * min), '<p><strong>Maya asked me something:</strong> when Maya doesn’t confirm a reminder after I’ve followed up (medicine, the bins…), may I tell you here? Just say yes or no. You can change your mind any time.</p>',
      { kind: 'consent', consent: { id: 41, status: consentStatus, fromName: 'Maya', answeredAt: null } }),
  ] }];
}

// ---- Screens ---------------------------------------------------------------------------------------------------------------
export function resetScreensC() { balanceReads = 0; resetWishes(); resetLessons(); resetMe(); resetMutes(); resetReminders(); }
resetScreensC();
const fresh = make => () => { resetScreensC(); return make(); };
export const SCREENS = {
  'admin-models': fresh(() => ({ view: 'admin/model', nav: 'admin', ...modelScreen() })),
  'admin-usage': fresh(() => ({ view: 'admin/usage', nav: 'admin', ...usageScreen() })),
  'admin-system': fresh(() => ({ view: 'admin/system', nav: 'admin', ...systemScreen() })),
  'admin-overview': fresh(() => ({ view: 'admin/overview', nav: 'admin', ...overviewScreen() })),
  'admin-groups': fresh(() => ({ view: 'admin/groups', nav: 'admin', ...groupsScreen() })),
  'admin-lessons': fresh(() => ({ view: 'admin/lessons', nav: 'admin', ...lessonsScreen() })),
  'me-lessons': fresh(() => meLessonsScreen()),
  'feed-diet': fresh(() => ({ view: 'feed', nav: 'feed', feed: { ...fx.feed, home: true, mode: 'ranked', diet: diet() } })),
  'feed-story-gone': fresh(() => ({ view: 'feed', nav: 'feed', feed: { ...fx.feed, home: false, brief: null, mode: 'story', sections: [], next: null, count: 0,
    filters: { story: 'i999999', saved: false, history: false, q: '' } } })),
  'chat-reminders': fresh(() => ({ view: 'chat', nav: 'chat', mainClass: 'min-h-0 flex-1 overflow-hidden', thread: { id: 'main', title: 'Main', isMain: true },
    days: reminderDays(), agent: { activity: 'resting' }, sendUrl: '/api/v1/threads/main/messages', now: fx.now })),
};

// ---- Simulated API ---------------------------------------------------------------------------------------------------------
const invalid = errors => ({ status: 422, body: { error: 'Validation failed', errors } });
const OPML_REASON = { already: 'You already follow these there', duplicate: 'Listed twice in the file', invalid: 'Not a web address' };

/** /api/v1/… calls of these screens → { status?, body } or null. render(partial, data) → html. */
export async function screensCApi(method, path, query, body, render) {
  // Admin → System: the wish log
  const wish = /^\/admin\/wishes\/(\d+)$/.exec(path);
  if (wish && method === 'DELETE') {
    const i = wishes.findIndex(w => w.id === Number(wish[1]));
    if (i < 0) return { status: 404, body: { error: 'That wish is already gone.' } };
    wishes.splice(i, 1);
    return { body: { ok: true } };
  }
  // Admin → Models: Pictures
  if (path === '/admin/images' && method === 'POST') {
    const model = String(body.model || '').trim();
    if (model && !/^[\w.-]+\/[\w.:-]+$/.test(model)) return invalid({ model: 'Use an image model id like black-forest-labs/flux.2-klein-4b, or leave it empty for off.' });
    if (/unknown/.test(model)) return invalid({ model: `“${model}” isn’t an image model on this endpoint. OpenRouter lists them at openrouter.ai/models?output_modalities=image.` });
    return { body: { ok: true, settings: { model }, price: model && !/offline/.test(model) ? { label: 'about $0.039 a picture', source: 'history' } : null,
      warning: /offline/.test(model) ? 'Saved, but the image model list couldn’t be reached to check this id; the first picture will tell.' : null } };
  }
  // You → Memory: lessons
  if (path === '/me/lessons' && method === 'GET') {
    return { body: { lessons: myLessons, ...(query.fragment === '1' ? { html: await render('me/lessons', { lessons: myLessons }) } : {}) } };
  }
  const ml = /^\/me\/lessons\/(\d+)(\/keep)?$/.exec(path);
  if (ml) {
    const l = myLessons.find(x => x.id === Number(ml[1]));
    if (!l) return { status: 404, body: { error: 'That lesson no longer exists.' } };
    if (ml[2] && method === 'POST') { l.status = 'active'; return { body: { ok: true, lesson: l } }; }
    if (method === 'DELETE') { myLessons = myLessons.filter(x => x !== l); return { body: { ok: true } }; }
    if (method === 'PATCH') {
      if (body.rule !== undefined && !String(body.rule).trim()) return invalid({ rule: 'Write the rule.' });
      if (body.rule !== undefined) l.rule = String(body.rule).trim();
      if (body.why !== undefined) l.why = String(body.why).trim() || null;
      if (body.status) { l.status = body.status; l.retireSuggested = false; }
      return { body: { ok: true, lesson: l } };
    }
  }
  // You → Memory: the tidy
  const undo = /^\/me\/memory-tidies\/changes\/(\d+)\/undo$/.exec(path);
  if (undo && method === 'POST') {
    const c = tidy.changes.find(x => x.id === Number(undo[1]));
    if (!c) return { status: 404, body: { error: 'That change no longer exists.' } };
    if (c.id === 53) return invalid({ change: 'The merged memory was changed since, so this can’t be undone. Edit it on the Memory page instead.' });
    c.undone = true;
    return { body: { ok: true } };
  }
  const td = /^\/me\/memory-tidies\/(\d+)$/.exec(path);
  if (td && method === 'GET') return { body: { tidy, ...(query.fragment === '1' ? { html: await render('me/tidy', { tidy, open: true }) } : {}) } };
  // Feed: OPML, sources, mutes
  if (path === '/feed/opml' && method === 'POST') {
    const text = String(body.opml || '');
    if (!text.trim()) return invalid({ opml: 'Choose the .opml file your feed reader exported.' });
    if (!/<opml/i.test(text)) return invalid({ opml: 'That isn’t an OPML feed list (the .opml file a feed reader exports).' });
    const urls = [...text.matchAll(/xmlUrl="([^"]+)"/g)].map(m => m[1]);
    const titles = [...text.matchAll(/text="([^"]+)"[^>]*xmlUrl/g)].map(m => m[1]);
    const added = [], skipped = [];
    const seen = new Set();
    urls.forEach((u, i) => {
      const title = titles[i] || null;
      if (!/^https?:\/\/[\w.-]+\.[a-z]{2,}/i.test(u)) skipped.push({ title, url: u, reason: 'invalid' });
      else if (seen.has(u)) skipped.push({ title, url: u, reason: 'duplicate' });
      else if (/reuters/.test(u)) skipped.push({ title, url: u, reason: 'already' });
      else { seen.add(u); added.push({ title: title || u, url: u, topic: body.topic || 'Tech' }); }
    });
    const message = added.length ? `Added ${added.length} ${added.length === 1 ? 'feed' : 'feeds'}${skipped.length ? `, skipped ${skipped.length}` : ''}. New stories arrive with the next check.`
      : `Nothing new to add: ${skipped.length} ${skipped.length === 1 ? 'feed was' : 'feeds were'} skipped.`;
    const topics = added.length ? [{ key: 'tech', label: body.topic || 'Tech', created: true, added: added.length }] : [];
    const groups = Object.keys(OPML_REASON).map(reason => ({ reason, label: OPML_REASON[reason], items: skipped.filter(s => s.reason === reason) })).filter(g => g.items.length);
    return { status: added.length ? 201 : 200, body: { added, skipped, topics, message, html: await render('feed/opml-result', { result: { added, skipped, topics, message, groups } }) } };
  }
  if (path === '/feed/sources' && method === 'GET' && query.fragment === '1') {
    const topics = fx.feedSources.topics;
    return { body: { topics, counts: fx.feedSources.counts, html: await render('feed/topic-list', { topics }) } };
  }
  if (path === '/feed/mutes' && (method === 'POST' || method === 'DELETE')) {
    const kind = String(body.kind || ''), value = String(body.value || '').replace(/\s+/g, ' ').trim();
    const list = { word: mutes.words, topic: mutes.topics, source: mutes.sources }[kind];
    if (!list) return invalid({ kind: 'Mute a topic, a source or a word.' });
    if (!value || !/[\p{L}\p{N}]/u.test(value)) return invalid({ value: 'Which word should I hide stories about?' });
    if (value.split(' ').length > 5) return invalid({ value: 'Mute a word or a short phrase (up to 5 words).' });
    const i = list.findIndex(x => x.value.toLowerCase() === value.toLowerCase());
    if (method === 'POST' && i < 0) list.unshift({ value, at: new Date().toISOString() });
    if (method === 'DELETE' && i >= 0) list.splice(i, 1);
    return { status: method === 'POST' ? 201 : 200, body: { kind, value, muted: method === 'POST', hidden: 3, mutes, html: await render('feed/mutes', { mutes }) } };
  }
  // Chat: reminder Done, consent
  const done = /^\/alarms\/(\d+)\/done$/.exec(path);
  if (done && method === 'POST') {
    alarm = { ...alarm, status: 'done', live: false, followUp: { ...alarm.followUp, awaiting: false, line: null, closedHow: 'card',
      closed: { how: 'card', label: 'Done', done: true, at: new Date().toISOString(), canMarkDone: false } } };
    return { body: { alarm } };
  }
  const consent = /^\/alarms\/consents\/(\d+)$/.exec(path);
  if (consent && method === 'POST') {
    if (typeof body.allow !== 'boolean') return invalid({ allow: 'Say yes (true) or no (false).' });
    consentStatus = body.allow ? 'granted' : 'declined';
    return { body: { consent: { id: Number(consent[1]), status: consentStatus, answeredAt: new Date().toISOString(), person: { id: 2, name: 'Maya' } } } };
  }
  return null;
}

/** /admin/… calls of these screens (the web routes' JSON) → { status?, body } or null. */
export async function screensCAdmin(method, path, query, body, render) {
  if (path === '/admin/model/test' && method === 'POST') {
    const model = String(body.model || '').trim();
    if (/down/.test(model)) return { body: { ok: false, ms: 900, model, error: `The model "${model}" wasn't found on this endpoint.`, status: 404 } };
    return { body: { ok: true, ms: 800 + model.length * 20, model, answered: model, reply: 'Ready.', cost: 0.00002 } };
  }
  if (path === '/admin/model' && method === 'POST') {
    const list = String(body.fallbacks || '').split(/[\s,]+/).filter(Boolean);
    if (list.some(m => /down/.test(m))) return invalid({ fallbacks: `${list.find(m => /down/.test(m))} didn’t answer: it wasn't found on this endpoint.` });
    return { body: { ok: true, ms: 1100, model: body.model, reply: 'Ready.', cost: 0.00002,
      llm: { ...modelScreen().llm, model: body.model, fallbacks: list.join(', '), fallbackList: list, background: String(body.background || '').trim() } } };
  }
  if (path === '/admin/usage/balance' && method === 'GET') {
    if (query.refresh === '1') balanceReads++;
    const b = balance();
    return { body: { balance: b, html: await render('admin/balance-card', { balance: b }), gapHtml: await render('admin/balance-gap', { balance: b }) } };
  }
  const la = /^\/admin\/lessons(?:\/(\d+))?(?:\/(approve|reject|retire|promote))?$/.exec(path);
  if (la) {
    const [, id, action] = la;
    const reply = async (l, status = 200) => ({ status, body: { ok: true, lesson: l, waiting: lessons.filter(x => x.status === 'proposed').length,
      ...(query.fragment === '1' ? { html: await render('admin/lesson-card', { lesson: l }) } : {}) } });
    if (!id && method === 'POST') {
      const rule = String(body.rule || '').trim();
      if (!rule) return invalid({ rule: 'Write the rule: when this happens, do that.' });
      if (/@/.test(rule)) return invalid({ rule: 'A household lesson goes to everyone, so it can’t contain an email address.' });
      const l = lessonOf({ id: Date.now() % 100000, status: 'active', rule, why: String(body.why || '').trim() || null, domain: String(body.domain || '').trim() || null,
        source: 'owner', sourceLabel: 'Added by an admin' });
      lessons.unshift(l);
      return reply(l);
    }
    const l = lessons.find(x => x.id === Number(id));
    if (!l) return { status: 404, body: { error: 'That lesson no longer exists.' } };
    if (body.rule !== undefined) {
      if (!String(body.rule).trim()) return invalid({ rule: 'Write the rule: when this happens, do that.' });
      l.rule = String(body.rule).trim();
    }
    if (body.why !== undefined) l.why = String(body.why).trim() || null;
    if (body.domain !== undefined) l.domain = String(body.domain).trim() || null;
    if (action) {
      if (action === 'promote' && !l.promotable) return invalid({ status: 'It has come up 1 time in 1 task in the last 30 days; promote it once it has come up 3 times in 2 different tasks.' });
      l.status = { approve: 'active', reject: 'rejected', retire: 'retired', promote: 'promoted' }[action];
      l.retireSuggested = false;
    }
    l.open = ['proposed', 'active'].includes(l.status);
    return reply(l);
  }
  return null;
}
