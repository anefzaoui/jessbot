// Canonical vocabulary of what Jessbot can be doing. SINGLE SOURCE OF TRUTH shared by the server
// (imported by src/ for run events, activity log, templates) and the browser (status.js).
// Every live event carries { activity, target?, since } — never invent labels elsewhere.
//
//   tone:    drives colour — rest | busy | make | wait | bad
//   avatar:  orb animation / ring — idle | working | creating | waiting | error | offline
//   iconName: badge "prop" on the avatar (search glass, book, pen…)
//   emotion: humanoid avatar expression → assets/avatars/<variant>/<emotion>.png

export const ACTIVITIES = {
  resting:     { verb: 'Resting',           iconName: 'moon',           tone: 'rest', avatar: 'idle',     emotion: 'neutral' },
  thinking:    { verb: 'Thinking',          iconName: 'brain',          tone: 'busy', avatar: 'working',  emotion: 'thinking' },
  searching:   { verb: 'Searching the web', iconName: 'search',         tone: 'busy', avatar: 'working',  emotion: 'curious' },
  reading:     { verb: 'Reading',           iconName: 'book-open',      tone: 'busy', avatar: 'working',  emotion: 'reading' },
  browsing:    { verb: 'Browsing',          iconName: 'globe',          tone: 'busy', avatar: 'working',  emotion: 'curious' },
  writing:     { verb: 'Writing a reply',   iconName: 'pen-line',       tone: 'busy', avatar: 'working',  emotion: 'focused' },
  editing:     { verb: 'Editing',           iconName: 'file-pen-line',  tone: 'make', avatar: 'creating', emotion: 'focused' },
  creating:    { verb: 'Building',          iconName: 'sparkles',       tone: 'make', avatar: 'creating', emotion: 'excited' },
  fetching:    { verb: 'Checking feeds',    iconName: 'rss',            tone: 'busy', avatar: 'working',  emotion: 'curious' },
  looking:     { verb: 'Looking at the page', iconName: 'scan-eye',     tone: 'busy', avatar: 'working',  emotion: 'curious' },
  clicking:    { verb: 'Clicking through',  iconName: 'mouse-pointer-click', tone: 'busy', avatar: 'working', emotion: 'focused' },
  filling:     { verb: 'Filling in a form', iconName: 'text-cursor-input', tone: 'busy', avatar: 'working', emotion: 'focused' },
  choosing:    { verb: 'Choosing options',  iconName: 'list-checks',    tone: 'busy', avatar: 'working',  emotion: 'focused' },
  scrolling:   { verb: 'Scrolling',         iconName: 'arrow-down-up',  tone: 'busy', avatar: 'working',  emotion: 'reading' },
  loading:     { verb: 'Waiting for the page', iconName: 'hourglass',   tone: 'busy', avatar: 'working',  emotion: 'thinking' },
  capturing:   { verb: 'Taking a screenshot', iconName: 'camera',       tone: 'busy', avatar: 'working',  emotion: 'focused' },
  planning:    { verb: 'Planning',          iconName: 'list-todo',      tone: 'busy', avatar: 'working',  emotion: 'thinking' },
  scheduling:  { verb: 'Scheduling',        iconName: 'calendar-clock', tone: 'busy', avatar: 'working',  emotion: 'focused' },
  remembering: { verb: 'Saving to memory',  iconName: 'bookmark-plus',  tone: 'busy', avatar: 'working',  emotion: 'thinking' },
  emailing:    { verb: 'Working on email',  iconName: 'mail',           tone: 'busy', avatar: 'working',  emotion: 'focused' },
  speaking:    { verb: 'Recording a voice note', iconName: 'audio-lines', tone: 'make', avatar: 'creating', emotion: 'happy' },
  waiting:     { verb: 'Waiting for you',   iconName: 'hand',           tone: 'wait', avatar: 'waiting',  emotion: 'concerned' },
  error:       { verb: 'Hit a problem',     iconName: 'triangle-alert', tone: 'bad',  avatar: 'error',    emotion: 'apologetic' },
  offline:     { verb: 'Offline',           iconName: 'wifi-off',       tone: 'bad',  avatar: 'offline',  emotion: 'sleepy' },
};

// Momentary expressions not tied to an ongoing activity (shown briefly, then back to the activity's face).
export const MOMENTS = { done: 'proud', greeting: 'happy', clarifying: 'confused', surprise: 'surprised', delighted: 'happy' };

// "Reading · nytimes.com/…" — target is optional context (query, site, file name).
export function describe(activity, target) {
  const a = ACTIVITIES[activity] || ACTIVITIES.thinking;
  if (activity === 'resting') return target ? `Resting · ${target}` : 'Resting';
  return target ? `${a.verb} · ${target}` : `${a.verb}…`;
}

export const activityOf = key => ACTIVITIES[key] || ACTIVITIES.thinking;
