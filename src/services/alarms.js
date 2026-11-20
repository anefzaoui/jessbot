// Alarms, reminders and timers (decision #32). Alarms and timers RING (every open page + devices) until stopped,
// snoozed, or missed after RING_MINUTES; reminders post a message from Jess instead. Repeating ones move to their
// next occurrence when they end. Times are stored UTC and computed in the person's timezone.
// Follow-ups (decision #190): a reminder can keep nudging until the person says it's done (the posting side is
// src/agent/reminders.js); escalation to a household member needs that member's consent (#191).
import { get, all, run } from '../db/index.js';
import { publish } from '../lib/bus.js';
import { invalid, notFound, forbidden } from '../lib/errors.js';
import { tzOf, nextFromCron, localToDate, nextClockTime, repeatToCron, describeCron, localLabel } from '../lib/when.js';
import { toIso } from './chatview.js';

export const RING_MINUTES = Number(process.env.JESSBOT_RING_MINUTES) || 10;
export const SNOOZE_MINUTES = 9;
const LIVE = ['scheduled', 'snoozed', 'ringing'];

// Hard limits on follow-ups (#190): never more often than every 5 minutes, never more than 12 nudges, never longer than
// a day, and a repeating one never runs into its next occurrence.
export const FOLLOW = { minEvery: 5, maxEvery: 240, defaultEvery: 15, maxNudges: 12, defaultMax: 3, maxSpanMin: 24 * 60 };

export const getAlarm = id => get('SELECT * FROM alarms WHERE id = ?', id) || null;

export function alarmForUser(user, id) {
  const a = getAlarm(Number(id));
  if (!a || a.user_id !== user.id) throw notFound('That alarm doesn’t exist.');
  return a;
}

/** Do these two people share a group? (Escalation can only reach someone in the person's household.) */
export const shareGroup = (a, b) => !!get(`SELECT 1 FROM group_members m1 JOIN group_members m2 ON m2.group_id = m1.group_id
  WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 1`, a, b);

// follow_up input → the stored columns, or null. until: "HH:MM" (local) or a number of minutes after the reminder.
function readFollowUp(f, { user, kind }, errors) {
  if (f == null || f === false) return null;
  if (kind !== 'reminder') { errors.follow_up = 'Only reminders can follow up.'; return null; }
  const every = f.everyMin == null || f.everyMin === '' ? FOLLOW.defaultEvery : Math.round(Number(f.everyMin));
  const max = f.max == null || f.max === '' ? FOLLOW.defaultMax : Math.round(Number(f.max));
  if (!(every >= FOLLOW.minEvery && every <= FOLLOW.maxEvery)) errors.follow_up = `Follow up every ${FOLLOW.minEvery} to ${FOLLOW.maxEvery} minutes.`;
  else if (!(max >= 1 && max <= FOLLOW.maxNudges)) errors.follow_up = `Follow up 1 to ${FOLLOW.maxNudges} times.`;
  let until = null;
  const u = f.until == null ? '' : String(f.until).trim();
  if (/^\d{1,2}:\d{2}$/.test(u)) {
    const [h, m] = u.split(':').map(Number);
    if (h > 23 || m > 59) errors.follow_up = 'Follow up until a time like 21:30, or for a number of minutes.';
    else until = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  } else if (/^\+?\d+$/.test(u)) {
    const n = Number(u.replace('+', ''));
    if (!(n >= FOLLOW.minEvery && n <= FOLLOW.maxSpanMin)) errors.follow_up = `Follow up for ${FOLLOW.minEvery} minutes to 24 hours.`;
    else until = `+${n}`;
  } else if (u) errors.follow_up = 'Follow up until a time like 21:30, or for a number of minutes.';
  let escalateTo = null;
  if (f.escalateTo != null) {
    const target = get(`SELECT id, status FROM users WHERE id = ?`, Number(f.escalateTo));
    if (!target || target.status !== 'active' || target.id === user.id || !shareGroup(user.id, target.id)) {
      errors.escalate_to = 'I can only tell someone in your household (a group you share on Jessbot).';
    } else escalateTo = target.id;
  }
  return { every, max, until, escalateTo };
}

/**
 * kind: alarm | reminder | timer. When: `at` (local "YYYY-MM-DDTHH:mm"), `time` ("HH:MM", next occurrence),
 * `inMinutes`, or `durationSec` (timers). repeat: once | daily | weekdays | weekends | "mon,wed" | cron (alarms/reminders).
 * followUp (reminders): { everyMin, max, until, escalateTo (user id) } — keeps nudging until it's done (#190).
 */
