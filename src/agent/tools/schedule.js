// Time tools (Phase 7a, decisions #32/#48): alarms, reminders, timers and scheduled tasks. Times are the person's
// local wall-clock time (their timezone is in "Right now"); the server converts, stores UTC and fires them.
import { registerTool } from './registry.js';
import * as alarms from '../../services/alarms.js';
import * as schedules from '../../services/schedules.js';
import { pokeScheduler } from '../proactive.js';
import { requestConsent } from '../reminders.js';
import { matchHousehold } from './household.js';
import { getUser } from '../../services/users.js';

const REPEAT = 'once (default), daily, weekdays, weekends, weekly, monthly, yearly (the same date every year: birthdays, anniversaries; '
  + 'give that date with `at`), a list of days like "mon,wed,fri", or a 5-field cron pattern';
const LOCAL = 'Local date-time "YYYY-MM-DDTHH:mm" in the person’s timezone';
// Persistent (decision #124): keeps acting after this task — a repeat, a scheduled task, removing a standing one. After the
// task read outside content these ask first (services/policy.js assess); a one-off reminder or a timer doesn't.
const repeats = args => !!args?.repeat && !/^\s*(once)?\s*$/i.test(String(args.repeat));
const UNDO = { possible: true, note: 'you can cancel it in Upcoming' };

const confirm = (a, extra = '') => {
  const v = alarms.alarmView(a);
  return {
    content: `${v.noun} set (id ${v.id}): “${v.label}” — ${v.whenLabel}${v.repeatLabel ? `, ${v.repeatLabel.toLowerCase()}` : ''}.${extra} `
      + 'It shows in Upcoming; tell the person plainly when it will go off.',
    step: { detail: `${v.whenLabel}${v.repeatLabel ? ` · ${v.repeatLabel}` : ''}`, href: '/upcoming' },
  };
};

registerTool({
  name: 'set_alarm', toolset: 'schedule', risk: 'write', activity: 'scheduling', iconName: 'alarm-clock', activityKind: 'schedule',
  persistent: repeats, undo: UNDO,
  description: 'Set an alarm that RINGS on the person’s devices until they stop or snooze it. Use a clock time (next occurrence) '
    + 'or a full local date-time, optionally repeating (yearly for a birthday or an anniversary).',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      time: { type: 'string', description: '"HH:MM" 24h — the next time the clock shows it.' },
      at: { type: 'string', description: `${LOCAL}, for a specific day.` },
      repeat: { type: 'string', description: `How it repeats: ${REPEAT}.` },
      label: { type: 'string', description: 'What it is for, e.g. "Wake up", "Leave for school".' },
    },
  },
  label: args => `Set an alarm${args.label ? ` “${String(args.label).slice(0, 40)}”` : ''}`,
  target: args => args.time || args.at || '',
  run: (args, ctx) => {
    const a = alarms.createAlarm({ user: ctx.user, kind: 'alarm', label: args.label || 'Alarm', time: args.time, at: args.at, repeat: args.repeat, threadId: ctx.thread.id });
    pokeScheduler();
    return confirm(a);
  },
});

// follow_up.escalate_to: a name → the household member it means (a group they share); ask that member once (#191).
function escalationOf(user, name) {
  if (name == null || String(name).trim() === '') return { id: null };
  const who = matchHousehold(user, [String(name).trim()]);
  const p = who.found.get(String(name).trim());
  if (who.ambiguous.length) return { error: `More than one person in the household matches “${name}”: use their full name.` };
  if (!p) return { error: `“${name}” isn’t in ${user.name.split(/\s+/)[0]}’s household on Jessbot (a group you share), so I can’t tell them.` };
  if (p.id === user.id) return { error: 'The reminder is already for them; escalate_to is someone else in the household.' };
  return { id: p.id, person: getUser(p.id) };
}

