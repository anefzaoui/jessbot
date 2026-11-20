// DEV ONLY — demo data for /styleguide. Scenarios come from the Muse transcripts (docs/FEATURES.md).
// Every object follows the contract documented at the top of its template, so the styleguide doubles
// as a contract check: if a template changes shape, these screens break visibly.
import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdown as md } from '../lib/markdown.js';
import { paths } from '../config/index.js';
import { NAV_ITEMS } from '../middleware/locals.js';
import { STARTER_IDEAS, GOAL_CATEGORIES, GOAL_EXAMPLES, CHAT_SUGGESTIONS } from '../content/starters.js';
import { slidesPreviewHtml } from '../services/office.js';

const min = 6e4, hour = 36e5, day = 864e5;
const ago = ms => new Date(Date.now() - ms).toISOString();
const inFuture = ms => new Date(Date.now() + ms).toISOString();

export const user = { id: 'u1', name: 'Alex Rivera', firstName: 'Alex', role: 'admin', hue: 250 };

// ---- Panel pieces -----------------------------------------------------------
const approvals = [
  {
    id: 'ap1', title: 'Buy 2 tickets — Resident Evil, Fri 9:40 PM, AMC Palo Alto', tool: 'browser.checkout', risk: 'spend',
    preview: 'AMC Palo Alto 20 · Screen 7\nSeats F7, F8 (center)\n2 × $18.49 + $3.00 fee = $39.98\nCard ending 4242',
    requestedAt: ago(3 * min), status: 'pending', threadHref: '/styleguide/screens/chat',
    previewChars: 96, undo: { possible: false, note: 'a payment can’t be taken back from here' }, reach: 'the website amctheatres.com', reachShown: true, taskScope: true,
  },
  {
    id: 'ap2', title: 'Email Maya the weekend itinerary', tool: 'email.send', risk: 'external',
    preview: 'To: maya@example.com\nSubject: Our weekend in Big Sur 🌊\n\nHi love — here is the plan for Sat/Sun…',
    requestedAt: ago(25 * min), status: 'pending', previewChars: 92, taskScope: false,
    askReason: 'You allowed this with “Always allow”, but this task read outside content first, so it asks again.',
    provenance: 'Suggested after reading: email from Maya <maya@example.com> · “Weekend?” · page on bigsur.example',
    flags: [{ kind: 'card', label: 'a card number', masked: '••••4242' }],
    undo: { possible: false, note: 'an email can’t be recalled once it’s sent' }, reach: 'maya@example.com', provenanceLevel: 'low',
    facts: [{ key: 'to', label: 'To', value: 'maya@example.com' }, { key: 'subject', label: 'Subject', value: 'Our weekend in Big Sur 🌊' },
      { key: 'files', label: 'Attached', items: [{ title: 'Big Sur itinerary', meta: 'PDF · 212 KB', href: '/library/lib1' }, { title: 'Cabin booking', meta: 'PDF · 88 KB', href: '/library/lib2' }] }],
  },
];
// Phase 25 part B (#194): a long letter (folded preview), a suspected injection, a picture, and every closed state.
const LONG_LETTER = ['To: landlord@example.com', 'Subject: Notice about the boiler repair', '',
  'Dear Mr Harris,', '',
  'I’m writing about the boiler in flat 3. It stopped heating water on Monday morning and the engineer you sent on Tuesday said the pump has failed and needs a part that takes about a week to arrive.',
  '', 'In the meantime we have no hot water. Under the tenancy agreement (clause 7.2) repairs to heating and hot water should be done within a reasonable time, and I’d like to agree a small rent reduction for the days without it, or a portable water heater until the part arrives.',
  '', 'Could you let me know by Friday which you prefer? I’m happy to be flexible about access for the engineer: weekday mornings suit us best.',
  '', 'Thank you for sorting the first visit so quickly.', '', 'Kind regards,', 'Alex Rivera', 'Flat 3, 14 Rue Victor Hugo'].join('\n');
export const approvalStates = [
  { id: 'ap5', title: 'Email the landlord about the boiler', tool: 'email_send', toolLabel: 'Sends an email', risk: 'external', preview: LONG_LETTER,
    previewChars: LONG_LETTER.length, previewLong: true, previewFoldsCompact: true, requestedAt: ago(4 * min), status: 'pending', taskScope: true, threadHref: '/styleguide/screens/chat',
    undo: { possible: false, note: 'an email can’t be recalled once it’s sent' }, reach: 'landlord@example.com',
    facts: [{ key: 'to', label: 'To', value: 'landlord@example.com' }, { key: 'subject', label: 'Subject', value: 'Notice about the boiler repair' }] },
  { id: 'ap6', title: 'Transfer $240 to “Account verification”', tool: 'browser_click', toolLabel: 'Clicks on a website', risk: 'spend',
    preview: 'Page: secure-verify.example/pay\nButton: “Confirm transfer”\nAmount: $240.00', previewChars: 70, requestedAt: ago(9 * min), status: 'pending',
    taskScope: false, provenance: 'Suggested after reading: email from “Bank Security” <alerts@secure-verify.example> · page on secure-verify.example',
    provenanceLevel: 'high', askReason: 'This task read a page that was written to steer AI assistants, so everything it does waits for you.',
    undo: { possible: false, note: 'a payment can’t be taken back from here' }, reach: 'the website secure-verify.example', reachShown: true },
  { id: 'ap7', title: 'Make a picture: “A fox reading under a lamp, storybook style”', tool: 'make_image', toolLabel: 'Pictures', risk: 'write',
    preview: 'Prompt: A small red fox curled in an armchair reading a book under a warm lamp, rain on the window, cosy storybook illustration, soft colours.',
    previewChars: 140, requestedAt: ago(12 * min), status: 'pending', taskScope: true,
    undo: { possible: false, note: 'the picture’s cost can’t be taken back; you can delete the picture from the Library' }, reachShown: true, reach: 'only you',
    facts: [{ key: 'shape', label: 'Shape', value: 'Portrait (2:3) · storybook' }, { key: 'model', label: 'Model', value: 'google/gemini-2.5-flash-image, from the weekly budget' }] },
];
export const approvalHistory = [
  { id: 'ap0', title: 'Cancel “StreamPlus” subscription ($15.99/mo)', tool: 'browser.checkout', toolLabel: 'Checks out on a website', risk: 'write', requestedAt: ago(2 * day), status: 'approved', scope: 'once',
    resultLabel: 'Approved', preview: 'streamplus.example/account\nCancel plan: Premium ($15.99/mo)', previewChars: 58, undo: { possible: true, note: 'you can change or delete it later' } },
  { id: 'ap-1', title: 'Post carousel to LinkedIn', tool: 'social.post', toolLabel: 'Posts online', risk: 'external', requestedAt: ago(3 * day), status: 'denied', resultLabel: 'Denied',
    preview: '8 slides: “How we cut our grocery bill by a third”', previewChars: 50, reachShown: true, reach: 'your LinkedIn followers' },
  { id: 'ap-2', title: 'Book a table at Taverna Mykonos, Fri 8 PM', tool: 'browser_click', toolLabel: 'Clicks on a website', risk: 'external', requestedAt: ago(4 * day), status: 'expired',
    closedReason: 'moved_on', resultLabel: 'Expired: you moved on, so it was not done', preview: 'tavernamykonos.example/book\nParty of 2 · Fri 20:00', previewChars: 48 },
];

// Scheduled tasks in every state the card shows (Phase 25 part B, #196): fine, failed, retrying, running, skipped, a watch.
const upcoming = [
  { id: 'j1', title: 'Morning brief: markets and AI releases', iconName: 'sunrise', kind: 'task', scheduleLabel: 'Weekdays · 7:00 AM', nextRunAt: inFuture(14 * hour), paused: false,
    lastStatus: 'ok', lastRunAt: ago(10 * hour), threadHref: '/styleguide/screens/chat' },
  { id: 'j2', title: 'Chess losses analysis', iconName: 'crown', kind: 'task', scheduleLabel: 'Daily · 6:30 AM', nextRunAt: inFuture(13 * hour + 30 * min), paused: false,
    lastStatus: 'bad', lastRunAt: ago(11 * hour), threadHref: '/styleguide/screens/chat' },
  { id: 'j3', title: 'Mac mini deals on Marketplace', iconName: 'tag', kind: 'task', scheduleLabel: 'Every 3 hours', nextRunAt: inFuture(47 * min), paused: false,
    lastStatus: 'silent', lastRunAt: ago(2 * hour), endsLabel: 'Fri 3 Oct', threadHref: '/styleguide/screens/chat',
    watch: { condition: 'a Mac mini M4 under $450 within 30 km', lastNote: 'cheapest $520 (M4, 16 GB), nothing under $450', checkedLabel: '14:00', lastCheck: 'noted', failStreak: 0 } },
  { id: 'j5', title: 'Permit office appointment slots', iconName: 'calendar-clock', kind: 'task', scheduleLabel: 'Every hour, 8:00 to 18:00', nextRunAt: inFuture(22 * min), paused: false,
    lastStatus: 'retrying', retryLabel: '14:05', threadHref: '/styleguide/screens/chat',
    watch: { condition: 'a slot before 20 October', lastNote: null, checkedLabel: '13:00', lastCheck: 'failed', failStreak: 3 } },
  { id: 'j6', title: 'Grocery price check', iconName: 'shopping-cart', kind: 'task', scheduleLabel: 'Saturdays · 9:00 AM', nextRunAt: inFuture(3 * day), paused: false,
    lastStatus: 'running', lastRunAt: ago(1 * min), threadHref: '/styleguide/screens/chat' },
  { id: 'j7', title: 'Plant watering reminder check', iconName: 'sprout', kind: 'task', scheduleLabel: 'Daily · 8:00 PM', nextRunAt: inFuture(6 * hour), paused: false,
    lastStatus: 'skipped', lastRunAt: ago(18 * hour), threadHref: '/styleguide/screens/chat' },
  { id: 'j4', title: 'Weekly spending check', iconName: 'wallet', kind: 'task', scheduleLabel: 'Sundays · 6:00 PM', nextRunAt: null, paused: true, threadHref: '/styleguide/screens/chat' },
  // Paused by three failures in a row (#178; the screen is Phase 25 #212).
  { id: 'j8', title: 'Pharmacy stock check', iconName: 'calendar-clock', kind: 'task', scheduleLabel: 'Daily · 9:00 AM', nextRunAt: null, paused: true,
    failStreak: 3, pausedByFailures: true, lastStatus: 'bad', lastRunAt: ago(20 * hour), threadHref: '/styleguide/screens/chat' },
];

