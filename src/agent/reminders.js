// Reminders in the chat (decisions #48, #190, #191). A reminder is a message from Jess (a note: a finished run with a hidden
// system trigger, no model call). With follow_up it keeps nudging, gentler to firmer, until the person says it's done:
//   - "Done": the Done button (POST /api/v1/alarms/:id/done), the reminder_done tool (the model heard "done" in any
//     language), or a confirming reply read in plain code (lib/reply-intent.js) — checked when a chat turn ends and again
//     before every nudge, so a "done" is never followed by another nudge;
//   - "stop reminding me" ends this occurrence's nudges; repeating reminders start clean at their next occurrence;
//   - never in their quiet hours (the nudge waits for the end of them), never past `until`, `max`, a day, or the next
//     occurrence; when the nudges run out unconfirmed, a household member who AGREED (#191) is told in their own chat.
// The scheduler (agent/proactive.js) calls fireReminder for every reminder that comes due.
import { get, all } from '../db/index.js';
import * as alarms from '../services/alarms.js';
import { getUser } from '../services/users.js';
import { notify } from '../services/notify.js';
import { logActivity } from '../services/activity.js';
import { audit } from '../services/audit.js';
import { effectivePolicy } from '../services/policy.js';
import { inQuietHours, tzOf, localLabel, nextClockTime } from '../lib/when.js';
import { oneLine } from '../lib/untrusted.js';
import { readReply } from '../lib/reply-intent.js';
import { decide, choice, noul, picked, yes, threshold, note } from '../services/decide.js';
import { postNote } from './proactive.js';
import { onRunFinished } from './loop.js';
import { getRun } from '../services/runs.js';
import { assistantView } from '../services/chatview.js';
import { renderFragment } from '../views/render.js';
import { publish } from '../lib/bus.js';
import { botName } from '../services/bot.js';

const firstName = u => u.call_me || String(u.name || '').split(/\s+/)[0] || 'They';
const minutes = n => `${n} ${n === 1 ? 'minute' : 'minutes'}`;
const clock = (at, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(at));

// A note from Jess, remembered as one of this reminder's posts (which reply belongs to which reminder; how often it spoke).
// consentId: the request a consent note carries, so its chat card can answer it with a tap (#205).
async function post(user, a, { kind, level = 0, system, text, threadId = a?.thread_id ?? null, consentId = null }) {
  const r = await postNote(user, { threadId, origin: 'reminder', originLabel: 'Reminder', system, text });
  const messageId = get('SELECT reply_message_id AS id FROM runs WHERE id = ?', r.id)?.id ?? null;
  alarms.recordPost({ alarmId: a?.id ?? null, userId: user.id, runId: r.id, messageId, kind, level, consentId });
  return { run: r, messageId };
}

// The note went out (postNote rendered it) before it was recorded as this reminder's post and before the reminder moved on,
// so its card (Done, "Nudge 2 of 3", Yes / No: partials/chat/reminder-card.hbs, #205) is drawn again now, in every open chat.
async function redraw(user, r) {
  const html = await renderFragment('chat/message', assistantView(getRun(r.id)), user).catch(() => null);
  if (html) publish(user.id, 'run.refresh', { html }, { threadId: r.thread_id, runId: r.id });
}

/** The scheduler's entry point for a due reminder (late: it was due while the server was off). */
export async function fireReminder(user, a, now = new Date(), { late = false } = {}) {
  if (!alarms.followsUp(a)) return plainReminder(user, a, now, late);
  if (!a.occurrence_at) return firstPost(user, a, now, late);
  return nudge(user, a, now);
}

const lateNote = (a, now) => ` _(this was due ${localLabel(a.fire_at, a.timezone, now).toLowerCase()} — I was offline)_`;

async function plainReminder(user, a, now, late) {
  await post(user, a, { kind: 'reminder',
    system: `[Reminder fired: “${a.label}” — you set it earlier; this message was sent automatically.]`,
    text: `**Reminder:** ${a.label}${late ? lateNote(a, now) : ''}` });
  notify(user.id, { kind: 'reminder', title: 'Reminder', body: a.label, href: '/chat', tag: `alarm-${a.id}` });
  logActivity(user.id, { kind: 'schedule', icon: 'bell', title: `Reminded you: “${a.label.slice(0, 60)}”`, href: '/upcoming' });
  return alarms.completeReminder(a, now);
}

