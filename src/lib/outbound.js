// Outbound requests from the server (decision #221): every server-side fetch and mail/calendar connection goes through
// here, so one rule holds everywhere: public internet only, unless the admin allowed the local network (Admin → Browser).
//
// The rule is enforced where the connection is made, not beside it:
//   - the host name is resolved ONCE, by the connection's own lookup; every answer is checked, and the socket connects to
//     an address from that same answer (no second lookup a changing DNS answer could slip through);
//   - after connecting, the socket's real peer address is checked again (an IP literal, or anything the lookup missed);
//   - redirects are followed here, hop by hop, each hop under the same rule.
// Mail (IMAP/SMTP) libraries open their own sockets: resolveTarget() resolves and checks once and hands them the checked
// address to connect to, with the host name kept for TLS (SNI and certificate checks).
//
// Admin-configured endpoints (the model provider, SearXNG) may be on the local network — the admin typed them — but only
// that exact origin: a redirect from it to somewhere else is held to the public-only rule.
import dns from 'node:dns';
import net from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import { settings } from '../db/index.js';

// ---- What counts as private -------------------------------------------------------------------------------------------
const PRIVATE = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3]]) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10],
  ['ff00::', 8]]) PRIVATE.addSubnet(a, p, 'ipv6');

// IPv6 forms that carry an IPv4 address: mapped (::ffff:a.b.c.d), the old "compatible" form (::a.b.c.d), NAT64
// (64:ff9b::a.b.c.d) and 6to4 (2002:AABB:CCDD::). The IPv4 inside is what is really reached, so it is what is checked.
function embeddedV4(ip) {
  let canon;
  try { canon = new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return null; }
  const hex = (h, l) => [parseInt(h, 16) >> 8, parseInt(h, 16) & 255, parseInt(l, 16) >> 8, parseInt(l, 16) & 255].join('.');
  let m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canon) || /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canon)
    || /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canon);
  if (m) return hex(m[1], m[2]);
  m = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(:|$)/.exec(canon);
  return m ? hex(m[1], m[2]) : null;
}

/** True for every address that isn't on the public internet (loopback, LAN, link-local/cloud metadata, multicast, …). */
export function isPrivateIp(ip) {
  const addr = String(ip || '').replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // brackets, IPv6 zone id
  const v = net.isIP(addr);
  if (!v) return true;
  if (v === 4) return PRIVATE.check(addr, 'ipv4');
  const v4 = embeddedV4(addr);
  if (v4) return PRIVATE.check(v4, 'ipv4');
  return PRIVATE.check(addr, 'ipv6');
}

/** Names that only mean something on this machine or the local network. */
export const isPrivateName = host => {
  const h = String(host || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return !h || h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h) || (!h.includes('.') && !net.isIP(h));
};

/** The admin's local-network switch (Admin → Browser), read live. */
export const localNetworkAllowed = () => !!settings.get('browser', {})?.allowPrivate;

export class OutboundBlocked extends Error {
  constructor(host) {
    super('That address is on this computer or the local network — only public addresses are allowed (the admin can allow the local network in Admin → Browser).');
    this.name = 'OutboundBlocked';
    this.code = 'EBLOCKED';
    this.host = host;
    this.status = 400;
  }
}

// ---- One lookup, checked --------------------------------------------------------------------------------------------
let resolver = (host, cb) => dns.lookup(host, { all: true, verbatim: true }, cb);
/** Tests swap the resolver (a fake DNS that changes its answer); returns the previous one. */
export function setResolver(fn) { const prev = resolver; resolver = fn || ((h, cb) => dns.lookup(h, { all: true, verbatim: true }, cb)); return prev; }

/** Resolve host once and check every answer. → [{ address, family }] (all public unless allowPrivate). */
export function resolveChecked(host, { allowPrivate = false } = {}) {
  return new Promise((resolve, reject) => {
    const h = String(host || '').replace(/^\[|\]$/g, '');
    if (net.isIP(h)) {
      if (!allowPrivate && isPrivateIp(h)) return reject(new OutboundBlocked(h));
      return resolve([{ address: h, family: net.isIP(h) }]);
    }
    if (!allowPrivate && isPrivateName(h)) return reject(new OutboundBlocked(h));
    resolver(h, (err, list) => {
      if (err) return reject(err);
      const answers = (Array.isArray(list) ? list : [list]).filter(a => a?.address);
      if (!answers.length) return reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: 'ENOTFOUND', hostname: h }));
      // A mixed answer (one public, one private) is refused whole: that is how a rebinding name hedges its bets.
      if (!allowPrivate && answers.some(a => isPrivateIp(a.address))) return reject(new OutboundBlocked(h));
      resolve(answers.map(a => ({ address: a.address, family: a.family || net.isIP(a.address) })));
    });
  });
}

