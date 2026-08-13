const DASHBOARD_BUILD_ID = '__PI_DASHBOARD_BUILD_ID__';
void DASHBOARD_BUILD_ID;

self.addEventListener('install', (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      const cacheKeys = await caches.keys();
      await Promise.all(
        cacheKeys
          .filter((key) => key.startsWith('pi-dashboard-'))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
      await Promise.all(
        windows.map((client) => client.navigate(client.url).catch(() => null)),
      );
    })(),
  ),
);
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
