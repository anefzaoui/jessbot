// Push transport (Phase 12, decision #85): reaching someone whose Jessbot isn't open. Two self-hostable transports, no
// Google account needed on the server:
//   webpush     — browsers and installed PWAs (Chrome/Edge/Firefox/Safari, Android included) via the Web Push protocol,
//                 VAPID keys made per install (in .env). The page's service worker (public/sw.js) shows the notification.
//   unifiedpush — the Android app (later) through any UnifiedPush distributor, e.g. ntfy: a plain HTTPS POST to the
//                 endpoint the device registered.
// Subscriptions that the push service says are gone (404/410) are removed. Endpoints on the local network are refused
// unless the admin allowed the local network (same switch as the browser's) — a push endpoint must not become a way to
// reach inside the network.
import webpush from 'web-push';
import { get, run } from '../db/index.js';
import { setEnvVar } from '../lib/envfile.js';
import { isPrivateUrl, browserSettings } from '../browser/index.js';

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

async function publicEndpoint(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && !browserSettings().allowPrivate) return false;
  return browserSettings().allowPrivate || !(await isPrivateUrl(u.href));
}

/** Deliver one notification to one device. Returns 'sent' | 'gone' | 'skipped' | 'failed'. */
export async function pushTo(device, message) {
  if (!device.push_token) return 'skipped';
  const payload = JSON.stringify({ title: message.title, body: message.body || '', href: message.href || '/chat', tag: message.tag || null, kind: message.kind });
  try {
    if (device.push_kind === 'webpush') {
      let sub;
      try { sub = JSON.parse(device.push_token); } catch { forget(device); return 'gone'; }
      if (!(await publicEndpoint(sub.endpoint))) return 'skipped';
      vapidKeys();
      // web-push encrypts the payload for this browser and signs the VAPID header; delivery is a plain fetch (same as UnifiedPush).
      const req = webpush.generateRequestDetails(sub, payload, { TTL: 3600, urgency: ['alarm', 'timer', 'reminder'].includes(message.kind) ? 'high' : 'normal' });
      const res = await fetch(req.endpoint, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(10000) });
      if (res.status === 404 || res.status === 410) { forget(device); return 'gone'; }
      if (!res.ok) { console.warn(`[push] device ${device.id} (webpush): ${res.status}`, (await res.text().catch(() => '')).slice(0, 160)); return 'failed'; }
      return 'sent';
    }
    if (device.push_kind === 'unifiedpush' || device.push_kind === 'ntfy') {
      if (!(await publicEndpoint(device.push_token))) return 'skipped';
      const res = await fetch(device.push_token, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json', TTL: '3600' }, signal: AbortSignal.timeout(10000) });
      if (res.status === 404 || res.status === 410) { forget(device); return 'gone'; }
      return res.ok ? 'sent' : 'failed';
    }
    return 'skipped';
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) { forget(device); return 'gone'; }
    console.warn(`[push] device ${device.id} (${device.push_kind}):`, err.statusCode || '', String(err.body || err.message).slice(0, 160));
    return 'failed';
  }
}