registerTool({
  name: 'set_reminder', toolset: 'schedule', risk: 'write', activity: 'scheduling', iconName: 'bell', activityKind: 'schedule',
  // Follow-ups keep posting after this task (and escalate_to writes to someone else's chat): persistent like a repeat (#190).
  persistent: args => repeats(args) || !!args?.follow_up, undo: UNDO,
  description: 'Remind the person of something later: at that moment you post a message in their chat and notify their devices '
    + '(no ringing). Use in_minutes for "in 20 minutes", or at / time for a clock time. For a birthday or an anniversary, at = the '
    + 'next date (with the time to remind) and repeat = yearly. follow_up only when they ask you to keep at it ("keep reminding me '
    + 'until I say done", medicine they forget): you nudge again, gentler then firmer, until they say it\'s done or ask you to stop, '
    + 'never in their quiet hours; escalate_to tells a household member who agreed when the nudges run out unconfirmed.',
  parameters: {
    type: 'object', required: ['text'], additionalProperties: false,
    properties: {
      text: { type: 'string', description: 'What to remind them about, written to them ("Call the dentist to confirm Friday").' },
      in_minutes: { type: 'number', description: 'Minutes from now.' },
      time: { type: 'string', description: '"HH:MM" 24h — next occurrence.' },
      at: { type: 'string', description: `${LOCAL}.` },
      repeat: { type: 'string', description: `How it repeats: ${REPEAT}.` },
      follow_up: {
        type: 'object', additionalProperties: false,
        description: `Keep nudging until it's done (each occurrence of a repeating one starts over). At most ${alarms.FOLLOW.maxNudges} nudges, `
          + `every ${alarms.FOLLOW.minEvery}–${alarms.FOLLOW.maxEvery} min, within a day.`,
        properties: {
          every_min: { type: 'integer', description: `Minutes between nudges (default ${alarms.FOLLOW.defaultEvery}).` },
          max: { type: 'integer', description: `How many nudges after the reminder, at most (default ${alarms.FOLLOW.defaultMax}).` },
          until: { type: 'string', description: 'Stop nudging at this local time "HH:MM", or after this many minutes ("90").' },
          escalate_to: { type: 'string', description: 'Name of a household member to tell if it is still not done after the last nudge '
            + '(a partner for the bins, a parent for a child\'s medicine). They are asked once, in their own chat, and are only ever told if they agree.' },
        },
      },
    },
  },
  label: args => `Set a reminder “${String(args.text || '').slice(0, 40)}”`,
  target: args => String(args.text || '').slice(0, 40),
  run: async (args, ctx) => {
    const f = args.follow_up || null;
    const esc = escalationOf(ctx.user, f?.escalate_to);
    if (esc.error) throw new Error(esc.error);
    const followUp = f ? { everyMin: f.every_min, max: f.max, until: f.until, escalateTo: esc.id } : null;
    const a = alarms.createAlarm({ user: ctx.user, kind: 'reminder', label: args.text, inMinutes: args.in_minutes, time: args.time, at: args.at,
      repeat: args.repeat, followUp, threadId: ctx.thread.id });
    pokeScheduler();
    let extra = '';
    if (f) {
      const v = alarms.alarmView(a).followUp;
      extra = ` Follows up every ${v.everyMin} min, at most ${v.max} ${v.max === 1 ? 'time' : 'times'}${v.untilLabel ? ` (${v.untilLabel})` : ''}, `
        + 'until they say it’s done or ask you to stop.';
      if (esc.person) {
        const consent = await requestConsent(ctx.user, esc.person);
        const who = esc.person.name.split(/\s+/)[0];
        extra += consent.status === 'granted' ? ` If the nudges run out unconfirmed, ${who} is told (they agreed).`
          : consent.status === 'declined' ? ` ${who} said no to being told about missed reminders, so nobody else will be told.`
            : ` I asked ${who} in their own chat whether they may be told if it goes unconfirmed; until they agree, nobody else is told.`;
      }
    }
    return confirm(a, extra);
  },
});