// What the model is told alongside each post (hidden), so "done" or "stop" in any language closes the right reminder.
const toolHint = a => `When they say it's done, call reminder_done with id ${a.id}; if they ask you to stop reminding them, call reminder_done `
  + `with id ${a.id} and stopped=true.`;

async function firstPost(user, a, now, late) {
  const { run: note, messageId } = await post(user, a, { kind: 'reminder', level: 0,
    system: `[Reminder fired: “${a.label}” (reminder id ${a.id}) — you set it earlier; this message was sent automatically. It follows up every `
      + `${minutes(a.follow_every_min)} (at most ${a.follow_max} more ${a.follow_max === 1 ? 'time' : 'times'}) until they confirm. ${toolHint(a)}]`,
    text: `**Reminder:** ${a.label}${late ? lateNote(a, now) : ''}\n\nTell me when it’s done and I’ll stop. Until then I’ll check back every `
      + `${minutes(a.follow_every_min)}.` });
  notify(user.id, { kind: 'reminder', title: 'Reminder', body: a.label, href: '/chat', tag: `alarm-${a.id}` });
  logActivity(user.id, { kind: 'schedule', icon: 'bell', title: `Reminded you: “${a.label.slice(0, 60)}”`, href: '/upcoming' });
  const out = alarms.startFollowUp(a, { now, messageId });
  await redraw(user, note);
  return out;
}

// Gentler to firmer; a different line each time (never the same words twice in a row), and the last one says it's the last.
const GENTLE = [l => `**Still on your list:** ${l}`, l => `**Just checking:** ${l}. Done yet?`];
const FIRMER = [l => `**Reminder again:** ${l}. Please let me know once it’s done.`, l => `**Don’t forget:** ${l}. Tell me when it’s done.`];
export function nudgeText(a, level, { last = false, tellName = null } = {}) {
  const l = a.label;
  if (last) {
    return `**Last nudge:** ${l}. I’ll stop reminding you after this one.`
      + `${tellName ? ` If it’s still open in ${minutes(a.follow_every_min)}, I’ll let ${tellName} know.` : ''}`;
  }
  const set = level <= Math.max(1, Math.floor(a.follow_max / 2)) ? GENTLE : FIRMER;
  return set[(level - 1) % set.length](l);
}

async function nudge(user, a, now) {
  if ((await settle(user, { alarm: a, now })).length) return alarms.getAlarm(a.id);
  const deadline = alarms.followDeadline(a);
  if (a.follow_count >= a.follow_max || now >= deadline) return exhausted(user, a, now);
  // Nudges are Jess's idea of timing, not theirs: never in their quiet hours (the reminder itself, at the time they chose, is).
  const policy = effectivePolicy(user);
  const tz = tzOf(user);
  if (inQuietHours(policy.quietStart, policy.quietEnd, tz, now)) {
    const after = nextClockTime(policy.quietEnd, tz, now);
    return after && after < deadline ? alarms.deferFollowUp(a, after) : exhausted(user, a, now);
  }
  const level = a.follow_count + 1;
  const last = level >= a.follow_max || now.getTime() + a.follow_every_min * 60000 >= deadline.getTime();
  const target = last ? alarms.escalationTarget(a) : null;
  const { run: note, messageId } = await post(user, a, { kind: 'follow_up', level,
    system: `[Reminder follow-up ${level} of ${a.follow_max}: “${a.label}” (reminder id ${a.id}) is not confirmed yet; sent automatically.`
      + `${last ? ' This is the last nudge.' : ''} ${toolHint(a)}]`,
    text: nudgeText(a, level, { last, tellName: target ? firstName(target) : null }) });
  notify(user.id, { kind: 'reminder', title: last ? 'Last reminder' : 'Reminder', body: a.label, href: '/chat', tag: `alarm-${a.id}` });
  const out = alarms.recordNudge(a, { now, messageId });
  await redraw(user, note);
  return out;
}

