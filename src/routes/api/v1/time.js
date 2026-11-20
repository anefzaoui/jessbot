// Alarms, reminders, timers, scheduled tasks, check-in preference and devices (Phase 7a, decisions #32/#48).
// The Android app uses GET /alarms to schedule alarms locally and POST …/snooze|dismiss to keep every device in sync.
import { Router } from 'express';
import * as alarms from '../../../services/alarms.js';
import * as schedules from '../../../services/schedules.js';
import { registerDevice, removeDevice, devicesOf, deviceView } from '../../../services/notify.js';
import { vapidKeys, pushTo } from '../../../services/push.js';
import { pokeScheduler, runScheduleNow, syncCheckins } from '../../../agent/proactive.js';
import { requestConsent } from '../../../agent/reminders.js';
import { getUser } from '../../../services/users.js';
import { run } from '../../../db/index.js';
import { invalid, badRequest, tooMany } from '../../../lib/errors.js';
import { hit } from '../../../lib/ratelimit.js';
import { notesFor } from '../../../services/notes.js';
import { botName } from '../../../services/bot.js';

const router = Router();
const view = a => alarms.alarmView(a);

router.get('/alarms', (req, res) => res.json({ alarms: alarms.listAlarms(req.user, { live: req.query.all !== '1' }).map(view) }));

// followUp (reminders, #190): { everyMin, max, until: "HH:MM" | minutes, escalateTo: user id of a household member }.
router.post('/alarms', async (req, res) => {
  const b = req.body || {};
  const f = b.followUp && typeof b.followUp === 'object' ? b.followUp : null;
  const a = alarms.createAlarm({ user: req.user, kind: b.kind, label: b.label, at: b.at, time: b.time, inMinutes: b.inMinutes,
    durationSec: b.durationSec, repeat: b.repeat, createdBy: 'user',
    followUp: f && { everyMin: f.everyMin, max: f.max, until: f.until, escalateTo: f.escalateTo ?? null } });
  pokeScheduler();
  if (a.escalate_to) await requestConsent(req.user, getUser(a.escalate_to)); // asked once, in their own chat (#191)
  res.status(201).json({ alarm: view(alarms.getAlarm(a.id)) });
});

router.post('/alarms/:id/snooze', (req, res) => {
  const a = alarms.alarmForUser(req.user, req.params.id);
  const out = alarms.snoozeAlarm(a, req.body?.minutes);
  pokeScheduler();
  res.json({ alarm: view(out) });
});

router.post('/alarms/:id/dismiss', (req, res) => {
  const a = alarms.alarmForUser(req.user, req.params.id);
  const out = ['ringing', 'snoozed'].includes(a.status) || a.repeat_cron ? alarms.dismissAlarm(a) : alarms.cancelAlarm(a);
  pokeScheduler();
  res.json({ alarm: view(out) });
});

// A reminder's Done (decision #190): closes the occurrence it's on (its follow-ups stop; a repeating one moves on). Marking it
// done before it fired counts too. Answering an already-closed one is harmless: it returns the reminder as it is.
router.post('/alarms/:id/done', (req, res) => {
  const out = alarms.closeReminder(alarms.alarmForUser(req.user, req.params.id), 'card');
  pokeScheduler();
  res.json({ alarm: view(out) });
});

// Escalation consent (#191): requests the person was asked (they answer) and the ones they made.
router.get('/alarms/consents', (req, res) => res.json(alarms.consentsFor(req.user)));
router.post('/alarms/consents/:id', (req, res) => {
  if (typeof req.body?.allow !== 'boolean') throw invalid({ allow: 'Say yes (true) or no (false).' });
  const c = alarms.answerConsent(req.user, req.params.id, req.body.allow);
  res.json({ consent: alarms.consentsFor(req.user).asked.find(x => x.id === c.id) });
});

router.post('/alarms/:id/cancel', (req, res) => {
  const out = alarms.cancelAlarm(alarms.alarmForUser(req.user, req.params.id));
  pokeScheduler();
  res.json({ alarm: view(out) });
});

router.get('/schedules', (req, res) => res.json({ schedules: schedules.listSchedules(req.user).map(s => schedules.jobView(s)) }));

router.post('/schedules/:id/:action', async (req, res) => {
  const s = schedules.scheduleForUser(req.user, req.params.id);
  const action = req.params.action;
  if (action === 'pause' || action === 'resume') {
    const out = schedules.pauseSchedule(s, action === 'pause');
    pokeScheduler();
    return res.json({ schedule: schedules.jobView(out) });
  }
  if (action === 'run') {
    const r = await runScheduleNow(s);
    return res.json({ ok: true, runId: r.id, threadId: r.thread_id });
  }
  if (action === 'delete') {
    if (s.kind !== 'task') throw invalid({ id: 'Check-ins are changed with your check-in setting.' });
    schedules.deleteSchedule(s);
    pokeScheduler();
    return res.json({ ok: true });
  }
  throw invalid({ action: 'Unknown action.' });
});

// Check-ins: off | light (once a day) | normal (three times a day).
router.put('/me/checkins', (req, res) => {
  const value = req.body?.checkins;
  if (!['off', 'light', 'normal'].includes(value)) throw invalid({ checkins: 'Choose off, light or normal.' });
  run('UPDATE users SET checkins = ? WHERE id = ?', value, req.user.id);
  syncCheckins(getUser(req.user.id));
  pokeScheduler();
  res.json({ ok: true, checkins: value });
});

// Notes for later (#200): what unattended work left for the next check-in, and the last few delivered.
router.get('/me/notes', (req, res) => res.json(notesFor(req.user)));

router.get('/devices', (req, res) => res.json({ devices: devicesOf(req.user.id).map(deviceView) }));
router.post('/devices', (req, res) => {
  const b = req.body || {};
  const d = registerDevice({ userId: req.user.id, sessionId: req.session?.id || null, platform: b.platform, name: b.name, pushKind: b.pushKind, pushToken: b.pushToken });
  res.status(201).json({ device: deviceView(d) });
});
router.delete('/devices/:id', (req, res) => res.json({ ok: removeDevice(req.user.id, Number(req.params.id)) }));

// Web Push (decision #85): the key a browser subscribes with, and a test notification to every device of this person.
router.get('/push/key', (req, res) => res.json({ publicKey: vapidKeys().publicKey }));
router.post('/push/test', async (req, res) => {
  const l = hit(`pushtest:${req.user.id}`, { limit: 5, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany('Enough tests for now — try again in a few minutes.');
  const devices = devicesOf(req.user.id).filter(d => d.push_token);
  if (!devices.length) throw badRequest('No device is set up for notifications yet.');
  const results = await Promise.all(devices.map(d => pushTo(d, { kind: 'message', title: `Test from ${botName()}`, body: 'Notifications reach this device.', href: '/me/notifications', tag: 'push-test' })));
  res.json({ sent: results.filter(r => r === 'sent').length, gone: results.filter(r => r === 'gone').length, failed: results.filter(r => r === 'failed').length });
});

export default router;
