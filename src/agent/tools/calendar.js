// Calendar tools (Phase 10, decision #79) — the speaker's own calendars only. Looking runs freely; adding, moving or
// deleting an event is an outward change and always shows an approval card with the exact details first.
// Phase 22 part E: free time computed in code, with household members' busy times when they allow it (#158, #159), and
// calendar files (.ics) for people with no calendar connected (#160).
import { registerTool } from './registry.js';
import { connectionsOf, hasConnection } from '../../services/connections.js';
import { eventsBetween, syncUser, createEvent, changeEvent, eventLine, parseWhen, freeSlotsBetween, parseWithin, dayKeys, sharedBusyBlocks,
  sharesBusy } from '../../services/calendar.js';
import { saveCalendarFile, FILE_EVENTS_MAX } from '../../services/calendar-file.js';
import { itemView } from '../../services/library.js';
import { getUser } from '../../services/users.js';
import { get } from '../../db/index.js';
import { tzOf } from '../../lib/when.js';
import { oneLine } from '../../lib/untrusted.js';
import { publish } from '../../lib/bus.js';
import { renderFragment } from '../../views/render.js';
import { guardOutside } from '../injection.js';
import { matchHousehold } from './household.js';

const available = user => hasConnection(user, 'calendar');
function accountFor(user, which) {
  const list = connectionsOf(user, 'calendar');
  if (!list.length) throw Object.assign(new Error('No calendar is connected yet — they can add one under You → Connections.'), { status: 400 });
  if (!which) return list[0];
  const w = String(which).toLowerCase();
  return list.find(c => String(c.id) === w || c.label.toLowerCase() === w) || list[0];
}

const bad = msg => Object.assign(new Error(msg), { status: 400 });
const whenLabel = (start, end, allDay, tz) => eventLine({ starts_at: start.toISOString(), ends_at: end?.toISOString() || null, all_day: allDay, title: '' }, tz).replace(/ · $/, '');

registerTool({
  name: 'calendar_events', toolset: 'calendar', risk: 'read', activity: 'scheduling', iconName: 'calendar-days', available,
  displayName: 'Looks at your calendar',
  description: 'The person’s calendar events between two times (default: now → 7 days), soonest first, in their time zone; optional '
    + 'words to find a specific event. Use it for "when is my next…", "am I free…", before suggesting times, and to find an event’s id.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    from: { type: 'string', description: 'Local date/time, e.g. 2026-10-02 or 2026-10-02T09:00. Default now.' },
    to: { type: 'string', description: 'Local date/time. Default 7 days after from.' },
    query: { type: 'string', description: 'Words in the title or place.' } } },
  label: args => (args.query ? `Looked for “${String(args.query).slice(0, 40)}” in the calendar` : 'Checked the calendar'),
  run: async (args, ctx) => {
    const tz = tzOf(ctx.user);
    await syncUser(ctx.user, { maxAgeMs: 5 * 60000 });
    const from = parseWhen(args.from, tz) || new Date();
    const to = parseWhen(args.to, tz) || new Date(from.getTime() + 7 * 864e5);
    const evs = eventsBetween(ctx.user, from, to, { q: args.query });
    const range = `${whenLabel(from, null, false, tz)} → ${whenLabel(to, null, false, tz)} (${tz})`;
    if (!evs.length) return { content: `Nothing on the calendar ${args.query ? `matching “${args.query}” ` : ''}from ${range}.`, step: { detail: 'Nothing scheduled' } };
    // Entries can come from anyone's invitation: fenced and screened like any outside content (decision #118).
    const many = evs.length > 1 && connectionsOf(ctx.user, 'calendar').length > 1;
    const g = await guardOutside(ctx, { tool: 'calendar_events', kind: 'calendar', label: 'their calendar', origin: 'calendar',
      body: evs.map(e => `- [id ${e.uid}] ${eventLine(e, tz)}${e.recurring ? ' (repeats)' : ''}${many ? ` · ${e.account}` : ''}`).join('\n') });
    return { content: `Calendar, ${range}:\n${g.content}`, step: { detail: `${evs.length} event${evs.length === 1 ? '' : 's'}` } };
  },
});

const eventProps = {
  title: { type: 'string' }, start: { type: 'string', description: 'Local date/time in their zone, e.g. 2026-10-02T14:30 (date only for all-day).' },
  end: { type: 'string', description: 'Local end time. Default: 1 hour after start (the next day for all-day).' },
  all_day: { type: 'boolean', description: 'An all-day event (a date-only start is one too). When changing an event, leave it out to keep it as it is.' }, location: { type: 'string' }, description: { type: 'string' },
};

