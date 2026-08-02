const CACHE = 'pi-dashboard-v1';
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/']))));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached || caches.match('/'))));
});
self.addEventListener('push', (event) => {
  const data = event.data?.json?.() || {};
  if (data.clear && data.runtimeId) {
    event.waitUntil(self.registration.getNotifications({ tag: `waiting-${data.runtimeId}` }).then((notifications) => notifications.forEach((notification) => notification.close())));
    return;
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Pi Dashboard', { body: data.body || 'Pi needs attention', tag: data.kind && data.runtimeId ? `${data.kind}-${data.runtimeId}` : 'pi-dashboard', data: { url: data.url || '/' } }));
});
self.addEventListener('notificationclick', (event) => { event.notification.close(); event.waitUntil(clients.openWindow(event.notification.data?.url || '/')); });