export function createAlarm({ user, kind, label = '', at, time, inMinutes, durationSec, repeat, followUp = null, threadId = null, createdBy = 'agent', now = new Date() }) {
  const tz = tzOf(user);
  const errors = {};
  if (!['alarm', 'reminder', 'timer'].includes(kind)) errors.kind = 'Unknown kind.';
  let fireAt = null, cron = null, duration = null;
  if (kind === 'timer') {
    duration = Math.round(Number(durationSec) || Number(inMinutes) * 60);
    if (!(duration >= 1 && duration <= 7 * 86400)) errors.duration = 'A timer needs a duration between 1 second and 7 days.';
    else fireAt = new Date(now.getTime() + duration * 1000);
  } else {
    try {
      const clock = time || (at && String(at).split(/[T ]/)[1]?.slice(0, 5));
      cron = repeatToCron(repeat, clock, { tz, from: (at && localToDate(at, tz)) || now });
    } catch { errors.repeat = 'I couldn’t understand that repeat pattern.'; }
    if (cron) fireAt = nextFromCron(cron, tz, now);
    else if (at) fireAt = localToDate(at, tz);
    else if (time) fireAt = nextClockTime(time, tz, now);
    else if (inMinutes) fireAt = new Date(now.getTime() + Math.round(Number(inMinutes) * 60000));
    if (!fireAt && !errors.repeat) errors.when = at ? 'That time is in the past or not a valid date.' : 'Say when: a time, a date and time, or in how many minutes.';
  }
  if (kind === 'reminder' && !String(label).trim()) errors.label = 'What should I remind you about?';
  const f = readFollowUp(followUp, { user, kind }, errors);
  if (Object.keys(errors).length) throw invalid(errors);
  const { lastInsertRowid } = run(
    `INSERT INTO alarms (user_id, kind, label, fire_at, timezone, repeat_cron, duration_sec, thread_id, created_by,
       follow_every_min, follow_max, follow_until, escalate_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    user.id, kind, String(label).trim().slice(0, 200), fireAt.toISOString(), tz, cron, duration, threadId, createdBy,
    f?.every ?? null, f?.max ?? null, f?.until ?? null, f?.escalateTo ?? null);
  const a = getAlarm(Number(lastInsertRowid));
  announce(a);
  return a;
}

export const listAlarms = (user, { live = true } = {}) => all(
  `SELECT * FROM alarms WHERE user_id = ? ${live ? `AND status IN ('scheduled', 'snoozed', 'ringing')` : ''} ORDER BY fire_at LIMIT 200`, user.id);
export const ringingFor = user => all(`SELECT * FROM alarms WHERE user_id = ? AND status = 'ringing' ORDER BY rang_at`, user.id);
export const dueAlarms = (now = new Date()) => all(`SELECT * FROM alarms WHERE status IN ('scheduled', 'snoozed') AND fire_at <= ? ORDER BY fire_at`, now.toISOString());
export const nextAlarmAt = () => get(`SELECT MIN(fire_at) AS t FROM alarms WHERE status IN ('scheduled', 'snoozed')`)?.t || null;
export const staleRinging = (now = new Date()) => all(`SELECT * FROM alarms WHERE status = 'ringing' AND rang_at <= ?`, new Date(now.getTime() - RING_MINUTES * 60000).toISOString());

function set(a, fields) {
  const keys = Object.keys(fields);
  run(`UPDATE alarms SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map(k => fields[k]), a.id);
  const fresh = getAlarm(a.id);
  announce(fresh);
  return fresh;
}

// A follow-up's state belongs to one occurrence: a repeating reminder starts its next one clean.
const FRESH_OCCURRENCE = { follow_count: 0, occurrence_at: null, last_post_msg_id: null, escalated_at: null };

// Ended (dismissed / missed / done): repeating ones roll forward to their next occurrence. how: closed_how (follow-ups).
function end(a, status, now = new Date(), how = null) {
  const closed = how ? { closed_how: how } : {};
  if (a.repeat_cron) {
    // A follow-up closes at its deadline, a minute before the next occurrence, or at it when the scheduler wakes a little
    // late: never skip that next occurrence (look back a minute, but never at or before this occurrence's own start).
    const from = a.occurrence_at ? new Date(Math.max(new Date(a.occurrence_at).getTime() + 1000, now.getTime() - 60000)) : now;
    const next = nextFromCron(a.repeat_cron, a.timezone, from);
    if (next) return set(a, { status: 'scheduled', fire_at: next.toISOString(), ended_at: now.toISOString(), snooze_count: 0, ...FRESH_OCCURRENCE, ...closed });
  }
  return set(a, { status, ended_at: now.toISOString(), ...closed });
}