registerTool({
  name: 'calendar_create_event', toolset: 'calendar', risk: 'external', activity: 'scheduling', iconName: 'calendar-plus', available,
  displayName: 'Adds to your calendar',
  description: 'Add an event to the person’s calendar. The approval card they get IS the confirmation — when they’ve given the details, '
    + 'call this straight away (don’t ask them to confirm first); ask only for something truly missing, like which day. Mention a clash '
    + 'if calendar_events shows one. Times are local to them; "next Tuesday" means the coming Tuesday.',
  parameters: { type: 'object', required: ['title', 'start'], additionalProperties: false, properties: { ...eventProps,
    calendar: { type: 'string', description: 'Calendar name when they have several.' }, account: { type: 'string' } } },
  label: args => `Added “${String(args.title || 'event').slice(0, 60)}” to the calendar`,
  approvalTitle: args => `Add “${String(args.title || 'event').slice(0, 80)}” to your calendar`,
  approvalPreview: args => [`${args.title}`, `When: ${args.start}${args.end ? ` → ${args.end}` : ''}${args.all_day ? ' (all day)' : ''}`,
    args.location ? `Where: ${args.location}` : null, args.description ? `\n${String(args.description)}` : null].filter(Boolean).join('\n'),
  undo: { possible: true, note: 'you can delete the event' },
  reach: 'your calendar, and anyone you share it with',
  run: async (args, ctx) => {
    const tz = tzOf(ctx.user);
    const start = parseWhen(args.start, tz);
    if (!start) throw bad(`I couldn’t read the start time “${args.start}” — use 2026-10-02T14:30.`);
    const allDay = !!args.all_day || /^\d{4}-\d{2}-\d{2}$/.test(String(args.start).trim());
    const end = parseWhen(args.end, tz) || new Date(start.getTime() + (allDay ? 864e5 : 3600e3));
    if (end <= start) throw bad('The end is before the start.');
    const c = accountFor(ctx.user, args.account);
    const out = await createEvent(c, ctx.user, { title: String(args.title).slice(0, 200), start, end, allDay, location: args.location, description: args.description, calendar: args.calendar });
    return { content: `Added to ${out.calendar}: ${whenLabel(start, end, allDay, tz)} · ${args.title} (id ${out.uid}).`, step: { detail: `${whenLabel(start, end, allDay, tz)} · ${out.calendar}` } };
  },
});

registerTool({
  name: 'calendar_update_event', toolset: 'calendar', risk: 'external', activity: 'scheduling', iconName: 'calendar-cog', available,
  displayName: 'Changes a calendar event',
  description: 'Move or edit an event (by its id from calendar_events), or delete it with delete=true. They approve it first. '
    + 'Repeating events can only be deleted whole — for one occurrence, tell them to change it in their calendar app.',
  parameters: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' }, ...eventProps,
    delete: { type: 'boolean', description: 'true deletes the event instead (default false).' }, account: { type: 'string' } } },
  label: args => (args.delete ? 'Deleted a calendar event' : `Changed “${String(args.title || 'an event').slice(0, 60)}”`),
  approvalTitle: args => (args.delete ? 'Delete an event from your calendar' : `Change ${args.title ? `“${String(args.title).slice(0, 60)}”` : 'an event'} in your calendar`),
  // Every field that changes, the new description in full (it was missing: a changed description went unseen).
  approvalPreview: args => (args.delete ? `Delete event ${args.id}` : [Object.entries({ Title: args.title, Start: args.start, End: args.end, Where: args.location,
    'All day': args.all_day == null ? null : args.all_day ? 'yes' : 'no' }).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n'),
  args.description != null ? `Description:\n${String(args.description) || '(cleared)'}` : null].filter(Boolean).join('\n\n') || `Event ${args.id}`),
  undo: args => (args.delete ? { possible: false, note: 'a deleted event can’t be brought back from here' } : { possible: true, note: 'you can change it back' }),
  reach: 'your calendar, and anyone you share it with',
  run: async (args, ctx) => {
    const tz = tzOf(ctx.user);
    const c = accountFor(ctx.user, args.account);
    if (args.delete) { const row = await changeEvent(c, ctx.user, args.id, null); return { content: `Deleted “${row.title}”.`, step: { detail: row.title } }; }
    const patch = {};
    if (args.title) patch.title = String(args.title).slice(0, 200);
    if (args.location != null) patch.location = args.location;
    if (args.description != null) patch.description = args.description;
    if (args.start) { patch.start = parseWhen(args.start, tz); if (!patch.start) throw bad(`I couldn’t read “${args.start}”.`); }
    if (args.end) { patch.end = parseWhen(args.end, tz); if (!patch.end) throw bad(`I couldn’t read “${args.end}”.`); }
    if (patch.start && !patch.end && !args.all_day) patch.end = new Date(patch.start.getTime() + 3600e3);
    if (args.all_day != null) patch.allDay = !!args.all_day;
    const row = await changeEvent(c, ctx.user, args.id, patch);
    return { content: `Changed “${patch.title || row.title}”.`, step: { detail: patch.start ? whenLabel(patch.start, patch.end, patch.allDay, tz) : row.title } };
  },
});

