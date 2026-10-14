import { dashboardHttpClient } from '@pi-dashboard/client';
import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

export const nativeEndpoint = 'native:installed-pwa';
export function isLocalInstalledDashboard(): boolean {
  return (
    location.origin === 'http://127.0.0.1:4174' &&
    ['standalone', 'window-controls-overlay'].some(
      (mode) => matchMedia(`(display-mode: ${mode})`).matches,
    )
  );
}
export async function nativeStatus() {
  if (!isLocalInstalledDashboard())
    return { available: false, enabled: false, permission: 'unavailable' };
  const client = await dashboardHttpClient.getTrpcClient();
  return client.nativeControl.mutate({ action: 'status' });
}
export async function enableNativeNotifications(
  signal: AbortSignal,
  onCommitted: () => void,
): Promise<boolean> {
  signal.throwIfAborted();
  if (!isLocalInstalledDashboard()) return false;
  const registration =
    'serviceWorker' in navigator
      ? await navigator.serviceWorker.ready
      : undefined;
  signal.throwIfAborted();
  const subscription = await registration?.pushManager.getSubscription();
  signal.throwIfAborted();
  const client = await dashboardHttpClient.getTrpcClient();
  signal.throwIfAborted();
  const status = await client.nativeControl.mutate(
    {
      action: 'enable',
      endpoint: subscription?.endpoint,
    },
    { signal },
  );
  signal.throwIfAborted();
  if (!status.enabled)
    throw new Error(`Native permission: ${status.permission}`);
  signal.throwIfAborted();
  onCommitted();
  try {
    await subscription?.unsubscribe();
  } catch {
    // Native activation committed server-side; keep it enabled even if the
    // browser cannot remove its now-unregistered Web Push subscription.
  }
  window.dispatchEvent(new Event('native-notifications-enabled'));
  return true;
}

export async function cancelNativeAuthorization(): Promise<void> {
  const client = await dashboardHttpClient.getTrpcClient();
  await client.nativeControl.mutate({ action: 'disable' });
  // The server may have committed enablement and removed this exact endpoint
  // just before the browser canceled its response. Restore only this browser.
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription)
    await dashboardHttpClient.subscribePush(subscription.toJSON());
}

export function NativeClickNavigation() {
  const router = useRouter();
  useEffect(() => {
    if (!isLocalInstalledDashboard()) return;
    let disposed = false;
    let subscription: { unsubscribe(): void } | undefined;
    void dashboardHttpClient
      .getTrpcClient()
      .then((client) => {
        if (disposed) return;
        subscription = client.nativeClicks.subscribe(undefined, {
          onData(click) {
            if (
              !/^\/(sessions|runtimes)\/[^/]+$/.test(click.path) &&
              click.path !== '/'
            )
              return;
            void router
              .navigate({ to: click.path })
              .then(() =>
                client.nativeControl.mutate({ action: 'ack', id: click.id }),
              )
              .catch(() => undefined);
          },
        });
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      subscription?.unsubscribe();
    };
  }, [router]);
  return null;
}