registerTool({
  name: 'reminder_done', toolset: 'schedule', risk: 'write', activity: 'scheduling', iconName: 'check-check', activityKind: 'schedule',
  undo: { possible: false, note: 'a closed reminder isn’t reopened; set a new one if needed' },
  description: 'Close a reminder you are following up on: the person said it\'s done (in any words or language: "took them", "خلاص", '
    + '"c\'est fait"), or asked you to stop reminding them (stopped=true). A repeating reminder moves on to its next time. The id is in the '
    + 'reminder\'s message context and in list_alarms.',
  parameters: {
    type: 'object', required: ['id'], additionalProperties: false,
    properties: {
      id: { type: 'integer' },
      stopped: { type: 'boolean', description: 'They asked you to stop reminding them, not that it is done.' },
    },
  },
  label: args => (args.stopped ? 'Stopped a reminder' : 'Marked a reminder done'),
  run: (args, ctx) => {
    const a = alarms.alarmForUser(ctx.user, args.id);
    if (a.kind !== 'reminder') throw new Error(`That is ${alarms.alarmView(a).noun.toLowerCase()} ${a.id}, not a reminder: use cancel_alarm.`);
    const out = alarms.closeReminder(a, args.stopped ? 'stop' : 'tool');
    pokeScheduler();
    const next = out.repeat_cron && out.status === 'scheduled' ? ` Next time: ${alarms.alarmView(out).whenLabel}.` : '';
    return args.stopped ? `Stopped reminding them about “${a.label}” for now.${next}` : `Marked “${a.label}” done.${next}`;
  },
});

registerTool({
  name: 'answer_reminder_request', toolset: 'schedule', risk: 'write', activity: 'scheduling', iconName: 'user-check', activityKind: 'schedule',
  persistent: true, undo: { possible: true, note: 'they can change their answer any time' },
  description: 'The person answered a household member\'s request (a note in this chat with its request id) to be told when that member '
    + 'doesn\'t confirm a reminder. allow=true only when THEY clearly agreed; a no, or a change of mind later, is allow=false.',
  parameters: {
    type: 'object', required: ['request_id', 'allow'], additionalProperties: false,
    properties: { request_id: { type: 'integer' }, allow: { type: 'boolean' } },
  },
  label: args => (args.allow ? 'Agreed to hear about missed reminders' : 'Declined to hear about missed reminders'),
  run: (args, ctx) => {
    const c = alarms.answerConsent(ctx.user, args.request_id, !!args.allow);
    const from = getUser(c.from_user_id);
    return c.status === 'granted' ? `Saved: ${ctx.user.name.split(/\s+/)[0]} will be told when ${from?.name || 'they'} doesn’t confirm a reminder.`
      : `Saved: ${ctx.user.name.split(/\s+/)[0]} won’t be told about ${from?.name || 'their'} missed reminders.`;
  },
});

registerTool({
  name: 'set_timer', toolset: 'schedule', risk: 'write', activity: 'scheduling', iconName: 'timer', activityKind: 'schedule',
  description: 'Start a countdown timer that rings when it ends (cooking, breaks, parking). Shown live in Upcoming.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      minutes: { type: 'number', description: 'Length in minutes (may be fractional).' },
      seconds: { type: 'number', description: 'Extra seconds.' },
      label: { type: 'string', description: 'e.g. "Pasta", "Parking meter".' },
    },
  },
  label: args => `Started a timer${args.label ? ` “${String(args.label).slice(0, 40)}”` : ''}`,
  target: args => `${args.minutes || 0} min`,
  run: (args, ctx) => {
    const durationSec = Math.round((Number(args.minutes) || 0) * 60 + (Number(args.seconds) || 0));
    const a = alarms.createAlarm({ user: ctx.user, kind: 'timer', label: args.label || 'Timer', durationSec, threadId: ctx.thread.id });
    pokeScheduler();
    return confirm(a, ` Runs for ${Math.floor(durationSec / 60)}m ${durationSec % 60}s.`);
  },
});

