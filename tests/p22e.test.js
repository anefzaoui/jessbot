// Phase 22 part E (decisions #157–#160): email attachments in and out of the Library, tidying mail and finding the
// unsubscribe link, free time worked out in code, household busy sharing (consent, times only, audited), calendar files.
// Run: npm test. Mail and CalDAV run against real protocol servers when tools/test-servers has them (GreenMail: IMAP/SMTP,
// Radicale: CalDAV), started here on free local ports and stopped after; those tests are skipped (not failed) without them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { listen } from './helpers/listen.js';
import { spawnHelper, stopAllHelpers } from './helpers/procs.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jessbot-unit-'));
process.env.JESSBOT_HOME = HOME;
process.env.JESSBOT_ENV_FILE = path.join(HOME, '.env'); // keys the code makes (secrets, VAPID) never land in the real .env
process.env.JESSBOT_EMBED_OFF = '1'; // no embedding calls from unit tests
process.env.JESSBOT_DECIDE_OFF = '1'; // no decision-model calls either: every use takes its fallback

const { openDb, closeDb, run, get, all, settings } = await import('../src/db/index.js');
const { ensureDirs } = await import('../src/config/index.js');
ensureDirs();
await openDb();

const { default: ICAL } = await import('ical.js');
const { default: nodemailer } = await import('nodemailer');
const { ImapFlow } = await import('imapflow');
const { simpleParser } = await import('mailparser');
const { default: PizZip } = await import('pizzip');
const { default: express } = await import('express');
const { createUser, updateProfile, getUser } = await import('../src/services/users.js');
const { createGroup, addMember } = await import('../src/services/groups.js');
const { getTool } = await import('../src/agent/tools/registry.js');
await import('../src/agent/tools/index.js');
const { mainThread } = await import('../src/services/threads.js');
const { createRun } = await import('../src/services/runs.js');
const conns = await import('../src/services/connections.js');
const cal = await import('../src/services/calendar.js');
const mail = await import('../src/services/mail.js');
const files = await import('../src/services/mail-files.js');
const lib = await import('../src/services/library.js');
const T = await import('../src/agent/taint.js');
const { createApproval } = await import('../src/services/approvals.js');
const { assess } = await import('../src/services/policy.js');
const { registerSecret } = await import('../src/lib/dlp.js');
const { mailText } = await import('../src/agent/tools/email.js');

const reasons = err => (err.errors ? Object.values(err.errors).join(' ') : err.message);
const rejects = (p, re) => assert.rejects(p, err => { assert.match(reasons(err), re); return true; });
const throwsWith = (fn, re) => assert.throws(fn, err => { assert.match(reasons(err), re); return true; });
const fx = name => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const iso = s => new Date(s).toISOString();
const slotStrings = slots => slots.map(s => `${s.start.toISOString().slice(0, 16)}/${s.end.toISOString().slice(0, 16)}`);

// ---- Test servers (GreenMail, Radicale) on free ports -------------------------------------------------------------------
const TS = path.join(import.meta.dirname, '..', 'tools', 'test-servers');
const JAR = path.join(TS, 'greenmail-standalone.jar');
const RAD_PY = path.join(TS, 'radicale-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const haveMail = fs.existsSync(JAR);
const haveCal = fs.existsSync(RAD_PY);
const freePort = async () => { const s = await listen(net.createServer()); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const waitPort = async (port, ms = 40000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    if (await new Promise(r => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })) return;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`port ${port} never opened`);
};
let SMTP, IMAP, RAD;
async function startMail() {
  [SMTP, IMAP] = [await freePort(), await freePort()];
  spawnHelper('java', [`-Dgreenmail.smtp.hostname=127.0.0.1`, `-Dgreenmail.smtp.port=${SMTP}`, `-Dgreenmail.imap.hostname=127.0.0.1`, `-Dgreenmail.imap.port=${IMAP}`,
    '-Dgreenmail.users=owner:secret@local.test,sam:secret@local.test', '-Dgreenmail.users.login=email', '-Dgreenmail.api.enabled=false', '-jar', JAR]);
  await waitPort(SMTP); await waitPort(IMAP);
}
async function startCal() {
  RAD = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-rad-'));
  fs.writeFileSync(path.join(dir, 'users'), 'owner:secret\n');
  fs.writeFileSync(path.join(dir, 'config'), `[server]\nhosts = 127.0.0.1:${RAD}\n[auth]\ntype = htpasswd\nhtpasswd_filename = ${path.join(dir, 'users')}\n`
    + `htpasswd_encryption = plain\n[storage]\nfilesystem_folder = ${path.join(dir, 'col')}\n`);
  spawnHelper(RAD_PY, ['-m', 'radicale', '--config', path.join(dir, 'config')]);
  await waitPort(RAD);
}
const imapAs = async user => { const c = new ImapFlow({ host: '127.0.0.1', port: IMAP, secure: false, auth: { user, pass: 'secret' }, logger: false }); await c.connect(); return c; };
const smtpAs = user => nodemailer.createTransport({ host: '127.0.0.1', port: SMTP, secure: false, auth: { user, pass: 'secret' } });

