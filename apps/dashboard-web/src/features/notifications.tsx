import {
  dashboardHttpClient,
  pushSubscribeMutationOptions,
  pushVapidPublicKeyQueryOptions,
} from '@pi-dashboard/client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export function PushButton() {
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
    <button
      type="button"
      onClick={() => void enable().catch(() => setStatus('unavailable'))}
      disabled={status === 'on'}
    >
      {status === 'on'
        ? 'Push enabled'
        : status === 'unavailable'
          ? 'Push unavailable'
          : 'Enable push'}
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
