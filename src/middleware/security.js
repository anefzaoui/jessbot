import crypto from 'node:crypto';

// Strict baseline headers. Inline scripts are only allowed with the
// per-request nonce (used by the anti-flash theme script in the layout).
export function securityHeaders(req, res, next) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.nonce = nonce;
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:", // voice notes: your own recording plays before it uploads (docs/VOICE.md)
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  // geolocation=(self): "Use my location" in You → Places needs it (it was blocked entirely); others' frames get nothing.
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(self), microphone=(self)');
  // Behind HTTPS (a reverse proxy sets X-Forwarded-Proto; app.js trusts loopback proxies), browsers stay on HTTPS.
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
}
