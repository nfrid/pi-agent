const CACHE = 'pi-dashboard-v2';
self.addEventListener('install', (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/']))),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key !== CACHE)
              .map((key) => caches.delete(key)),
          ),
        ),
    ]),
  ),
);
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches
        .match(event.request)
        .then(
          (cached) =>
            cached ||
            (event.request.mode === 'navigate' ? caches.match('/') : undefined),
        ),
    ),
  );
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
self.addEventListener('push', (event) => {
  const data = event.data?.json?.() || {};
  if (data.clear && data.runtimeId) {
    event.waitUntil(
      self.registration
        .getNotifications({ tag: `waiting-${data.runtimeId}` })
        .then((notifications) => {
          for (const notification of notifications) notification.close();
        }),
    );
    return;
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Pi Dashboard', {
      body: data.body || 'Pi needs attention',
      tag:
        data.kind && data.runtimeId
          ? `${data.kind}-${data.runtimeId}`
          : 'pi-dashboard',
      data: { url: data.url || '/' },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/'));
});
