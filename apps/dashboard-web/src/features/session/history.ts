import {
  type DashboardLiveStore,
  dashboardHttpClient,
} from '@pi-dashboard/client';
import type {
  SessionApiResponse,
  SessionHistory,
} from '@pi-dashboard/protocol';
import type { RefObject } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

export function isContiguousOlderHistory(
  sessionId: string,
  pageMetadataId: string,
  pageHistory: SessionHistory | undefined,
  currentHistory: SessionHistory,
  currentNextBefore: string,
): boolean {
  return (
    pageMetadataId === sessionId &&
    Boolean(pageHistory) &&
    pageHistory?.version === currentHistory.version &&
    pageHistory.end === currentHistory.start &&
    pageHistory.start < currentHistory.start &&
    (!pageHistory.hasOlder ||
      (Boolean(pageHistory.nextBefore) &&
        pageHistory.nextBefore !== currentNextBefore))
  );
}

export function useOlderSessionHistory({
  id,
  data,
  store,
  scrollElementRef,
}: {
  id: string;
  data: SessionApiResponse | undefined;
  store: DashboardLiveStore;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
}) {
  const [history, setHistory] = useState<SessionApiResponse['history']>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const historySessionRef = useRef<string | undefined>(undefined);
  const historyGenerationRef = useRef(0);
  const historyRequestRef = useRef<
    | {
        id: string;
        generation: number;
        controller: AbortController;
      }
    | undefined
  >(undefined);
  const prependScrollRef = useRef<
    { scrollHeight: number; scrollTop: number } | undefined
  >(undefined);

  useEffect(() => {
    if (!id) return;
    historyGenerationRef.current += 1;
    historyRequestRef.current?.controller.abort();
    historyRequestRef.current = undefined;
    historySessionRef.current = undefined;
    setHistory(undefined);
    setHistoryLoading(false);
    setHistoryError(undefined);
    return () => {
      historyGenerationRef.current += 1;
      historyRequestRef.current?.controller.abort();
      historyRequestRef.current = undefined;
    };
  }, [id]);

  useEffect(() => {
    if (
      data?.metadata.id === id &&
      data.history &&
      historySessionRef.current !== id
    ) {
      historySessionRef.current = id;
      setHistory(data.history);
    }
  }, [data, id]);

  const loadEarlierHistory = useCallback(async () => {
    const currentHistory = history;
    if (
      historyLoading ||
      !currentHistory?.hasOlder ||
      !currentHistory.nextBefore
    )
      return;
    const scrollElement = scrollElementRef?.current;
    if (scrollElement)
      prependScrollRef.current = {
        scrollHeight: scrollElement.scrollHeight,
        scrollTop: scrollElement.scrollTop,
      };
    const request = {
      id,
      generation: historyGenerationRef.current,
      controller: new AbortController(),
    };
    historyRequestRef.current = request;
    setHistoryLoading(true);
    setHistoryError(undefined);
    const isCurrentRequest = () =>
      historyRequestRef.current === request &&
      historyGenerationRef.current === request.generation &&
      request.id === id &&
      !request.controller.signal.aborted;
    try {
      const page = await dashboardHttpClient.sessionBefore(
        id,
        currentHistory.nextBefore,
        request.controller.signal,
      );
      if (!isCurrentRequest()) return;
      if (
        !isContiguousOlderHistory(
          id,
          page.metadata.id,
          page.history,
          currentHistory,
          currentHistory.nextBefore,
        )
      )
        throw new Error('Dashboard returned non-contiguous older history.');
      if (!store.prependSessionHistory(page))
        throw new Error('Session changed while loading older history.');
      setHistory(page.history);
    } catch (loadError) {
      if (!isCurrentRequest()) return;
      if (loadError instanceof Error && loadError.name === 'AbortError') return;
      setHistoryError(
        loadError instanceof Error
          ? loadError.message
          : 'Could not load older history.',
      );
    } finally {
      if (isCurrentRequest()) {
        historyRequestRef.current = undefined;
        setHistoryLoading(false);
      }
    }
  }, [history, historyLoading, id, scrollElementRef, store]);

  useLayoutEffect(() => {
    void data;
    void history;
    const scrollElement = scrollElementRef?.current;
    const before = prependScrollRef.current;
    if (!scrollElement || !before) return;
    const delta = scrollElement.scrollHeight - before.scrollHeight;
    if (delta) scrollElement.scrollTop = before.scrollTop + delta;
    prependScrollRef.current = undefined;
  }, [data, history, scrollElementRef]);

  return {
    history,
    historyLoading,
    historyError,
    loadEarlierHistory,
  };
}