registerTool({
  name: 'list_alarms', toolset: 'schedule', risk: 'read', activity: 'scheduling', iconName: 'alarm-clock',
  description: 'List the person’s active alarms, reminders and timers (with ids for cancel_alarm).',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'Checked alarms and reminders',
  run: (args, ctx) => {
    const list = alarms.listAlarms(ctx.user).map(a => alarms.alarmView(a));
    if (!list.length) return 'No active alarms, reminders or timers.';
    const follow = f => (!f ? '' : f.awaiting ? `; waiting for them to say it’s done (${f.sent} of ${f.max} nudges sent; the time is the next check)`
      : `; follows up every ${f.everyMin} min until they say it’s done`);
    return list.map(v => `- [${v.id}] ${v.noun} “${v.label}” — ${v.status === 'ringing' ? 'ringing now' : v.whenLabel}${v.repeatLabel ? ` (${v.repeatLabel})` : ''}`
      + follow(v.followUp)).join('\n');
  },
});

registerTool({
  name: 'cancel_alarm', toolset: 'schedule', risk: 'write', activity: 'scheduling', iconName: 'alarm-clock-off', activityKind: 'schedule',
  // Stopping a repeating alarm or reminder for good is persistent; a one-off or a timer isn't.
  persistent: (args, { user } = {}) => { try { return !!alarms.alarmForUser(user, args.id).repeat_cron; } catch { return false; } },
  undo: { possible: false, note: 'a cancelled alarm or reminder has to be set again' },
  description: 'Cancel an alarm, reminder or timer by id (stops a repeating one for good).',
  parameters: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'integer' } } },
  label: () => 'Cancelled an alarm',
  run: (args, ctx) => {
    const a = alarms.cancelAlarm(alarms.alarmForUser(ctx.user, args.id));
    pokeScheduler();
    return `Cancelled ${alarms.alarmView(a).noun.toLowerCase()} “${a.label}”.`;
  },
});

