import { dashboardHttpClient } from '@pi-dashboard/client';
import { useEffect, useRef, useState } from 'react';

const REFRESH_MS = 10_000;

function routeTarget(pathname: string): {
  sessionId?: string;
  runtimeId?: string;
} {
  const match = pathname.match(/^\/(sessions|runtimes)\/([^/]+)\/?$/);
  if (!match?.[1] || !match[2]) return {};
  let id: string;
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    return {};
  }
  return match[1] === 'sessions' ? { sessionId: id } : { runtimeId: id };
}

export function PushForegroundPresence({ pathname }: { pathname: string }) {
  const requests = useRef(Promise.resolve());
  const [currentTabId] = useState(() => {
    if (
      typeof navigator === 'undefined' ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      typeof globalThis.crypto?.randomUUID !== 'function'
    )
      return undefined;
    return globalThis.crypto.randomUUID();
  });

  useEffect(() => {
    if (!currentTabId) return;
    let disposed = false;
    const target = routeTarget(pathname);
    let endpoint: string | undefined;
    let discovery: Promise<void> | undefined;
    const enqueue = (
      report: Parameters<typeof dashboardHttpClient.reportPushForeground>[0],
      keepalive = false,
    ) => {
      requests.current = requests.current
        .catch(() => undefined)
        .then(() => dashboardHttpClient.reportPushForeground(report, keepalive))
        .catch(() => undefined);
    };
    const discoverSubscription = () => {
      if (
        endpoint ||
        discovery ||
        disposed ||
        (!target.sessionId && !target.runtimeId)
      )
        return;
      discovery = navigator.serviceWorker?.ready
        .then((registration) => registration.pushManager.getSubscription())
        .then((subscription) => {
          if (!disposed && subscription) {
            endpoint = subscription.endpoint;
            update();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          discovery = undefined;
        });
    };
    const update = () => {
      if (disposed) return;
      if (!endpoint) {
        discoverSubscription();
        return;
      }
      const active =
        document.visibilityState === 'visible' &&
        document.hasFocus() &&
        Boolean(target.sessionId || target.runtimeId);
      enqueue({
        endpoint,
        tabId: currentTabId,
        visible: active,
        focused: active,
        ...(active ? target : {}),
      });
    };
    const clear = (keepalive = false) => {
      if (!endpoint) return;
      enqueue(
        {
          endpoint,
          tabId: currentTabId,
          visible: false,
          focused: false,
        },
        keepalive,
      );
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') clear();
      else update();
    };
    const onBlur = () => clear();
    const onFocus = () => update();
    const onPageHide = () => clear(true);

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onFocus);
    window.addEventListener('pagehide', onPageHide);
    const interval = window.setInterval(update, REFRESH_MS);
    update();

    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onFocus);
      window.removeEventListener('pagehide', onPageHide);
      clear(true);
    };
  }, [currentTabId, pathname]);

  return null;
}
