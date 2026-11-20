// Sign in / out and invite acceptance.
import { Router } from 'express';
import { getUserWithHash, touchUser } from '../../services/users.js';
import { verifyPassword, burnVerify, MIN_PASSWORD } from '../../services/passwords.js';
import { createSession, revokeSession, deviceLabel } from '../../services/sessions.js';
import { findInvite, acceptInvite } from '../../services/invites.js';
import { getUser } from '../../services/users.js';
import { audit } from '../../services/audit.js';
import { setSessionCookie, clearSessionCookie } from '../../middleware/auth.js';
import { formPost } from '../../lib/respond.js';
import { HttpError, invalid, tooMany } from '../../lib/errors.js';
import { hit, reset } from '../../lib/ratelimit.js';

const router = Router();

// Only same-site relative paths are allowed as post-login destinations (no open redirects).
export const safeNext = next => (typeof next === 'string' && /^\/(?!\/|\\)[^\s]*$/.test(next) ? next : '/chat');

// Shared by the web form and POST /api/v1/auth/login.
export async function authenticate(req, { email, password }) {
  const key = `login:${req.ip}:${String(email || '').toLowerCase()}`;
  const limit = hit(key, { limit: 8, windowMs: 15 * 60e3 });
  if (!limit.allowed) throw tooMany(`Too many attempts. Try again in ${Math.ceil(limit.retryInMs / 60e3)} min.`);
  const user = getUserWithHash(email);
  const ok = user ? await verifyPassword(String(password || ''), user.password_hash) : await burnVerify(String(password || ''));
  if (!ok || user.status !== 'active') {
    audit('auth.login_failed', { detail: { email }, ip: req.ip });
    throw new HttpError(401, 'That email and password don’t match.', { errors: { password: 'That email and password don’t match.' } });
  }
  reset(key);
  touchUser(user.id);
  audit('auth.login', { actorId: user.id, ip: req.ip });
  return user;
}

const loginData = req => ({ layout: 'base', title: 'Sign in', next: safeNext(req.query.next || req.body?.next), values: {} });

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('login', loginData(req));
});

router.post('/login', formPost('login', loginData, async (req, res) => {
  const user = await authenticate(req, req.body);
  setSessionCookie(req, res, createSession(user.id, { device: deviceLabel(req.get('user-agent')), ip: req.ip }));
  return { redirect: safeNext(req.body.next) };
}));

router.post('/logout', (req, res) => {
  if (req.session) {
    revokeSession(req.session.id, req.user.id);
    audit('auth.logout', { actorId: req.user.id, ip: req.ip });
  }
  clearSessionCookie(res);
  res.redirect('/login');
});

// ---- Invites ---------------------------------------------------------------------
const inviteData = req => {
  const invite = findInvite(req.params.token);
  const inviter = invite?.invited_by ? getUser(invite.invited_by) : null;
  return { layout: 'base', title: 'Join', invite, inviterName: inviter?.name, minPassword: MIN_PASSWORD,
    values: { name: invite?.name, email: invite?.email } };
};

router.get('/invite/:token', (req, res) => {
  const data = inviteData(req);
  res.status(data.invite ? 200 : 410).render('invite', data);
});

router.post('/invite/:token', formPost('invite', inviteData, async (req, res) => {
  if (!hit(`invite:${req.ip}`, { limit: 10, windowMs: 15 * 60e3 }).allowed) throw tooMany('Too many attempts. Wait a few minutes.');
  if (req.body.password !== req.body.confirm) throw invalid({ confirm: 'Passwords don’t match.' });
  const user = await acceptInvite(req.params.token, req.body);
  setSessionCookie(req, res, createSession(user.id, { device: deviceLabel(req.get('user-agent')), ip: req.ip }));
  audit('user.join', { actorId: user.id, ip: req.ip });
  return { redirect: '/chat?welcome=1' };
}));

export default router;
