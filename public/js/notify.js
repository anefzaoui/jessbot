// `notify` frames (decision #32): when this tab is hidden → a system notification (if allowed); when visible → a toast,
// unless the thing is already on screen (the chat it points to, or the ringing dock for alarms).
import { $, on, api, storage, withBusy } from './core.js';
import { toast } from './toast.js';

const seen = new Set();
const shown = tag => {
  if (!tag) return false;
  try {
    const list = JSON.parse(sessionStorage.getItem('jb-notified') || '[]');
    if (list.includes(tag)) return true;
    sessionStorage.setItem('jb-notified', JSON.stringify([...list.slice(-50), tag]));
  } catch {
    if (seen.has(tag)) return true;
    seen.add(tag);
  }
  return false;
};

const onScreen = ({ kind, href }) => {
  if (kind === 'alarm' || kind === 'timer') return !!$('[data-alarm-dock]'); // the ringing dock shows it
  const threadId = $('[data-chat]')?.dataset.threadId;
  return !!threadId && (href === location.pathname || (href === `/chat/${threadId}` && location.pathname.startsWith('/chat')));
};

function show(n) {
  if (shown(n.tag)) return;
  if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
    const note = new Notification(n.title, { body: n.body, tag: n.tag || undefined, icon: $('link[rel="icon"]')?.href, silent: n.kind !== 'alarm' && n.kind !== 'timer' });
    note.onclick = () => { window.focus(); if (n.href) location.assign(n.href); note.close(); };
    return;
  }
  if (onScreen(n)) return;
  toast(n.body || n.title, { title: n.body ? n.title : undefined, action: n.href ? { label: 'Open', onClick: () => location.assign(n.href) } : undefined });
}

export function initNotify() {
  document.addEventListener('jb:ws:notify', e => show(e.detail.data));

  // "Notifications on this device" (You → Notifications): Web Push through our service worker (decision #85), so alarms and
  // messages arrive even when Jessbot is closed. Contract: GET /api/v1/push/key · POST /api/v1/devices · DELETE /api/v1/devices/:id.
  const btn = $('[data-enable-notifications]');
  if (!btn) return;
  const state = $('[data-notifications-state]');
  const testBtn = $('[data-test-push]'), offBtn = $('[data-disable-push]');
  const pushable = 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
  const subscription = async () => (pushable ? (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription() : null);
  const render = async () => {
    const p = 'Notification' in window ? Notification.permission : 'unsupported';
    const sub = await subscription().catch(() => null);
    btn.hidden = p === 'denied' || p === 'unsupported' || !!sub;
    testBtn.hidden = offBtn.hidden = !sub;
    state.textContent = sub ? 'On, even when Jessbot is closed.'
      : p === 'denied' ? 'Blocked. Allow notifications for this site in the browser’s settings.'
        : p === 'unsupported' ? 'Not supported in this browser.'
          : !pushable ? (p === 'granted' ? 'On while Jessbot is open. (When it’s closed needs HTTPS.)' : 'While Jessbot is open. (When it’s closed needs HTTPS.)') : '';
  };
  render();
  const b64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
  on(document, 'click', '[data-enable-notifications]', (e, b) => withBusy(b, async () => {
    try {
      if ((await Notification.requestPermission()) !== 'granted') { await render(); return; }
      if (pushable) {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        const { publicKey } = await api('/api/v1/push/key');
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
        const name = /Android/.test(navigator.userAgent) ? 'Android browser' : /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Edg\//.test(navigator.userAgent) ? 'Edge' : /Firefox/.test(navigator.userAgent) ? 'Firefox' : 'Browser';
        const { device } = await api('/api/v1/devices', { method: 'POST', body: { platform: 'web', name, pushKind: 'webpush', pushToken: JSON.stringify(sub) } });
        storage.set('jb-push-device', device.id);
      }
      toast.success(pushable ? 'Notifications are on, even when Jessbot is closed.' : 'Notifications are on while Jessbot is open.');
    } catch (err) { toast.error(err.message, { title: 'Couldn’t turn notifications on' }); }
    await render();
  }, 'Turning on…'));
  on(document, 'click', '[data-test-push]', (e, b) => withBusy(b, async () => {
    try { const r = await api('/api/v1/push/test', { method: 'POST' }); toast(r.sent ? 'Sent. It should appear in a moment.' : 'Nothing could be delivered. Try turning notifications off and on.'); }
    catch (err) { toast.error(err.message); }
  }, 'Sending…'));
  on(document, 'click', '[data-disable-push]', (e, b) => withBusy(b, async () => {
    try {
      const sub = await subscription();
      await sub?.unsubscribe();
      const id = storage.get('jb-push-device');
      if (id) await api(`/api/v1/devices/${id}`, { method: 'DELETE' }).catch(() => {});
      storage.remove('jb-push-device');
      toast('Notifications are off for this device.');
    } catch (err) { toast.error(err.message); }
    await render();
  }, 'Turning off…'));
}