/** A net/tls `lookup` that answers only with checked addresses — the socket connects to what was checked. */
export function checkedLookup({ allowPrivate = false } = {}) {
  return (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    resolveChecked(host, { allowPrivate }).then(list => {
      const fam = opts?.family === 4 || opts?.family === 6 ? opts.family : 0;
      const pick = fam ? list.filter(a => a.family === fam) : list;
      if (!pick.length) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', hostname: host }));
      if (opts?.all) return cb(null, pick);
      cb(null, pick[0].address, pick[0].family);
    }, err => cb(err));
  };
}

/**
 * For libraries that open their own sockets (imapflow, nodemailer): resolve and check once, then connect to the returned
 * `host` (the checked address) with `servername` (the original name, for TLS). → { host, servername, address }.
 */
export async function resolveTarget(host, { allowPrivate = localNetworkAllowed() } = {}) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '');
  const [first] = await resolveChecked(h, { allowPrivate });
  return { host: first.address, servername: net.isIP(h) ? undefined : h, address: first.address };
}

// ---- fetch ------------------------------------------------------------------------------------------------------------
const agents = new Map();
/** One connection pool per rule (public-only or open) and TLS strictness. */
function agentFor({ open, rejectUnauthorized = true }) {
  const key = `${open ? 'open' : 'public'}|${rejectUnauthorized ? 'strict' : 'self-signed'}`;
  if (agents.has(key)) return agents.get(key);
  const base = buildConnector({ rejectUnauthorized, lookup: checkedLookup({ allowPrivate: open }) });
  const connect = (opts, cb) => {
    const host = String(opts.hostname || '').replace(/^\[|\]$/g, '');
    if (!open && (net.isIP(host) ? isPrivateIp(host) : isPrivateName(host))) return cb(new OutboundBlocked(host));
    base(opts, (err, socket) => {
      if (err) return cb(err);
      // Belt and braces: the peer we actually reached.
      if (!open && (!socket.remoteAddress || isPrivateIp(socket.remoteAddress))) { socket.destroy(); return cb(new OutboundBlocked(host)); }
      cb(null, socket);
    });
  };
  const agent = new Agent({ connect, keepAliveTimeout: 4000 });
  agents.set(key, agent);
  return agent;
}

// The HTTP transport. Tests that stand in for a provider swap it (setTransport); the stand-in gets plain fetch arguments.
let transport = null;
/** Tests only: route requests to fn(url, init) instead of the network; null restores it. Returns the previous one. */
export function setTransport(fn) { const prev = transport; transport = fn || null; return prev; }

const blockedCause = err => {
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) {
    if (e.code === 'EBLOCKED') return e;
    const inner = e.errors?.find?.(x => x?.code === 'EBLOCKED'); // autoSelectFamily's AggregateError
    if (inner) return inner;
  }
  return null;
};
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const originOf = u => { try { return new URL(u).origin; } catch { return null; } };

/**
 * fetch() under the outbound rule. Same arguments and Response as fetch, plus:
 *   allowPrivate  — override the admin's switch (true only for things the admin configured)
 *   trustedOrigin — an admin-configured endpoint (model provider, SearXNG): that origin may be private; other hops may not
 *   rejectUnauthorized — false accepts a self-signed certificate (a person's own server, when they said so)
 *   maxRedirects  — default 5
 * A blocked address rejects with OutboundBlocked (err.code 'EBLOCKED').
 */
export async function outboundFetch(input, init = {}, { allowPrivate, trustedOrigin = null, rejectUnauthorized = true, maxRedirects = 5 } = {}) {
  let url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  const trusted = trustedOrigin ? originOf(trustedOrigin) : null;
  const follow = (init.redirect || 'follow') === 'follow';
  let method = (init.method || 'GET').toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers || {});
  for (let hop = 0; ; hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new OutboundBlocked(url.protocol);
    const open = url.origin === trusted || (allowPrivate ?? localNetworkAllowed());
    let res;
    try {
      const req = { ...init, method, body, headers, redirect: 'manual' };
      res = transport ? await transport(url.href, req) : await undiciFetch(url, { ...req, dispatcher: agentFor({ open, rejectUnauthorized }) });
    } catch (err) { throw blockedCause(err) || err; } // fetch wraps it in "fetch failed"; a refusal is said as one
    const location = res.headers.get('location');
    if (!follow || !REDIRECTS.has(res.status) || !location) {
      if (init.redirect === 'error' && REDIRECTS.has(res.status)) throw new TypeError('fetch failed: redirect');
      return res;
    }
    if (hop >= maxRedirects) throw new TypeError('fetch failed: too many redirects');
    await res.body?.cancel().catch(() => {});
    const next = new URL(location, url);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = method === 'HEAD' ? 'HEAD' : 'GET';
      body = undefined;
      for (const h of ['content-type', 'content-length', 'content-encoding']) headers.delete(h);
    }
    if (next.origin !== url.origin) for (const h of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(h);
    url = next;
  }
}

/** A fetch function bound to options (for libraries that take one: the OpenAI client, tsdav). */
export const boundFetch = opts => (input, init) => outboundFetch(input, init, opts);