let ann, bob, cy, dee, family, thread;
const newRun = () => createRun({ threadId: thread.id, userId: ann.id, triggerMessageId: null, model: 'x' });
const ctxFor = r => ({ user: ann, thread, run: r, toolCallId: 'call-1' });
before(async () => {
  ann = await createUser({ name: 'Ann Owner', email: 'ann@t.dev', password: 'correct horse battery', role: 'admin', timezone: 'UTC' });
  bob = await createUser({ name: 'Bob Member', email: 'bob@t.dev', password: 'correct horse battery', timezone: 'UTC' });
  cy = await createUser({ name: 'Cy Outsider', email: 'cy@t.dev', password: 'correct horse battery', timezone: 'UTC' });
  dee = await createUser({ name: 'Dee Member', email: 'dee@t.dev', password: 'correct horse battery', timezone: 'UTC' });
  family = createGroup({ name: 'Family' });
  for (const u of [ann, bob, dee]) addMember(family.id, u.id);
  thread = mainThread(ann.id);
  settings.set('browser', { allowPrivate: true }); // the test servers run on this machine (the admin's "local network" switch)
  await Promise.all([haveMail ? startMail() : null, haveCal ? startCal() : null]);
});
after(async () => {
  await stopAllHelpers(); // GreenMail and Radicale, with whatever their launchers started (fails if anything is left)
  closeDb();
  fs.rmSync(HOME, { recursive: true, force: true });
});

// ---- Free time -------------------------------------------------------------------------------------------------------------
test('free slots: overlapping and touching events merge; gaps shorter than the minimum are left out; no events = all free', () => {
  const ev = (s, e, extra = {}) => ({ starts_at: iso(s), ends_at: e ? iso(e) : null, all_day: 0, ...extra });
  const day = ['2026-10-06T08:00Z', '2026-10-06T18:00Z'].map(d => new Date(d));
  const events = [ev('2026-10-06T09:00Z', '2026-10-06T10:00Z'), ev('2026-10-06T09:30Z', '2026-10-06T11:00Z'), ev('2026-10-06T11:00Z', '2026-10-06T12:00Z'),
    ev('2026-10-06T12:20Z', '2026-10-06T13:00Z'), ev('2026-10-06T15:00Z', null) /* no end: takes no time */];
  assert.deepEqual(slotStrings(cal.freeSlotsBetween(events, ...day, { minMinutes: 30 })),
    ['2026-10-06T08:00/2026-10-06T09:00', '2026-10-06T13:00/2026-10-06T18:00'], 'the 20-minute gap at 12:00 is too short');
  assert.deepEqual(slotStrings(cal.freeSlotsBetween(events, ...day, { minMinutes: 15 })),
    ['2026-10-06T08:00/2026-10-06T09:00', '2026-10-06T12:00/2026-10-06T12:20', '2026-10-06T13:00/2026-10-06T18:00']);
  assert.deepEqual(slotStrings(cal.freeSlotsBetween([], ...day)), ['2026-10-06T08:00/2026-10-06T18:00']);
  assert.equal(cal.freeSlotsBetween([], day[1], day[0]).length, 0, 'a backwards range has no slots');
  // An event running past both ends of the range blocks all of it.
  assert.equal(cal.freeSlotsBetween([ev('2026-10-05T00:00Z', '2026-10-07T00:00Z')], ...day).length, 0);
  const s = cal.freeSlotsBetween(events, ...day, { minMinutes: 30 })[1];
  assert.equal(s.minutes, 300);
});

test('free slots: all-day events block their day unless marked free; cancelled/free events never count; buffer keeps room around events', () => {
  const range = ['2026-10-05T00:00Z', '2026-10-08T00:00Z'].map(d => new Date(d));
  const allDay = { starts_at: iso('2026-10-06T00:00Z'), ends_at: iso('2026-10-07T00:00Z'), all_day: 1 };
  assert.deepEqual(slotStrings(cal.freeSlotsBetween([allDay], ...range)), ['2026-10-05T00:00/2026-10-06T00:00', '2026-10-07T00:00/2026-10-08T00:00']);
  assert.deepEqual(slotStrings(cal.freeSlotsBetween([{ ...allDay, busy: 0 }], ...range)), ['2026-10-05T00:00/2026-10-08T00:00'], 'a birthday marked free');
  assert.deepEqual(slotStrings(cal.freeSlotsBetween([{ ...allDay, ends_at: null }], ...range)), ['2026-10-05T00:00/2026-10-06T00:00', '2026-10-07T00:00/2026-10-08T00:00'],
    'an all-day event with no end takes its day');
  // In the person's zone: an all-day event there (stored as their local midnight) blocks their local day.
  const tokyoDay = { starts_at: iso('2026-10-05T15:00Z'), ends_at: null, all_day: 1 };
  assert.deepEqual(slotStrings(cal.freeSlotsBetween([tokyoDay], new Date('2026-10-05T12:00Z'), new Date('2026-10-06T18:00Z'), { tz: 'Asia/Tokyo' })),
    ['2026-10-05T12:00/2026-10-05T15:00', '2026-10-06T15:00/2026-10-06T18:00']);
  const meeting = { starts_at: iso('2026-10-06T10:00Z'), ends_at: iso('2026-10-06T11:00Z'), all_day: 0 };
  const win = ['2026-10-06T09:00Z', '2026-10-06T12:00Z'].map(d => new Date(d));
  assert.deepEqual(slotStrings(cal.freeSlotsBetween([meeting], ...win, { buffer: 15 })), ['2026-10-06T09:00/2026-10-06T09:45', '2026-10-06T11:15/2026-10-06T12:00']);
  assert.deepEqual(slotStrings(cal.freeSlotsBetween([meeting, { ...meeting, starts_at: iso('2026-10-06T11:20Z'), ends_at: iso('2026-10-06T11:40Z') }], ...win,
    { buffer: 15, minMinutes: 10 })), ['2026-10-06T09:00/2026-10-06T09:45'], 'buffers merge the two events');
});