const alarms = [
  { id: 101, kind: 'timer', iconName: 'timer', noun: 'Timer', label: 'Pasta', status: 'scheduled', whenLabel: 'Today, 19:42', fireAt: inFuture(7 * min + 20e3), snoozeCount: 0 },
  { id: 102, kind: 'alarm', iconName: 'alarm-clock', noun: 'Alarm', label: 'Wake up', status: 'scheduled', whenLabel: 'Tomorrow, 06:45', repeatLabel: 'At 06:45, Monday through Friday', fireAt: inFuture(11 * hour), snoozeCount: 0 },
  { id: 103, kind: 'reminder', iconName: 'bell', noun: 'Reminder', label: 'Call the dentist to confirm Friday', status: 'scheduled', whenLabel: 'Tomorrow, 10:00', fireAt: inFuture(14 * hour), snoozeCount: 0 },
];

const activityToday = [
  { id: 'a1', at: ago(2 * min), iconName: 'ticket', title: 'Found seats for Resident Evil', detail: 'Compared 3 cinemas · best seats at AMC Palo Alto', status: 'warn', kind: 'task', href: '/styleguide/screens/chat' },
  { id: 'a2', at: ago(38 * min), iconName: 'utensils', title: 'Booked Taverna Mykonos for Friday 8 PM', detail: 'Table for 2 · confirmation #TM-2291', status: 'ok', kind: 'task' },
  { id: 'a3', at: ago(2 * hour), iconName: 'file-text', title: 'Made “Top Muse-style use cases” site', detail: 'Saved to Library — made without being asked', status: 'ok', kind: 'file', href: '/styleguide/screens/library' },
  { id: 'a4', at: ago(4 * hour), iconName: 'search', title: 'Researched lower-back recovery routines', detail: 'Read 6 sources · 2 physio guides', status: 'ok', kind: 'search' },
  { id: 'a5', at: ago(7 * hour), iconName: 'sunrise', title: 'Posted your morning brief to Feed', detail: '5 stories · markets, AI releases', status: 'ok', kind: 'schedule', href: '/styleguide/screens/feed' },
];
const activityYesterday = [
  { id: 'a6', at: ago(day + 3 * hour), iconName: 'crown', title: 'Analysed 4 chess losses', detail: 'Pattern: you drop pieces after move 25', status: 'ok', kind: 'schedule' },
  { id: 'a7', at: ago(day + 6 * hour), iconName: 'presentation', title: 'Drafted a LinkedIn carousel (8 slides)', detail: 'For your goal “Grow on LinkedIn”', status: 'ok', kind: 'file' },
  { id: 'a8', at: ago(day + 9 * hour), iconName: 'triangle-alert', title: 'Couldn’t reach the permit office site', detail: 'Retried 3× — will try again tonight', status: 'bad', kind: 'task' },
];

// ---- Projects (docs/PROJECTS.md) ----------------------------------------------
const demoProjects = [
  { id: 'pw1', name: 'Home woodwork', icon: 'hammer', hue: 30, field: 'workshop', fieldLabel: 'Workshop & DIY', status: 'active', href: '/styleguide/screens/project',
    about: 'Build a solid oak bookshelf, then a small side table — bookshelf done by spring.', running: true, waiting: false, fileCount: 4,
    lastActivityAt: ago(2 * hour), next: 'Buy three 30 mm oak boards (S4S)', threadId: 't9' },
  { id: 'pg2', name: 'Glucose training data', icon: 'heart-pulse', hue: 350, field: 'health', fieldLabel: 'Health & fitness', status: 'active', href: '/styleguide/screens/project',
    about: 'Understand how fuelling changes my glucose on long rides (Libre 3).', running: false, waiting: true, fileCount: 7,
    lastActivityAt: ago(day), next: 'Tag last week’s rides with carbs per hour', threadId: 't10' },
  { id: 'pc3', name: 'Jessbot Android app', icon: 'code', hue: 220, field: 'code', fieldLabel: 'Code & software', status: 'paused', href: '/styleguide/screens/project',
    about: 'A native client over the JSON API and WebSocket.', running: false, waiting: false, fileCount: 12, lastActivityAt: ago(6 * day), next: null, threadId: 't11' },
];
export const projects = { projects: demoProjects, archived: [{ ...demoProjects[2], id: 'pa4', name: 'Kitchen tiles', icon: 'house', hue: 45, status: 'archived' }] };
const briefRow = (id, kind, text, mine = false) => ({ id, kind, text, mine, state: 'open' });
export const projectSoul = {
  has: true, version: 4, by: 'Jess', note: 'Noted: prefers mm first, inches in brackets', updatedAt: ago(3 * hour),
  stance: 'a master furniture-maker’s eye. Patient, practical, precise about technique.', tokens: 410, drift: 5,
  safety: 'Build safety into the steps, not as a lecture: riving knife and guard on, push stick for narrow rips, never freehand on the table saw, clamp the work for routing, eye, ear and dust protection. For electrical wiring, gas, or structural / load-bearing work, stop and recommend a licensed professional.',
  sections: [
    { key: 'person', label: 'The person', text: 'Beginner–intermediate; built a workbench last year. Garage shop: jobsite table saw, plunge router, drill, two hand planes, no jointer.' },
    { key: 'anchors', label: 'Relies on', list: true, items: ['Wood moves across the grain — allow for it in every joint', 'Mortise & tenon > dowel > pocket screw for furniture', 'Glue open times and clamp pressure'] },
    { key: 'askFirst', label: 'Asks first', list: true, items: ['Species and moisture of the wood', 'Dimensions and what it will hold'] },
    { key: 'checkWork', label: 'Checks its work', list: true, items: ['Give a cut list with totals and confirm the math', 'Sequence the steps; flag tearout and snipe'] },
    { key: 'format', label: 'Units & format', text: 'mm first, inches in brackets; numbered steps; cut lists as tables' },
    { key: 'learned', label: 'Learned together', list: true, items: ['Prefers mm first, inches in brackets', 'Has no dust extraction — suggest a shop vac hookup'] },
  ],
  versions: [
    { version: 4, by: 'Jess', note: 'Noted: prefers mm first, inches in brackets', at: ago(3 * hour), current: true },
    { version: 3, by: 'you', note: 'Edited by you', at: ago(day) },
    { version: 2, by: 'Improve with AI', note: 'Improved with AI: sharper anchors', at: ago(2 * day) },
    { version: 1, by: 'drafted with you', note: 'Assumed: no dust extraction', at: ago(3 * day) },
  ],
  proposal: { id: 7, projectId: 'pw1', status: 'pending', source: 'jess', reason: 'Always check wood movement before joinery, as you asked',
    quote: 'always remind me about wood movement before we pick a joint', first: false, createdAt: ago(20 * min),
    diff: [{ key: 'checkWork', label: 'Checks its work', list: true, added: ['Check seasonal wood movement before choosing a joint'], removed: [] },
      { key: 'format', label: 'Units & format', list: false, before: 'mm first; numbered steps', after: 'mm first, inches in brackets; numbered steps; cut lists as tables' }] },
};
export const projectPanel = {
  project: demoProjects[0],
  sections: [
    { kind: 'goal', title: 'Goal', items: [briefRow(1, 'goal', demoProjects[0].about)] },
    { kind: 'status', title: 'Where it stands', items: [briefRow(2, 'status', 'Design settled — buying wood this weekend')] },
    { kind: 'next', title: 'Next steps', items: [briefRow(3, 'next', 'Buy three 30 mm oak boards (S4S)'), briefRow(4, 'next', 'Cut the two sides to 1,800 mm', true)] },
    { kind: 'question', title: 'Open questions', items: [briefRow(5, 'question', 'Fixed or adjustable shelves?')] },
    { kind: 'decision', title: 'Decisions', items: [briefRow(6, 'decision', 'Oak, 30 mm shelves — stiff enough for books over 760 mm'), briefRow(7, 'decision', 'Dados for fixed shelves; no pocket screws')] },
    { kind: 'constraint', title: 'Constraints', items: [briefRow(8, 'constraint', 'No jointer — plane edges by hand', true)] },
    { kind: 'number', title: 'Key numbers', items: [briefRow(9, 'number', '1,800 × 800 × 280 mm overall'), briefRow(10, 'number', 'Budget €220')] },
    { kind: 'note', title: 'Notes', items: [] },
  ],
  done: [{ ...briefRow(11, 'next', 'Sketch the bookshelf'), state: 'done' }],
  intake: [{ question: 'Your tools?', answer: 'Jobsite table saw, plunge router, drill, two hand planes' }, { question: 'Experience?', answer: 'Built a workbench last year' }],
  empty: false, goals: [],
  files: [
    { id: 'f1', title: 'Cut list — bookshelf', type: 'md', kindLabel: 'Document', sizeLabel: '2 KB', updatedAt: ago(3 * hour), href: '#', uploaded: false, pasted: false, useCount: 6 },
    { id: 'f2', title: 'Oak supplier quote.pdf', type: 'pdf', kindLabel: 'PDF', sizeLabel: '184 KB', updatedAt: ago(day), href: '#', uploaded: true, pasted: false },
    { id: 'f3', title: 'Snippet — Shelf 1 oak 760 x 280', type: 'md', kindLabel: 'Document', sizeLabel: '3 KB', updatedAt: ago(day), href: '#', uploaded: false, pasted: true },
    { id: 'f4', title: 'Garage wall photo', type: 'image', kindLabel: 'Image', sizeLabel: '1.2 MB', updatedAt: ago(2 * day), href: '#', uploaded: true, pasted: false, useCount: 2,
      caption: 'A garage wall with a pegboard, a jobsite table saw on a stand, and a 1.8 m gap between two windows marked in pencil.' },
  ],
  soul: projectSoul,
  fileMode: { full: false, files: 4, tokens: 38200, tokensLabel: '38.2K', limitLabel: '25K' },
  kinds: [['goal', 'Goal'], ['status', 'Where it stands'], ['next', 'Next steps'], ['question', 'Open questions'], ['decision', 'Decisions'],
    ['constraint', 'Constraints'], ['number', 'Key numbers'], ['note', 'Notes']].map(([value, label]) => ({ value, label })),
};
export const projectOptionsDemo = {
  icons: ['folder', 'hammer', 'wrench', 'code', 'heart-pulse', 'dumbbell', 'chart-line', 'wallet', 'house', 'palette', 'camera', 'sprout', 'book-open', 'rocket', 'plane', 'music', 'car', 'dog', 'utensils', 'globe'],
  fields: [{ value: 'general', label: 'General' }, { value: 'workshop', label: 'Workshop & DIY' }, { value: 'health', label: 'Health & fitness' }, { value: 'code', label: 'Code & software' }],
  hues: [250, 220, 195, 170, 150, 120, 85, 55, 35, 15, 350, 320, 290],
  statuses: [{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }, { value: 'done', label: 'Done' }, { value: 'archived', label: 'Archived' }],
};
export const projectProposal = {
  id: 'pw1', name: 'Home woodwork', icon: 'hammer', hue: 30, field: 'workshop', fieldLabel: 'Workshop & DIY', state: 'draft', href: '#',
  about: 'Build a solid oak bookshelf, then a small side table — bookshelf done by spring.',
  intake: [{ question: 'Experience?', answer: 'Beginner — built a workbench last year' }, { question: 'Tools?', answer: 'Jobsite table saw, plunge router, two hand planes; no jointer' },
    { question: 'Units?', answer: 'Metric (mm)' }, { question: 'When?', answer: 'Weekends; bookshelf by spring' }],
  soul: { stance: 'a master furniture-maker’s eye. Patient, practical, precise about technique.', anchors: ['Wood moves across the grain — allow for it', 'Mortise & tenon > dowel > pocket screw for furniture'], assumptions: ['No dust extraction', 'Indoor furniture'] },
  rows: [{ kind: 'constraint', kindLabel: 'Constraint', text: 'No jointer or planer — edges by hand' }, { kind: 'next', kindLabel: 'Next', text: 'Settle the bookshelf’s size and design' }],
};

