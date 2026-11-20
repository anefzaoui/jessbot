// Which host names and origins this server answers to (decision #220).
//  - Host: when Jessbot listens on loopback only (the default), or PUBLIC_URL is set, a request must name one of the
//    expected hosts: loopback names, PUBLIC_URL's host, ALLOWED_HOSTS. That stops DNS rebinding (a web page whose own
//    name suddenly resolves to 127.0.0.1 talking to this server) and Host-header tricks in links we build. Listening on
//    all interfaces without PUBLIC_URL (a LAN install reached by IP) keeps accepting any Host.
//  - Origin: cookie-authenticated changes and WebSocket upgrades must come from PUBLIC_URL's origin, an ALLOWED_ORIGINS
//    entry, or the request's own (already checked) host.
//  - Links we hand out (invites, setup) use PUBLIC_URL when it is set, never the request's Host.
import net from 'node:net';
import { config } from '../config/index.js';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const hostname = host => String(host || '').toLowerCase().replace(/:\d+$/, '');
const isLoopbackHost = host => {
  const h = hostname(host).replace(/^\[|\]$/g, '');
  return LOOPBACK_NAMES.has(h) || h.endsWith('.localhost') || (net.isIPv4(h) && h.startsWith('127.'));
};
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const originOf = u => { try { return new URL(u).origin; } catch { return null; } };

const bindIsLoopback = () => isLoopbackHost(config.host);
const publicUrlSet = () => !!process.env.PUBLIC_URL;
const publicOrigin = () => (publicUrlSet() ? originOf(process.env.PUBLIC_URL) : null);

/** Whether this request's Host header is one we answer to. */
export function hostAllowed(host) {
  if (!host) return false;
  if (!bindIsLoopback() && !publicUrlSet()) return true; // a LAN install reached by IP or name: anything goes
  if (isLoopbackHost(host)) return true;
  const h = hostname(host);
  if (publicUrlSet() && h === hostname(new URL(process.env.PUBLIC_URL).host)) return true;
  return list(process.env.ALLOWED_HOSTS).some(a => hostname(a) === h);
}

/** Whether a browser Origin (or Referer) may make cookie-authenticated changes on a request for `host`. */
export function originAllowed(origin, host) {
  const o = originOf(origin);
  if (!o) return false;
  if (o === publicOrigin()) return true;
  if (list(process.env.ALLOWED_ORIGINS).map(originOf).includes(o)) return true;
  return hostAllowed(host) && new URL(o).host === String(host || '').toLowerCase();
}

/** Express middleware: requests for an unexpected host get 421 before anything else runs. */
export function checkHost(req, res, next) {
  if (hostAllowed(req.headers.host)) return next();
  res.status(421).type('text/plain').send('This Jessbot does not answer to that host name. Set PUBLIC_URL or ALLOWED_HOSTS if it should.');
}

/** The base address for links we hand out: PUBLIC_URL when set, else the request's own address. */
export const baseUrl = req => (publicUrlSet() ? publicOrigin() : `${req.protocol}://${req.get('host')}`);
