import {
  type DashboardLiveStore,
  dashboardHttpClient,
  selectRuntimeForSession,
  selectSessionChange,
  sessionQueryOptions,
  useDashboardStore,
} from '@pi-dashboard/client';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

export function useSessionHydration({
  id,
  store,
  onReplacement,
}: {
  id: string;
  store: DashboardLiveStore;
  onReplacement: (sessionId: string) => void;
}) {
  const query = useQuery(sessionQueryOptions(dashboardHttpClient, id));
  const runtime = useDashboardStore(store, selectRuntimeForSession(id));
  const sessionChange = useDashboardStore(store, selectSessionChange(id));
  const resyncNonce = useDashboardStore(store, (state) => state.resyncNonce);
  const storedMetadata = useDashboardStore(
    store,
    (state) => state.sessionsById[id],
  );
  const projection = useDashboardStore(
    store,
    (state) => state.transcriptsBySessionId[id],
  );
  const data = query.data
    ? { ...query.data, metadata: storedMetadata ?? query.data.metadata }
    : undefined;
  const [error, setError] = useState<string>();
  const hydrationRetryCountRef = useRef(0);
  const sessionChangeRef = useRef({ id, value: sessionChange });
  const sessionRefetchRef = useRef<
    | {
        id: string;
        promise: ReturnType<typeof query.refetch>;
      }
    | undefined
  >(undefined);
  const refetchSession = query.refetch;
  const requestSessionRefetch = useCallback(() => {
    if (document.visibilityState !== 'visible') return undefined;
    const current = sessionRefetchRef.current;
    if (current?.id === id) return current.promise;
    if (current) sessionRefetchRef.current = undefined;
    const pending = refetchSession();
    const request = { id, promise: pending };
    sessionRefetchRef.current = request;
    void pending.then(
      () => {
        if (sessionRefetchRef.current === request)
          sessionRefetchRef.current = undefined;
      },
      () => {
        if (sessionRefetchRef.current === request)
          sessionRefetchRef.current = undefined;
      },
    );
    return pending;
  }, [id, refetchSession]);

  useEffect(() => {
    if (sessionRefetchRef.current?.id !== id)
      sessionRefetchRef.current = undefined;
    if (!id) return;
    setError(undefined);
    hydrationRetryCountRef.current = 0;
  }, [id]);

  useEffect(() => {
    // A refetch can reuse structurally equal data; its timestamp still marks a
    // new hydration attempt that must be evaluated.
    void query.dataUpdatedAt;
    if (!query.data) return;
    if (query.data.metadata.id !== id) {
      onReplacement(query.data.metadata.id);
      return;
    }
    if (store.hydrateSession(query.data)) {
      hydrationRetryCountRef.current = 0;
      setError(undefined);
      return;
    }
    const attempt = hydrationRetryCountRef.current;
    if (attempt >= 6) {
      setError('Session changed repeatedly while loading. Retry when ready.');
      return;
    }
    hydrationRetryCountRef.current = attempt + 1;
    setError('Session changed while loading; retrying…');
    const retry = window.setTimeout(
      () => void requestSessionRefetch(),
      Math.min(8_000, 250 * 2 ** attempt),
    );
    return () => window.clearTimeout(retry);
  }, [
    id,
    onReplacement,
    query.data,
    query.dataUpdatedAt,
    requestSessionRefetch,
    store,
  ]);

  useEffect(() => {
    const previous = sessionChangeRef.current;
    sessionChangeRef.current = { id, value: sessionChange };
    if (previous.id !== id || previous.value === sessionChange) return;
    void requestSessionRefetch();
  }, [id, requestSessionRefetch, sessionChange]);

  useEffect(() => {
    if (resyncNonce > 0) void requestSessionRefetch();
  }, [requestSessionRefetch, resyncNonce]);

  useEffect(() => {
    const reconcileWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      hydrationRetryCountRef.current = 0;
      void requestSessionRefetch();
    };
    document.addEventListener('visibilitychange', reconcileWhenVisible);
    return () =>
      document.removeEventListener('visibilitychange', reconcileWhenVisible);
  }, [requestSessionRefetch]);

  const retrySession = useCallback(() => {
    hydrationRetryCountRef.current = 0;
    setError(undefined);
    void requestSessionRefetch();
  }, [requestSessionRefetch]);

  return {
    data,
    queryError: query.error,
    runtime,
    sessionChange,
    storedMetadata,
    error,
    retrySession,
    projection,
    waitingForInitialHistory:
      (data?.entriesComplete === false ||
        data?.completeThroughCursor === false) &&
      (!projection || projection.order.length === 0),
  };
}

export type SessionHydration = ReturnType<typeof useSessionHydration>;