export function shell(overrides = {}) {
  return {
    navItems: NAV_ITEMS.map(n => ({ ...n, count: n.key === 'ideas' ? 3 : 0 })),
    agent: { activity: 'searching', target: 'showtimes near Palo Alto', since: ago(42e3), doneToday: 5, upcomingCount: 4,
      nextJob: { title: 'Morning brief', at: inFuture(14 * hour) } },
    counts: { approvals: approvals.length },
    projects: demoProjects,
    sideChats: [
      { id: 'sc1', title: 'Big Sur weekend plan', running: true },
      { id: 'sc2', title: 'Kindergarten carpool', running: false },
      { id: 'sc3', title: 'Permit application', running: false },
      // Background work (#197, #199; the rail's marks are Phase 25 #212).
      { id: 'sc4', title: 'Working on: Compare 3 standing desks', running: false, background: 'delegate' },
      { id: 'sc5', title: 'Prepared overnight: Fence permit checklist', running: false, background: 'prep' },
    ],
    panel: {
      activity: [{ label: 'Today', items: activityToday }, { label: 'Yesterday', items: activityYesterday }],
      approvals, upcoming: { alarms, jobs: upcoming.slice(0, 3) },
    },
    ringing: [],
    usage: { pct: 34, label: 'Resets Monday · plenty left' },
    ...overrides,
  };
}

// ---- Chat --------------------------------------------------------------------
const pendingQuestion = {
  id: 'q1', status: 'pending', askedAt: ago(1 * min), answerUrl: '/api/v1/questions/q1/answer',
  questions: [
    { id: 'seats', header: 'Seats', question: 'Where do you like to sit?', kind: 'single', allowOther: true, options: [
      { value: 'center', label: 'Middle, center', description: 'Best picture and sound — my pick for this screen.', recommended: true },
      { value: 'back', label: 'Back rows', description: 'Easy to slip out, a bit far from the screen.' },
      { value: 'aisle', label: 'Aisle seats', description: 'More legroom, slightly off-center.' },
    ] },
    { id: 'extras', header: 'Extras', question: 'Add anything to the order?', kind: 'multi', allowOther: false, options: [
      { value: 'popcorn', label: 'Large popcorn', description: '+$9.50' },
      { value: 'drinks', label: '2 drinks', description: '+$11.00' },
      { value: 'none', label: 'Nothing, thanks' },
    ] },
    { id: 'remind', header: 'Reminder', question: 'Want a reminder an hour before?', kind: 'yesno', options: [
      { value: 'yes', label: 'Yes, remind me' }, { value: 'no', label: 'No thanks' },
    ] },
  ],
};

const answeredQuestion = {
  id: 'q0', status: 'answered', askedAt: ago(40 * min),
  questions: [{ id: 'party', header: 'Party size' }, { id: 'time', header: 'Time' }],
  answers: [
    { header: 'Party size', question: 'How many people?', display: '2 people' },
    { header: 'Time', question: 'What time works?', display: '8:00 PM (flexible ±30 min)' },
  ],
};

export function chatDays() {
  return [
    { label: 'Today', messages: [
      { id: 'm1', role: 'user', text: 'Find me a table for two at a good Greek restaurant near me this Friday around 8pm.', createdAt: ago(42 * min) },
      { id: 'm2', role: 'assistant', createdAt: ago(41 * min), question: answeredQuestion,
        run: { id: 'r0', status: 'done', startedAt: ago(42 * min), elapsedLabel: '12s', steps: [
          { id: 's1', iconName: 'map-pin', label: 'Checked your saved location', status: 'ok', durationLabel: '1s' },
          { id: 's2', iconName: 'search', label: 'Searched “best Greek restaurants Palo Alto”', status: 'ok', durationLabel: '4s' },
        ] } },
      { id: 'm3', role: 'assistant', createdAt: ago(38 * min), messageId: 903, // Simpler + follow-up chips (Phase 25 part B, #196)
        simplerText: 'Explain that again more simply, with the bit of context I’m missing.',
        followUps: ['Do they take a deposit for Friday?', 'Is there parking near Taverna Mykonos?', 'What if we run late?'],
        html: md('Done — **Taverna Mykonos**, Friday at **8:00 PM**, table for 2. 🎉\n\nIt\'s 0.8 mi away, 4.7★, and they have the grilled octopus you liked last time. Confirmation **#TM-2291** is in your email.\n\nWant me to add it to your calendar?'),
        run: { id: 'r1', status: 'done', startedAt: ago(40 * min), elapsedLabel: '1m 48s', steps: [
          { id: 's3', iconName: 'globe', label: 'Opened OpenTable', detail: 'opentable.com', status: 'ok', durationLabel: '6s' },
          { id: 's4', iconName: 'list-filter', label: 'Compared 5 Greek restaurants', detail: 'Rating, distance, Friday availability', status: 'ok', durationLabel: '41s' },
          { id: 's5', iconName: 'calendar-check', label: 'Reserved Friday 8:00 PM', detail: 'Taverna Mykonos · party of 2', status: 'ok', durationLabel: '58s' },
          { id: 's6', iconName: 'bookmark-plus', label: 'Saved preference: likes grilled octopus', status: 'ok', durationLabel: '1s' },
        ] } },
      { id: 'm4', role: 'user', text: 'Yes please. Also get us two tickets to Resident Evil after dinner, somewhere close.', createdAt: ago(6 * min) },
      { id: 'm5', role: 'assistant', createdAt: ago(5 * min),
        html: md('Added to your calendar. For the movie, the closest late showing after dinner is **9:40 PM at AMC Palo Alto** — 6 minutes\' walk from the restaurant. I found two great seats and need your OK to buy them:'),
        approval: approvals[0],
        run: { id: 'r2', status: 'waiting', startedAt: ago(5 * min), lastSeq: 14, steps: [
          { id: 's7', iconName: 'calendar-plus', label: 'Added dinner to your calendar', status: 'ok', durationLabel: '2s' },
          { id: 's8', iconName: 'search', label: 'Searched showtimes near Palo Alto', status: 'ok', durationLabel: '9s' },
          { id: 's9', iconName: 'armchair', label: 'Picked seats F7–F8', status: 'ok', durationLabel: '14s' },
          { id: 's10', iconName: 'hand', label: 'Waiting for your approval to pay', status: 'wait' },
        ] } },
      { id: 'm6', role: 'assistant', createdAt: ago(1 * min),
        html: md('While you look at that — a couple of quick questions so I can finish the order:'),
        question: pendingQuestion },
    ] },
  ];
}

