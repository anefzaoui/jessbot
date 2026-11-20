// Phase 22 (decisions #190–#193): reminders that follow up until they're done (Done, a confirming reply, "stop reminding
// me", until/max, quiet hours, repeating ones starting clean, escalation only with consent), and the Feed in chat
// (feed_stories / feed_follow / feed_mute), OPML import and export, muted words, the reading diet.
// Run: npm test  (node --test, throwaway data dir, no network: feeds come from fixtures, no browser).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listen } from './helpers/listen.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-p22k-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env');
process.env.JESSBOT_EMBED_OFF = '1';
process.env.JESSBOT_DECIDE_OFF = '1';

const { openDb, closeDb, get, all, run, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { createUser, getUser } = await import('../src/services/users.js');
const { createGroup, addMember } = await import('../src/services/groups.js');
const { createApp } = await import('../src/app.js'); // registers every tool too
const { getTool } = await import('../src/agent/tools/registry.js');
const { mainThread } = await import('../src/services/threads.js');
const { addMessage } = await import('../src/services/messages.js');
const { createSession } = await import('../src/services/sessions.js');
const alarms = await import('../src/services/alarms.js');
const R = await import('../src/agent/reminders.js');
const { readReply, normalize } = await import('../src/lib/reply-intent.js');
const { runDue, schedulerHealth } = await import('../src/agent/proactive.js');

let alice, bob, carol, family, base, server;
const tokens = {};
before(async () => {
  alice = await createUser({ name: 'Alice Owner', email: 'alice@p22k.dev', password: 'correct horse battery', role: 'admin', timezone: 'UTC' });
  bob = await createUser({ name: 'Bob Member', email: 'bob@p22k.dev', password: 'correct horse battery', timezone: 'UTC' });
  carol = await createUser({ name: 'Carol Other', email: 'carol@p22k.dev', password: 'correct horse battery', timezone: 'UTC' });
  family = createGroup({ name: 'Family' });
  for (const u of [alice, bob]) addMember(family.id, u.id);
  settings.set('setup', { done: ['account', 'model', 'browser', 'identity', 'people'], completedAt: new Date().toISOString() });
  for (const [k, u] of Object.entries({ alice, bob, carol })) tokens[k] = createSession(u.id, { kind: 'app', device: 'test' });
  server = await listen(createApp());
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); closeDb(); fs.rmSync(HOME, { recursive: true, force: true }); });
// The scheduler fires every due alarm of everyone: nothing a test leaves live may fire in the next one.
afterEach(() => run(`UPDATE alarms SET status = 'cancelled' WHERE status IN ('scheduled', 'snoozed', 'ringing')`));