test('free slots: a daily window (also past midnight) and chosen days, in the person’s zone', () => {
  const week = ['2026-10-02T00:00Z', '2026-10-06T00:00Z'].map(d => new Date(d)); // Fri 2 → Mon 5 Oct
  const out = cal.freeSlotsBetween([], ...week, { within: '09:00-17:30', days: ['weekdays'] });
  assert.deepEqual(slotStrings(out), ['2026-10-02T09:00/2026-10-02T17:30', '2026-10-05T09:00/2026-10-05T17:30'], 'the weekend is left out');
  const paris = cal.freeSlotsBetween([], ...week, { within: '09:00-10:00', days: ['sat'], tz: 'Europe/Paris' });
  assert.deepEqual(slotStrings(paris), ['2026-10-03T07:00/2026-10-03T08:00'], '09:00 in Paris (summer time) is 07:00 UTC');
  const nights = cal.freeSlotsBetween([], new Date('2026-10-02T12:00Z'), new Date('2026-10-04T12:00Z'), { within: '22:00-02:00' });
  assert.deepEqual(slotStrings(nights), ['2026-10-02T22:00/2026-10-03T02:00', '2026-10-03T22:00/2026-10-04T02:00']);
  const early = cal.freeSlotsBetween([], new Date('2026-10-03T01:00Z'), new Date('2026-10-03T12:00Z'), { within: '22:00-02:00' });
  assert.deepEqual(slotStrings(early), ['2026-10-03T01:00/2026-10-03T02:00'], 'last night’s window reaches into the range');
  assert.equal(cal.freeSlotsBetween([], ...week, { within: '00:00-24:00' }).reduce((n, s) => n + s.minutes, 0), 4 * 1440);
  throwsWith(() => cal.parseWithin('9-5'), /HH:MM-HH:MM/);
  throwsWith(() => cal.parseWithin('09:00-09:00'), /HH:MM-HH:MM/);
  throwsWith(() => cal.dayKeys(['someday']), /day of the week/);
  assert.deepEqual([...cal.dayKeys(['Tuesday', 'weekends'])].sort(), ['sat', 'sun', 'tue']);
});

test('free slots: clock-change days follow the wall clock (a 23-hour and a 25-hour day in Paris)', () => {
  const tz = 'Europe/Paris';
  const spring = cal.freeSlotsBetween([], cal.parseWhen('2026-03-29', tz), cal.parseWhen('2026-03-30', tz), { within: '00:00-24:00', tz });
  assert.equal(spring.length, 1);
  assert.equal(spring[0].minutes, 23 * 60, 'the spring-forward day has 23 hours');
  const work = cal.freeSlotsBetween([], cal.parseWhen('2026-03-29', tz), cal.parseWhen('2026-03-30', tz), { within: '09:00-17:00', tz });
  assert.deepEqual(slotStrings(work), ['2026-03-29T07:00/2026-03-29T15:00'], 'after the change Paris is UTC+2');
  const fall = cal.freeSlotsBetween([], cal.parseWhen('2026-10-25', tz), cal.parseWhen('2026-10-26', tz), { within: '00:00-24:00', tz });
  assert.equal(fall[0].minutes, 25 * 60, 'the fall-back day has 25 hours');
  // Times on both sides of the change read right (the offset in force at that time, not at a first guess).
  assert.equal(cal.parseWhen('2026-03-29T01:30', tz).toISOString(), '2026-03-29T00:30:00.000Z');
  assert.equal(cal.parseWhen('2026-03-29T03:30', tz).toISOString(), '2026-03-29T01:30:00.000Z');
  assert.equal(cal.parseWhen('2026-10-25T03:30', tz).toISOString(), '2026-10-25T02:30:00.000Z');
  assert.equal(cal.parseWhen('2026-02-30T10:00x', tz), null);
  assert.equal(cal.parseWhen('2026-10-02T10:00+01:00', tz).toISOString(), '2026-10-02T09:00:00.000Z');
});

test('calendar events: marked free or cancelled don’t take up time; a file with many events expands each one', () => {
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:bday@t', 'DTSTART;VALUE=DATE:20261006', 'DTEND;VALUE=DATE:20261007', 'SUMMARY:Sam’s birthday', 'TRANSP:TRANSPARENT', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:off@t', 'DTSTART:20261006T090000Z', 'DTEND:20261006T100000Z', 'SUMMARY:Cancelled call', 'STATUS:CANCELLED', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:dentist@t', 'DTSTART:20261006T140000Z', 'DTEND:20261006T150000Z', 'SUMMARY:Dentist', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const occ = cal.occurrences(ics, new Date('2026-10-05Z'), new Date('2026-10-08Z'), 'UTC');
  assert.deepEqual(occ.map(o => [o.title, o.busy]), [['Sam’s birthday', 0], ['Cancelled call', 0], ['Dentist', 1]]);
  assert.deepEqual(slotStrings(cal.freeSlotsBetween(occ, new Date('2026-10-06T08:00Z'), new Date('2026-10-06T16:00Z'))),
    ['2026-10-06T08:00/2026-10-06T14:00', '2026-10-06T15:00/2026-10-06T16:00']);
});

