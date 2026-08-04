import {
  dashboardHttpClient,
  notificationReadMutationOptions,
  pushSubscribeMutationOptions,
  pushVapidPublicKeyQueryOptions,
} from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

export function PushButton() {
  const [status, setStatus] = useState<'off' | 'on' | 'unavailable'>('off');
  const keyQuery = useQuery({
    ...pushVapidPublicKeyQueryOptions(dashboardHttpClient),
    enabled: false,
  });
  const subscribeMutation = useMutation(
    pushSubscribeMutationOptions(dashboardHttpClient),
  );
  const enable = async () => {
    if (
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)
    ) {
      setStatus('unavailable');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const keyResponse = (await keyQuery.refetch()).data;
    if (!keyResponse?.publicKey) {
      setStatus('unavailable');
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(keyResponse.publicKey),
    });
    await subscribeMutation.mutateAsync(subscription.toJSON());
    setStatus('on');
  };
  return (
    <button
      type="button"
      className="push-button"
      onClick={() => void enable().catch(() => setStatus('unavailable'))}
    >
      {status === 'on'
        ? 'Notifications on'
        : status === 'unavailable'
          ? 'Push unavailable'
          : 'Enable notifications'}
    </button>
  );
}

function decodeVapidKey(value: string): ArrayBuffer {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer as ArrayBuffer;
}

export function NotificationList({
  notifications,
}: {
  notifications: BrowserSnapshot['unread'];
}) {
  const [error, setError] = useState<string>();
  const [browserAlerts, setBrowserAlerts] = useState<
    'off' | 'on' | 'unavailable'
  >('off');
  const enableBrowserAlerts = async () => {
    if (!('Notification' in window)) {
      setBrowserAlerts('unavailable');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    setBrowserAlerts('on');
    // This is a local fallback when Push/VAPID is unavailable. It is bounded
    // to the visible notification slice and never retries a failed delivery.
    for (const notification of notifications.slice(0, 8))
      new Notification(notification.title, { body: notification.body });
  };
  const readMutation = useMutation(
    notificationReadMutationOptions(dashboardHttpClient),
  );
  const queryClient = useQueryClient();
  const markingAll = readMutation.isPending;
  const markRead = async (id: string) => {
    try {
      await readMutation.mutateAsync({ id });
      setError(undefined);
      await queryClient.invalidateQueries({
        queryKey: ['dashboard', 'notifications'],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const markAllRead = async () => {
    try {
      await readMutation.mutateAsync({ all: true });
      setError(undefined);
      await queryClient.invalidateQueries({
        queryKey: ['dashboard', 'notifications'],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <section className="notifications" aria-labelledby="notifications-heading">
      <div className="workspace-title">
        <span id="notifications-heading">Unread events</span>
        <span className="notification-actions">
          <span>{notifications.length}</span>
          <button
            type="button"
            onClick={() => void markAllRead()}
            disabled={markingAll}
          >
            {markingAll ? 'Reading…' : 'Read all'}
          </button>
          <button
            type="button"
            onClick={() => void enableBrowserAlerts()}
            disabled={browserAlerts === 'on' || !notifications.length}
          >
            {browserAlerts === 'on'
              ? 'Browser alerts on'
              : browserAlerts === 'unavailable'
                ? 'Alerts unavailable'
                : 'Browser alerts'}
          </button>
        </span>
      </div>
      {error && (
        <p className="error" role="alert">
          Could not update notification: {error}
        </p>
      )}
      {notifications.slice(0, 8).map((notification) => (
        <article className="notification" key={notification.id}>
          <div>
            <strong>{notification.title}</strong>
            <p>{notification.body}</p>
          </div>
          <button type="button" onClick={() => void markRead(notification.id)}>
            Mark read
          </button>
        </article>
      ))}
    </section>
  );
}

export function UsagePanel({
  usage,
  error,
}: {
  usage: unknown;
  error?: string;
}) {
  const snapshots =
    usage &&
    typeof usage === 'object' &&
    Array.isArray((usage as Record<string, unknown>).snapshots)
      ? ((usage as Record<string, unknown>).snapshots as unknown[])
      : [];
  return (
    <section className="usage-panel" aria-labelledby="usage-heading">
      <div className="workspace-title">
        <span id="usage-heading">Usage</span>
        <span>{snapshots.length ? 'latest' : 'reported'}</span>
      </div>
      {error && (
        <p className="error" role="alert">
          Usage unavailable: {error}
        </p>
      )}
      {snapshots.length ? (
        snapshots.map((item, index) => {
          const record =
            item && typeof item === 'object'
              ? (item as Record<string, unknown>)
              : {};
          const primary =
            record.primary && typeof record.primary === 'object'
              ? (record.primary as Record<string, unknown>)
              : undefined;
          const used =
            typeof primary?.usedPercent === 'number'
              ? `${Math.round(primary.usedPercent)}% used`
              : 'window reported';
          return (
            <div className="usage-row" key={String(record.limitId ?? index)}>
              <strong>
                {String(record.limitName ?? record.limitId ?? 'limit')}
              </strong>
              <span>{used}</span>
            </div>
          );
        })
      ) : (
        <p className="muted">Usage data is unavailable.</p>
      )}
    </section>
  );
}
