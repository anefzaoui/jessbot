// The browser's way out (decision #222): every browser context sends its traffic through this small proxy on 127.0.0.1,
// so the browser never looks a host name up itself. The proxy resolves each name ONCE with lib/outbound.js's checked
// lookup and connects to that checked address; a name whose DNS answer changes after the request guard looked at it can't
// move the connection onto this machine or the local network. HTTPS and WebSockets arrive as CONNECT tunnels (the proxy
// sees only host and port, never the content); plain http:// requests are forwarded.
//
// Only this process's browser may use it: it listens on 127.0.0.1, on a port the system picks, and asks for a random
// per-process credential (Playwright answers the proxy's 407 with it).
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { resolveChecked, checkedLookup, localNetworkAllowed, isPrivateIp } from '../lib/outbound.js';

const USER = 'jessbot';
const PASS = crypto.randomBytes(18).toString('base64url');
const EXPECTED = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
const CONNECT_TIMEOUT = 15000;

let server = null, starting = null, refused = 0;
/** How many connections the proxy refused (local network), for Admin → Browser and tests. */
export const proxyRefused = () => refused;

const authorized = req => {
  const got = Buffer.from(String(req.headers['proxy-authorization'] || ''));
  const want = Buffer.from(EXPECTED);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};

// "host:port" or "[v6]:port" → { host, port }
function splitHostPort(s, defPort) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) || /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  const port = Number(m[2] || defPort);
  return port > 0 && port < 65536 ? { host: m[1].toLowerCase(), port } : null;
}

function onConnect(req, client, head) {
  client.on('error', () => {});
  if (!authorized(req)) {
    client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="jessbot"\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const target = splitHostPort(req.url, 443);
  if (!target) { client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'); return; }
  resolveChecked(target.host, { allowPrivate: localNetworkAllowed() }).then(([first]) => {
    const upstream = net.connect({ host: first.address, port: target.port, timeout: CONNECT_TIMEOUT });
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.once('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); });
    client.on('close', () => upstream.destroy());
  }, err => {
    if (err.code === 'EBLOCKED') refused++;
    client.end(`HTTP/1.1 ${err.code === 'EBLOCKED' ? '403 Forbidden' : '502 Bad Gateway'}\r\nContent-Length: 0\r\n\r\n`);
  });
}

const HOP = new Set(['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function onRequest(req, res) {
  if (!authorized(req)) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="jessbot"' }); return res.end(); }
  let url;
  try { url = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
  if (url.protocol !== 'http:') { res.writeHead(400); return res.end(); }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  const allowPrivate = localNetworkAllowed();
  const h = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && net.isIP(h) && isPrivateIp(h)) { refused++; res.writeHead(403); return res.end(); } // an IP literal skips the lookup
  const up = http.request({
    host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || 80, method: req.method, path: `${url.pathname}${url.search}`, headers,
    lookup: checkedLookup({ allowPrivate }), agent: false, timeout: CONNECT_TIMEOUT,
  });
  up.on('response', r => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
    res.writeHead(r.statusCode, r.statusMessage, out);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', err => {
    if (err.code === 'EBLOCKED') refused++;
    if (!res.headersSent) { res.writeHead(err.code === 'EBLOCKED' ? 403 : 502); res.end(); } else res.destroy();
  });
  req.pipe(up);
}

/** Start the proxy (once). → { server: 'http://127.0.0.1:<port>', username, password, bypass } for Playwright's `proxy`. */
export async function guardProxy() {
  if (!server) {
    starting ||= new Promise((resolve, reject) => {
      const s = http.createServer(onRequest);
      s.on('connect', onConnect);
      s.on('clientError', (err, socket) => socket.destroy());
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { s.unref(); server = s; resolve(); });
    }).finally(() => { starting = null; });
    await starting;
  }
  // '<-loopback>' takes away Chromium's built-in exception, so even localhost goes to the proxy (which refuses it).
  return { server: `http://127.0.0.1:${server.address().port}`, username: USER, password: PASS, bypass: '<-loopback>' };
}

/** Tests: stop the proxy. */
export async function stopGuardProxy() {
  const s = server; server = null;
  if (s) await new Promise(r => { s.closeAllConnections?.(); s.close(() => r()); });
}