// ---- Household busy sharing -----------------------------------------------------------------------------------------------
test('busy sharing: consent is off by default, set through the profile (audited); only household members who said yes are counted, times only', async () => {
  assert.equal(getUser(bob.id).shareBusy, false);
  const calConn = user => conns.saveConnection(user, 'calendar', conns.readForm('calendar', { provider: 'custom', url: 'http://127.0.0.1:9/', username: 'x', password: 'x' }));
  const addEvent = (c, user, uid, title, s, e) => run(`INSERT INTO calendar_events (connection_id, user_id, calendar_url, calendar_name, uid, title, location, starts_at, ends_at, all_day, busy)
    VALUES (?, ?, 'u', 'Home', ?, ?, 'Clinic Street 4', ?, ?, 0, 1)`, c.id, user.id, uid, title, iso(s), iso(e));
  const [ca, cb, cc] = [calConn(ann), calConn(bob), calConn(cy)];
  addEvent(ca, ann, 'a1', 'Ann gym', '2026-10-06T09:00Z', '2026-10-06T10:00Z');
  addEvent(cb, bob, 'b1', 'Secret surgery', '2026-10-06T11:00Z', '2026-10-06T13:00Z');
  addEvent(cc, cy, 'c1', 'Cy dinner', '2026-10-06T14:00Z', '2026-10-06T15:00Z');
  const from = new Date('2026-10-06T08:00Z'), to = new Date('2026-10-06T16:00Z');
  assert.deepEqual(cal.sharedBusyBlocks(ann, getUser(bob.id), from, to), { status: 'not_shared' });
  const before = get(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'calendar.busy_lookup'`).n;
  assert.equal(before, 0, 'a refused lookup is not a lookup');

  updateProfile(bob.id, { shareBusy: true });
  updateProfile(cy.id, { shareBusy: 'true' });
  assert.equal(getUser(bob.id).shareBusy, true);
  assert.ok(get(`SELECT 1 FROM audit_log WHERE action = 'calendar.share_busy' AND actor_id = ? AND detail LIKE '%"on":true%'`, bob.id));
  const shared = cal.sharedBusyBlocks(ann, getUser(bob.id), from, to);
  assert.equal(shared.status, 'shared');
  assert.deepEqual(shared.blocks, [{ starts_at: iso('2026-10-06T11:00Z'), ends_at: iso('2026-10-06T13:00Z'), all_day: 0, busy: 1 }], 'times only');
  assert.deepEqual(cal.sharedBusyBlocks(ann, getUser(cy.id), from, to), { status: 'not_household' }, 'consent alone isn’t enough: Cy shares no group with Ann');
  assert.deepEqual(cal.sharedBusyBlocks(ann, getUser(dee.id), from, to), { status: 'not_shared' });
  const audits = all(`SELECT * FROM audit_log WHERE action = 'calendar.busy_lookup'`);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_id, ann.id);
  assert.equal(audits[0].target_id, String(bob.id));
  assert.deepEqual(Object.keys(JSON.parse(audits[0].detail)).sort(), ['blocks', 'from', 'to'], 'metadata only');

  // Through the tool: Bob's busy time counts, his event is never named; who isn't included is said plainly.
  const r = newRun();
  const outp = await getTool('calendar_free_slots').run({ from: '2026-10-06T08:00', to: '2026-10-06T16:00', duration: 45, people: ['Bob', 'Dee', 'Cy', 'Zed'] }, ctxFor(r));
  const text = outp.content;
  assert.match(text, /08:00–09:00/);
  assert.match(text, /10:00–11:00/);
  assert.match(text, /13:00–16:00/);
  assert.doesNotMatch(text, /11:00–13:00|Secret surgery|Clinic Street|Cy dinner/);
  assert.match(text, /Busy times counted: you, Bob\./);
  assert.match(text, /Dee isn’t included: hasn’t turned on sharing/);
  assert.match(text, /“Cy” isn’t anyone in your household/);
  assert.match(text, /“Zed” isn’t anyone in your household/);
  assert.equal(all(`SELECT * FROM audit_log WHERE action = 'calendar.busy_lookup'`).length, 2, 'the tool’s lookup of Bob was audited too');
  // Turning it off stops it at once.
  updateProfile(bob.id, { shareBusy: false });
  assert.deepEqual(cal.sharedBusyBlocks(ann, getUser(bob.id), from, to), { status: 'not_shared' });
  // Available to someone without a calendar of their own when a household member shares.
  assert.equal(getTool('calendar_free_slots').available(dee), false);
  updateProfile(bob.id, { shareBusy: true });
  assert.equal(getTool('calendar_free_slots').available(dee), true);
  await assert.rejects(getTool('calendar_free_slots').run({ from: '2026-10-06', to: '2026-12-30', duration: 30 }, ctxFor(r)), /60 days/);
});

test('calendar sync stores whether an event takes up time (Radicale: a free all-day event and a busy one)', { skip: !haveCal && 'Radicale not installed in tools/test-servers' }, async () => {
  const auth = { Authorization: `Basic ${Buffer.from('owner:secret').toString('base64')}` };
  const base = `http://127.0.0.1:${RAD}`;
  const mk = await fetch(`${base}/owner/home/`, { method: 'MKCALENDAR', headers: { ...auth, 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>Home</D:displayname></D:prop></D:set></C:mkcalendar>' });
  assert.ok(mk.status < 300, `MKCALENDAR ${mk.status}`);
  const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  const next = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  const put = (uid, lines) => fetch(`${base}/owner/home/${uid}.ics`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'text/calendar' },
    body: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') });
  assert.ok((await put('holiday', [`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`, 'SUMMARY:School holiday', 'TRANSP:TRANSPARENT'])).ok);
  assert.ok((await put('meeting', [`DTSTART:${day}T100000Z`, `DTEND:${day}T110000Z`, 'SUMMARY:Meeting'])).ok);
  const u = await createUser({ name: 'Radi Cal', email: 'radi@t.dev', password: 'correct horse battery', timezone: 'UTC' });
  const c = conns.saveConnection(u, 'calendar', conns.readForm('calendar', { provider: 'custom', url: `${base}/`, username: 'owner', password: 'secret' }));
  assert.equal(await cal.syncConnection(c, u), 2);
  const rows = all('SELECT title, busy FROM calendar_events WHERE user_id = ? ORDER BY title', u.id).map(r => [r.title, r.busy]);
  assert.deepEqual(rows, [['Meeting', 1], ['School holiday', 0]]);
  const d = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`;
  const slots = cal.freeSlotsBetween(cal.eventsBetween(u, new Date(`${d}T08:00Z`), new Date(`${d}T12:00Z`)), new Date(`${d}T08:00Z`), new Date(`${d}T12:00Z`));
  assert.deepEqual(slotStrings(slots), [`${d}T08:00/${d}T10:00`, `${d}T11:00/${d}T12:00`], 'the free holiday doesn’t block the day');
});

// ---- Calendar files --------------------------------------------------------------------------------------------------------
test('make_calendar_file: many events with time zones become one .ics in the Library (text/calendar) that reads back exactly', async () => {
  const r = newRun();
  const long = `Bring passports; tickets, and the charger. ${'مرحبا بكم في طوكيو '.repeat(12)}`;
  const out = await getTool('make_calendar_file').run({ title: 'Tokyo trip', events: [
    { title: 'Flight to Tokyo', start: '2026-11-02T10:00', end: '2026-11-02T14:00', time_zone: 'Asia/Tokyo', location: 'Haneda, Terminal 3' },
    { title: 'Hotel', start: '2026-11-02', end: '2026-11-05', location: 'Shinjuku; Tokyo' },
    { title: 'Tea ceremony', start: '2026-11-03T09:00', description: long },
  ] }, ctxFor(r));
  const id = /\/library\/([\w-]+)\)/.exec(out.content)[1];
  const item = lib.itemForUser(ann, id);
  assert.equal(item.ext, 'ics');
  assert.equal(item.mime, 'text/calendar; charset=utf-8');
  assert.match(out.content, /\[Add to calendar\]\(\/library\/[\w-]+\/download\)/);
  const ics = lib.readBytes(item).toString('utf8');
  assert.ok(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75), 'lines folded at 75 octets');
  assert.match(ics, /METHOD:PUBLISH/);
  const comp = new ICAL.Component(ICAL.parse(ics));
  assert.equal(comp.getFirstPropertyValue('x-wr-calname'), 'Tokyo trip');
  const evs = comp.getAllSubcomponents('vevent').map(v => new ICAL.Event(v));
  assert.equal(evs.length, 3);
  const [flight, hotel, tea] = evs;
  assert.equal(flight.startDate.toJSDate().toISOString(), '2026-11-02T01:00:00.000Z', '10:00 in Tokyo');
  assert.equal(flight.location, 'Haneda, Terminal 3');
  assert.ok(hotel.startDate.isDate);
  assert.equal(hotel.startDate.toString(), '2026-11-02');
  assert.equal(hotel.endDate.toString(), '2026-11-06', 'an all-day end date is the last day included');
  assert.equal(hotel.location, 'Shinjuku; Tokyo');
  assert.equal(tea.description, long, 'a long Arabic description folds and unfolds exactly');
  assert.equal(tea.endDate.toJSDate() - tea.startDate.toJSDate(), 3600e3, 'no end: one hour');
  assert.equal(new Set(evs.map(e => e.uid)).size, 3);
  assert.equal(cal.occurrences(ics, new Date('2026-11-01Z'), new Date('2026-11-10Z'), 'UTC').length, 3);
  // The Library page shows the events, search finds them; nothing is added to any calendar.
  assert.match(lib.renderedDoc(item), /Tea ceremony/);
  assert.ok(lib.listItems(ann, { query: 'ceremony' }).some(i => i.id === item.id));
  // The download is served as a calendar file (phones offer to add it).
  const { default: libraryRoutes } = await import('../src/routes/web/library.js');
  const app = express();
  app.use((req, _res, next) => { req.user = ann; next(); });
  app.use(libraryRoutes);
  const server = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/library/${id}/download`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/calendar/);
    assert.match(res.headers.get('content-disposition'), /tokyo-trip\.ics/);
    assert.equal(await res.text(), ics);
  } finally { server.close(); }
  // Mistakes are named, event by event.
  await rejects(getTool('make_calendar_file').run({ events: [{ title: 'X', start: '2026-11-02T10:00', time_zone: 'Mars/Olympus' }] }, ctxFor(r)), /Event 1: “Mars\/Olympus” isn’t a time zone/);
  await rejects(getTool('make_calendar_file').run({ events: [{ title: 'A', start: '2026-11-02' }, { title: 'B', start: '2026-11-02T10:00', end: '2026-11-02T09:00' }] }, ctxFor(r)),
    /Event 2 \(“B”\) ends before it starts/);
  await rejects(getTool('make_calendar_file').run({ events: [{ title: 'C', start: 'next tuesday' }] }, ctxFor(r)), /couldn’t read the start/);
  assert.equal(getTool('make_calendar_file').toolset, 'library', 'people without a calendar connection get it');
});

// ---- Email -------------------------------------------------------------------------------------------------------------------
test('unsubscribe headers: web and mail options, one-click only over https, other schemes dropped, folded lines read', () => {
  const u = mail.parseListUnsubscribe('<mailto:leave@news.test?subject=unsubscribe%20me>,\r\n <https://news.test/u?id=42>, <javascript:alert(1)>, <data:text/html,x>',
    'List-Unsubscribe=One-Click');
  assert.deepEqual(u.urls, ['https://news.test/u?id=42']);
  assert.deepEqual(u.mailto, [{ address: 'leave@news.test', subject: 'unsubscribe me', body: null }]);
  assert.equal(u.oneClick, true);
  assert.equal(mail.parseListUnsubscribe('<http://news.test/u>', 'List-Unsubscribe=One-Click').oneClick, false, 'one-click needs https');
  assert.deepEqual(mail.parseListUnsubscribe('', ''), { urls: [], mailto: [], oneClick: false });
  assert.equal(mail.looksLikeBin('Trash'), true);
  assert.equal(mail.looksLikeBin('[Gmail]/Spam'), true);
  assert.equal(mail.looksLikeBin('Receipts'), false);
  assert.deepEqual(files.chooseAttachments([{ index: 1, filename: 'a.pdf', inline: false }, { index: 2, filename: 'logo.png', inline: true }]).chosen.map(a => a.index), [1],
    'pictures inside the body are left out unless picked');
  assert.deepEqual(files.chooseAttachments([{ index: 1, filename: 'a.pdf' }], { names: ['A.PDF', 'b.doc'], indexes: [3] }), { chosen: [{ index: 1, filename: 'a.pdf' }], unknown: ['b.doc', '#3'] });
});

test('email (GreenMail): attachments are listed by number, saved to the Library filtered by what they really are, and not copied twice', { skip: !haveMail && 'GreenMail not installed in tools/test-servers' }, async () => {
  const c = conns.saveConnection(ann, 'email', conns.readForm('email', { provider: 'custom', label: 'Test mail', username: 'owner@local.test', password: 'secret',
    address: 'owner@local.test', imapHost: '127.0.0.1', imapPort: IMAP, imapSecure: false, smtpHost: '127.0.0.1', smtpPort: SMTP, smtpSecure: false }));
  const zip = new PizZip(); zip.file('a.txt', 'hello'); const zipBuf = zip.generate({ type: 'nodebuffer' });
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 1)]);
  await smtpAs('sam@local.test').sendMail({ from: 'Sam <sam@local.test>', to: 'owner@local.test', subject: 'Invoice 12 and photos', text: 'See attached.',
    html: '<p>See attached.</p><img src="cid:logo@sam">', attachments: [
      { filename: 'invoice.pdf', content: fx('sample.pdf') }, { filename: 'photo.png', content: PNG }, { filename: 'notes.txt', content: 'Pay by Friday.' },
      { filename: 'setup.exe', content: exe }, { filename: 'photos.zip', content: zipBuf }, { filename: 'invoice-copy.pdf', content: exe, contentType: 'application/pdf' },
      { filename: 'logo.png', content: PNG, cid: 'logo@sam' }] });
  const [m] = await mail.listMail(c, { subject: 'Invoice 12' });
  const read = await mail.readMail(c, m.uid);
  // Numbered in the order the message carries them (the body's pictures come with the body, first).
  assert.deepEqual(read.attachments.map(a => [a.index, a.filename, a.inline]), [[1, 'logo.png', true], [2, 'invoice.pdf', false], [3, 'photo.png', false],
    [4, 'notes.txt', false], [5, 'setup.exe', false], [6, 'photos.zip', false], [7, 'invoice-copy.pdf', false]]);
  const r = newRun();
  const shown = await mailText(ctxFor(r), c, read);
  assert.match(shown, /Attachments: logo\.png \(\d+ B\) \[1\] \(a picture inside the message\); invoice\.pdf \(\d+ KB\) \[2\]; photo\.png \(\d+ B\) \[3\]/);

  const out = await getTool('email_save_attachments').run({ uid: m.uid }, ctxFor(r));
  assert.match(out.content, /Saved 3 files from “Invoice 12 and photos”/);
  assert.match(out.content, /Not saved: setup\.exe \[5\]: a program/);
  assert.match(out.content, /Not saved: photos\.zip \[6\]: an archive/);
  assert.match(out.content, /Not saved: invoice-copy\.pdf \[7\]: a program or a file with macros \(named “invoice-copy\.pdf”, but it is really a \.exe file\)/);
  assert.doesNotMatch(out.content, /logo/);
  const saved = all(`SELECT * FROM library_items WHERE owner_id = ? AND source_label LIKE 'From email:%' ORDER BY id`, ann.id);
  assert.deepEqual(saved.map(i => [i.title, i.type, i.ext]), [['invoice', 'pdf', 'pdf'], ['photo', 'image', 'png'], ['notes', 'md', 'txt']]);
  assert.equal(saved[0].source_label, 'From email: “Invoice 12 and photos”');
  assert.equal(lib.originOf(saved[0]), 'email', 'the Library treats them as outside files (fenced when read, never regenerated over)');
  assert.ok(lib.isOutsideFile(saved[0]));
  assert.ok(lib.readText(saved[0]).trim().length > 0, 'the PDF’s text was extracted like an upload');
  assert.equal(lib.readText(saved[2]), 'Pay by Friday.');
  assert.ok(T.taintOf(r.id).sources.some(s => s.tool === 'email_save_attachments' && /attachments of an email from Sam/.test(s.label)), 'the run read outside content');
  // The same files again: found, not copied; picked by number or name.
  const again = await getTool('email_save_attachments').run({ uid: m.uid, indexes: [2], names: ['NOTES.TXT', 'nope.doc'] }, ctxFor(r));
  assert.match(again.content, /already in the Library from this email/);
  assert.match(again.content, /No attachment called “nope\.doc”/);
  assert.equal(all(`SELECT COUNT(*) AS n FROM library_items WHERE owner_id = ? AND source_label LIKE 'From email:%'`, ann.id)[0].n, 3);
  const logo = await getTool('email_save_attachments').run({ uid: m.uid, indexes: [1] }, ctxFor(r));
  assert.match(logo.content, /Saved 1 file/, 'an inline picture is saved when picked');
});

