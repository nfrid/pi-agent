export * from './authentication.js';
export * from './event-stream.js';
export * from './http-client.js';
export * from './query-options.js';
export * from './store.js';

import { useEffect, useRef } from 'react';
import type { DashboardHttpClient } from './http-client.js';
import { dashboardHttpClient } from './http-client.js';
import {
  DashboardLiveStore,
  selectSnapshot,
  useDashboardStore,
} from './store.js';

export interface DashboardState {
  snapshot: ReturnType<typeof selectSnapshot>;
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

export type DashboardShellState = Omit<
  DashboardState,
  'events' | 'cursorHistory' | 'cursor' | 'resyncNonce'
>;

function useConnectedDashboardStore(client: DashboardHttpClient) {
  const storeRef = useRef<DashboardLiveStore | undefined>(undefined);
  if (!storeRef.current) storeRef.current = new DashboardLiveStore();
  const store = storeRef.current;

  useEffect(() => {
    const stop = store.connect(client);
    const onOnline = () => store.reconnect();
    const onOffline = () => store.setConnection('reconnecting');
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') store.reconnect();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      stop();
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [client, store]);

  return store;
}

/** Full compatibility adapter, including raw stream metadata. */
export function useDashboard(
  client: DashboardHttpClient = dashboardHttpClient,
): DashboardState {
  const store = useConnectedDashboardStore(client);
  const state = useDashboardStore(store, (current) => current);
  const snapshot = useDashboardStore(store, selectSnapshot);
  return {
    snapshot,
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

/**
 * Optimized application-shell adapter. Transcript routes use dedicated entity
 * selectors, so token records must not rerender the router, header, and page.
 */
export function useDashboardShell(
  client: DashboardHttpClient = dashboardHttpClient,
): DashboardShellState {
  const store = useConnectedDashboardStore(client);
  const snapshot = useDashboardStore(store, selectSnapshot);
  const error = useDashboardStore(store, (state) => state.connection.error);
  const usageError = useDashboardStore(store, (state) => state.usageError);
  const connectionState = useDashboardStore(
    store,
    (state) => state.connection.status,
  );
  return { snapshot, error, usageError, connectionState, store };
}
