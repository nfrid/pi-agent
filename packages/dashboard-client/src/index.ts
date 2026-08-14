export * from './authentication.js';
export * from './connection-runtime.js';
export * from './http-client.js';
export * from './query-options.js';
export * from './store.js';
export * from './trpc-client.js';

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
  errorKind?: ReturnType<
    DashboardLiveStore['getSnapshot']
  >['connection']['errorKind'];
  usageError?: string;
  connectionState: ReturnType<
    DashboardLiveStore['getSnapshot']
  >['connection']['status'];
  store: DashboardLiveStore;
}

export type DashboardShellState = DashboardState;

function useConnectedDashboardStore(client: DashboardHttpClient) {
  const storeRef = useRef<DashboardLiveStore | undefined>(undefined);
  if (!storeRef.current) storeRef.current = new DashboardLiveStore();
  const store = storeRef.current;

  useEffect(() => store.connect(client), [client, store]);
  return store;
}

/** Normalized dashboard state for non-shell consumers. */
export function useDashboard(
  client: DashboardHttpClient = dashboardHttpClient,
): DashboardState {
  const store = useConnectedDashboardStore(client);
  const state = useDashboardStore(store, (current) => current);
  const snapshot = useDashboardStore(store, selectSnapshot);
  return {
    snapshot,
    error: state.connection.error,
    errorKind: state.connection.errorKind,
    usageError: state.usageError,
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
  const errorKind = useDashboardStore(
    store,
    (state) => state.connection.errorKind,
  );
  const usageError = useDashboardStore(store, (state) => state.usageError);
  const connectionState = useDashboardStore(
    store,
    (state) => state.connection.status,
  );
  return {
    snapshot,
    error,
    errorKind,
    usageError,
    connectionState,
    store,
  };
}