test('email (GreenMail): Library files go out on email_send (real MIME, Sent copy too); the card lists each file; limits, ownership and secrets hold', { skip: !haveMail && 'GreenMail not installed in tools/test-servers' }, async () => {
  const pdf = get(`SELECT * FROM library_items WHERE owner_id = ? AND ext = 'pdf' AND source_label LIKE 'From email:%'`, ann.id);
  const notes = get(`SELECT * FROM library_items WHERE owner_id = ? AND ext = 'txt'`, ann.id);
  const card = lib.createItem({ user: ann, title: 'Card details', type: 'md', content: 'Visa 4242 4242 4242 4242, expires 12/29.' });
  const tool = getTool('email_send');
  const args = { to: 'sam@local.test', subject: 'The invoice', body: 'Here it is.\n\nAnn', attachments: [pdf.public_id, `/library/${notes.public_id}`, card.public_id] };
  const preview = tool.approvalPreview(args);
  assert.match(preview, /Attached: 3 files/);
  assert.match(preview, /- “invoice” · PDF \(\.pdf\) · \d+ KB/);
  assert.match(preview, /- “notes” · Document \(\.txt\) · 14 B/);
  assert.match(preview, /Contains a card number/);
  const r = newRun();
  const a = createApproval({ run: r, user: ann, tool, args, toolCallId: 'call-send' });
  assert.match(a.preview, /a card number ••••4242/);
  assert.doesNotMatch(a.preview, /4242 4242 4242 4242/, 'the card masks it');

  const out = await tool.run({ ...args, attachments: [pdf.public_id, `/library/${notes.public_id}`] }, ctxFor(r));
  assert.match(out.content, /with invoice\.pdf \(\d+ KB\), notes\.txt \(14 B\)/, 'the sent record names the files');
  const imap = await imapAs('sam@local.test');
  let msg;
  try {
    const lock = await imap.getMailboxLock('INBOX');
    try { for await (const m of imap.fetch('1:*', { source: true, envelope: true })) if (m.envelope.subject === 'The invoice') msg = await simpleParser(m.source); } finally { lock.release(); }
  } finally { await imap.logout(); }
  assert.ok(msg, 'Sam got it');
  assert.deepEqual(msg.attachments.map(x => [x.filename, x.contentType]), [['invoice.pdf', 'application/pdf'], ['notes.txt', 'text/plain']]);
  assert.ok(msg.attachments[0].content.equals(fx('sample.pdf')), 'the PDF arrives byte for byte');
  assert.equal(msg.attachments[1].content.toString(), 'Pay by Friday.');
  assert.match(msg.text, /Here it is/);
  const own = await imapAs('owner@local.test');
  try {
    const folders = await own.list();
    const sent = folders.find(f => f.specialUse === '\\Sent')?.path || 'Sent';
    const lock = await own.getMailboxLock(sent);
    let copy;
    try { for await (const m of own.fetch('1:*', { source: true, envelope: true })) if (m.envelope.subject === 'The invoice') copy = await simpleParser(m.source); } finally { lock.release(); }
    assert.equal(copy?.attachments.length, 2, 'the Sent copy carries the files');
  } finally { await own.logout(); }

  // Refused before anything goes out.
  const theirs = lib.createItem({ user: bob, title: 'Bob’s notes', type: 'md', content: 'private' });
  await rejects(tool.run({ ...args, attachments: [theirs.public_id] }, ctxFor(r)), /isn’t a file in Ann’s Library/);
  await rejects(tool.run({ ...args, attachments: ['nope123'] }, ctxFor(r)), /isn’t a file in/);
  await rejects(tool.run({ ...args, attachments: ['a', 'b', 'c', 'd', 'e', 'f'] }, ctxFor(r)), /At most 5 files/);
  const big = () => lib.createFileItem({ user: ann, title: 'big', type: 'image', ext: 'png', mime: 'image/png', buffer: Buffer.alloc(11 * 1048576) });
  const [b1, b2] = [big(), big()];
  await rejects(tool.run({ ...args, attachments: [b1.public_id, b2.public_id] }, ctxFor(r)), /at most 20\.0 MB/);
  registerSecret('sk-live-THIS-IS-A-TEST-SECRET-123', 'the model key');
  const leak = lib.createItem({ user: ann, title: 'Config', type: 'md', content: 'key: sk-live-THIS-IS-A-TEST-SECRET-123' });
  await rejects(tool.run({ ...args, attachments: [leak.public_id] }, ctxFor(r)), /Blocked: “Config” contains the model key/);
  const audit = get(`SELECT * FROM audit_log WHERE action = 'secret_blocked' ORDER BY id DESC LIMIT 1`);
  assert.match(audit.detail, new RegExp(leak.public_id));
  assert.doesNotMatch(audit.detail, /THIS-IS-A-TEST-SECRET/, 'metadata only');
  assert.match(tool.approvalPreview({ ...args, attachments: ['gone999'] }), /gone999: not in the Library \(the email won’t be sent\)/);
});

