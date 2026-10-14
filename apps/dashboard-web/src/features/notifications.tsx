import {
  dashboardHttpClient,
  pushSubscribeMutationOptions,
  pushVapidPublicKeyQueryOptions,
} from '@pi-dashboard/client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  cancelNativeAuthorization,
  enableNativeNotifications,
  nativeStatus,
} from './native-notifications';

export function PushButton() {
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [nativePending, setNativePending] = useState(false);
  const [nativeCancelable, setNativeCancelable] = useState(false);
  const nativeRequest = useRef<
    { controller: AbortController; committed: boolean } | undefined
  >(undefined);
  const [status, setStatus] = useState<'off' | 'on' | 'unavailable'>('off');
  const keyQuery = useQuery({
    ...pushVapidPublicKeyQueryOptions(dashboardHttpClient),
    enabled: false,
  });
  const subscribeMutation = useMutation(
    pushSubscribeMutationOptions(dashboardHttpClient),
  );

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      const native = await nativeStatus().catch(() => undefined);
      if (native?.available) {
        if (!cancelled) {
          setNativeAvailable(true);
          setStatus(native.enabled ? 'on' : 'off');
        }
        return;
      }
      if (
        !('serviceWorker' in navigator) ||
        !('PushManager' in window) ||
        !('Notification' in window)
      ) {
        if (!cancelled) setStatus('unavailable');
        return;
      }
      if (Notification.permission === 'denied') {
        if (!cancelled) setStatus('unavailable');
        return;
      }
      if (Notification.permission !== 'granted') return;
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!cancelled && subscription) setStatus('on');
    };
    void initialize().catch(() => {
      if (!cancelled) setStatus('unavailable');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = async (signal: AbortSignal, onNativeCommitted: () => void) => {
    if (nativeAvailable) {
      await enableNativeNotifications(signal, onNativeCommitted);
      setStatus('on');
      return;
    }
    if (
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)
    ) {
      setStatus('unavailable');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setStatus(permission === 'denied' ? 'unavailable' : 'off');
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      setStatus('on');
      return;
    }
    const keyResponse = (await keyQuery.refetch()).data;
    if (!keyResponse?.publicKey) {
      setStatus('unavailable');
      return;
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(keyResponse.publicKey),
    });
    await subscribeMutation.mutateAsync(subscription.toJSON());
    setStatus('on');
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          const request = {
            controller: new AbortController(),
            committed: false,
          };
          nativeRequest.current = request;
          if (nativeAvailable) {
            setNativePending(true);
            setNativeCancelable(true);
          }
          void enable(request.controller.signal, () => {
            request.committed = true;
            setNativeCancelable(false);
          })
            .catch(() => {
              if (!request.controller.signal.aborted) setStatus('unavailable');
            })
            .finally(() => {
              if (request === nativeRequest.current) {
                setNativePending(false);
                setNativeCancelable(false);
              }
            });
        }}
        disabled={status === 'on' || nativePending}
      >
        {nativePending
          ? nativeCancelable
            ? 'Waiting for Mac permission…'
            : 'Finishing Mac notification setup…'
          : status === 'on'
            ? nativeAvailable
              ? 'Mac notifications enabled'
              : 'Push enabled'
            : status === 'unavailable'
              ? nativeAvailable
                ? 'Mac notifications unavailable'
                : 'Push unavailable'
              : nativeAvailable
                ? 'Enable Mac notifications'
                : 'Enable push'}
      </button>
      {nativePending && nativeCancelable && (
        <button
          type="button"
          onClick={() => {
            const request = nativeRequest.current;
            if (!request || request.committed) return;
            request.controller.abort();
            nativeRequest.current = undefined;
            setNativeCancelable(false);
            void cancelNativeAuthorization()
              .then(() => setStatus('off'))
              .catch(() => setStatus('unavailable'))
              .finally(() => setNativePending(false));
          }}
        >
          Cancel notification request
        </button>
      )}
    </>
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
