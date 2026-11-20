// Sign in (password, then a code when two-step sign-in is on), sign out, invites and password reset links.
import { Router } from 'express';
import { getUserWithHash, touchUser, rehashPassword } from '../../services/users.js';
import { verifyPassword, burnVerify, needsRehash, MIN_PASSWORD } from '../../services/passwords.js';
import { createSession, revokeSession, deviceLabel } from '../../services/sessions.js';
import { findInvite, acceptInvite } from '../../services/invites.js';
import { getUser } from '../../services/users.js';
import { audit } from '../../services/audit.js';
import { twoFactorOn, verifySecondStep, createChallenge, readChallenge, endChallenge } from '../../services/twofactor.js';
import { findReset, useReset } from '../../services/password-reset.js';
import { setSessionCookie, clearSessionCookie, readCookie } from '../../middleware/auth.js';
import { formPost } from '../../lib/respond.js';
import { HttpError, invalid, tooMany } from '../../lib/errors.js';
import { hit, reset, signInLimit } from '../../lib/ratelimit.js';
import { oversightOn } from '../../services/oversight.js';

const router = Router();

// Only same-site relative paths are allowed as post-login destinations (no open redirects).
export const safeNext = next => (typeof next === 'string' && /^\/(?!\/|\\)[^\s]*$/.test(next) ? next : '/chat');

// The first step, shared by the web form and POST /api/v1/auth/login: the password. → the user row (the session isn't made
// here: with two-step sign-in on, a code comes first). A hash made with older, weaker parameters is redone now (#230).
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
  if (needsRehash(user.password_hash)) await rehashPassword(user.id, String(password));
  return user;
}

/** The second step: an app or recovery code for a user whose password was right. Throws a 401/429 a person can read. */
export function checkSecondStep(req, userId, code) {
  const limit = hit(`2fa:${userId}`, { limit: 5, windowMs: 15 * 60e3 });
  if (!limit.allowed) throw tooMany(`Too many codes tried. Try again in ${Math.ceil(limit.retryInMs / 60e3)} min.`);
  const out = verifySecondStep(userId, code);
  if (!out.ok) {
    audit('auth.2fa_failed', { actorId: userId, ip: req.ip });
    const msg = out.reused ? 'That code was just used. Wait for the next one.' : 'That code doesn’t match. Try the newest one, or a recovery code.';
    throw new HttpError(401, msg, { errors: { code: msg }, code: 'two_factor_invalid' });
  }
  reset(`2fa:${userId}`);
  return out;
}

/** Signed in for real: the audit line and the last-seen time. */
export function signedIn(req, user, via = 'password') {
  touchUser(user.id);
  audit('auth.login', { actorId: user.id, ip: req.ip, detail: via === 'password' ? undefined : { via } });
}

const loginData = req => ({ layout: 'base', title: 'Sign in', next: safeNext(req.query.next || req.body?.next), values: {},
  resetDone: req.query.reset === '1' });
const CHALLENGE_COOKIE = 'jb_2fa';
const challengeCookie = (req, res, token) => res.cookie(CHALLENGE_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/login', maxAge: 10 * 60e3 });
const startSession = (req, res, user) => setSessionCookie(req, res, createSession(user.id, { device: deviceLabel(req.get('user-agent')), ip: req.ip }));

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('login', loginData(req));
});

router.post('/login', signInLimit, formPost('login', loginData, async (req, res) => {
  const user = await authenticate(req, req.body);
  if (twoFactorOn(user.id)) {
    challengeCookie(req, res, createChallenge(user.id, safeNext(req.body.next)));
    return { redirect: '/login/code' };
  }
  startSession(req, res, user);
  signedIn(req, user);
  return { redirect: safeNext(req.body.next) };
}));

// Two-step sign-in: the code page, reachable only with a live challenge from the password step (10 minutes).
const codeData = () => ({ layout: 'base', title: 'Two-step sign-in', values: {} });
router.get('/login/code', (req, res) => {
  if (!readChallenge(readCookie(req, CHALLENGE_COOKIE))) return res.redirect('/login');
  res.render('login-code', codeData());
});

router.post('/login/code', signInLimit, formPost('login-code', codeData, async (req, res) => {
  const token = readCookie(req, CHALLENGE_COOKIE);
  const challenge = readChallenge(token);
  if (!challenge) throw new HttpError(401, 'That took too long. Sign in again.', { errors: { code: 'That took too long. Sign in again.' } });
  const out = checkSecondStep(req, challenge.userId, req.body.code);
  endChallenge(token);
  res.clearCookie(CHALLENGE_COOKIE, { path: '/login' });
  const user = getUser(challenge.userId);
  if (user?.status !== 'active') throw new HttpError(401, 'That account is turned off.');
  startSession(req, res, user);
  signedIn(req, user, out.via);
  // A recovery code was used up: the You page says how many are left.
  return { redirect: out.via === 'recovery' ? '/me/devices?recovery=used' : safeNext(challenge.next) };
}));

// ---- Password reset links (made by an admin, or with `npm run reset-link`) ------------------------------------------
const resetData = req => ({ layout: 'base', title: 'New password', valid: !!findReset(req.params.token), minPassword: MIN_PASSWORD, values: {} });
router.get('/reset/:token', (req, res) => {
  const data = resetData(req);
  res.set('Referrer-Policy', 'no-referrer').status(data.valid ? 200 : 410).render('reset', data);
});

router.post('/reset/:token', signInLimit, formPost('reset', resetData, async (req, res) => {
  if (req.body.password !== req.body.confirm) throw invalid({ confirm: 'Passwords don’t match.' });
  const userId = await useReset(req.params.token, req.body.password, { ip: req.ip });
  if (!userId) throw new HttpError(410, 'This link has been used or has expired. Ask your admin for a new one.');
  if (req.session) clearSessionCookie(res);
  return { redirect: '/login?reset=1' };
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
  return { layout: 'base', title: 'Join', invite, inviterName: inviter?.name, minPassword: MIN_PASSWORD, readByAdmins: oversightOn(),
    values: { name: invite?.name, email: invite?.email } };
};

router.get('/invite/:token', (req, res) => {
  const data = inviteData(req);
  res.status(data.invite ? 200 : 410).render('invite', data);
});

router.post('/invite/:token', signInLimit, formPost('invite', inviteData, async (req, res) => {
  if (!hit(`invite:${req.ip}`, { limit: 10, windowMs: 15 * 60e3 }).allowed) throw tooMany('Too many attempts. Wait a few minutes.');
  if (req.body.password !== req.body.confirm) throw invalid({ confirm: 'Passwords don’t match.' });
  const user = await acceptInvite(req.params.token, req.body);
  setSessionCookie(req, res, createSession(user.id, { device: deviceLabel(req.get('user-agent')), ip: req.ip }));
  audit('user.join', { actorId: user.id, ip: req.ip });
  return { redirect: '/chat?welcome=1' };
}));

export default router;