test('email (GreenMail): email_organize flags, marks, archives and moves (new uids back); big batches and the bin ask first; nothing deletes', { skip: !haveMail && 'GreenMail not installed in tools/test-servers' }, async () => {
  const c = conns.connectionsOf(ann, 'email')[0];
  const smtp = smtpAs('sam@local.test');
  for (const s of ['Tidy one', 'Tidy two', 'Tidy three']) await smtp.sendMail({ from: 'sam@local.test', to: 'owner@local.test', subject: s, text: s });
  const own = await imapAs('owner@local.test');
  try { await own.mailboxCreate('Receipts'); await own.mailboxCreate('Borttaget'); } finally { await own.logout(); }
  const uidOf = async subject => (await mail.listMail(c, { subject }))[0].uid;
  const [u1, u2, u3] = [await uidOf('Tidy one'), await uidOf('Tidy two'), await uidOf('Tidy three')];
  const tool = getTool('email_organize');
  const r = newRun();

  await tool.run({ uids: [u1, u2], action: 'flag' }, ctxFor(r));
  await tool.run({ uids: [u1], action: 'mark_read' }, ctxFor(r));
  let list = await mail.listMail(c, { subject: 'Tidy' });
  const by = uid => list.find(m => m.uid === uid);
  assert.equal(by(u1).flagged, true); assert.equal(by(u2).flagged, true); assert.equal(by(u3).flagged, false);
  assert.equal(by(u1).unread, false); assert.equal(by(u2).unread, true);
  await tool.run({ uids: [u2], action: 'unflag' }, ctxFor(r));
  await tool.run({ uids: [u1], action: 'mark_unread' }, ctxFor(r));
  list = await mail.listMail(c, { subject: 'Tidy' });
  assert.equal(by(u2).flagged, false); assert.equal(by(u1).unread, true);

  const arch = await tool.run({ uids: [u1, 99999], action: 'archive' }, ctxFor(r));
  assert.match(arch.content, /Moved 1 email from INBOX to Archive\. New uids in Archive: \d+→\d+\./);
  assert.match(arch.content, /1 email weren’t in INBOX \(uid 99999\)/);
  const newUid = Number(/→(\d+)/.exec(arch.content)[1]);
  assert.equal((await mail.listMail(c, { folder: 'Archive', subject: 'Tidy one' }))[0].uid, newUid);
  const moved = await tool.run({ uids: [u2], action: 'move', to_folder: 'receipts' }, ctxFor(r));
  assert.match(moved.content, /to Receipts/);
  assert.equal((await mail.listMail(c, { subject: 'Tidy' })).length, 1, 'only Tidy three is left in the inbox');
  // Back again with the new uid (the undo the card promises).
  await tool.run({ uids: [newUid], action: 'move', folder: 'Archive', to_folder: 'INBOX' }, ctxFor(r));
  assert.equal((await mail.listMail(c, { subject: 'Tidy one' })).length, 1);
  await rejects(tool.run({ uids: [u3], action: 'move', to_folder: 'Nowhere' }, ctxFor(r)), /no folder called “Nowhere”\. Folders: .*Receipts/);
  await rejects(tool.run({ uids: [u3], action: 'move' }, ctxFor(r)), /Which folder/);
  throwsWith(() => mail.organizeMail(c, { uids: [u3], action: 'delete' }), /Unknown action/);

  // The gate: small tidy-ups run, big batches and the bin ask (by name, or by the folder's special use on the server).
  const many = Array.from({ length: 21 }, (_, i) => i + 1);
  assert.equal(tool.risk({ uids: [u3], action: 'flag' }), 'write');
  assert.equal(tool.risk({ uids: many, action: 'mark_read' }), 'external');
  assert.equal(tool.risk({ uids: [u3], action: 'move', to_folder: 'Trash' }), 'external');
  assert.equal(tool.risk({ uids: [u3], action: 'move', to_folder: 'Receipts' }), 'write');
  assert.equal(await tool.riskCheck({ uids: [u3], action: 'move', to_folder: 'Borttaget' }, { user: ann }), 'external', 'the server’s bin, whatever its name');
  assert.equal(await tool.riskCheck({ uids: [u3], action: 'move', to_folder: 'Receipts' }, { user: ann }), null);
  const clean = createRun({ threadId: thread.id, userId: ann.id, triggerMessageId: null, model: 'x' });
  assert.equal(assess(ann, tool, { uids: [u3], action: 'flag' }, clean.id).verdict, 'allow');
  assert.equal(assess(ann, tool, { uids: many, action: 'flag' }, clean.id).verdict, 'ask');
  const raised = await tool.riskCheck({ uids: [u3], action: 'move', to_folder: 'Borttaget' }, { user: ann });
  assert.equal(assess(ann, tool, { uids: [u3], action: 'move', to_folder: 'Borttaget' }, clean.id, { raised }).verdict, 'ask');
  const card = createApproval({ run: clean, user: ann, tool, args: { uids: [u3], action: 'move', to_folder: 'Trash' }, toolCallId: 'call-bin', risk: 'external' });
  assert.match(card.title, /Move 1 email to “Trash”/);
  assert.match(card.preview, /Nothing is deleted/);
  assert.equal(card.undoable, 1);
  assert.match(card.undo_note, /out of the bin/);
  assert.equal(card.reach, 'your mailbox only');
  assert.ok(!getTool('email_delete'), 'there is no delete tool');
});