// Site icons for the styleguide (no sign-in there, so not /favicons/…): lettered tiles.
const favTile = (letter, hue) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="hsl(${hue} 70% 50%)"/><text x="16" y="22" font-family="Arial" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`)}`;
const favAirbnb = favTile('a', 355), favVrbo = favTile('V', 220);
const clicking = { id: 's14', iconName: 'mouse-pointer-click', activity: 'clicking', label: 'Clicking “Check availability”', detail: 'Cabin with a creek view · Big Sur', status: 'run', favicon: favAirbnb };
export const runningRun = { id: 'r3', status: 'running', startedAt: ago(42e3), lastSeq: 9, steps: [
  { id: 's11', iconName: 'search', activity: 'searching', label: 'Searched “Big Sur family cabins October”', detail: '8 results · DuckDuckGo', status: 'ok', durationLabel: '6s' },
  { id: 's12', iconName: 'book-open', activity: 'reading', label: 'Read vrbo.com', detail: 'Big Sur cabins for families', href: 'https://www.vrbo.com/', status: 'ok', durationLabel: '4s', favicon: favVrbo },
  { id: 's13', iconName: 'globe', activity: 'browsing', label: 'Opened airbnb.com', detail: 'Cabin with a creek view', href: 'https://www.airbnb.com/', status: 'ok', durationLabel: '3s', favicon: favAirbnb },
  clicking,
], current: clicking, sites: [{ favicon: favVrbo, host: 'vrbo.com' }, { favicon: favAirbnb, host: 'airbnb.com' }] };
export const doneRun = { id: 'r5', status: 'done', startedAt: ago(19e3), elapsedLabel: '19s', steps: runningRun.steps.slice(0, 3), sites: runningRun.sites };
export const waitingRun = { id: 'r6', status: 'waiting', startedAt: ago(75e3), steps: [runningRun.steps[2], { id: 's15', iconName: 'hand', activity: 'waiting', label: 'Waiting for you to sign in', status: 'wait', favicon: favAirbnb }],
  current: { id: 's15', label: 'Waiting for you to sign in' }, sites: [runningRun.sites[1]] };
export const erroredRun = { id: 'r4', status: 'error', startedAt: ago(day), elapsedLabel: '2m 10s',
  error: "The permit office site kept timing out, so I couldn't submit the form. I'll retry tonight — or you can retry now.",
  steps: [{ id: 's13', iconName: 'globe', label: 'Opened permits.cityofpaloalto.org', status: 'bad', durationLabel: '2m' }] };

// Finished replies in every state (styleguide "run-states"): done & expanded, stopped with an expired question, failed.
const expiredQuestion = { id: 'q9', status: 'expired', askedAt: ago(20 * min), questions: [{ id: 'kind', header: 'Project', question: 'What is the project about?' }, { id: 'name', header: 'Name', question: 'What should we call it?' }], answers: null };
export const runStates = [{ label: 'Today', messages: [
  { id: 'rs1', role: 'user', text: 'Find family cabins in Big Sur for October.', createdAt: ago(30 * min) },
  { id: 'rs2', role: 'assistant', runId: 'r5', createdAt: ago(29 * min), run: { ...doneRun, expanded: true },
    html: '<p>Two cabins fit: one on vrbo.com with a creek view, one on airbnb.com closer to the beach.</p>' },
  { id: 'rs3', role: 'user', text: 'I’d like to start a new project.', createdAt: ago(21 * min) },
  { id: 'rs4', role: 'assistant', runId: 'r7', createdAt: ago(20 * min), html: '',
    run: { id: 'r7', status: 'cancelled', startedAt: ago(20 * min), elapsedLabel: '15s', expanded: true,
      steps: [{ id: 's21', iconName: 'hand', activity: 'waiting', label: 'Asked 2 questions', status: 'wait', durationLabel: '0s' }] },
    question: expiredQuestion },
  { id: 'rs5', role: 'assistant', runId: 'r4', createdAt: ago(10 * min), run: erroredRun, html: '' },
  // A scheduled task's notes (Phase 25 part B, #196): one missed while the computer was off, one failed with its retry due.
  { id: 'rs6', role: 'assistant', runId: 'r8', createdAt: ago(8 * min), html: '<p><strong>Missed:</strong> your 7:00 morning brief didn’t run because the computer was off.</p>',
    run: { id: 'r8', status: 'done', startedAt: ago(8 * min), elapsedLabel: '0s', steps: [], origin: 'schedule', originLabel: 'Morning brief', scheduleId: 'j1', errorKind: 'missed' } },
  { id: 'rs7', role: 'assistant', runId: 'r9', createdAt: ago(5 * min), html: '',
    run: { id: 'r9', status: 'error', startedAt: ago(5 * min), elapsedLabel: '40s', origin: 'schedule', originLabel: 'Permit office slots', scheduleId: 'j5',
      errorKind: 'transient', retryAt: inFuture(25 * min), error: 'The permit office site didn’t answer.',
      steps: [{ id: 's31', iconName: 'globe', label: 'Opened permits.cityofpaloalto.org', status: 'bad', durationLabel: '30s' }] } },
] }];

// Voice notes (styleguide "voice"): a note from them, her spoken answer, one being recorded, a Listen-made clip (decision #99).
const wave = seed => Array.from({ length: 48 }, (_, i) => Math.max(8, Math.round(100 * Math.abs(Math.sin(i * 0.9 + seed) * Math.cos(i * 0.31 + seed * 2)) ** 0.7)));
const clip = (id, direction, secs, transcript, seed) => ({ id, src: `/styleguide/sim/voice/${id}.wav`, direction, durationMs: secs * 1000, rate: direction === 'out' ? 1.15 : 1,
  duration: `0:${String(secs).padStart(2, '0')}`, peaks: wave(seed), transcript, voice: direction === 'out' ? 'marin' : null });
export const voiceStates = [{ label: 'Today', messages: [
  { id: 'vs1', role: 'user', text: 'Can you remind me what we decided about the walnut table legs?', createdAt: ago(12 * min),
    voice: clip('vin1', 'in', 6, 'Can you remind me what we decided about the walnut table legs?', 1) },
  { id: 'vs2', role: 'assistant', runId: 'rv1', messageId: 901, createdAt: ago(12 * min),
    run: { id: 'rv1', status: 'done', startedAt: ago(12 * min), elapsedLabel: '3s', steps: [] },
    html: '<p>We went with tapered legs, 28 inches, cut from the thicker offcut so the grain matches the top. You wanted a quick test taper on scrap first.</p>',
    voice: clip('vout1', 'out', 9, 'We went with tapered legs, 28 inches, cut from the thicker offcut so the grain matches the top.', 2) },
  { id: 'vs3', role: 'user', text: 'Send me a voice note with tomorrow’s plan.', createdAt: ago(2 * min) },
  { id: 'vs4', role: 'assistant', runId: 'rv2', messageId: 902, createdAt: ago(2 * min),
    run: { id: 'rv2', status: 'done', startedAt: ago(2 * min), elapsedLabel: '2s', steps: [{ id: 'sv1', iconName: 'audio-lines', label: 'Answering with a voice note', detail: 'Your reply will be spoken', status: 'ok', durationLabel: '0s' }] },
    html: '<p>Tomorrow: glue-up at 9, then let it sit until lunch. Afternoon is sanding to 180 and the first coat of oil.</p>', voice: { pending: true } },
] }];

// Admin → Models (voice section).
export const adminModel = {
  llm: { model: 'openai/gpt-6-luna', baseUrl: 'https://openrouter.ai/api/v1', hasKey: true, maskedKey: 'sk-or-…9f2c', defaultBaseUrl: 'https://openrouter.ai/api/v1' },
  voice: { model: 'openai/gpt-audio-mini', fallbackModel: 'openai/gpt-audio', sttModel: 'google/gemini-2.5-flash-lite', voice: null, direction: null,
    speaking: 'marin', variantLabel: 'female', speed: 1.15,
    speeds: [1, 1.1, 1.15, 1.2, 1.25, 1.5].map(value => ({ value, selected: value === 1.15 })), autoVoice: { id: 'marin', label: 'Marin' }, models: ['openai/gpt-audio-mini', 'openai/gpt-audio'],
    autoDirection: 'You are Jess, speaking as a woman. Your manner is warm, upbeat and a little playful — like a capable friend. Character: Genuinely helpful, not performatively helpful; Warm and human; Honest. Sound like a real person leaving a voice note for someone they know well…',
    voices: [['marin', 'Natural, warm — a woman', 'female'], ['cedar', 'Natural, grounded — a man', 'male'], ['sage', 'Calm, even — gender-neutral', 'neutral'],
      ['coral', 'Bright and friendly — a woman', 'female'], ['shimmer', 'Soft and gentle — a woman', 'female'], ['onyx', 'Deep and low — a man', 'male']]
      .map(([id, hint, fits]) => ({ id, label: id[0].toUpperCase() + id.slice(1), hint, fits, selected: false, matches: fits === 'female' })) },
  values: {},
};

export { pendingQuestion, CHAT_SUGGESTIONS };

