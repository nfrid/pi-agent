import {
  type DashboardLiveStore,
  selectRuntimeForSession,
  selectSessionChange,
  selectSessionSnapshot,
  useDashboardStore,
} from '@pi-dashboard/client';
import { useCallback, useEffect } from 'react';

export function useSessionHydration({
  id,
  store,
  onReplacement,
}: {
  id: string;
  store: DashboardLiveStore;
  onReplacement: (sessionId: string) => void;
}) {
  const runtime = useDashboardStore(store, selectRuntimeForSession(id));
  const sessionChange = useDashboardStore(store, selectSessionChange(id));
  const sessionSnapshot = useDashboardStore(store, selectSessionSnapshot(id));
  const sessionSync = useDashboardStore(
    store,
    (state) => state.sessionSyncById[id],
  );
  const storedMetadata = useDashboardStore(
    store,
    (state) => state.sessionsById[id],
  );
  const projection = useDashboardStore(
    store,
    (state) => state.transcriptsBySessionId[id],
  );
  const data = sessionSnapshot
    ? {
        ...sessionSnapshot,
        metadata: storedMetadata ?? sessionSnapshot.metadata,
      }
    : undefined;

  useEffect(() => {
    if (!id) return;
    const subscription = store.acquireSession(id);
    return () => subscription?.release();
  }, [id, store]);

  useEffect(() => {
    if (sessionSnapshot && sessionSnapshot.metadata.id !== id)
      onReplacement(sessionSnapshot.metadata.id);
  }, [id, onReplacement, sessionSnapshot]);

  const retrySession = useCallback(() => {
    store.reconnectSession(id);
  }, [id, store]);

  return {
    data,
    queryError: null,
    runtime,
    sessionChange,
    storedMetadata,
    error: sessionSync?.status === 'error' ? sessionSync.error : undefined,
    retrySession,
    projection,
    waitingForInitialHistory:
      (data?.entriesComplete === false ||
        data?.completeThroughCursor === false) &&
      (!projection || projection.order.length === 0),
  };
}

export type SessionHydration = ReturnType<typeof useSessionHydration>;
