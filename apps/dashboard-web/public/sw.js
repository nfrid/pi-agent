const DASHBOARD_BUILD_ID = '__PI_DASHBOARD_BUILD_ID__';
const CACHE_PREFIX = 'pi-dashboard-';
const CACHE = `${CACHE_PREFIX}${DASHBOARD_BUILD_ID}`;

self.addEventListener('install', (event) =>
  event.waitUntil(
    (async () => {
      await self.skipWaiting();
      try {
        const response = await fetch('/', { cache: 'no-store' });
        if (response.ok) await (await caches.open(CACHE)).put('/', response);
      } catch {
        // Cache population is best effort; activation must not be blocked.
      }
    })(),
  ),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate')
    return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        if (response.ok)
          event.waitUntil(
            caches
              .open(CACHE)
              .then((cache) => cache.put('/', response.clone()))
              .catch(() => undefined),
          );
        return response;
      } catch {
        return (await caches.match('/')) ?? Response.error();
      }
    })(),
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