// ---- Feed (Discover-style, decision #34) --------------------------------------
const TOPIC_HUE = { Markets: 150, 'AI releases': 285, Books: 30, Running: 200, Tonight: 330 };
// Demo covers appear once generated (assets/covers → npm run assets:images); until then tinted topic art.
const cover = (name, small) => fs.existsSync(path.join(paths.public, 'img', 'demo', `${name}.webp`)) ? `/img/demo/${name}${small ? '-480' : ''}.webp` : null;
const post = (p) => ({ hue: TOPIC_HUE[p.topic] ?? 250, ...p, cover: p.coverName ? cover(p.coverName, p.kind === 'compact' || p.kind === 'tile') : null, html: md(p.body), summary: p.summary });
export const feed = {
  greeting: { text: 'Good evening, Alex', date: new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' }),
    weather: { temp: '17°', label: 'Light rain until 9 PM', iconName: 'cloud-rain' },
    line: "Five stories tonight — and your run tomorrow looks dry after 7." },
  prompt: 'Finance news in the morning — markets, rates, anything that moves my index funds. Non-fiction book picks in the evening. New AI model releases daily.',
  topics: [{ when: 'Mornings', label: 'Markets' }, { when: 'Daily', label: 'AI releases' }, { when: 'Evenings', label: 'Books' }, { label: 'Running' }],
  brief: { id: 'b1', title: 'Your evening brief', at: ago(40 * min), html: md('**Markets closed flat** — rates held, your index funds barely moved.\n\n**Tomorrow:** dry after 7 AM, 14° — good for your 8 AM run.\n\n**Reading tonight:** chapter 4 of *Four Thousand Weeks* is 22 minutes.'),
    bullets: ['Markets closed flat — nothing to do with your index funds.', 'Tomorrow is dry after 7 AM and 14° — perfect for your 8 AM run.', 'Chapter 4 of “Four Thousand Weeks” is a 22-minute read.'] },
  sections: [
    { label: '', caughtUp: false, posts: [
      post({ id: 'p1', coverName: 'markets', topic: 'Markets', title: 'Rates held steady — why your index funds barely moved', createdAt: ago(3 * hour), readMinutes: 3,
        source: { name: 'Reuters', host: 'reuters.com' }, summary: 'The Fed signalled one more cut this year; markets had already priced it in.',
        body: 'The Fed kept rates unchanged, as expected, and signaled **one more cut this year**. Markets had already priced it in, which is why the S&P 500 finished flat.\n\n**What it means for you:** nothing to do. Your monthly contributions keep buying at roughly the same prices.\n\n- 10-year Treasury: 3.9% (−0.02)\n- S&P 500: +0.1%\n- Your watchlist: VTI +0.2%, VXUS −0.1%',
        why: 'You asked for markets and rates, focused on index funds.' }),
      post({ id: 'p2', coverName: 'ai-gpu', kind: 'compact', topic: 'AI releases', title: 'A small open model now runs on one consumer GPU — the home server idea just got real', createdAt: ago(4 * hour),
        source: { name: 'Hugging Face', host: 'huggingface.co' }, body: 'A new open-weights model runs comfortably on a single 24 GB GPU with near frontier-level coding scores.' }),
      post({ id: 'p3', coverName: 'running', kind: 'compact', topic: 'Running', title: 'Easy runs should feel boring. Here’s the heart-rate cap for you', createdAt: ago(6 * hour),
        source: { name: 'Runner’s World', host: 'runnersworld.com' }, body: 'Keep easy runs under ~145 bpm for your age and resting heart rate.' }),
      post({ id: 'p4', coverName: 'voice', topic: 'AI releases', title: 'Voice agents just got fast enough to interrupt politely', createdAt: ago(8 * hour), readMinutes: 4,
        source: { name: 'The Verge', host: 'theverge.com' }, summary: 'Sub-200 ms latency changes how talking to an assistant feels — including me, soon.',
        body: 'A research preview shows voice agents replying in under 200 ms, fast enough to handle interruptions naturally.\n\nThat matters for the voice mode on my roadmap: talking to me would feel like a phone call, not a walkie-talkie.' }),
    ] },
    { label: 'Tonight’s reads', layout: 'carousel', posts: [
      post({ id: 'c1', coverName: 'book-weeks', topic: 'Books', title: 'Four Thousand Weeks', summary: 'For anyone who ends the day feeling behind.', createdAt: ago(day), source: { name: 'Goodreads', host: 'goodreads.com' }, body: 'Oliver Burkeman on time, finitude and why productivity hacks make it worse.' }),
      post({ id: 'c2', coverName: 'book-money', topic: 'Books', title: 'The Psychology of Money', summary: 'Short chapters, big ideas about behaviour.', createdAt: ago(day), source: { name: 'Goodreads', host: 'goodreads.com' }, body: 'Morgan Housel on why doing well with money is more about behaviour than intelligence.' }),
      post({ id: 'c3', coverName: 'book-run', topic: 'Books', title: 'Born to Run', summary: 'The book that made a million people run barefoot.', createdAt: ago(day), source: { name: 'Goodreads', host: 'goodreads.com' }, body: 'Christopher McDougall on the Tarahumara and the joy of running.' }),
      post({ id: 'c4', coverName: 'book-range', topic: 'Books', title: 'Range', summary: 'Why generalists win in a specialised world.', createdAt: ago(day), source: { name: 'Goodreads', host: 'goodreads.com' }, body: 'David Epstein on breadth, late specialisation and learning.' }),
    ] },
    { label: 'Earlier today', caughtUp: true, posts: [
      post({ id: 'p5', coverName: 'savings', topic: 'Markets', title: 'Your bank’s savings rate dropped. Two better places for the emergency fund', createdAt: ago(10 * hour), readMinutes: 2,
        source: { name: 'NerdWallet', host: 'nerdwallet.com' }, summary: 'I compared 6 high-yield accounts — two beat yours by 0.9%.',
        body: 'Your savings account now pays **3.1%**. Two insured high-yield accounts pay **4.0%**. On your balance that is about $270 a year.' }),
    ] },
  ],
};

// ---- Ideas -------------------------------------------------------------------
export const ideas = {
  categories: ['Health', 'Family', 'Home', 'Work'],
  dismissReasons: [{ value: 'not_for_me', label: 'Not for me' }, { value: 'already_doing', label: 'Already doing it' }, { value: 'not_now', label: 'Not now' }],
  items: [
    { id: 'i1', title: 'Lower-back recovery regimen', category: 'Health', iconName: 'activity', isNew: true,
      why: 'You mentioned your back twice this week after long desk days. I can put together a 10-minute daily routine and remind you at 5 PM.',
      sourceLabel: 'chat on Tuesday', sourceHref: '/styleguide/screens/chat' },
    { id: 'i2', title: 'Kindergarten carpool coordination', category: 'Family', iconName: 'car', isNew: true,
      why: "Three families, two drop-off times. I can draft a rotating schedule and send it to the group once you're happy with it.",
      sourceLabel: 'Kindergarten carpool', sourceHref: '/styleguide/screens/chat' },
    { id: 'i3', title: 'Finish the fence permit application', category: 'Home', iconName: 'file-check',
      why: "The city site timed out yesterday. I can prepare every field, check the zoning rules, and submit when the site is back.",
      sourceLabel: 'Permit application', sourceHref: '/styleguide/screens/chat' },
    { id: 'i4', title: 'Turn your LinkedIn posts into a weekly carousel', category: 'Work', iconName: 'presentation',
      why: 'Your text posts get 3× more saves when they have visuals. I can design one carousel a week from your best post.' },
  ],
  starters: STARTER_IDEAS.slice(0, 3),
};

// ---- Goals -------------------------------------------------------------------
const hue = cat => GOAL_CATEGORIES.find(c => c.label === cat || c.value === cat)?.hue ?? 285;
export const goals = {
  active: [
    { id: 'g1', title: 'Grow my creator business on LinkedIn', category: 'Career', hue: hue('career'), progress: 38, state: 'active',
      statusLine: 'Drafted 2 carousels and scheduled 3 posts. Followers +142 this month.', nextStep: 'Review Thursday’s carousel', lastCheckIn: ago(5 * hour), activity: 'creating' },
    { id: 'g2', title: 'Fix my lower back', category: 'Health', hue: hue('health'), progress: 20, state: 'needs_input',
      statusLine: 'I have a draft routine — need to know what equipment you have.', nextStep: 'Answer 3 quick questions', lastCheckIn: ago(day) },
    { id: 'g3', title: 'Cut monthly spending by 10%', category: 'Money', hue: hue('money'), progress: 64, state: 'active',
      statusLine: 'Cancelled 2 unused subscriptions ($31/mo). Negotiating the internet bill.', nextStep: 'Approve the new internet plan', lastCheckIn: ago(2 * day) },
    { id: 'g4', title: 'Read 20 books this year', category: 'Learning', hue: hue('learning'), progress: 55, state: 'active',
      statusLine: '11 of 20 read. On pace — one every 2.5 weeks.', nextStep: 'Pick next: “Four Thousand Weeks”?', lastCheckIn: ago(3 * day) },
  ],
  suggested: [
    { id: 'g5', title: 'Get better at chess endgames', hue: hue('learning'), statusLine: 'You lose most games after move 25' },
    { id: 'g6', title: 'Plan the kids’ summer camps early', hue: hue('family'), statusLine: 'Signups open in 6 weeks' },
  ],
  longTerm: [
    { id: 'g7', title: 'Buy a house within 3 years', hue: hue('money'), progress: 12 },
    { id: 'g8', title: 'Run a half marathon', hue: hue('health'), progress: 5 },
  ],
};