// ---- Free time (decisions #158, #159) ----------------------------------------------------------------------------------
const SLOTS_SHOWN = 20;
// Someone in a group with this person shares their busy times: the tool helps them even without a calendar of their own.
const householdShares = user => !!get(`SELECT 1 FROM users u JOIN group_members m ON m.user_id = u.id
  WHERE u.share_busy = 1 AND u.status = 'active' AND u.id != ? AND m.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?) LIMIT 1`, user.id, user.id);
const dur = mins => (mins >= 60 ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}` : `${mins} min`);
const WHY_LEFT_OUT = { not_shared: 'hasn’t turned on sharing when they’re busy', no_calendar: 'has no calendar connected', not_household: 'isn’t in a group with you' };

registerTool({
  name: 'calendar_free_slots', toolset: 'calendar', risk: 'read', activity: 'scheduling', iconName: 'calendar-check',
  available: user => hasConnection(user, 'calendar') || householdShares(user),
  displayName: 'Finds free time',
  description: 'Free time between two moments, worked out exactly from calendars (never work out gaps yourself). Counts every '
    + 'event on the person’s connected calendars; all-day events block their whole day unless marked free; events marked free '
    + 'or cancelled don’t count. people: household members to include ("Sam", "Mum"); each counts only if they share a group '
    + 'with the person AND turned on "share when I’m busy" (you get busy times only, never what the events are; each lookup is '
    + 'logged for them). Say plainly who wasn’t included and why. Returns up to 20 free stretches, each at least `duration` long, '
    + 'in the person’s time zone. Use it before proposing times for anything.',
  parameters: { type: 'object', required: ['duration'], additionalProperties: false, properties: {
    from: { type: 'string', description: 'Local date/time, e.g. 2026-10-02 or 2026-10-02T09:00. Default now.' },
    to: { type: 'string', description: 'Local date/time. Default 7 days after from; at most 60 days after it.' },
    duration: { type: 'integer', minimum: 5, maximum: 1440, description: 'Minutes needed: only stretches at least this long are returned.' },
    within: { type: 'string', description: 'Daily window in their zone, HH:MM-HH:MM, e.g. 09:00-17:30 (may cross midnight).' },
    days: { type: 'array', items: { type: 'string' }, description: 'Only these days: mon…sun, "weekdays" or "weekends".' },
    buffer: { type: 'integer', minimum: 0, maximum: 240, description: 'Minutes kept clear before and after each event (travel, a breather).' },
    people: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Household members to include, by name. The person is always included.' } } },
  label: args => (args.people?.length ? `Looked for a time that suits ${args.people.slice(0, 3).map(p => oneLine(p, 20)).join(', ')}` : 'Looked for free time'),
  run: async (args, ctx) => {
    const tz = tzOf(ctx.user);
    const from = args.from ? parseWhen(args.from, tz) : new Date();
    if (!from) throw bad(`I couldn’t read “${args.from}”: use 2026-10-02 or 2026-10-02T09:00.`);
    const to = args.to ? parseWhen(args.to, tz) : new Date(from.getTime() + 7 * 864e5);
    if (!to) throw bad(`I couldn’t read “${args.to}”: use 2026-10-09 or 2026-10-09T18:00.`);
    if (to <= from) throw bad('The end of the range is before its start.');
    if (to - from > 60 * 864e5) throw bad('Look at most 60 days ahead at a time.');
    const within = parseWithin(args.within), days = dayKeys(args.days);
    // Who counts: the person, then each named household member (busy times only, and only with their consent).
    const who = matchHousehold(ctx.user, (args.people || []).map(String).filter(Boolean));
    const others = [...new Map([...who.found.values()].filter(p => p && p.id !== ctx.user.id).map(p => [p.id, getUser(p.id)])).values()];
    const events = [], included = [], left = [];
    for (const m of [ctx.user, ...others]) {
      const self = m.id === ctx.user.id;
      if (self || sharesBusy(m.id)) await syncUser(m, { maxAgeMs: 5 * 60000 });
      const r = sharedBusyBlocks(ctx.user, m, from, to);
      const name = self ? 'you' : (m.callMe || m.firstName);
      if (r.status === 'shared') { events.push(...r.blocks); included.push(name); } else left.push({ self, name, why: r.status });
    }
    const slots = freeSlotsBetween(events, from, to, { minMinutes: args.duration, within, days, buffer: args.buffer, tz });
    const notes = [
      ...left.map(l => (l.self ? 'You have no calendar connected, so only the others’ busy times count.' : `${l.name} isn’t included: ${WHY_LEFT_OUT[l.why]}.`)),
      ...who.missing.map(n => `“${oneLine(n, 40)}” isn’t anyone in your household on Jessbot.`),
      ...who.ambiguous.map(n => `“${oneLine(n, 40)}” matches more than one person (or was named twice): use their full name.`),
    ];
    const range = `${whenLabel(from, null, false, tz)} → ${whenLabel(to, null, false, tz)} (${tz})`;
    const rules = [`at least ${dur(args.duration)}`, within ? `within ${String(args.within).trim()}` : null, days ? `on ${[...days].join(', ')}` : null,
      args.buffer ? `${args.buffer} min clear around events` : null].filter(Boolean).join(', ');
    const lines = slots.slice(0, SLOTS_SHOWN).map(s => `- ${whenLabel(s.start, s.end, false, tz)} (${dur(s.minutes)} free)`);
    const more = slots.length > SLOTS_SHOWN ? `\n(${slots.length - SLOTS_SHOWN} more later in the range: ask again from ${whenLabel(slots[SLOTS_SHOWN].start, null, false, tz)}.)` : '';
    const body = slots.length ? `Free (${rules}), ${range}:\n${lines.join('\n')}${more}` : `No free stretch (${rules}) from ${range}.`;
    const whose = included.length ? `Busy times counted: ${included.join(', ')}.` : 'No calendars were counted: every stretch in the range is free.';
    return {
      content: [body, whose, ...notes].join('\n'),
      step: { detail: `${slots.length} free slot${slots.length === 1 ? '' : 's'}${included.length > 1 ? ` · ${included.length} people` : ''}` },
    };
  },
});

// ---- Calendar files (decision #160) -----------------------------------------------------------------------------------
registerTool({
  name: 'make_calendar_file', toolset: 'library', risk: 'write', activity: 'scheduling', iconName: 'calendar-plus',
  displayName: 'Makes a calendar file',
  description: 'Save one or many events (an appointment, a trip day by day, a fixture list, school term dates) as a calendar file '
    + '(.ics) in the person’s Library. Anyone adds it to their phone or calendar app with one tap (link the "Add to calendar" '
    + 'download), so use it when they have no calendar connected, or to hand events to someone else; with a connected calendar, '
    + `calendar_create_event adds to it directly. Up to ${FILE_EVENTS_MAX} events. Times are their local time unless an event gives `
    + 'time_zone (a flight leaving Tokyo: Asia/Tokyo); a date alone is an all-day event; an all-day end date is the last day '
    + 'included. Saved straight away, no approval: nothing reaches any calendar until they open the file.',
  parameters: { type: 'object', required: ['events'], additionalProperties: false, properties: {
    title: { type: 'string', description: 'The file’s name, e.g. "Lisbon trip" or "Spring fixtures". Default: the first event’s title.' },
    events: { type: 'array', minItems: 1, maxItems: FILE_EVENTS_MAX, items: { type: 'object', required: ['title', 'start'], additionalProperties: false, properties: {
      title: { type: 'string' },
      start: { type: 'string', description: 'Local date/time, e.g. 2026-10-02T14:30, or 2026-10-02 for all day.' },
      end: { type: 'string', description: 'Default: 1 hour after start (all day: that day).' },
      all_day: { type: 'boolean', description: 'An all-day event (default false; a date-only start is one too).' }, location: { type: 'string' }, description: { type: 'string' },
      time_zone: { type: 'string', description: 'IANA zone the times are in, when not theirs (e.g. Asia/Tokyo).' } } } } } },
  label: args => `Made a calendar file${args.title ? ` “${oneLine(args.title, 50)}”` : ''} (${args.events?.length || 0} event${args.events?.length === 1 ? '' : 's'})`,
  run: async (args, ctx) => {
    const tz = tzOf(ctx.user);
    const { item, events, text } = saveCalendarFile(ctx.user, { title: args.title, events: args.events, tz, threadId: ctx.thread?.id ?? null, runId: ctx.run?.id ?? null });
    const view = itemView(item);
    publish(ctx.user.id, 'library.created', { item: view, html: await renderFragment('library-card', view, ctx.user).catch(() => null) });
    return {
      content: `Saved “${item.title}” (${events.length} event${events.length === 1 ? '' : 's'}) as a calendar file in the Library. Link it as `
        + `[${item.title}](/library/${item.public_id}); the file itself is [Add to calendar](${view.downloadUrl}): on a phone, tapping it `
        + `offers to add ${events.length === 1 ? 'the event' : 'the events'} to their calendar app.\n\n${text}`,
      step: { detail: `${events.length} event${events.length === 1 ? '' : 's'} · in your Library`, href: `/library/${item.public_id}` },
    };
  },
});