// The nudges ran out and nobody said "done": tell the household member who agreed (in THEIR chat, outside their quiet
// hours), then close this occurrence as unconfirmed. A repeating reminder moves on to its next time.
async function exhausted(user, a, now) {
  const target = !a.escalated_at ? alarms.escalationTarget(a) : null;
  if (target) {
    const tp = effectivePolicy(target), ttz = tzOf(target);
    if (inQuietHours(tp.quietStart, tp.quietEnd, ttz, now)) {
      const after = nextClockTime(tp.quietEnd, ttz, now);
      // Waits for the end of their quiet hours (the person can still say "done" meanwhile), within 12 hours and before
      // the next occurrence; otherwise the moment has passed.
      const next = a.repeat_cron ? alarms.followDeadline(a) : null;
      if (after && after - now <= 12 * 3600000 && (!next || after < next)) return alarms.deferFollowUp(a, after);
    } else {
      await escalate(user, target, a, now);
    }
  }
  logActivity(user.id, { kind: 'schedule', icon: 'bell', status: 'warn', href: '/upcoming',
    title: `Reminder not confirmed: “${a.label.slice(0, 60)}”` });
  return alarms.closeReminder(alarms.getAlarm(a.id), 'unconfirmed', now);
}

async function escalate(user, target, a, now) {
  const times = a.follow_count + 1;
  const since = clock(a.occurrence_at, tzOf(target));
  const label = oneLine(a.label, 200); // their words, in someone else's chat: one clean line
  await post(target, a, { kind: 'escalation', threadId: null,
    system: `[Reminder escalation, sent automatically: ${user.name} hasn't confirmed their reminder “${label}” (reminded ${times} `
      + `${times === 1 ? 'time' : 'times'} since ${since}). ${target.name} agreed to be told when ${firstName(user)} doesn't confirm a reminder.]`,
    text: `**${firstName(user)} hasn’t confirmed a reminder:** “${label}”. I reminded them ${times} ${times === 1 ? 'time' : 'times'} since ${since}. `
      + 'Maybe check in with them?' });
  notify(target.id, { kind: 'reminder', title: `${firstName(user)} hasn’t confirmed a reminder`, body: label, href: '/chat', tag: `alarm-esc-${a.id}` });
  alarms.markEscalated(a, now);
  audit('reminder.escalated', { actorId: user.id, targetType: 'user', targetId: target.id, detail: { alarmId: a.id, times } });
  logActivity(user.id, { kind: 'schedule', icon: 'user-check', href: '/upcoming', title: `Told ${firstName(target)}: “${a.label.slice(0, 50)}” not confirmed` });
}

/**
 * Ask a household member (once) whether they may be told when `from` doesn't confirm a reminder. The request is a note in
 * THEIR chat; they answer there (answer_reminder_request) or with a tap (POST /api/v1/alarms/consents/:id). → the consent row.
 */
export async function requestConsent(from, target) {
  const { consent, created } = alarms.askConsent(from.id, target.id);
  if (!created) return consent;
  const { run: note } = await post(target, null, { kind: 'consent_request', threadId: null, consentId: consent.id,
    system: `[Request sent automatically: ${from.name} asked that you (${target.name}) be told in this chat when ${firstName(from)} doesn't `
      + `confirm one of their reminders after the follow-ups run out. Request id ${consent.id}. Nothing is shared unless ${firstName(target)} agrees. `
      + `When they answer, call answer_reminder_request with request_id ${consent.id} and allow true or false.]`,
    text: `**${firstName(from)} asked me something:** when ${firstName(from)} doesn’t confirm a reminder after I’ve followed up (medicine, `
      + `the bins…), may I tell you here? Just say yes or no. You can change your mind any time.` });
  notify(target.id, { kind: 'reminder', title: `${firstName(from)} asked me something`, body: 'May I tell you when they miss a reminder?', href: '/chat',
    tag: `consent-${consent.id}` });
  await redraw(target, note);
  audit('reminder.consent_requested', { actorId: from.id, targetType: 'user', targetId: target.id, detail: { consentId: consent.id } });
  return consent;
}

// The decision model's reading of one message against one waiting reminder (docs/JEV.md, use `reminder`, decision #209):
// 'done' | 'stop' | 'neither' when it is sure the message is about this reminder (or sure it says neither), else null: off,
// failed or unsure, and the plain-code reader decides. Asked once per reminder post and message (settle runs after every
// chat turn while a reminder waits), remembered in a small bounded map.
const readings = new Map();
const INTENTS = { done: 'their message says the reminded thing is done (in any words or language)',
  stop: 'their message asks to stop the reminders or the nagging, without saying it is done', neither: 'anything else: a question, '
    + 'another topic, a "not yet", a plan to do it later, or a negation' };