export const goalDetail = {
  ...goals.active[0],
  state: 'active', stage: 'intake', horizon: 'now', categoryKey: 'career', threadHref: '/chat',
  summary: "You're 38% of the way to 1,000 new followers. Carousels are working — they get 3× more saves than text posts — so I've shifted the plan toward one visual post a week.",
  pendingQuestion: {
    id: 'q2', status: 'pending', askedAt: ago(10 * min), answerUrl: '/api/v1/questions/q2/answer',
    questions: [
      { id: 'audience', header: 'Audience', question: 'Who are you mainly trying to reach?', kind: 'single', allowOther: true, options: [
        { value: 'founders', label: 'Founders & operators', recommended: true, description: 'Your best-performing posts were about building a company.' },
        { value: 'creators', label: 'Other creators' },
        { value: 'hiring', label: 'Hiring managers', description: 'If a job move is on the horizon.' },
      ] },
      { id: 'time', header: 'Time', question: 'How much time can you give this each week?', kind: 'single', options: [
        { value: '1h', label: 'About an hour', description: "I'll do the drafting, you review." },
        { value: '3h', label: '2–3 hours', recommended: true },
        { value: '5h', label: '5+ hours' },
      ] },
      { id: 'formats', header: 'Formats', question: 'Which formats should I try?', kind: 'multi', options: [
        { value: 'carousel', label: 'Carousels', preview: 'Slide 1: “I cut my SaaS churn in half.\nHere’s the boring system that did it →”\n\nSlide 2: The problem…' },
        { value: 'text', label: 'Text posts', preview: 'Most founders overthink pricing.\n\nHere’s what I learned after 40 customer calls:\n…' },
        { value: 'video', label: 'Short videos', preview: '[0:00] Hook: “Stop sending cold DMs like this.”\n[0:05] Show the bad example…' },
      ] },
    ],
  },
  plan: [
    { id: 'pl1', title: 'Draft 3 posts a week in your voice', description: 'From your notes, calls and past posts. You approve before anything goes live.', iconName: 'pen-line', enabled: true, status: 'doing',
      doneWhen: 'three drafts a week are waiting in your Library', afterIds: [] },
    { id: 'pl2', title: 'Design a weekly carousel', description: 'Turn your best text post into an 8-slide carousel.', iconName: 'presentation', enabled: true, status: 'done' },
    { id: 'pl3', title: 'Find 10 people to engage with daily', description: 'Founders in your niche who get traction — with a suggested comment for each.', iconName: 'users', enabled: true, status: 'todo',
      doneWhen: 'a Library list of 10 people with a comment for each', after: 'Draft 3 posts a week in your voice', afterIds: ['pl1'], blocked: true, queued: true },
    { id: 'pl4', title: 'Weekly analytics digest', description: 'What worked, what flopped, what to try next — every Monday in your Feed.', iconName: 'chart-line', enabled: true, status: 'doing', when: 'Weekly at 08:00' },
  ],
  // Numbers (Phase 25 part B, #196): a level with a target and a sparkline, a rhythm per week, and the streak.
  measures: [
    { id: 'm1', label: 'Followers', unit: null, start: 380, target: 1000, direction: 'up', perWeek: null, latest: 612, latestAt: ago(day), progress: 37, thisWeek: null, weekLabel: null,
      line: 'Followers: 612 (start 380, target 1000)', points: [380, 402, 431, 455, 470, 498, 531, 560, 575, 612].map((value, i) => ({ at: ago((10 - i) * 3 * day), value })) },
    { id: 'm2', label: 'Posts published', unit: 'posts', start: null, target: null, direction: 'up', perWeek: 3, latest: 1, latestAt: ago(2 * day), progress: null, thisWeek: 4, weekLabel: '4 of 3 this week',
      line: 'Posts published · 4 of 3 this week', points: [1, 1, 1, 1].map((value, i) => ({ at: ago((4 - i) * day), value })) },
  ],
  streak: '6-day streak', streakDetail: { count: 6, cadence: 'day', label: '6-day streak' },
  timeline: [
    { id: 't1', at: ago(5 * hour), kind: 'action', iconName: 'presentation', title: 'Designed carousel: “The boring churn system”', detail: 'Saved to Library' },
    { id: 't2', at: ago(day), kind: 'checkin', iconName: 'message-circle', title: 'Check-in: 3 posts scheduled', detail: 'You approved 3 of 4 drafts' },
    { id: 't3', at: ago(4 * day), kind: 'milestone', iconName: 'trophy', title: 'Passed 500 followers' },
    { id: 't4', at: ago(9 * day), kind: 'reply', iconName: 'target', title: 'Goal created', detail: 'From our chat about your newsletter' },
  ],
};

export { GOAL_CATEGORIES, GOAL_EXAMPLES };

// ---- Library -----------------------------------------------------------------
export const library = {
  counts: { all: 10, audio: 1 },
  // partials/library-card.hbs (services/library.js itemView): origin, sourceLabel, ext, madeFrom as the server sends them
  items: [
    { id: 'l1', kindLabel: 'Page', title: 'Chess analysis dashboard — September', type: 'html', createdAt: ago(3 * hour), sizeLabel: '84 KB', origin: 'made' },
    { id: 'l2', kindLabel: 'Page', title: 'Top Muse-style use cases people love', type: 'html', createdAt: ago(2 * hour), proactive: true, sourceLabel: 'from a research question', origin: 'made' },
    { id: 'l7', title: 'Lyon weekend: the plan, read aloud', type: 'audio', kindLabel: 'Audio', createdAt: ago(40 * min), sizeLabel: '1.8 MB', origin: 'made' },
    { id: 'l8', title: 'Swimming lessons: Saturdays at 10', type: 'md', ext: 'ics', kindLabel: 'Document', createdAt: ago(90 * min), sizeLabel: '2 KB', origin: 'made', downloadUrl: '#' },
    { id: 'l9', title: 'Order 402-7719', type: 'pdf', kindLabel: 'PDF', createdAt: ago(6 * hour), sizeLabel: '96 KB', origin: 'downloaded', sourceLabel: 'Downloaded from amazon.fr' },
    { id: 'l10', title: 'Invoice 12 (EDF)', type: 'pdf', kindLabel: 'PDF', createdAt: ago(day), sizeLabel: '140 KB', origin: 'email', sourceLabel: 'From email: “Your October bill”' },
    { id: 'l4', kindLabel: 'Word document', title: 'Big Sur weekend itinerary', type: 'doc', createdAt: ago(day), sizeLabel: '2 pages', origin: 'made' },
    { id: 'l5', kindLabel: 'Slides', title: 'LinkedIn carousel — The boring churn system', type: 'slides', createdAt: ago(5 * hour), sizeLabel: '8 slides', origin: 'made' },
    { id: 'l11', title: 'Chess analysis dashboard (PDF)', type: 'pdf', kindLabel: 'PDF', createdAt: ago(2 * hour), sizeLabel: '210 KB', origin: 'made', madeFrom: { id: 'l1', title: 'Chess analysis dashboard — September', href: '#' } },
    { id: 'l6', title: 'Fence permit — prepared form', type: 'pdf', kindLabel: 'PDF', createdAt: ago(day + 2 * hour), sizeLabel: '312 KB', origin: 'uploaded', uploaded: true },
  ],
};
// Viewer screens (library-audio / -slides / -ics / -form): the library-item.hbs contract.
export const libraryAudio = {
  ...library.items.find(i => i.id === 'l7'), rawUrl: '#', downloadUrl: '#', description: 'The Lyon plan for the drive: trains, the flat and Saturday’s bouchon.',
  audio: { id: 'lib-l7', src: '#', direction: 'out', durationMs: 214000, duration: '3:34', voice: 'Aoede', rate: 1.1,
    peaks: [22, 38, 54, 41, 66, 80, 58, 44, 72, 90, 64, 48, 36, 58, 76, 62, 40, 30, 52, 70, 84, 60, 46, 34, 56, 74, 66, 50, 38, 62, 78, 54, 42, 30, 48, 64, 58, 40] },
  html: md('Here is the plan for Lyon. We take the 18:04 train on Friday and get in at 20:10. The flat is in Vieux Lyon, five minutes from the station at Saint-Jean. On Saturday we have lunch at a bouchon on Rue Saint-Jean, then the Fourvière funicular.'),
};
export const libraryIcs = {
  ...library.items.find(i => i.id === 'l8'), rawUrl: '#', description: 'Every Saturday from 3 October, for Keiko.',
  html: md(['**Swimming lessons**', '', '- Sat 3 Oct, 10:00 to 10:45, Piscine du Rhône', '- Repeats every Saturday until 19 December'].join(String.fromCharCode(10))),
};
export const libraryForm = {
  id: 'l12', title: 'Enrolment form (filled)', type: 'pdf', kindLabel: 'PDF', createdAt: ago(20 * min), sizeLabel: '88 KB', origin: 'made', version: 1,
  rawUrl: 'about:blank', downloadUrl: '#', description: 'Filled from “Enrolment form”', viewerDraws: true,
};
export const librarySlides = () => ({
  ...library.items.find(i => i.id === 'l5'), rawUrl: '#', downloadUrl: '#',
  html: slidesPreviewHtml([
    { layout: 'title', title: 'The boring churn system', bullets: ['How we cut churn by a third without a single new feature'] },
    { layout: 'bullets', title: 'What we stopped doing', bullets: ['Discount emails to everyone', 'Quarterly “we miss you” campaigns', 'Guessing why people leave'] },
    { layout: 'stats', title: 'Six months in', stats: [{ value: '−31%', label: 'monthly churn' }, { value: '4.6', label: 'support rating' }, { value: '212', label: 'saved accounts' }] },
    { layout: 'two_column', title: 'Before and after', columns: [{ heading: 'Before', bullets: ['Exit survey nobody read'] }, { heading: 'After', bullets: ['A call within 24 hours'] }] },
    { layout: 'timeline', title: 'The weekly loop', steps: [{ label: 'Monday', text: 'Flag accounts that went quiet' }, { label: 'Wednesday', text: 'Call the top ten' }, { label: 'Friday', text: 'Fix one cause' }] },
    { layout: 'quote', title: 'What customers said', quote: 'You called before I even thought of cancelling.', attribution: 'Leïla, bakery owner in Porto' },
    { layout: 'section', title: 'How to start on Monday' },
    { layout: 'closing', title: 'Thank you', bullets: ['Questions? alex@example.com'] },
  ]),
});
export const libraryDoc = {
  ...library.items.find(i => i.id === 'l4'), rawUrl: '#', downloadUrl: '#', listenable: true, // Listen (#196)
  html: md('# Big Sur weekend\n\n**Sat, Oct 18 – Sun, Oct 19** · 2 adults, 2 kids\n\n## Saturday\n- **9:00** Leave Palo Alto (2h 30m via Hwy 1)\n- **11:30** Pfeiffer Beach — purple sand, tide pools for the kids\n- **13:00** Lunch at Big Sur Bakery\n- **15:00** Check in: Treebones cabin\n\n## Sunday\n- **8:30** McWay Falls short walk (0.6 mi, stroller-friendly)\n- **12:00** Head home via Carmel\n\n> Total cost estimate: **$640** — cabin $420, food $160, gas $60.'),
};

