import { useSyncExternalStore } from 'react';
import type { DashboardLiveState, DashboardLiveStore } from './store.js';

/** React-only binding for the framework-neutral DashboardLiveStore. */
export function useDashboardStore<T>(
  store: DashboardLiveStore,
  selector: (state: DashboardLiveState) => T,
): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot()),
  );
}
