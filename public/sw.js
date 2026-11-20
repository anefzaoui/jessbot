// Jessbot service worker (decision #85) — only for push: shows a notification when Jessbot isn't open and opens the right
// page when it's tapped. No caching, no fetch handling: the app is always served fresh by the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let n = {};
  try { n = e.data ? e.data.json() : {}; } catch { n = { title: 'Jessbot', body: e.data?.text() || '' }; }
  const urgent = ['alarm', 'timer', 'reminder'].includes(n.kind);
  e.waitUntil(self.registration.showNotification(n.title || 'Jessbot', {
    body: n.body || '', tag: n.tag || undefined, renotify: !!n.tag, requireInteraction: urgent,
    icon: '/img/favicon.svg', badge: '/img/favicon.svg', data: { href: n.href || '/chat' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const href = new URL(e.notification.data?.href || '/chat', self.location.origin).href;
  e.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = tabs.find(t => new URL(t.url).origin === self.location.origin);
    if (open) { await open.focus(); return open.navigate(href).catch(() => {}); }
    return self.clients.openWindow(href);
  })());
});