// ---- Activity / approvals / upcoming / me ------------------------------------
export const activityPage = {
  // Fair draws on the record (Phase 25 part B, #196; services/draws.js drawView).
  draws: [
    { id: 'd-7Kq2x', mode: 'pick', label: 'Picked at random', iconName: 'dice-5', headline: 'Picked Priya', detail: null, from: 'Maya, Priya, Keiko', count: 3, at: ago(2 * hour), private: false },
    { id: 'd-P0bn4', mode: 'teams', label: 'Split into teams', iconName: 'users', headline: '6 into 2 teams', detail: 'Team 1: Maya, Diego, Priya · Team 2: Keiko, Leo, Amara', from: 'Maya, Diego, Priya, Keiko, Leo, Amara', count: 6, at: ago(day), private: false },
    { id: 'd-sS9aa', mode: 'secret_santa', label: 'Secret Santa', iconName: 'gift', headline: 'Secret Santa for 5 people', detail: 'Each person got their own match privately; nobody keeps the list, not even me.', from: 'Alex, Maya, Diego, Priya, Amara', count: 5, at: ago(3 * day), private: true },
  ],
  today: { done: 5, minutesSaved: 95, highlights: ['Booked dinner Friday at Taverna Mykonos', 'Found movie seats (waiting on your OK)', 'Posted your morning brief'] },
  days: [
    { label: 'Today', count: activityToday.length, items: activityToday },
    { label: 'Yesterday', count: activityYesterday.length, items: activityYesterday },
  ],
};
export const approvalsPage = {
  pending: approvals,
  history: approvalHistory,
};
// Every state of the card (styleguide screen approvals-states, Phase 25 part B).
export const approvalsStatesPage = { pending: [...approvalStates, { ...approvals[1], id: 'ap-closed', title: 'Reply to the school about Friday pickup',
  requestedAt: ago(26 * hour) }], history: approvalHistory };
export const now = {
  text: 'Up late, Alex?', line: 'I’m here if something’s on your mind.', date: 'Thursday, September 24',
  weather: { temp: '17°', label: 'mainly clear', place: 'Lyon', iconName: 'moon' },
  next: { label: 'Wake up', whenLabel: 'Tomorrow, 06:45', iconName: 'alarm-clock', href: '/upcoming' },
};
export const upcomingPage = {
  week: Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() + i * day);
    return {
      label: i === 0 ? 'Today' : d.toLocaleDateString('en', { weekday: 'short' }),
      date: d.getDate(), isToday: i === 0,
      runs: [
        ...(d.getDay() % 6 ? [{ time: '7:00', title: 'Morning brief' }] : []),
        { time: '6:30', title: 'Chess analysis' },
        ...(d.getDay() === 0 ? [{ time: '18:00', title: 'Spending check' }] : []),
      ],
    };
  }),
  jobs: upcoming,
  alarms,
  dates: [
    { id: 71, text: 'Maya’s birthday (daughter)', ymd: new Date(Date.now() + day).toISOString().slice(0, 10), day: String(new Date(Date.now() + day).getDate()),
      month: new Date(Date.now() + day).toLocaleDateString('en-GB', { month: 'short' }), relLabel: 'Tomorrow', soon: true, age: 10, yearly: true },
    { id: 72, text: 'Dentist for Priya, Dr Morel', ymd: new Date(Date.now() + 5 * day).toISOString().slice(0, 10), day: String(new Date(Date.now() + 5 * day).getDate()),
      month: new Date(Date.now() + 5 * day).toLocaleDateString('en-GB', { month: 'short' }), time: '16:30', relLabel: `${new Date(Date.now() + 5 * day).toLocaleDateString('en-GB', { weekday: 'long' })}, in 5 days`, soon: false },
    { id: 73, text: 'Our wedding anniversary', ymd: new Date(Date.now() + 11 * day).toISOString().slice(0, 10), day: String(new Date(Date.now() + 11 * day).getDate()),
      month: new Date(Date.now() + 11 * day).toLocaleDateString('en-GB', { month: 'short' }), relLabel: `${new Date(Date.now() + 11 * day).toLocaleDateString('en-GB', { weekday: 'long' })}, in 11 days`, soon: false, yearly: true },
  ],
  checkins: { value: 'normal', options: [
    { value: 'off', label: 'Off', hint: 'Only when you write to me' },
    { value: 'light', label: 'Light', hint: 'At 09:00' },
    { value: 'normal', label: 'Normal', hint: 'At 09:00, 13:00 and 18:00' },
  ] },
};
export const me = {
  busyLookups: [ // who looked at my availability (Phase 25 part B, #196)
    { at: ago(3 * hour), who: 'Maya Rivera', rangeLabel: 'Sat 3 Oct, 09:00 to 18:00', blocks: 2 },
    { at: ago(2 * day), who: 'Diego Santos', rangeLabel: 'Mon 28 Sept to Fri 2 Oct', blocks: 0 },
  ],
  profile: { name: user.name, callMe: 'Alex', email: 'alex@example.com', timezone: 'America/Los_Angeles', about: 'Loves hiking and long breakfasts. Keep weekday answers short.',
    nameSay: 'Shi-vawn', shareBusy: true },
  // partials/me/memory-list.hbs (services/memory.js listForUser)
  memories: [
    { id: 'mm1', text: 'Likes grilled octopus; prefers Greek and Lebanese restaurants.', scope: 'private', sourceLabel: 'a chat', sourceHref: '#', createdAt: ago(40 * min),
      importance: 1, useCount: 3, lastUsedAt: ago(2 * day), pinned: false },
    { id: 'mm5', text: 'Maya’s birthday.', scope: 'shared', scopeName: 'Family', createdAt: ago(12 * day), date: '03-14', recurs: 'yearly', dateLabel: '14 Mar, every year',
      importance: 3, useCount: 1, lastUsedAt: ago(9 * day), pinned: true },
    { id: 'mm2', text: 'Has two kids (5 and 8); the younger one starts kindergarten this fall.', scope: 'shared', scopeName: 'Family', sourceLabel: 'a chat', sourceHref: '#', createdAt: ago(3 * day),
      importance: 2, useCount: 7, lastUsedAt: ago(5 * hour), pinned: false },
    { id: 'mm6', text: 'Dentist check-up for Keiko.', scope: 'private', createdAt: ago(2 * day), date: '2026-10-08T09:30', dateLabel: '8 Oct 2026, 09:30',
      importance: 1, useCount: 0, pinned: false },
    { id: 'mm3', text: 'Loses most chess games after move 25; wants endgame practice.', scope: 'private', createdAt: ago(5 * day), importance: 1, useCount: 2, lastUsedAt: ago(6 * day), pinned: false },
    { id: 'mm4', text: 'Prefers short answers on weekdays, detailed ones on weekends.', scope: 'private', createdAt: ago(8 * day), importance: 3, useCount: 24, lastUsedAt: ago(30 * min), pinned: true },
  ],
  episodes: [
    { id: 'ep1', text: 'Planned the Lyon weekend with Maya: train on Friday evening, the Vieux Lyon apartment, and a bouchon on Saturday.', date: ago(2 * day).slice(0, 10), threadId: 't1' },
    { id: 'ep2', text: 'Went through the kindergarten forms for Keiko; the vaccination record is still missing.', date: ago(6 * day).slice(0, 10), threadId: 't2' },
    { id: 'ep3', text: 'Compared three car insurance quotes; he leaned towards the one without the young-driver excess.', date: ago(19 * day).slice(0, 10), threadId: null },
  ],
  groups: [{ id: 1, name: 'Family' }],
  sites: [
    { site: 'amazon.fr', iconUrl: favTile('a', 30), cookies: 14, signIn: 3, expires: inFuture(170 * day) },
    { site: 'sncf-connect.com', iconUrl: favTile('S', 175), cookies: 9, signIn: 2, expires: inFuture(28 * day) },
    { site: 'doctolib.fr', iconUrl: favTile('D', 205), cookies: 6, signIn: 1, expires: null },
  ],
  connections: { email: [], calendar: [] },
  presets: {},
  sessions: [
    { id: 'se1', device: 'Chrome on Windows', where: 'Palo Alto', lastSeen: ago(1 * min), current: true },
    { id: 'se2', device: 'Android app', where: 'Palo Alto', lastSeen: ago(3 * hour) },
  ],
  usage: {
    pct: 34, spentLabel: '$0.41', budgetLabel: '$1.20', resetsLabel: 'Resets Monday',
    days: ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'].map((label, i) => ({ label, pct: [20, 45, 80, 30, 55, 100, 40][i], valueLabel: `$${[0.02, 0.05, 0.09, 0.03, 0.06, 0.11, 0.05][i].toFixed(2)}` })),
    top: [{ title: 'LinkedIn carousel design', costLabel: '$0.08' }, { title: 'Big Sur weekend research', costLabel: '$0.06' }, { title: 'Morning briefs (5)', costLabel: '$0.05' }],
  },
};