test('email (GreenMail): email_unsubscribe_link surfaces the link and address, fenced, and changes nothing', { skip: !haveMail && 'GreenMail not installed in tools/test-servers' }, async () => {
  const c = conns.connectionsOf(ann, 'email')[0];
  await smtpAs('sam@local.test').sendMail({ from: 'News <sam@local.test>', to: 'owner@local.test', subject: 'Weekly deals', text: 'Deals!',
    headers: { 'List-Unsubscribe': '<mailto:leave@news.test?subject=unsubscribe>, <https://news.test/u?id=42>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
  const [m] = await mail.listMail(c, { subject: 'Weekly deals' });
  const r = newRun();
  const out = await getTool('email_unsubscribe_link').run({ uid: m.uid }, ctxFor(r));
  assert.match(out.content, /fence="[0-9a-f]+"/);
  assert.match(out.content, /Web link: https:\/\/news\.test\/u\?id=42/);
  assert.match(out.content, /Email: leave@news\.test · subject “unsubscribe”/);
  assert.match(out.content, /One-click/);
  assert.match(out.content, /Not unsubscribed/);
  assert.equal((await mail.listMail(c, { subject: 'Weekly deals' }))[0].unread, true, 'reading the header doesn’t mark it read');
  const [plain] = await mail.listMail(c, { subject: 'Tidy three' });
  const none = await getTool('email_unsubscribe_link').run({ uid: plain.uid }, ctxFor(r));
  assert.match(none.content, /has no unsubscribe header/);
});