registerTool({
  name: 'schedule_task', toolset: 'schedule', risk: 'write', activity: 'scheduling', iconName: 'calendar-clock', activityKind: 'schedule',
  persistent: true, undo: { possible: true, note: 'you can delete it in Upcoming' },
  approvalTitle: args => `${args.only_when || args.watch_url ? 'Watch' : 'Schedule'} “${String(args.title || 'a task').slice(0, 80)}”`
    + `${args.cron ? ` (${args.cron})` : args.at ? ` at ${args.at}` : ''}`,
  approvalPreview: args => `${args.cron ? `Repeats: ${args.cron} (local time)` : `Once: ${args.at || 'not set'}`}`
    + `${args.until ? `\nUntil: ${args.until}` : ''}${args.watch_url ? `\nWatches the page: ${args.watch_url}` : ''}`
    + `${args.only_when ? `\nTells you only when: ${args.only_when}` : ''}\n\n`
    + `What I’ll do each time, on my own:\n${args.instructions || ''}`,
  description: 'Schedule YOURSELF to do something later or on a rhythm (a morning brief, a weekly budget check, "check the '
    + 'train strike news every evening"). When it fires you run on your own with these instructions and post the result in the '
    + 'chat. Use cron for rhythms (5 fields, the person’s local time: "0 7 * * 1-5" = weekdays 07:00) or at for once. '
    + 'For "tell me only if / when …" (a price drop, a new listing, a parcel update, tickets on sale) make it a WATCH: set only_when '
    + 'to the condition in words; it then checks quietly, remembers what it saw last time, and writes only when the condition is met '
    + '(at most every 2 hours; up to 10 watches). watch_url: the page to check (an unchanged page costs nothing). until: the last day.',
  parameters: {
    type: 'object', required: ['title', 'instructions'], additionalProperties: false,
    properties: {
      title: { type: 'string', description: 'Short name, e.g. "Morning brief", "Lisbon–Paris fare".' },
      instructions: { type: 'string', description: 'Exactly what to do each time, self-contained (you won’t see this chat’s context).' },
      cron: { type: 'string', description: 'Rhythm as 5-field cron in local time.' },
      at: { type: 'string', description: `${LOCAL}, for a one-off.` },
      only_when: { type: 'string', description: 'Makes it a quiet watch: the condition, in words, for writing to them ("the fare is under '
        + '900 EUR or 5% cheaper than last time"). Otherwise it stays silent.' },
      until: { type: 'string', description: 'Last day it runs, "YYYY-MM-DD" local (e.g. until the parcel is due).' },
      watch_url: { type: 'string', description: 'Full https address of the page a watch checks; when its text hasn’t changed since '
        + 'the last check, nothing runs.' },
    },
  },
  label: args => `${args.only_when || args.watch_url ? 'Watching' : 'Scheduled'} “${String(args.title || '').slice(0, 40)}”`,
  target: args => String(args.title || '').slice(0, 40),
  run: (args, ctx) => {
    const s = schedules.createSchedule({ user: ctx.user, title: args.title, prompt: args.instructions, cron: args.cron, at: args.at, threadId: ctx.thread.id,
      onlyWhen: args.only_when, until: args.until, watchUrl: args.watch_url });
    pokeScheduler();
    const v = schedules.jobView(s);
    const extra = `${v.watch ? ` A watch: it writes only when ${v.watch.condition || 'something changed that matters'}; otherwise it stays quiet.` : ''}`
      + `${v.endsLabel ? ` Runs until ${v.endsLabel}.` : ''}`;
    return { content: `Scheduled (id ${v.id}) “${v.title}” — ${v.scheduleLabel}; next run ${v.nextLabel}.${extra} Tell the person plainly.`,
      step: { detail: `${v.watch ? 'Watch · ' : ''}${v.scheduleLabel} · next ${v.nextLabel}`, href: '/upcoming' } };
  },
});

registerTool({
  name: 'list_schedules', toolset: 'schedule', risk: 'read', activity: 'scheduling', iconName: 'calendar-clock',
  description: 'List the tasks you have scheduled for the person (ids for cancel_schedule).',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'Checked scheduled tasks',
  run: (args, ctx) => {
    const list = schedules.listSchedules(ctx.user).map(s => schedules.jobView(s));
    if (!list.length) return 'No scheduled tasks.';
    return list.map(v => `- [${v.id}] “${v.title}” — ${v.scheduleLabel}${v.paused ? ' (paused)' : `, next ${v.nextLabel}`}`
      + `${v.endsLabel ? `, until ${v.endsLabel}` : ''}${v.lastStatus ? `, last run: ${v.lastStatus}` : ''}`
      // (the watch's last note is page-derived text: it's shown only inside the watch's own fenced prompt, not here)
      + `${v.watch ? `; watch, only when: ${v.watch.condition || 'something changed'}${v.watch.checkedLabel ? `, last checked ${v.watch.checkedLabel}` : ''}` : ''}`
      + `: ${v.prompt.slice(0, 120)}`).join('\n');
  },
});

registerTool({
  name: 'cancel_schedule', toolset: 'schedule', risk: 'write', activity: 'scheduling', iconName: 'calendar-x', activityKind: 'schedule',
  persistent: true, undo: { possible: false, note: 'a deleted task has to be set up again' },
  description: 'Delete a scheduled task by id.',
  parameters: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'integer' } } },
  label: () => 'Removed a scheduled task',
  run: (args, ctx) => {
    const s = schedules.scheduleForUser(ctx.user, args.id);
    if (s.kind !== 'task') throw new Error('That is the check-in rhythm — the person changes it in their settings (You → Check-ins).');
    schedules.deleteSchedule(s);
    pokeScheduler();
    return `Removed “${s.title}”.`;
  },
});
