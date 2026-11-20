// A person's mail and calendar accounts (You → Connections; decisions #78/#79). Settings are proven against the real
// server BEFORE they're saved — a wrong password never gets stored. Views never include the password.
import { Router } from 'express';
import { PRESETS, connectionsOf, connectionFor, readForm, saveConnection, deleteConnection, connectionView } from '../../../services/connections.js';
import { testMail } from '../../../services/mail.js';
import { listCalendars, syncConnection } from '../../../services/calendar.js';
import { seal } from '../../../lib/secrets.js';
import { audit } from '../../../services/audit.js';
import { invalid, tooMany } from '../../../lib/errors.js';
import { hit } from '../../../lib/ratelimit.js';

const router = Router();
const KINDS = new Set(['email', 'calendar']);
const all = user => ({ email: connectionsOf(user, 'email').map(connectionView), calendar: connectionsOf(user, 'calendar').map(connectionView) });

// Try the settings for real. Returns what we learned (the calendars on the account).
// Each check opens connections to a server the person chose — capped so the form can't be used to hammer or scan anything.
function throttle(user) {
  const l = hit(`connections:${user.id}`, { limit: 12, windowMs: 10 * 60e3 });
  if (!l.allowed) throw tooMany(`Too many checks — try again in ${Math.ceil(l.retryInMs / 60e3)} min.`);
}

async function prove(kind, form, existing) {
  const probe = { id: existing?.id || 0, kind, provider: form.provider, config: form.config, secret: form.password ? seal(form.password) : existing?.secret };
  if (kind === 'email') { await testMail(probe); return {}; }
  const calendars = await listCalendars(probe);
  if (!calendars.length) throw invalid({ url: 'Signed in, but there are no calendars on this account.' });
  return { calendars };
}

router.get('/connections', (req, res) => res.json({ ...all(req.user),
  presets: Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, { label: p.label, email: !!p.email, calendar: !!p.calendar, help: p.help, url: p.calendar?.url || null }])) }));

router.post('/connections/:kind', async (req, res) => {
  const kind = req.params.kind;
  if (!KINDS.has(kind)) throw invalid({ kind: 'Mail or calendar?' });
  throttle(req.user);
  const form = readForm(kind, req.body || {});
  const learned = await prove(kind, form, null);
  if (learned.calendars) form.config.calendars = learned.calendars.map(c => c.url);
  const c = saveConnection(req.user, kind, form);
  audit('connection.add', { actorId: req.user.id, detail: { kind, provider: form.provider, label: form.label } });
  if (kind === 'calendar') await syncConnection(c, req.user).catch(() => {}); // events ready for the prompt and Upcoming
  res.status(201).json({ connection: connectionView(connectionFor(req.user, c.id)), calendars: learned.calendars || null, ...all(req.user) });
});

router.patch('/connections/:id', async (req, res) => {
  const existing = connectionFor(req.user, req.params.id);
  throttle(req.user);
  const form = readForm(existing.kind, req.body || {}, existing);
  const learned = await prove(existing.kind, form, existing);
  if (learned.calendars && Array.isArray(req.body?.calendars)) {
    const known = new Set(learned.calendars.map(c => c.url));
    form.config.calendars = req.body.calendars.filter(u => known.has(u));
  }
  const c = saveConnection(req.user, existing.kind, form, existing);
  if (c.kind === 'calendar') await syncConnection(c, req.user).catch(() => {});
  res.json({ connection: connectionView(connectionFor(req.user, c.id)), ...all(req.user) });
});

router.post('/connections/:id/test', async (req, res) => {
  const c = connectionFor(req.user, req.params.id);
  throttle(req.user);
  if (c.kind === 'email') await testMail(c);
  else await syncConnection(c, req.user);
  res.json({ ok: true, connection: connectionView(connectionFor(req.user, c.id)) });
});

router.delete('/connections/:id', (req, res) => {
  const c = connectionFor(req.user, req.params.id);
  deleteConnection(req.user, c.id);
  audit('connection.remove', { actorId: req.user.id, detail: { kind: c.kind, label: c.label } });
  res.json({ ok: true, ...all(req.user) });
});

export default router;
