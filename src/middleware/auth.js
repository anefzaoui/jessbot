// Authentication for web (HttpOnly cookie) and apps (Authorization: Bearer). One token system, two carriers.
import { resolveSession } from '../services/sessions.js';
import { toPublic } from '../services/users.js';
import { isSetupComplete } from '../services/setup.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { originAllowed } from '../lib/origin.js';

export const COOKIE = 'jb_session';

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function setSessionCookie(req, res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 30 * 864e5,
  });
}
export const clearSessionCookie = res => res.clearCookie(COOKIE, { path: '/' });

// Populate req.user / res.locals.user from either carrier.
export function loadUser(req, res, next) {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearer || readCookie(req, COOKIE);
  const found = token ? resolveSession(token) : null;
  if (found) {
    req.user = toPublic(found.user);
    req.session = { id: found.sessionId, kind: found.kind, via: bearer ? 'bearer' : 'cookie' };
    res.locals.user = req.user;
  }
  next();
}

// Cookie-authenticated state changes must come from our own origin. Bearer requests (apps) and requests with no
// session at all (login, setup, invite accept) aren't CSRF-able in a harmful way, so they pass.
export function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.session?.via !== 'cookie') return next();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next(forbidden('Missing origin.'));
  if (!originAllowed(origin, req.headers.host)) return next(forbidden('Cross-site request blocked.')); // PUBLIC_URL, ALLOWED_ORIGINS or this host (#220)
  next();
}

const wantsJson = req => req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/') || req.accepts(['html', 'json']) === 'json';

// Until setup is finished, everything except setup, auth assets and health goes to the wizard.
export function requireSetup(req, res, next) {
  if (isSetupComplete()) return next();
  if (wantsJson(req)) return res.status(503).json({ error: 'Jessbot is not set up yet.', setup: '/setup' });
  res.redirect('/setup');
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return next(unauthorized());
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

export function requireAdmin(req, res, next) {
  if (!req.user) return requireAuth(req, res, next);
  if (req.user.role !== 'admin') return next(forbidden('Only the admin can do that.'));
  next();
}