export const startRinging = (a, now = new Date()) => set(a, { status: 'ringing', rang_at: now.toISOString() });
export const dismissAlarm = (a, now = new Date()) => end(a, a.kind === 'reminder' ? 'done' : 'dismissed', now);
export const missAlarm = (a, now = new Date()) => end(a, 'missed', now);
export const completeReminder = (a, now = new Date()) => end(a, 'done', now);
export const cancelAlarm = a => set(a, { status: 'cancelled', ended_at: new Date().toISOString() });

export function snoozeAlarm(a, minutes = SNOOZE_MINUTES, now = new Date()) {
  const m = Math.max(1, Math.min(60, Number(minutes) || SNOOZE_MINUTES));
  return set(a, { status: 'snoozed', fire_at: new Date(now.getTime() + m * 60000).toISOString(), snooze_count: a.snooze_count + 1 });
}

// ---- Follow-ups (#190) ----------------------------------------------------------------------------------------------
export const followsUp = a => a?.kind === 'reminder' && !!a.follow_every_min;
/** Posted at least once this occurrence and still waiting for "done". */
export const awaitingDone = a => followsUp(a) && !!a.occurrence_at && LIVE.includes(a.status);

/** The last moment this occurrence may nudge: its `until`, a day at most, and (repeating) before the next occurrence. */
export function followDeadline(a) {
  if (!a?.occurrence_at) return null;
  const start = new Date(a.occurrence_at).getTime();
  let end = start + FOLLOW.maxSpanMin * 60000;
  const u = a.follow_until;
  if (u?.startsWith('+')) end = Math.min(end, start + Number(u.slice(1)) * 60000);
  else if (u) { const t = nextClockTime(u, a.timezone, new Date(start)); if (t) end = Math.min(end, t.getTime()); }
  if (a.repeat_cron) { const n = nextFromCron(a.repeat_cron, a.timezone, new Date(start)); if (n) end = Math.min(end, n.getTime() - 60000); }
  return new Date(end);
}

// The next check: every_min after this post, but never past the deadline (the last nudge's answer window ends with it).
function nextCheck(a, now) {
  const t = now.getTime() + a.follow_every_min * 60000;
  const d = followDeadline(a);
  return new Date(d ? Math.min(t, Math.max(d.getTime(), now.getTime())) : t).toISOString();
}

/** The first post of an occurrence went out: wait for "done", next check after every_min. */
export const startFollowUp = (a, { now = new Date(), messageId = null } = {}) => set(a, {
  occurrence_at: now.toISOString(), follow_count: 0, last_post_msg_id: messageId, escalated_at: null, closed_how: null,
  fire_at: nextCheck({ ...a, occurrence_at: now.toISOString() }, now) });
/** A nudge went out. */
export const recordNudge = (a, { now = new Date(), messageId = null } = {}) => set(a, {
  follow_count: a.follow_count + 1, last_post_msg_id: messageId ?? a.last_post_msg_id, fire_at: nextCheck(a, now) });
/** Quiet hours (theirs, or the household member's before an escalation): check again at `at`. */
export const deferFollowUp = (a, at) => set(a, { fire_at: new Date(at).toISOString() });
export const markEscalated = (a, now = new Date()) => set(a, { escalated_at: now.toISOString() });

/**
 * Close a reminder's current occurrence. how: card | chat | tool (they said it's done) · stop ("stop reminding me") ·
 * unconfirmed (the nudges ran out). Done early (before it fired) counts as done. A one-off that ended unconfirmed can
 * still be marked done afterwards (the truth arrived late); anything else already over stays as it is.
 */
export function closeReminder(a, how, now = new Date()) {
  if (a.kind !== 'reminder') throw invalid({ id: 'Only reminders are marked done.' });
  const done = ['card', 'chat', 'tool'].includes(how);
  if (!LIVE.includes(a.status)) {
    if (done && a.status === 'missed' && !a.repeat_cron) return set(a, { status: 'done', closed_how: how });
    return a;
  }
  const status = done ? 'done' : how === 'stop' ? 'dismissed' : 'missed';
  return end(a, status, now, done && !a.occurrence_at ? 'early' : how);
}