const reasons = err => (err.errors ? Object.values(err.errors).join(' ') : err.message);
const throwsWith = (fn, re) => assert.throws(fn, err => { assert.match(reasons(err), re); return true; });
const ctxOf = (user, extra = {}) => ({ user: getUser(user.id), thread: mainThread(user.id), run: null, signal: undefined, ...extra });
const text = out => (typeof out === 'string' ? out : out.content);
async function api(who, method, url, body) {
  const res = await fetch(`${base}/api/v1${url}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
}

// Tools that set or close a reminder poke the scheduler (a tick 50 ms later): let it run while the database is open.
async function schedulerTicked(since) {
  for (let i = 0; i < 100 && schedulerHealth().lastTickAt === since; i++) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 150));
}

// Each test gets its own person (a fresh main chat), so the scheduler's other due reminders never mix in.
let n = 0;
async function person(extra = {}) {
  n++;
  const u = await createUser({ name: `Pat${n} Tester`, email: `pat${n}@p22k.dev`, password: 'correct horse battery', timezone: 'UTC', ...extra });
  return getUser(u.id);
}
const T0 = new Date('2030-03-04T12:00:00Z'); // noon UTC: outside the default quiet hours (22:00–07:30)
const at = min => new Date(T0.getTime() + min * 60000);
const said = u => all(`SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY id`, mainThread(u.id).id).map(m => m.content);
const reply = (u, content) => addMessage({ threadId: mainThread(u.id).id, role: 'user', content });
// A reminder due at T0 (created a minute before it), following up.
function pills(u, followUp, extra = {}) {
  return alarms.createAlarm({ user: u, kind: 'reminder', label: 'Take your pills', inMinutes: 1, followUp, threadId: mainThread(u.id).id,
    now: at(-1), ...extra });
}

// ---- Follow-ups: shapes and limits -----------------------------------------------------------------------------------------
test('migration 047: follow-up columns, reminder posts and consents, and feed_mutes rebuilt with word (nothing else lost)', () => {
  const cols = all('PRAGMA table_info(alarms)').map(c => c.name);
  for (const c of ['follow_every_min', 'follow_max', 'follow_until', 'follow_count', 'occurrence_at', 'last_post_msg_id', 'escalate_to', 'escalated_at', 'closed_how']) {
    assert.ok(cols.includes(c), c);
  }
  for (const t of ['reminder_posts', 'reminder_consents']) assert.ok(get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, t), t);
  assert.match(get(`SELECT sql FROM sqlite_master WHERE name = 'feed_mutes'`).sql, /'topic', 'source', 'word'\)/);
  assert.deepEqual(all('PRAGMA table_info(feed_mutes)').map(c => c.name), ['user_id', 'kind', 'value', 'created_at']);
  assert.equal(all('PRAGMA foreign_key_check').length, 0);
});

test('follow_up is validated: reminders only, 5–240 min, 1–12 nudges, until as HH:MM or minutes, escalation inside the household', async () => {
  const u = await person();
  throwsWith(() => alarms.createAlarm({ user: u, kind: 'alarm', inMinutes: 5, followUp: {} }), /Only reminders/);
  throwsWith(() => pills(u, { everyMin: 2 }), /every 5 to 240/);
  throwsWith(() => pills(u, { max: 13 }), /1 to 12/);
  throwsWith(() => pills(u, { until: 'tonight' }), /until a time/);
  throwsWith(() => pills(u, { until: '25:00' }), /until a time/);
  throwsWith(() => pills(u, { until: '2000' }), /24 hours/);
  throwsWith(() => pills(alice, { escalateTo: carol.id }), /household/);
  throwsWith(() => pills(alice, { escalateTo: alice.id }), /household/);
  const a = pills(u, {});
  assert.deepEqual([a.follow_every_min, a.follow_max, a.follow_until], [alarms.FOLLOW.defaultEvery, alarms.FOLLOW.defaultMax, null]);
  assert.equal(pills(u, { until: '9:05' }).follow_until, '09:05');
  assert.equal(pills(u, { until: 90 }).follow_until, '+90');
  const plain = alarms.createAlarm({ user: u, kind: 'reminder', label: 'Plain', inMinutes: 5 });
  assert.equal(plain.follow_every_min, null);
  assert.equal(alarms.alarmView(plain).followUp, null);
  const v = alarms.alarmView(pills(alice, { everyMin: 10, max: 2, until: '+45', escalateTo: bob.id })).followUp;
  assert.deepEqual({ ...v, escalateTo: { ...v.escalateTo } }, { everyMin: 10, max: 2, sent: 0, awaiting: false, untilLabel: 'for 45 min',
    escalateTo: { id: bob.id, name: 'Bob Member', consent: 'none' }, escalated: false, closedHow: null,
    line: null, closed: null, lastPostId: null }); // the chat card's fields (Phase 25 #205): nothing posted yet
  for (const x of alarms.listAlarms(u)) alarms.cancelAlarm(x);
  for (const x of alarms.listAlarms(alice)) alarms.cancelAlarm(x);
});

test('a plain reminder still posts once and is done (unchanged behaviour)', async () => {
  const u = await person();
  const a = alarms.createAlarm({ user: u, kind: 'reminder', label: 'Water the plants', inMinutes: 1, now: at(-1) });
  await runDue(T0);
  assert.deepEqual(said(u), ['**Reminder:** Water the plants']);
  assert.equal(alarms.getAlarm(a.id).status, 'done');
  assert.equal(alarms.postsOf(a.id).length, 1, 'its post is remembered (the card can find its reminder)');
});

test('follow-ups re-post on schedule, gentler to firmer with different words each time, and stop after max (unconfirmed)', async () => {
  const u = await person();
  const a = pills(u, { everyMin: 10, max: 3 });
  await runDue(T0);
  let x = alarms.getAlarm(a.id);
  assert.equal(x.status, 'scheduled');
  assert.equal(x.occurrence_at, T0.toISOString());
  assert.equal(x.fire_at, at(10).toISOString());
  assert.equal(alarms.alarmView(x).followUp.awaiting, true);
  await runDue(at(9)); // not yet
  assert.equal(said(u).length, 1);
  for (const m of [10, 20, 30]) await runDue(at(m));
  const posts = said(u);
  assert.equal(posts.length, 4);
  assert.match(posts[0], /^\*\*Reminder:\*\* Take your pills\n\nTell me when it’s done and I’ll stop\. Until then I’ll check back every 10 minutes\./);
  assert.match(posts[1], /^\*\*Still on your list:\*\* Take your pills$/);
  assert.match(posts[2], /Please let me know once it’s done|Tell me when it’s done/);
  assert.match(posts[3], /^\*\*Last nudge:\*\* Take your pills\. I’ll stop reminding you after this one\.$/);
  assert.equal(new Set(posts).size, 4, 'never the same words twice');
  assert.ok(posts.every(p => !p.includes('—')), 'no em-dashes in what she says (#116)');
  assert.equal(alarms.getAlarm(a.id).follow_count, 3);
  await runDue(at(40)); // the last nudge had its 10 minutes: closed, silently
  x = alarms.getAlarm(a.id);
  assert.equal(x.status, 'missed');
  assert.equal(x.closed_how, 'unconfirmed');
  assert.equal(said(u).length, 4, 'no fifth message');
  assert.deepEqual(alarms.postsOf(a.id).map(p => [p.kind, p.level]), [['reminder', 0], ['follow_up', 1], ['follow_up', 2], ['follow_up', 3]]);
  // The hidden context tells the model which reminder and how to close it.
  const sys = all(`SELECT content FROM messages WHERE thread_id = ? AND role = 'system' ORDER BY id`, mainThread(u.id).id).map(m => m.content);
  assert.match(sys[0], new RegExp(`reminder id ${a.id}.*reminder_done with id ${a.id}`));
  // Late truth: a "done" tap on the closed one-off still records it.
  assert.equal(alarms.closeReminder(alarms.getAlarm(a.id), 'card').status, 'done');
});

test('Done (the API), a confirming reply, and "stop reminding me" each end the nudges; "not yet" or a question does not', async () => {
  // Done on the card (API), and other people can't touch it.
  const u1 = await person();
  const t1 = tokens.u1 = createSession(u1.id, { kind: 'app', device: 'test' });
  assert.ok(t1);
  const a1 = pills(u1, { everyMin: 10, max: 3 });
  await runDue(T0);
  assert.equal((await api('carol', 'POST', `/alarms/${a1.id}/done`)).status, 404);
  const r = await api('u1', 'POST', `/alarms/${a1.id}/done`);
  assert.equal(r.status, 200);
  assert.equal(r.json.alarm.status, 'done');
  assert.equal(r.json.alarm.followUp.closedHow, 'card');
  await runDue(at(10));
  assert.equal(said(u1).length, 1, 'no nudge after Done');
  assert.equal((await api('u1', 'POST', `/alarms/${a1.id}/done`)).json.alarm.status, 'done', 'Done twice is harmless');

  // A reply naming the thing, anywhere after the nudge (read before the next nudge).
  const u2 = await person();
  const a2 = pills(u2, { everyMin: 10, max: 3 });
  await runDue(T0);
  reply(u2, 'what is the weather like?');
  reply(u2, 'oh and I took my pills');
  await runDue(at(10));
  assert.equal(said(u2).length, 1);
  assert.equal(alarms.getAlarm(a2.id).status, 'done');
  assert.equal(alarms.getAlarm(a2.id).closed_how, 'chat');

  // A bare "done" counts as the direct answer only; "not yet" and a question never do.
  const u3 = await person();
  const a3 = pills(u3, { everyMin: 10, max: 5 });
  await runDue(T0);
  reply(u3, 'not yet');
  await runDue(at(10));
  assert.equal(said(u3).length, 2, 'nudged: "not yet" is not done');
  reply(u3, 'did I take them already?');
  await runDue(at(20));
  assert.equal(said(u3).length, 3, 'a question is not done');
  reply(u3, 'can you check the train times');
  reply(u3, 'done');
  await runDue(at(30));
  assert.equal(said(u3).length, 4, 'a bare "done" after something else is not taken as this');
  reply(u3, 'خلاص');
  await runDue(at(40));
  assert.equal(said(u3).length, 4);
  assert.equal(alarms.getAlarm(a3.id).status, 'done', 'Arabic "khalas" as the direct answer');

  // "Stop reminding me" (any language): this occurrence ends as dismissed, right when the chat turn ends.
  const u4 = await person();
  const a4 = pills(u4, { everyMin: 10, max: 3 });
  await runDue(T0);
  reply(u4, 'ما تفكرنيش');
  assert.equal((await R.settle(u4, { threadId: mainThread(u4.id).id })).length, 1, 'read when the chat turn ends');
  const x4 = alarms.getAlarm(a4.id);
  assert.equal(x4.status, 'dismissed');
  assert.equal(x4.closed_how, 'stop');
  await runDue(at(10));
  assert.equal(said(u4).length, 1);
});

test('two reminders waiting in one chat: a bare "done" is ambiguous, naming one closes that one, "stop reminding me" stops both', async () => {
  const u = await person();
  const pill = pills(u, { everyMin: 10, max: 5 });
  const bins = alarms.createAlarm({ user: u, kind: 'reminder', label: 'Put the bins out', inMinutes: 1, now: at(-1), followUp: { everyMin: 10, max: 5 },
    threadId: mainThread(u.id).id });
  await runDue(T0);
  reply(u, 'done');
  assert.equal((await R.settle(u)).length, 0, 'which one? neither');
  reply(u, 'bins are out, put them out just now');
  const closed = await R.settle(u);
  assert.deepEqual(closed.map(c => c.id), [bins.id]);
  assert.equal(alarms.getAlarm(pill.id).status, 'scheduled');
  reply(u, 'please stop reminding me');
  assert.deepEqual((await R.settle(u)).map(c => c.id), [pill.id]);
});

test('until: HH:MM or minutes bounds the nudges (the last one says so); a day at most', async () => {
  const u = await person();
  const a = pills(u, { everyMin: 10, max: 12, until: '+15' });
  await runDue(T0);
  await runDue(at(10));
  assert.match(said(u).at(-1), /^\*\*Last nudge:\*\*/, 'the next one would be past until');
  await runDue(at(20));
  assert.equal(alarms.getAlarm(a.id).status, 'missed');
  assert.equal(said(u).length, 2);

  const v = await person();
  const b = pills(v, { everyMin: 10, max: 12, until: '12:25' });
  await runDue(T0);
  for (const m of [10, 20, 30]) await runDue(at(m));
  assert.equal(said(v).length, 3, 'reminder + nudges at 12:10 and 12:20; the 12:30 check is past 12:25');
  assert.match(said(v).at(-1), /Last nudge/);
  assert.equal(alarms.getAlarm(b.id).status, 'missed');
  assert.equal(alarms.followDeadline({ occurrence_at: T0.toISOString(), timezone: 'UTC', follow_until: null }).toISOString(), at(24 * 60).toISOString());
});

test('quiet hours: a nudge waits for the end of them, or the occurrence closes quietly when that is past its end', async () => {
  const u = await person();
  const night = new Date('2030-03-04T21:50:00Z');
  const a = alarms.createAlarm({ user: u, kind: 'reminder', label: 'Take your pills', inMinutes: 1, now: new Date(night.getTime() - 60000),
    followUp: { everyMin: 20, max: 3 } });
  await runDue(night);
  await runDue(new Date('2030-03-04T22:10:00Z')); // quiet since 22:00
  assert.equal(said(u).length, 1, 'no nudge at night');
  assert.equal(alarms.getAlarm(a.id).fire_at, '2030-03-05T07:30:00.000Z', 'waits for 07:30');
  await runDue(new Date('2030-03-05T07:30:00Z'));
  assert.equal(said(u).length, 2);
  assert.match(said(u)[1], /Still on your list/);

  const v = await person();
  const b = alarms.createAlarm({ user: v, kind: 'reminder', label: 'Take your pills', inMinutes: 1, now: new Date(night.getTime() - 60000),
    followUp: { everyMin: 20, max: 3, until: '+60' } });
  await runDue(night);
  await runDue(new Date('2030-03-04T22:10:00Z'));
  assert.equal(said(v).length, 1);
  assert.equal(alarms.getAlarm(b.id).status, 'missed', '07:30 is past its hour: closed, silently');
});

test('repeating reminders start each occurrence clean, and their nudges never run into the next one', async () => {
  const u = await person();
  const a = alarms.createAlarm({ user: u, kind: 'reminder', label: 'Take your pills', time: '12:00', repeat: 'daily', now: at(-60),
    followUp: { everyMin: 30, max: 2 } });
  assert.equal(a.fire_at, T0.toISOString());
  await runDue(T0);
  await runDue(at(30));
  let x = alarms.getAlarm(a.id);
  assert.equal(x.follow_count, 1);
  reply(u, 'took the pills');
  await runDue(at(60));
  x = alarms.getAlarm(a.id);
  assert.equal(x.status, 'scheduled', 'still repeating');
  assert.equal(x.fire_at, at(24 * 60).toISOString(), 'tomorrow at noon');
  assert.deepEqual([x.follow_count, x.occurrence_at, x.last_post_msg_id, x.escalated_at, x.closed_how], [0, null, null, null, 'chat']);
  assert.equal(alarms.alarmView(x).followUp.awaiting, false);
  // Tomorrow: the first post again, then nudges as new.
  await runDue(at(24 * 60));
  assert.match(said(u).at(-1), /^\*\*Reminder:\*\* Take your pills/);
  // Hourly with long follow-ups: capped just before the next hour.
  const h = alarms.createAlarm({ user: u, kind: 'reminder', label: 'Stretch', time: '12:00', repeat: '0 * * * *', now: at(-30),
    followUp: { everyMin: 20, max: 12 } });
  await runDue(T0);
  assert.equal(alarms.followDeadline(alarms.getAlarm(h.id)).toISOString(), at(59).toISOString());
  for (const m of [20, 40]) await runDue(at(m));
  assert.equal(alarms.getAlarm(h.id).fire_at, at(59).toISOString(), 'the last check is at its deadline');
  await runDue(at(60)); // the scheduler woke a minute late: the 13:00 occurrence is still next, not skipped
  let hx = alarms.getAlarm(h.id);
  assert.deepEqual([hx.status, hx.closed_how, hx.fire_at, hx.occurrence_at], ['scheduled', 'unconfirmed', at(60).toISOString(), null]);
  await runDue(at(60));
  hx = alarms.getAlarm(h.id);
  assert.equal(hx.occurrence_at, at(60).toISOString(), 'the 13:00 occurrence starts clean');
  assert.equal(hx.closed_how, null);
  for (const x2 of alarms.listAlarms(u)) alarms.cancelAlarm(x2);
});

test('escalation: only to a household member, only after they agreed (asked once, in their own chat), and only in their chat', async () => {
  const bobThread = mainThread(bob.id).id;
  const bobSaid = () => all(`SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY id`, bobThread).map(m => m.content);
  const ticked = schedulerHealth().lastTickAt;
  // set_reminder with escalate_to asks Bob once (a note in Bob's chat); Alice's own reply says nobody is told yet.
  const ctx = ctxOf(alice);
  const out = text(await getTool('set_reminder').run({ text: 'Put the bins out', in_minutes: 1, follow_up: { every_min: 10, max: 1, escalate_to: 'Bob' } }, ctx));
  assert.match(out, /Follows up every 10 min, at most 1 time/);
  assert.match(out, /I asked Bob in their own chat/);
  assert.match(bobSaid().at(-1), /\*\*Alice asked me something:\*\* when Alice doesn’t confirm a reminder/);
  const consent = alarms.consentBetween(alice.id, bob.id);
  assert.equal(consent.status, 'pending');
  await assert.rejects(async () => getTool('set_reminder').run({ text: 'x', in_minutes: 5, follow_up: { escalate_to: 'Carol' } }, ctx), /isn’t in Alice’s household/);
  // Asked once: a second reminder doesn't ask again.
  const again = text(await getTool('set_reminder').run({ text: 'Water the plants', in_minutes: 30, follow_up: { escalate_to: 'Bob' } }, ctx));
  assert.match(again, /I asked Bob/);
  alarms.cancelAlarm(alarms.listAlarms(alice).find(a => a.label === 'Water the plants'));
  assert.equal(bobSaid().filter(m => /asked me something/.test(m)).length, 1);

  // Not agreed yet: the nudges run out and nobody is told.
  const bins = alarms.listAlarms(alice).find(a => a.label === 'Put the bins out');
  run('UPDATE alarms SET fire_at = ? WHERE id = ?', T0.toISOString(), bins.id);
  await runDue(T0);
  await runDue(at(10));
  assert.doesNotMatch(said(alice).at(-1), /let Bob know/, 'no promise to tell Bob without his yes');
  await runDue(at(20));
  assert.equal(alarms.getAlarm(bins.id).status, 'missed');
  assert.equal(bobSaid().filter(m => /hasn’t confirmed/.test(m)).length, 0);

  // Only Bob can answer; Alice can't answer for him (tool or API).
  assert.throws(() => alarms.answerConsent(alice, consent.id, true), /Only the person who was asked/);
  assert.equal((await api('alice', 'POST', `/alarms/consents/${consent.id}`, { allow: true })).status, 403);
  assert.equal((await api('bob', 'POST', `/alarms/consents/${consent.id}`, { allow: 'yes' })).status, 422);
  const yes = text(await getTool('answer_reminder_request').run({ request_id: consent.id, allow: true }, ctxOf(bob)));
  assert.match(yes, /Bob will be told when Alice Owner doesn’t confirm a reminder/);
  const listed = await api('bob', 'GET', '/alarms/consents');
  assert.equal(listed.json.asked[0].status, 'granted');
  assert.equal(listed.json.asked[0].person.name, 'Alice Owner');
  assert.equal((await api('alice', 'GET', '/alarms/consents')).json.mine[0].person.name, 'Bob Member');

  // Agreed: the last nudge says so, and when it goes unconfirmed Bob is told in HIS chat (a push too), never Alice's.
  const b2 = alarms.createAlarm({ user: alice, kind: 'reminder', label: 'Put the bins out', inMinutes: 1, now: at(99), followUp: { everyMin: 10, max: 1, escalateTo: bob.id },
    threadId: mainThread(alice.id).id });
  await runDue(at(100));
  await runDue(at(110));
  assert.match(said(alice).at(-1), /If it’s still open in 10 minutes, I’ll let Bob know\./);
  const before = said(alice).length;
  await runDue(at(120));
  assert.match(bobSaid().at(-1), /^\*\*Alice hasn’t confirmed a reminder:\*\* “Put the bins out”\. I reminded them 2 times since 13:40\. Maybe check in with them\?$/);
  assert.equal(said(alice).length, before, 'nothing more in Alice’s chat');
  const x = alarms.getAlarm(b2.id);
  assert.ok(x.escalated_at);
  assert.equal(x.status, 'missed');
  assert.ok(get(`SELECT 1 FROM audit_log WHERE action = 'reminder.escalated' AND actor_id = ? AND target_id = ?`, alice.id, String(bob.id)));
  assert.equal(alarms.postsOf(b2.id).at(-1).kind, 'escalation');

  // Bob in his quiet hours: the escalation waits for their end (Alice can still say done meanwhile).
  const late = new Date('2030-03-04T21:30:00Z');
  const b3 = alarms.createAlarm({ user: alice, kind: 'reminder', label: 'Lock the door', inMinutes: 1, now: new Date(late.getTime() - 60000),
    followUp: { everyMin: 10, max: 1, escalateTo: bob.id }, threadId: mainThread(alice.id).id });
  await runDue(late);
  await runDue(new Date('2030-03-04T21:40:00Z'));
  await runDue(new Date('2030-03-04T22:05:00Z')); // Alice's quiet hours too: exhausted at 22:05, Bob quiet → wait
  assert.equal(alarms.getAlarm(b3.id).fire_at, '2030-03-05T07:30:00.000Z');
  assert.equal(bobSaid().filter(m => /Lock the door/.test(m)).length, 0);
  reply(alice, 'locked the door, done');
  await runDue(new Date('2030-03-05T07:30:00Z'));
  assert.equal(alarms.getAlarm(b3.id).status, 'done', 'she confirmed before Bob had to be told');
  assert.equal(bobSaid().filter(m => /Lock the door/.test(m)).length, 0);

  await schedulerTicked(ticked);
  // Bob changes his mind: no more escalations.
  alarms.answerConsent(getUser(bob.id), consent.id, false);
  assert.equal(alarms.escalationTarget(alarms.getAlarm(b2.id)), null);
  for (const a of alarms.listAlarms(alice)) alarms.cancelAlarm(a);
});

test('reminder_done closes the one it names (done or stopped), repeating ones move on; list_alarms shows who is waiting', async () => {
  const ticked = schedulerHealth().lastTickAt;
  const u = await person();
  const ctx = ctxOf(u);
  const a = pills(u, { everyMin: 10, max: 3 });
  await runDue(T0);
  const listed = text(await getTool('list_alarms').run({}, ctx));
  assert.match(listed, new RegExp(`\\[${a.id}\\] Reminder “Take your pills”.*waiting for them to say it’s done \\(0 of 3 nudges sent`));
  assert.match(text(await getTool('reminder_done').run({ id: a.id }, ctx)), /Marked “Take your pills” done\./);
  assert.equal(alarms.getAlarm(a.id).closed_how, 'tool');
  const d = alarms.createAlarm({ user: u, kind: 'reminder', label: 'Stretch', time: '15:00', repeat: 'daily', now: T0, followUp: {} });
  const stopped = text(await getTool('reminder_done').run({ id: d.id, stopped: true }, ctx));
  assert.match(stopped, /Stopped reminding them about “Stretch” for now\. Next time: /);
  assert.equal(alarms.getAlarm(d.id).closed_how, 'stop');
  const timer = alarms.createAlarm({ user: u, kind: 'timer', durationSec: 60 });
  await assert.rejects(async () => getTool('reminder_done').run({ id: timer.id }, ctx), /not a reminder/);
  await assert.rejects(async () => getTool('reminder_done').run({ id: a.id }, ctxOf(carol)), /doesn’t exist/);
  await schedulerTicked(ticked);
  for (const x of alarms.listAlarms(u)) alarms.cancelAlarm(x);
});

test('the confirming-reply reader: many languages, whole words, negations and questions never count', () => {
  const L = 'Take your pills';
  const done = (t, direct = true, label = L) => readReply(t, label, { direct }).intent === 'done';
  const stop = (t, direct = true) => readReply(t, L, { direct }).intent === 'stop';
  for (const t of ['done', 'Done!', 'ok done, thanks', 'all done now', 'yes I did', 'took them', '✅', 'c\'est fait', 'fini merci', 'خلاص', 'تم',
    'كملت', 'خلاص يعيشك', '5las', 'khlas']) assert.ok(done(t), t);
  for (const t of ['not yet', 'not done', 'did I take them?', 'pas encore', 'pas fait', 'مازلت', 'ماخذيتهاش', 'لا', 'later', 'I haven\'t done it',
    'yes', 'ok', 'I finished the report, thanks', 'done with the essay', 'will do', 'mazelt']) assert.ok(!done(t), t);
  assert.ok(!done('done', false), 'a bare done needs to be the direct answer');
  assert.ok(done('took my pills', false), 'naming the thing counts anywhere');
  assert.ok(done('شربت الدواء', false, 'خذ الدواء'), 'Arabic, with the article peeled');
  assert.ok(done('j\'ai pris mes médicaments', false, 'Prendre tes médicaments'), 'French, accents folded');
  assert.ok(!done('I took the car', false), 'another thing');
  assert.ok(done('stop reminding me, I took my pills', false), 'done wins over stop when both are said');
  for (const t of ['stop reminding me', 'please stop the reminders', 'don\'t remind me again', 'arrête de me rappeler', 'ما تفكرنيش', 'توقف عن تذكيري']) assert.ok(stop(t, false), t);
  for (const t of ['stop', 'enough', 'يزي', 'barka']) { assert.ok(stop(t), t); assert.ok(!stop(t, false), `${t} (not direct)`); }
  assert.ok(!stop('stop the car'), 'a bare stop in a sentence is about something else');
  assert.equal(normalize('  Ça  SUFFIT  '), 'ca suffit');
  assert.equal(normalize('أخذتُها'), 'اخذتها');
});

// ---- The Feed in chat, OPML, muted words, the reading diet (#192, #193) ------------------------------------------------------
const F = await import('../src/services/feed.js');
const S = await import('../src/services/feed-sources.js');
const { readingDiet, recordEvent } = await import('../src/services/feed-rank.js');
const { wordMatcher } = await import('../src/lib/word-match.js');
const { taintOf } = await import('../src/agent/taint.js');
const runs = await import('../src/services/runs.js');

const FAR = '2099-01-01T00:00:00.000Z'; // fixture sources are never due: the scheduler must not fetch them
function feedFor(u, labels) {
  F.savePrefs(u, { prompt: labels.join(', '), topics: labels.map(l => ({ key: S.slug(l), label: l, query: l, sites: [], when: 'any' })) });
}
function source(url, title) {
  const s = F.ensureSource(url, { title });
  run('UPDATE feed_sources SET next_fetch_at = ?, fetched_at = ? WHERE id = ?', FAR, new Date().toISOString(), s.id);
  return F.ensureSource(url);
}
const follow = (u, s, label) => run(`INSERT OR IGNORE INTO feed_subscriptions (user_id, source_id, topic_key, origin) VALUES (?, ?, ?, 'manual')`, u.id, s.id, S.slug(label));
let itemN = 0;
function item(s, title, { summary = '', hoursAgo = 1, name = 'Daily Planet', host = 'dailyplanet.test' } = {}) {
  itemN++;
  const { lastInsertRowid } = run(`INSERT INTO feed_items (source_id, dedupe_key, url, title, summary, source_name, source_host, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, s.id, `k${itemN}`, `https://${host}/story-${itemN}`, title, summary, name, host,
  new Date(Date.now() - hoursAgo * 3600000).toISOString());
  return Number(lastInsertRowid);
}

test('muted words: whole words in any script (Arabic clitics too), never substrings; phrases; scripts without spaces', () => {
  const m = wordMatcher(['Trump', 'رياضة', 'Premier League', 'الانتخابات', '東京', 'café']);
  for (const t of ['Trump’s new plan', 'TRUMP wins', 'الرياضة اليوم', 'والرياضة', 'للرياضة', 'بالرياضة', 'the premier   league final',
    'الانتخابات البلدية', 'انتخابات', 'وانتخابات', '東京で', 'Cafe opens']) assert.ok(m(t), t);
  for (const t of ['trumpet player', 'رياضيات', 'premier leagues', 'cafés', 'Tokyo']) assert.equal(m(t), null, t);
  assert.equal(wordMatcher([])('anything'), null);
});

test('muted words hide stories from the ranked feed (title or summary) and hide written stories; unmute brings them back', async () => {
  const u = await person();
  feedFor(u, ['World', 'Sport']);
  const world = source('https://planet.test/world.xml', 'Daily Planet');
  follow(u, world, 'World');
  const a = item(world, 'Trump visits Lisbon');
  const b = item(world, 'A trumpet festival opens');
  const c = item(world, 'Elections next month', { summary: 'The campaign is led by trump allies' });
  const d = item(world, 'الرياضة في الأردن');
  const e = item(world, 'رياضيات للأطفال');
  const ids = () => F.cardCandidates(u).map(x => x.id).sort((x, y) => x - y);
  assert.deepEqual(ids(), [a, b, c, d, e]);
  const post = F.addPost(u, { topicKey: 'world', topic: 'World', itemId: a, title: 'Trump in Lisbon', summary: 'A visit', body: 'x' });
  const out = F.setMute(u, 'word', ' Trump ');
  assert.deepEqual([out.kind, out.value, out.muted, out.hidden], ['word', 'Trump', true, 1]);
  assert.deepEqual(ids(), [b, d, e], 'title and summary, whole words only');
  assert.equal(get('SELECT hidden FROM feed_posts WHERE id = ?', post.id).hidden, 1, 'a written story is hidden too');
  F.setMute(u, 'word', 'رياضة');
  assert.deepEqual(ids(), [b, e]);
  assert.deepEqual(F.mutesList(u).words.map(w => w.value), ['Trump', 'رياضة']);
  F.setMute(u, 'word', 'trump'); // same word, any case: not added twice
  assert.equal(F.mutesList(u).words.length, 2);
  // Unmuting a word re-hides exactly what the other mutes cover (a topic mute stays).
  F.setMute(u, 'topic', 'Sport');
  F.setMute(u, 'word', 'TRUMP', { undo: true });
  assert.equal(get('SELECT hidden FROM feed_posts WHERE id = ?', post.id).hidden, 0);
  assert.deepEqual(ids(), [a, b, c, e]);
  assert.deepEqual(F.mutesList(u).topics.map(x => x.value), ['Sport']);
  // Validation.
  throwsWith(() => F.setMute(u, 'word', '   '), /Which word/);
  throwsWith(() => F.setMute(u, 'word', 'one two three four five six'), /up to 5 words/);
  throwsWith(() => F.setMute(u, 'colour', 'red'), /topic, a source or a word/);
});

test('feed_stories: the ranked feed or a search, a topic, hours; fenced as outside content; /feed?story= opens the one story', async () => {
  const u = await person();
  const ctx = ctxOf(u);
  assert.match(text(await getTool('feed_stories').run({}, ctx)), /isn’t set up yet/);
  feedFor(u, ['AI', 'Cooking']);
  const ai = source('https://ai.test/feed.xml', 'AI Weekly');
  const food = source('https://food.test/feed.xml', 'Food Mag');
  follow(u, ai, 'AI'); follow(u, food, 'Cooking');
  const fresh = item(ai, 'New open model beats benchmarks', { summary: 'A lab released weights today.', name: 'AI Weekly', host: 'ai.test' });
  item(ai, 'Old news about chips', { hoursAgo: 30, name: 'AI Weekly', host: 'ai.test' });
  const soup = item(food, 'Harissa soup for cold evenings', { name: 'Food Mag', host: 'food.test' });
  const r = runs.createRun({ threadId: ctx.thread.id, userId: u.id, triggerMessageId: null, model: null });
  const out = await getTool('feed_stories').run({}, { ...ctx, run: r });
  assert.match(out.content, /^2 stories ranked for them \(their topics: AI, Cooking\):/);
  assert.match(out.content, /<feed_stories scope="ranked for them" fence="[0-9a-f]+">/);
  assert.match(out.content, /New open model beats benchmarks\n {3}Source: AI Weekly · Topic: AI/);
  assert.match(out.content, new RegExp(`Link: https://ai\\.test/story-\\d+ · On their Feed: /feed\\?story=i${fresh}`));
  assert.doesNotMatch(out.content, /Old news about chips/, 'older than 24 h');
  assert.equal(taintOf(r.id).level, 'low', 'publishers wrote these: the run read outside content');
  const cooking = await getTool('feed_stories').run({ topic: 'cooking', hours: 48 }, ctx);
  assert.match(cooking.content, /^1 story ranked for them in cooking/);
  assert.match(cooking.content, /Harissa soup/);
  const found = await getTool('feed_stories').run({ query: 'chips' }, ctx);
  assert.match(found.content, /Old news about chips/, 'a search looks back a week');
  assert.match(text(await getTool('feed_stories').run({ query: 'volcano' }, ctx)), /^No stories matching “volcano”/);
  await assert.rejects(async () => getTool('feed_stories').run({ topic: 'Gardening' }, ctx), /no topic “Gardening” .*AI, Cooking/);
  assert.equal(F.storiesFor(u, { limit: 1 }).length, 1);
  // The story link: one card on /feed (page data), and nothing for someone who doesn't follow it.
  const page = F.feedData(u, F.feedFilters({ story: `i${soup}` }));
  assert.equal(page.mode, 'story');
  assert.equal(page.home, false);
  assert.equal(page.sections[0].posts[0].title, 'Harissa soup for cold evenings');
  assert.equal(F.feedData(carol, F.feedFilters({ story: `i${soup}` })).count, 0);
  assert.equal(F.feedFilters({ story: '../etc' }).story, null);
  tokens.storyUser = createSession(u.id, { kind: 'app', device: 'test' });
  const res = await fetch(`${base}/feed?story=i${soup}`, { headers: { Authorization: `Bearer ${tokens.storyUser}` } });
  assert.equal(res.status, 200, 'the page renders with a story filter');
  assert.match(await res.text(), /Harissa soup for cold evenings/);
});

test('feed_mute and feed_follow from chat: exactly one thing to mute, topics by name; following checks and files a site', async () => {
  const u = await person();
  const ctx = ctxOf(u);
  feedFor(u, ['World', 'Tech']);
  assert.match(text(await getTool('feed_mute').run({ word: 'football' }, ctx)), /Muted: stories with the word “football” won't show/);
  assert.match(text(await getTool('feed_mute').run({ topic: 'tech' }, ctx)), /Muted: the topic Tech/);
  assert.match(text(await getTool('feed_mute').run({ source: 'Daily Planet' }, ctx)), /stories from Daily Planet/);
  assert.match(text(await getTool('feed_mute').run({ word: 'football', undo: true }, ctx)), /Unmuted/);
  await assert.rejects(async () => getTool('feed_mute').run({ word: 'a', source: 'b' }, ctx), /exactly one/);
  await assert.rejects(async () => getTool('feed_mute').run({ topic: 'Gardening' }, ctx), /no Feed topic “Gardening”.*World, Tech/);
  const list = F.mutesList(u);
  assert.deepEqual([list.topics, list.sources, list.words].map(l => l.map(x => x.value)), [['Tech'], ['Daily Planet'], []]);
  // Follow: which topic (two exist), validation like the Sources page, then a real add (no network: the site's search
  // source was checked minutes ago, so it isn't fetched again, and a private address is never opened).
  await assert.rejects(async () => getTool('feed_follow').run({ site: 'theverge.com' }, ctx), /Which topic.*World, Tech/);
  await assert.rejects(async () => getTool('feed_follow').run({ topic: 'Tech' }, ctx), /Give the site/);
  await assert.rejects(async () => getTool('feed_follow').run({ site: 'not a web address', topic: 'Tech' }, ctx), err => /web address/.test(reasons(err)));
  const tech = F.prefsOf(u).topics.find(t => t.key === 'tech');
  const search = F.ensureSource(F.gnewsUrl(`site:127.0.0.1 ${tech.query}`, u), { kind: 'gnews', title: '127.0.0.1' });
  run('UPDATE feed_sources SET fetched_at = ?, next_fetch_at = ? WHERE id = ?', new Date().toISOString(), FAR, search.id);
  const added = await getTool('feed_follow').run({ url: 'http://127.0.0.1/blog', topic: 'Tech' }, ctx);
  assert.match(added.content, /127\.0\.0\.1 has no feed, so it is followed through Google News in Tech\./);
  assert.ok(get(`SELECT 1 FROM feed_subscriptions WHERE user_id = ? AND source_id = ? AND topic_key = 'tech' AND origin = 'manual'`, u.id, search.id));
});

test('OPML import: folders become topics (feeds only, no search), dupes and bad links skipped, caps; export round-trips', async () => {
  const u = await person();
  const opml = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'p22k-feeds.opml'), 'utf8');
  const out = S.importOpml(u, opml);
  assert.deepEqual(out.topics.map(t => [t.label, t.created]), [['Tech', true], ['Cuisine', true], ['My reader', true]]);
  assert.deepEqual(out.added.map(a => [a.title, a.topic]), [['The Verge', 'Tech'], ['Ars Technica', 'Tech'], ['Hacker News', 'Tech'],
    ['Délices', 'Cuisine'], ['مطبخ', 'Cuisine'], ['Loose blog', 'My reader']]);
  assert.deepEqual(out.skipped.map(s => s.reason).sort(), ['duplicate', 'invalid', 'invalid']);
  const tech = S.topicsWithSources(u).find(t => t.label === 'Tech');
  assert.equal(tech.sources.length, 3, 'only its own feeds: no Google News search was added');
  assert.ok(tech.sources.every(s => s.mine && s.kind === 'rss'));
  assert.equal(get(`SELECT next_fetch_at FROM feed_sources WHERE url = 'https://www.theverge.com/rss/index.xml'`).next_fetch_at, null, 'due at once: the feed tick fetches it');
  // Editing the topic later (its time of day) doesn't bring a search back: it started out removed. (New search words would
  // add one, as for any topic: that is asking for a search.)
  S.editTopic(u, tech.key, { label: 'Tech', query: tech.query, when: 'morning' });
  assert.equal(S.topicsWithSources(u).find(t => t.label === 'Tech').sources.length, 3);
  // Again: everything is already there.
  const again = S.importOpml(u, opml);
  assert.equal(again.added.length, 0);
  assert.equal(again.skipped.filter(s => s.reason === 'already').length, 6);
  assert.deepEqual(again.topics.map(t => t.created), [false, false, false]);
  // Into one named topic, with the per-topic cap.
  const v = await person();
  const many = `<?xml version="1.0"?><opml version="2.0"><body>${Array.from({ length: 12 }, (_, i) => `<outline type="rss" text="F${i}" xmlUrl="https://f${i}.test/rss"/>`).join('')}</body></opml>`;
  const capped = S.importOpml(v, many, { topic: 'Blogs' });
  assert.equal(capped.added.length, S.MAX_SOURCES_PER_TOPIC);
  assert.deepEqual(capped.skipped.map(s => s.reason), ['full', 'full']);
  throwsWith(() => S.importOpml(v, 'not xml at all'), /isn’t an OPML feed list/);
  throwsWith(() => S.importOpml(v, '<?xml version="1.0"?><opml version="2.0"><body><outline text="Empty folder"/></body></opml>'), /no feeds/);
  // Export → import into someone else: the same topics and feeds.
  const exported = S.exportOpml(u);
  assert.match(exported, /<title>Pat\d+’s feeds \(Jessbot\)<\/title>/);
  assert.match(exported, /<outline text="Cuisine" title="Cuisine">/);
  const w = await person();
  const round = S.importOpml(w, exported);
  assert.deepEqual(round.topics.map(t => t.label), ['Tech', 'Cuisine', 'My reader']);
  assert.deepEqual(round.added.map(a => a.url).sort(), out.added.map(a => a.url).sort());
});

test('OPML, mutes, diet and stories over the API (additive routes; each person only sees their own)', async () => {
  const u = await person();
  tokens.feedUser = createSession(u.id, { kind: 'app', device: 'test' });
  const opml = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'p22k-feeds.opml'), 'utf8');
  assert.equal((await api('feedUser', 'POST', '/feed/opml', { opml: '' })).status, 422);
  const imp = await api('feedUser', 'POST', '/feed/opml', { opml, topic: 'Imported' });
  assert.equal(imp.status, 201);
  assert.match(imp.json.message, /^Added 6 feeds, skipped 3\. New stories arrive with the next check\.$/);
  const res = await fetch(`${base}/api/v1/feed/opml`, { headers: { Authorization: `Bearer ${tokens.feedUser}` } });
  assert.match(res.headers.get('content-type'), /text\/x-opml/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="jessbot-feeds\.opml"/);
  assert.match(await res.text(), /<outline text="Imported" title="Imported">/);
  const m = await api('feedUser', 'POST', '/feed/mutes', { kind: 'word', value: 'crypto' });
  assert.equal(m.status, 201);
  assert.deepEqual(m.json.mutes.words.map(x => x.value), ['crypto']);
  assert.equal((await api('feedUser', 'POST', '/feed/mutes', { kind: 'word', value: '' })).status, 422);
  assert.deepEqual((await api('carol', 'GET', '/feed/mutes')).json.words, []);
  assert.deepEqual((await api('feedUser', 'DELETE', '/feed/mutes', { kind: 'word', value: 'CRYPTO' })).json.mutes.words, []);
  const diet = await api('feedUser', 'GET', '/feed/diet?days=30');
  assert.equal(diet.json.diet.enough, false);
  assert.deepEqual((await api('feedUser', 'GET', '/feed/stories?limit=3')).json.stories, []);
});

