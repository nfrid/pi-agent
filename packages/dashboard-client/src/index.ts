export * from './authentication.js';
export * from './event-stream.js';
export * from './http-client.js';
export * from './query-options.js';
export * from './store.js';

import { useEffect, useRef } from 'react';
import type { DashboardHttpClient } from './http-client.js';
import { dashboardHttpClient } from './http-client.js';
import { DashboardLiveStore, useDashboardStore } from './store.js';

export interface DashboardState {
  snapshot: ReturnType<DashboardLiveStore['getSnapshot']>['snapshot'];
  error?: string;
  usageError?: string;
  events: ReturnType<DashboardLiveStore['getSnapshot']>['recentEvents'];
  cursorHistory: ReturnType<DashboardLiveStore['getSnapshot']>['cursorHistory'];
  cursor: number;
  resyncNonce: number;
  connectionState: ReturnType<
    DashboardLiveStore['getSnapshot']
  >['connection']['status'];
  store: DashboardLiveStore;
}

/** React adapter for the client-owned store and SSE lifecycle. */
export function useDashboard(
  client: DashboardHttpClient = dashboardHttpClient,
): DashboardState {
  const storeRef = useRef<DashboardLiveStore | undefined>(undefined);
  if (!storeRef.current) storeRef.current = new DashboardLiveStore();
  const store = storeRef.current;
  const state = useDashboardStore(store, (current) => current);

  useEffect(() => {
    const stop = store.connect(client);
    const onOnline = () => store.reconnect();
    const onOffline = () => store.setConnection('reconnecting');
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      document.addEventListener('visibilitychange', onOnline);
    }
    return () => {
      stop();
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
        document.removeEventListener('visibilitychange', onOnline);
      }
    };
  }, [client, store]);

  return {
    snapshot: state.snapshot,
    error: state.connection.error,
    usageError: state.usageError,
    events: state.recentEvents,
    cursorHistory: state.cursorHistory,
    cursor: state.cursor,
    resyncNonce: state.resyncNonce,
    connectionState: state.connection.status,
    store,
  };
}