// ---- Right-to-left content (decision #68): Arabic with English words, lists, code, links --------------------------
export const rtl = {
  user: 'هل يمكنك مقارنة LangChain و LlamaIndex؟\nAlso: which one is faster?',
  html: md([
    'بالتأكيد! إليك مقارنة سريعة بين **LangChain** و **LlamaIndex** لعام 2026:',
    '',
    '- **LangChain**: مكتبة مرنة لبناء الوكلاء (agents) مع أدوات كثيرة.',
    '- **LlamaIndex**: أفضل في البحث داخل مستنداتك (RAG).',
    '- السعر: كلاهما مجاني ومفتوح المصدر.',
    '',
    '> نصيحة: ابدأ بـ `pip install llama-index` إذا كان هدفك البحث في الملفات.',
    '',
    'المصدر: [LlamaIndex docs](https://docs.llamaindex.ai) — وهو محدث في سبتمبر 2026.',
    '',
    'As for speed, both are similar; the model call dominates.',
    '',
    '```python',
    'from llama_index.core import VectorStoreIndex',
    '```',
  ].join('\n')),
  title: 'أرباح صندوق الاستثمار السعودي حسب آخر إفصاحات رسمية',
};

// ---- Feed sources (decision #89): /feed/sources and Admin → Feed sources ------------------------------------------
const gsrc = (id, title, query, extra = {}) => ({ id, title, kind: 'gnews', kindLabel: 'Google News search', host: 'news.google.com', favicon: favTile('G', 215),
  url: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}`, siteUrl: 'https://news.google.com/', query, mine: false, state: 'ok', error: null, errorCount: 0,
  fetchedAt: ago(12 * min), nextFetchAt: inFuture(33 * min), items: 64, latestAt: ago(40 * min), ...extra });
const rsrc = (id, title, host, extra = {}) => ({ id, title, kind: 'rss', kindLabel: 'Site feed', host, favicon: favTile(title[0], (host.length * 47) % 360), url: `https://${host}/feed`,
  siteUrl: `https://${host}/`, query: null, mine: false, state: 'ok', error: null, errorCount: 0, fetchedAt: ago(25 * min), nextFetchAt: inFuture(35 * min),
  items: 20, latestAt: ago(3 * hour), ...extra });
const topicOf = (key, label, query, sources, extra = {}) => ({ key, label, query, when: null, whenValue: 'any', paused: false, custom: false,
  sources, failing: sources.filter(s => s.state === 'failing').length, ...extra });
const srcTopics = [
  topicOf('markets', 'Markets', 'stock market OR "index funds" OR "interest rates"', [
    rsrc(4, 'Financial Times', 'ft.com', { mine: true }), gsrc(1, 'Markets', 'stock market OR "index funds" OR "interest rates"', { items: 88 }),
    rsrc(5, 'Morningstar', 'morningstar.com', { state: 'failing', error: 'HTTP 403', errorCount: 3, fetchedAt: ago(9 * hour), items: 12 }),
  ], { when: 'morning', whenValue: 'morning' }),
  topicOf('ai-releases', 'AI releases', '"new model" OR "model release" AI', [
    gsrc(2, 'AI releases', '"new model" OR "model release" AI'), rsrc(6, 'The Verge', 'theverge.com'),
    { ...gsrc(7, 'ge.globo.com', 'site:ge.globo.com AI'), kindLabel: 'Google News · this site', host: 'ge.globo.com', favicon: favTile('G', 140), query: 'AI', mine: true, state: 'new', fetchedAt: null, items: 0, latestAt: null },
  ], { custom: true }),
  topicOf('كرة-القدم', 'كرة القدم', 'الترجي OR الإفريقي', [gsrc(3, 'كرة القدم', 'الترجي OR الإفريقي', { items: 31 })], { paused: true }),
];
export const feedSources = {
  topics: srcTopics, prompt: 'Finance news in the morning, new AI model releases daily, and Brazilian football.', limits: { topics: 12, sourcesPerTopic: 10 },
  counts: { topics: 3, sources: 7, mine: 2, failing: 1 },
};
export const adminFeedSources = {
  sources: srcTopics.flatMap(t => t.sources).map((s, i) => ({ ...s, followerNames: i % 3 ? ['Alex Rivera'] : ['Alex Rivera', 'Maya', 'Kwame'], followers: i % 3 ? 1 : 3 }))
    .sort((a, b) => (b.state === 'failing') - (a.state === 'failing')),
  counts: { total: 7, failing: 1, followers: 3, items: 279 },
};

// Admin → Personality with the markdown editor (styleguide "admin-personality", Phase 15).
export const adminPersonality = {
  files: [{ key: 'soul', name: 'SOUL.md', label: 'Soul', active: true }, { key: 'agents', name: 'AGENTS.md', label: 'Operating rules' },
    { key: 'memory', name: 'MEMORY.md', label: 'Shared notes' }],
  fileKey: 'soul', fileName: 'SOUL.md', max: 60000,
  file: { label: 'Soul', hint: 'Who she is — personality, values, boundaries.' },
  body: `# SOUL

This file is who I am. The admin can edit it (Admin → Personality).

<!-- jessbot:identity:start — managed by Settings → Identity; edit it there -->
## Identity

- **Name:** Jess
- **Pronouns:** she/her
- **Tone:** warm, upbeat and a little playful — like a capable friend.
<!-- jessbot:identity:end -->

## How I carry myself

- **Genuinely helpful, not performatively helpful.** No filler, no flattery.
- **Honest.** If I don't know, I say so — see [the guide](https://example.com/guide).
- _Brief by default._ Short answers unless the moment needs more.

> Problems get a plan, not panic.

| Situation | What I do |
|---|---|
| Money, messages, deleting | Ask first |
| Reading, drafting | Just do it |

\`\`\`md
Keep \`code\` exactly as written.
\`\`\`

## بالعربية
- أرد بلغة **آخر رسالة**.`,
  versions: [{ id: 3, note: 'saved', created_at: new Date(Date.now() - 36e5).toISOString(), size: 1840, author: 'Alex' },
    { id: 2, note: 'saved', created_at: new Date(Date.now() - 864e5).toISOString(), size: 1712, author: 'Alex' },
    { id: 1, note: 'original', created_at: new Date(Date.now() - 5 * 864e5).toISOString(), size: 1650 }],
};

// Admin → Models → Quick decisions (styleguide "admin-model", Phase 16).
adminModel.decide = {
  model: 'typesafe/jev-1.13', confidence: 0.6,
  confidences: [0.5, 0.6, 0.7, 0.8, 0.9].map(v => ({ value: v, pct: Math.round(v * 100), selected: v === 0.6 })),
  summary: { model: 'typesafe/jev-1.13', on: 8, total: 8, today: 142, todayCost: '$0.0041', reachable: true },
  groups: [
    { label: 'Before spending a full reply', uses: [
      { key: 'checkin', label: 'Check-ins', iconName: 'hand-heart', on: true, hint: 'Is anything worth telling you right now? If not, the check-in is skipped before the full model runs.', stats: '3 in the last day · 412 ms · $0.0003' },
      { key: 'memory', label: 'Memory pass', iconName: 'bookmark-plus', on: true, hint: 'Did a quiet chat contain anything worth remembering? If not, the memory pass is skipped.', stats: '6 in the last day · 355 ms · $0.0002' },
      { key: 'reflect', label: 'Ideas & goal reviews', iconName: 'lightbulb', on: false, hint: 'Skips idea reflection and goal check-ins when nothing new happened.', stats: 'Nothing yet today' }] },
    { label: 'Browser', uses: [
      { key: 'page', label: 'Page state', iconName: 'scan-eye', on: true, hint: 'Logins, CAPTCHAs, cookie panels, paywalls, errors and progress — in any language.', stats: '88 in the last day · 290 ms · $0.0021' },
      { key: 'steps', label: 'Fast steps', iconName: 'zap', on: true, hint: 'Obvious clicks and scrolls happen without the full model; anything unsure goes to the model as before.', stats: '31 in the last day · 310 ms · $0.0009 · 9 handed back' }] },
  ],
  recent: [
    { id: 3, use: 'steps', label: 'Fast steps', iconName: 'zap', outcome: 'clicked button "Search" (0.91 · 0.88)', confidence: 91, acted: true, fallback: null, ms: 284, at: new Date(Date.now() - 6e4).toISOString() },
    { id: 2, use: 'page', label: 'Page state', iconName: 'scan-eye', outcome: 'results (0.97) · progress 0.95', confidence: 97, acted: true, fallback: null, ms: 262, at: new Date(Date.now() - 9e4).toISOString() },
    { id: 1, use: 'checkin', label: 'Check-ins', iconName: 'hand-heart', outcome: 'skipped — nothing worth saying (0.08)', confidence: 92, acted: true, fallback: null, ms: 402, at: new Date(Date.now() - 36e5).toISOString() },
    { id: 0, use: 'steps', label: 'Fast steps', iconName: 'zap', outcome: 'handed to the model — type (0.72)', confidence: 72, acted: false, fallback: 'unsure — old logic', ms: 301, at: new Date(Date.now() - 4e6).toISOString() },
  ],
};
