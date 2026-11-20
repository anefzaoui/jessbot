// Your own sign-in (decision #230, issue #6): change the password, turn two-step sign-in on or off, new recovery codes.
// Every change here signs out your other devices; a password change also gives this device a fresh session (the old
// token stops working). Each answer carries `html`: the card re-rendered from partials/me/twofactor.hbs.
import { Router } from 'express';
import { get } from '../../../db/index.js';
import { verifyPassword } from '../../../services/passwords.js';
import { setPassword } from '../../../services/users.js';
import { createSession, revokeAllSessions, deviceLabel } from '../../../services/sessions.js';
import { twoFactorState, beginSetup, confirmSetup, regenerateRecoveryCodes, disableTwoFactor, verifySecondStep } from '../../../services/twofactor.js';
import { audit } from '../../../services/audit.js';
import { setSessionCookie } from '../../../middleware/auth.js';
import { invalid, tooMany } from '../../../lib/errors.js';
import { hit } from '../../../lib/ratelimit.js';

const router = Router();
const card = (res, data) => new Promise((resolve, reject) =>
  res.render('fragment', { layout: false, partial: 'me/twofactor', data, ...data }, (err, html) => (err ? reject(err) : resolve(html))));

/** The current password, checked (8 tries per 15 minutes per person). */
async function checkPassword(req, field = 'current') {
  const l = hit(`password-check:${req.user.id}`, { limit: 8, windowMs: 15 * 60e3 });
  if (!l.allowed) throw tooMany(`Too many tries. Wait ${Math.ceil(l.retryInMs / 60e3)} min.`);
  const row = get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!(await verifyPassword(String(req.body?.[field] || ''), row?.password_hash))) throw invalid({ [field]: 'That isn’t your current password.' });
}

router.post('/me/password', async (req, res) => {
  await checkPassword(req);
  const { password, confirm } = req.body || {};
  if (password !== confirm) throw invalid({ confirm: 'Passwords don’t match.' });
  await setPassword(req.user.id, password);
  // Everywhere signed out, this device included; then a new session here (a stolen old token is worthless now).
  revokeAllSessions(req.user.id);
  const kind = req.session.kind === 'app' ? 'app' : 'web';
  const token = createSession(req.user.id, { kind, device: kind === 'app' ? 'Android app' : deviceLabel(req.get('user-agent')), ip: req.ip });
  if (req.session.via === 'cookie') setSessionCookie(req, res, token);
  audit('auth.password_changed', { actorId: req.user.id, ip: req.ip });
  res.json({ ok: true, ...(req.session.via === 'bearer' ? { token } : {}) });
});

router.get('/me/2fa', async (req, res) => {
  const twoFactor = twoFactorState(req.user.id);
  res.json({ twoFactor, html: await card(res, { twoFactor }) });
});

// Turning it on: a new secret (shown as a QR code and as text), confirmed with a code from the app.
router.post('/me/2fa/setup', async (req, res) => {
  await checkPassword(req, 'password');
  const setup = beginSetup(req.user);
  res.json({ secret: setup.secret, uri: setup.uri, html: await card(res, { twoFactor: twoFactorState(req.user.id), setup }) });
});

router.post('/me/2fa/confirm', async (req, res) => {
  const { codes } = confirmSetup(req.user, req.body?.code, { keepSessionId: req.session.id, ip: req.ip });
  res.json({ ok: true, codes, html: await card(res, { twoFactor: twoFactorState(req.user.id), codes, codesText: codes.join('\n') }) });
});

router.post('/me/2fa/recovery-codes', async (req, res) => {
  await checkPassword(req, 'password');
  const codes = regenerateRecoveryCodes(req.user, { ip: req.ip });
  res.json({ ok: true, codes, html: await card(res, { twoFactor: twoFactorState(req.user.id), codes, codesText: codes.join('\n') }) });
});

// Turning it off takes the password and a code (an app code or a recovery code).
router.post('/me/2fa/off', async (req, res) => {
  await checkPassword(req, 'password');
  const l = hit(`2fa:${req.user.id}`, { limit: 5, windowMs: 15 * 60e3 });
  if (!l.allowed) throw tooMany(`Too many codes tried. Wait ${Math.ceil(l.retryInMs / 60e3)} min.`);
  if (!verifySecondStep(req.user.id, req.body?.code).ok) throw invalid({ code: 'That code doesn’t match.' });
  disableTwoFactor(req.user.id, { keepSessionId: req.session.id, ip: req.ip });
  res.json({ ok: true, html: await card(res, { twoFactor: twoFactorState(req.user.id) }) });
});

export default router;