test('reading diet: topics and sources actually read, variety, and one suggestion', async () => {
  const u = await person();
  feedFor(u, ['AI', 'Cooking', 'Chess']);
  const ai = source('https://diet-ai.test/rss', 'AI Weekly');
  const food = source('https://diet-food.test/rss', 'Food Mag');
  const chess = source('https://diet-chess.test/rss', 'Chess News');
  follow(u, ai, 'AI'); follow(u, food, 'Cooking'); follow(u, chess, 'Chess');
  const read = (s, title, kinds, secs = 0) => {
    const id = item(s, title, { name: s.title, host: new URL(s.url).hostname });
    for (const k of kinds) recordEvent(u.id, F.itemById(id), k, { value: k === 'read' ? secs : 0 });
  };
  assert.equal(readingDiet(u).suggestion.kind, 'start');
  for (let i = 0; i < 6; i++) read(ai, `AI story ${i}`, ['open', 'read'], 120);
  read(food, 'Soup', ['open', 'like']);
  read(food, 'Bread', ['impression']); // seen, not read: doesn't count
  const d = readingDiet(u);
  assert.equal(d.enough, true);
  assert.equal(d.stories, 7);
  assert.equal(d.minutes, 12);
  assert.equal(d.liked, 1);
  assert.deepEqual(d.topics.map(t => [t.label, t.count, t.share]), [['AI', 6, 86], ['Cooking', 1, 14]]);
  assert.equal(d.sources[0].name, 'AI Weekly');
  assert.equal(d.variety.topics, 2);
  assert.equal(d.variety.label, 'narrow');
  assert.deepEqual([d.suggestion.kind, d.suggestion.topic], ['unread_topic', 'Chess'], 'a followed topic they never open comes first');
  assert.match(d.suggestion.text, /^You follow Chess but didn’t open any of its stories this month\. Keep it, or pause it\?$/);
  F.savePrefs(u, { prompt: '', topics: F.prefsOf(u).topics.filter(t => t.label !== 'Chess') });
  const d2 = readingDiet(u);
  assert.equal(d2.suggestion.kind, 'one_source');
  assert.match(d2.suggestion.text, /^86% of what you read came from AI Weekly\./);
  assert.ok([d.suggestion.text, d2.suggestion.text].every(t => !t.includes('—')));
  // Old events fall out of the window.
  assert.equal(readingDiet(u, { now: new Date(Date.now() + 40 * 864e5) }).stories, 0);
});

test('a reminder with follow-ups counts as persistent (it asks first after outside content, like a repeat)', async () => {
  const { persistentOf } = await import('../src/services/policy.js');
  const tool = getTool('set_reminder');
  assert.equal(persistentOf(tool, { text: 'x', in_minutes: 5 }), false);
  assert.equal(persistentOf(tool, { text: 'x', in_minutes: 5, follow_up: {} }), true);
  assert.equal(persistentOf(tool, { text: 'x', time: '09:00', repeat: 'daily' }), true);
  assert.equal(getTool('feed_follow').toolset, 'web', 'following a site reaches the internet: off when web is off');
  assert.equal(getTool('feed_stories').risk, 'read');
});
