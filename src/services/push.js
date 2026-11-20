// Push transport (Phase 12, decision #85): reaching someone whose Jessbot isn't open. Two self-hostable transports, no
// Google account needed on the server:
//   webpush     — browsers and installed PWAs (Chrome/Edge/Firefox/Safari, Android included) via the Web Push protocol,
//                 VAPID keys made per install (in .env). The page's service worker (public/sw.js) shows the notification.
//   unifiedpush — the Android app (later) through any UnifiedPush distributor, e.g. ntfy: a plain HTTPS POST to the
//                 endpoint the device registered.
// Subscriptions that the push service says are gone (404/410) are removed. Endpoints on the local network are refused
// unless the admin allowed the local network (same switch as the browser's) — a push endpoint must not become a way to
// reach inside the network. Delivery goes through lib/outbound.js (decision #221): the address it connects to is the one
// it checked, and a redirect is checked again.
import * as webpush from 'web-push'; // v4 is ESM with named exports only
import { get, run } from '../db/index.js';
import { setEnvVar } from '../lib/envfile.js';
import { outboundFetch, localNetworkAllowed } from '../lib/outbound.js';

let vapid = null;
/** This install's VAPID keys (made once, kept in .env). */
export function vapidKeys() {
  if (vapid) return vapid;
  let pub = process.env.JESSBOT_VAPID_PUBLIC, priv = process.env.JESSBOT_VAPID_PRIVATE;
  if (!pub || !priv) {
    ({ publicKey: pub, privateKey: priv } = webpush.generateVAPIDKeys());
    setEnvVar('JESSBOT_VAPID_PUBLIC', pub);
    setEnvVar('JESSBOT_VAPID_PRIVATE', priv);
  }
  const admin = get(`SELECT email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`);
  webpush.setVapidDetails(`mailto:${admin?.email || 'owner@jessbot.local'}`, pub, priv);
  vapid = { publicKey: pub, privateKey: priv };
  return vapid;
}

const forget = device => run('DELETE FROM devices WHERE id = ?', device.id);

// https only (plain http only when the admin allowed the local network); where it may connect is outboundFetch's job.
function usableEndpoint(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' || (u.protocol === 'http:' && localNetworkAllowed());
}
// A refused address is 'skipped' (as before), never a delivery failure that counts against the device.
const deliver = (url, init) => outboundFetch(url, { ...init, signal: AbortSignal.timeout(10000) });

/** Deliver one notification to one device. Returns 'sent' | 'gone' | 'skipped' | 'failed'. */
export async function pushTo(device, message) {
  if (!device.push_token) return 'skipped';
  const payload = JSON.stringify({ title: message.title, body: message.body || '', href: message.href || '/chat', tag: message.tag || null, kind: message.kind });
  try {
    if (device.push_kind === 'webpush') {
      let sub;
      try { sub = JSON.parse(device.push_token); } catch { forget(device); return 'gone'; }
      if (!usableEndpoint(sub.endpoint)) return 'skipped';
      vapidKeys();
      // web-push encrypts the payload for this browser and signs the VAPID header; delivery is a plain fetch (same as UnifiedPush).
      const req = webpush.generateRequestDetails(sub, payload, { TTL: 3600, urgency: ['alarm', 'timer', 'reminder'].includes(message.kind) ? 'high' : 'normal' });
      const res = await deliver(req.endpoint, { method: req.method, headers: req.headers, body: req.body });
      if (res.status === 404 || res.status === 410) { forget(device); return 'gone'; }
      if (!res.ok) { console.warn(`[push] device ${device.id} (webpush): ${res.status}`, (await res.text().catch(() => '')).slice(0, 160)); return 'failed'; }
      return 'sent';
    }
    if (device.push_kind === 'unifiedpush' || device.push_kind === 'ntfy') {
      if (!usableEndpoint(device.push_token)) return 'skipped';
      const res = await deliver(device.push_token, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json', TTL: '3600' } });
      if (res.status === 404 || res.status === 410) { forget(device); return 'gone'; }
      return res.ok ? 'sent' : 'failed';
    }
    return 'skipped';
  } catch (err) {
    if (err.code === 'EBLOCKED') return 'skipped';
    if (err.statusCode === 404 || err.statusCode === 410) { forget(device); return 'gone'; }
    console.warn(`[push] device ${device.id} (${device.push_kind}):`, err.statusCode || '', String(err.body || err.message).slice(0, 160));
    return 'failed';
  }
}