async function jevReading(user, a, m, others) {
  const key = `${a.id}:${a.last_post_msg_id}:${m.id}`;
  if (readings.has(key)) return readings.get(key);
  const res = await decide('reminder', { user, timeoutMs: 2000,
    state: { reminder: a.label, other_reminders_waiting: others.map(o => o.label).join(' | ') || 'none', message: String(m.content || '').slice(0, 600) },
    questions: {
      intent: choice('The person was reminded: `reminder`. Does `message` say it is done, ask to stop the reminders, or neither?', INTENTS),
      about: noul('Is `message` about `reminder` (and not about one of `other_reminders_waiting` or something else)?'),
    } }).catch(() => null);
  const intent = picked(res?.answers?.intent), about = yes(res?.answers?.about);
  const bar = threshold();
  const out = !intent || intent.p < bar ? null
    : intent.pick === 'neither' ? 'neither'
      : ['done', 'stop'].includes(intent.pick) && about != null && about >= bar ? intent.pick : null;
  if (res) note(res.id, out ? `${out} (${Math.round(intent.p * 100)}%)` : 'unsure', { confidence: intent?.p ?? null, acted: !!out });
  readings.set(key, out);
  if (readings.size > 500) readings.delete(readings.keys().next().value);
  return out;
}

/**
 * Read the person's chat messages that came after a reminder's last post and close what they confirmed ("done") or
 * stopped. The decision model reads each message first (any language; a confident "neither" leaves it open); when it is
 * off or unsure, lib/reply-intent.js decides: a bare "done" counts only as the direct answer (the first message after the
 * post) and only when exactly one reminder is waiting in that chat; naming the thing ("took my pills") picks the reminder
 * it names. `alarm`: only that reminder (before its nudge). → the reminders closed.
 */
export async function settle(user, { alarm = null, threadId = null, now = new Date() } = {}) {
  const waiting = all(`SELECT a.*, m.thread_id AS post_thread FROM alarms a JOIN messages m ON m.id = a.last_post_msg_id
    WHERE a.user_id = ? AND a.kind = 'reminder' AND a.occurrence_at IS NOT NULL AND a.status IN ('scheduled', 'snoozed')`, user.id)
    .filter(a => !threadId || a.post_thread === threadId);
  const scope = alarm ? waiting.filter(a => a.post_thread === waiting.find(w => w.id === alarm.id)?.post_thread) : waiting;
  const closed = [];
  for (const thread of new Set(scope.map(a => a.post_thread))) {
    const here = scope.filter(a => a.post_thread === thread);
    const from = Math.min(...here.map(a => a.last_post_msg_id));
    const msgs = all(`SELECT id, content FROM messages WHERE thread_id = ? AND role = 'user' AND id > ? ORDER BY id`, thread, from);
    for (const a of here) {
      if (alarm && a.id !== alarm.id) continue;
      const after = msgs.filter(m => m.id > a.last_post_msg_id);
      for (const [i, m] of after.entries()) {
        const others = here.filter(o => o.id !== a.id && o.last_post_msg_id < m.id);
        const jev = await jevReading(user, a, m, others);
        if (jev === 'neither') continue;
        let intent = jev;
        if (!intent) {
          const r = readReply(m.content, a.label, { direct: i === 0, botName: botName() });
          // A bare "done" or "stop" is ambiguous when several reminders wait here; a stop about the reminding is not.
          if (!r.intent || (!r.specific && others.length)) continue;
          intent = r.intent;
        }
        const current = alarms.getAlarm(a.id);
        // Closed (reminder_done in the turn) or moved on while the decision model read the message.
        if (!current || !['scheduled', 'snoozed'].includes(current.status) || current.last_post_msg_id !== a.last_post_msg_id) break;
        closed.push(alarms.closeReminder(current, intent === 'done' ? 'chat' : 'stop', now));
        logActivity(user.id, { kind: 'schedule', icon: 'bell', href: '/upcoming',
          title: intent === 'done' ? `Marked done: “${a.label.slice(0, 60)}”` : `Stopped reminding you: “${a.label.slice(0, 60)}”` });
        break;
      }
    }
  }
  return closed;
}

// A chat turn ended: whatever the person said may have answered a waiting reminder (the model may also have called
// reminder_done already; then nothing is waiting any more).
onRunFinished(r => {
  if (r?.origin !== 'chat' || !r.user_id) return;
  const user = getUser(r.user_id);
  // Not awaited: the decision model may take a moment, and the finished reply shouldn't wait for it.
  if (user) settle(user, { threadId: r.thread_id }).catch(err => console.warn('[reminders] settle failed:', err.message));
});