// ---- Who a reminder posted where (Phase 25: the Done button on its chat card) ----------------------------------------------
// consentId: the request a 'consent_request' note carries (its card's Yes / No, #205).
export function recordPost({ alarmId = null, userId, runId = null, messageId = null, kind, level = 0, consentId = null }) {
  run('INSERT INTO reminder_posts (alarm_id, user_id, run_id, message_id, kind, level, consent_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    alarmId, userId, runId, messageId, kind, level, consentId);
}
export const postsOf = alarmId => all('SELECT * FROM reminder_posts WHERE alarm_id = ? ORDER BY id', alarmId);
/** The reminder a chat reply (run) came from, if any: { alarm, post }. */
export function reminderOfRun(user, runId) {
  const post = get(`SELECT * FROM reminder_posts WHERE run_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`, Number(runId), user.id);
  const a = post?.alarm_id ? getAlarm(post.alarm_id) : null;
  return post ? { post, alarm: a && a.user_id === user.id ? a : null } : null;
}

// ---- Escalation consent (#191): asked once per pair; only the person asked can answer ----------------------------------------
export const consentBetween = (fromId, toId) => get('SELECT * FROM reminder_consents WHERE from_user_id = ? AND to_user_id = ?', fromId, toId) || null;
export const getConsent = id => get('SELECT * FROM reminder_consents WHERE id = ?', Number(id)) || null;

/** Ask `toId` (once): → { consent, created }. An earlier answer stands (a "no" is never asked again by Jess). */
export function askConsent(fromId, toId) {
  const had = consentBetween(fromId, toId);
  if (had) return { consent: had, created: false };
  run('INSERT INTO reminder_consents (from_user_id, to_user_id) VALUES (?, ?)', fromId, toId);
  return { consent: consentBetween(fromId, toId), created: true };
}

/** The person asked says yes or no (their own chat or a tap); they can change it later. */
export function answerConsent(user, id, allow) {
  const c = getConsent(id);
  if (!c) throw notFound('That request doesn’t exist.');
  if (c.to_user_id !== user.id) throw forbidden('Only the person who was asked can answer this.');
  run(`UPDATE reminder_consents SET status = ?, answered_at = datetime('now') WHERE id = ?`, allow ? 'granted' : 'declined', c.id);
  const fresh = getConsent(c.id);
  // Every open chat of theirs repaints the request's card (#205), whether they tapped it or answered in words.
  publish(user.id, 'reminder.consent', { consent: { id: fresh.id, status: fresh.status, answeredAt: toIso(fresh.answered_at) } });
  return fresh;
}

/** Who a reminder may be escalated to right now: an active household member who agreed, else null. */
export function escalationTarget(a) {
  if (!a?.escalate_to) return null;
  const target = get(`SELECT * FROM users WHERE id = ? AND status = 'active'`, a.escalate_to);
  if (!target || !shareGroup(a.user_id, target.id)) return null;
  return consentBetween(a.user_id, target.id)?.status === 'granted' ? target : null;
}

const consentView = (c, other) => ({ id: c.id, status: c.status, askedAt: toIso(c.asked_at), answeredAt: toIso(c.answered_at),
  person: other ? { id: other.id, name: other.name } : null });
/** Both directions for one person: requests they were asked (can answer) and the ones they made. */
export function consentsFor(user) {
  const name = id => get('SELECT id, name FROM users WHERE id = ?', id);
  return {
    asked: all('SELECT * FROM reminder_consents WHERE to_user_id = ? ORDER BY id DESC', user.id).map(c => consentView(c, name(c.from_user_id))),
    mine: all('SELECT * FROM reminder_consents WHERE from_user_id = ? ORDER BY id DESC', user.id).map(c => consentView(c, name(c.to_user_id))),
  };
}

// ---- Views ----------------------------------------------------------------------------------------------
const KIND = { alarm: { iconName: 'alarm-clock', noun: 'Alarm' }, reminder: { iconName: 'bell', noun: 'Reminder' }, timer: { iconName: 'timer', noun: 'Timer' } };

// How an occurrence ended, for its chat card (#205). done: they said so (a card, the chat, the tool, or before it was due).
const CLOSED = { card: 'Done', chat: 'Done', tool: 'Done', early: 'Done before it was due', stop: 'Stopped', unconfirmed: 'Not confirmed' };
const DONE_HOW = new Set(['card', 'chat', 'tool', 'early']);
const clockOf = (at, tz) => new Date(at).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined });

function followView(a) {
  if (!followsUp(a)) return null;
  const target = a.escalate_to ? get('SELECT id, name FROM users WHERE id = ?', a.escalate_to) : null;
  const u = a.follow_until;
  const awaiting = awaitingDone(a);
  const next = awaiting && a.fire_at ? clockOf(a.fire_at, a.timezone) : null;
  return {
    everyMin: a.follow_every_min, max: a.follow_max, sent: a.follow_count, awaiting,
    untilLabel: !u ? null : u.startsWith('+') ? `for ${u.slice(1)} min` : `until ${u}`,
    escalateTo: target ? { id: target.id, name: target.name, consent: consentBetween(a.user_id, target.id)?.status || 'none' } : null,
    escalated: !!a.escalated_at, closedHow: a.closed_how || null,
    // The chat card (Phase 25 #205): "Nudge 2 of 3 · next at 6:15 PM" while it waits; how it ended once it's closed; and the
    // message of its newest post (only that note's card offers Done: older nudges fold to a line).
    line: !awaiting ? null : a.follow_count === 0 ? `Waiting for your Done · first nudge at ${next}`
      : a.follow_count >= a.follow_max ? `Nudge ${a.follow_count} of ${a.follow_max} · the last one`
        : `Nudge ${a.follow_count} of ${a.follow_max} · next at ${next}`,
    closed: awaiting || !a.closed_how ? null : { how: a.closed_how, label: CLOSED[a.closed_how] || 'Closed', done: DONE_HOW.has(a.closed_how),
      at: toIso(a.ended_at), canMarkDone: a.closed_how === 'unconfirmed' && a.status === 'missed' && !a.repeat_cron },
    lastPostId: get('SELECT message_id FROM reminder_posts WHERE alarm_id = ? ORDER BY id DESC LIMIT 1', a.id)?.message_id ?? null,
  };
}

/**
 * The card on a reminder's note in the chat (partials/chat/reminder-card.hbs, Phase 25 #205), or null. r: the runs row of
 * the note. A follow-up reminder's post → { kind: 'reminder', alarm (alarmView), level, messageId, latest (its newest post:
 * the one that offers Done) }; a consent request (#191) → { kind: 'consent', consent: { id, status, fromName, answeredAt } }
 * for the person it asks. Plain reminders and escalation notes say all they need in their text.
 */
export function reminderCard(r) {
  if (r?.origin !== 'reminder' || !r.user_id) return null;
  const post = get('SELECT * FROM reminder_posts WHERE run_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', r.id, r.user_id);
  if (!post) return null;
  if (post.kind === 'consent_request') {
    const c = post.consent_id ? getConsent(post.consent_id) : null;
    if (!c || c.to_user_id !== r.user_id) return null;
    const from = get('SELECT name, call_me FROM users WHERE id = ?', c.from_user_id);
    return { kind: 'consent', consent: { id: c.id, status: c.status, answeredAt: toIso(c.answered_at),
      fromName: from ? from.call_me || String(from.name || '').split(/\s+/)[0] : 'They' } };
  }
  if (!['reminder', 'follow_up'].includes(post.kind) || !post.alarm_id) return null;
  const a = getAlarm(post.alarm_id);
  if (!a || a.user_id !== r.user_id || !followsUp(a)) return null;
  const alarm = alarmView(a);
  return { kind: 'reminder', alarm, level: post.level, messageId: post.message_id, latest: alarm.followUp.lastPostId === post.message_id };
}

export function alarmView(a, now = new Date()) {
  return {
    id: a.id, kind: a.kind, iconName: KIND[a.kind].iconName, noun: KIND[a.kind].noun,
    label: a.label || KIND[a.kind].noun, status: a.status, live: LIVE.includes(a.status),
    fireAt: toIso(a.fire_at), whenLabel: localLabel(a.fire_at, a.timezone, now),
    repeatLabel: a.repeat_cron ? describeCron(a.repeat_cron) : null,
    durationSec: a.duration_sec, rangAt: toIso(a.rang_at), snoozeCount: a.snooze_count,
    followUp: followView(a),
  };
}

// Every open page (and later the phone) follows alarm state: ring, snooze, dismiss on one device → all devices.
function announce(a) {
  publish(a.user_id, 'alarm.updated', { alarm: alarmView(a) });
}
