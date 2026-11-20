// Calendar files (Phase 22 part E, decision #160): one or many events as a standard .ics file in the Library, for people
// with no calendar connected (or to hand a trip or a fixture list to someone else). Phones and calendar apps add it with
// one tap: the download is served as text/calendar. Built with the same writer as CalDAV events (buildCalendar).
import crypto from 'node:crypto';
import { buildCalendar, parseWhen, eventLine } from './calendar.js';
import { createFileItem } from './library.js';
import { validTimezone } from '../lib/when.js';
import { renderMarkdown } from '../lib/markdown.js';

export const ICS_MIME = 'text/calendar; charset=utf-8';
export const FILE_EVENTS_MAX = 200;
const bad = msg => Object.assign(new Error(msg), { status: 400 });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Model-written events → checked events for buildCalendar. Each: { title, start, end?, all_day?, location?, description?,
 * time_zone? }; times are local to time_zone (default `tz`, the person's) unless they carry Z or an offset. A date alone is
 * an all-day event; a timed event with no end lasts an hour; an all-day one with no end lasts its day. Throws a 400 naming
 * the event (1-based) that can't be read.
 */
export function checkEvents(events, tz) {
  if (!Array.isArray(events) || !events.length) throw bad('Give at least one event.');
  if (events.length > FILE_EVENTS_MAX) throw bad(`At most ${FILE_EVENTS_MAX} events in one file; make two files.`);
  return events.map((e, i) => {
    const n = `Event ${i + 1}`;
    const title = String(e?.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!title) throw bad(`${n} has no title.`);
    const zone = e.time_zone ? String(e.time_zone).trim() : tz;
    if (!validTimezone(zone)) throw bad(`${n}: “${e.time_zone}” isn’t a time zone (use a name like Europe/Paris or Asia/Tokyo).`);
    const start = parseWhen(e.start, zone);
    if (!start) throw bad(`${n} (“${title}”): I couldn’t read the start “${e.start}”. Use 2026-10-02T14:30, or 2026-10-02 for all day.`);
    const allDay = !!e.all_day || DAY.test(String(e.start).trim());
    let end = e.end ? parseWhen(e.end, zone) : null;
    if (e.end && !end) throw bad(`${n} (“${title}”): I couldn’t read the end “${e.end}”.`);
    // An all-day end given as the last day ("the 3rd to the 5th") includes it: the file's DTEND is the day after.
    if (end && allDay && DAY.test(String(e.end).trim())) end = new Date(end.getTime() + 864e5);
    end ||= new Date(start.getTime() + (allDay ? 864e5 : 3600e3));
    if (end <= start) throw bad(`${n} (“${title}”) ends before it starts.`);
    return { uid: `${crypto.randomUUID()}@jessbot`, title, start, end, allDay, tz: zone,
      location: e.location ? String(e.location).slice(0, 300) : null, description: e.description ? String(e.description).slice(0, 4000) : null };
  });
}

/** Lines people read in the Library (and search finds): one per event, in the person's zone. */
const summaryLines = (events, tz) => events.map(e => `- ${eventLine({ starts_at: e.start.toISOString(), ends_at: e.end.toISOString(), all_day: e.allDay,
  title: e.title, location: e.location }, e.allDay ? e.tz : tz)}${!e.allDay && e.tz !== tz ? ` (${e.tz} time given)` : ''}`);

/**
 * Save a calendar file for this person → { item, events, text }. title: the file's name (also the calendar's name in the
 * apps that show one). The .ics bytes are the file; the event list is its preview and search text.
 */
export function saveCalendarFile(user, { title, events, tz, threadId = null, runId = null }) {
  const name = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120) || (events.length === 1 ? String(events[0].title) : 'Calendar');
  const checked = checkEvents(events, tz);
  const ics = buildCalendar(checked, tz, { method: 'PUBLISH', name });
  const lines = summaryLines([...checked].sort((a, b) => a.start - b.start), tz);
  const text = `${name}\n\n${lines.join('\n')}`;
  const item = createFileItem({
    user, title: name, type: 'md', ext: 'ics', mime: ICS_MIME, buffer: Buffer.from(ics, 'utf8'), text,
    preview: renderMarkdown(`**${checked.length} event${checked.length === 1 ? '' : 's'}**, times in ${tz}. Download the file to add ${checked.length === 1 ? 'it' : 'them'} to a calendar.\n\n${lines.join('\n')}`),
    description: `Calendar file · ${checked.length} event${checked.length === 1 ? '' : 's'}`, threadId, runId, sourceLabel: null,
  });
  return { item, events: checked, text };
}
