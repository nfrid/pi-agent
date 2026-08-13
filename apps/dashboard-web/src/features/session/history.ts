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

type ScrollAnchor = {
  scrollHeight: number;
  scrollTop: number;
};

type HistoryRequest = {
  id: string;
  generation: number;
  requestId: number;
  controller: AbortController;
  intentRevision: number;
  scrollAnchor?: ScrollAnchor;
};

type PrependRestore = ScrollAnchor & {
  id: string;
  generation: number;
  requestId: number;
  intentRevision: number;
};

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
  const [prependRevision, setPrependRevision] = useState(0);
  const historySessionRef = useRef<string | undefined>(undefined);
  const historyGenerationRef = useRef(0);
  const historyRequestRef = useRef<HistoryRequest | undefined>(undefined);
  const historyRequestSequenceRef = useRef(0);
  const scrollIntentRevisionRef = useRef(0);
  const prependRestoreRef = useRef<PrependRestore | undefined>(undefined);

  useEffect(() => {
    if (!id) return;
    historyGenerationRef.current += 1;
    historyRequestRef.current?.controller.abort();
    historyRequestRef.current = undefined;
    prependRestoreRef.current = undefined;
    historySessionRef.current = undefined;
    setHistory(undefined);
    setHistoryLoading(false);
    setHistoryError(undefined);
    return () => {
      historyGenerationRef.current += 1;
      historyRequestRef.current?.controller.abort();
      historyRequestRef.current = undefined;
      prependRestoreRef.current = undefined;
    };
  }, [id]);

  useEffect(() => {
    const scrollElement = scrollElementRef?.current;
    if (!scrollElement) return;
    const noteScrollIntent = () => {
      scrollIntentRevisionRef.current += 1;
      const request = historyRequestRef.current;
      if (request) request.scrollAnchor = undefined;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, [contenteditable="true"], [role="textbox"]',
        )
      )
        return;
      if (
        [
          'ArrowUp',
          'ArrowDown',
          'PageUp',
          'PageDown',
          'Home',
          'End',
          'Space',
        ].includes(event.code)
      )
        noteScrollIntent();
    };
    scrollElement.addEventListener('pointerdown', noteScrollIntent, {
      passive: true,
    });
    scrollElement.addEventListener('wheel', noteScrollIntent, {
      passive: true,
    });
    scrollElement.addEventListener('touchstart', noteScrollIntent, {
      passive: true,
    });
    scrollElement.addEventListener('touchmove', noteScrollIntent, {
      passive: true,
    });
    scrollElement.addEventListener('keydown', onKeyDown);
    return () => {
      scrollElement.removeEventListener('pointerdown', noteScrollIntent);
      scrollElement.removeEventListener('wheel', noteScrollIntent);
      scrollElement.removeEventListener('touchstart', noteScrollIntent);
      scrollElement.removeEventListener('touchmove', noteScrollIntent);
      scrollElement.removeEventListener('keydown', onKeyDown);
    };
  }, [scrollElementRef]);

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
    const request: HistoryRequest = {
      id,
      generation: historyGenerationRef.current,
      requestId: historyRequestSequenceRef.current + 1,
      controller: new AbortController(),
      intentRevision: scrollIntentRevisionRef.current,
      ...(scrollElement
        ? {
            scrollAnchor: {
              scrollHeight: scrollElement.scrollHeight,
              scrollTop: scrollElement.scrollTop,
            },
          }
        : {}),
    };
    historyRequestSequenceRef.current = request.requestId;
    historyRequestRef.current = request;
    setHistoryLoading(true);
    setHistoryError(undefined);
    const clearRequestRestore = () => {
      request.scrollAnchor = undefined;
      if (prependRestoreRef.current?.requestId === request.requestId)
        prependRestoreRef.current = undefined;
    };
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
      if (!isCurrentRequest()) {
        clearRequestRestore();
        return;
      }
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
      const scrollAnchor = request.scrollAnchor;
      if (!store.prependSessionHistory(page))
        throw new Error('Session changed while loading older history.');
      prependRestoreRef.current =
        scrollAnchor &&
        request.intentRevision === scrollIntentRevisionRef.current
          ? {
              ...scrollAnchor,
              id: request.id,
              generation: request.generation,
              requestId: request.requestId,
              intentRevision: request.intentRevision,
            }
          : undefined;
      setHistory(page.history);
      setPrependRevision((revision) => revision + 1);
    } catch (loadError) {
      if (!isCurrentRequest()) {
        clearRequestRestore();
        return;
      }
      clearRequestRestore();
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
    const scrollElement = scrollElementRef?.current;
    const restore = prependRestoreRef.current;
    if (!scrollElement || !restore) return;
    if (
      restore.id !== id ||
      restore.generation !== historyGenerationRef.current ||
      restore.intentRevision !== scrollIntentRevisionRef.current
    ) {
      prependRestoreRef.current = undefined;
      return;
    }
    const delta = scrollElement.scrollHeight - restore.scrollHeight;
    if (delta) scrollElement.scrollTop = restore.scrollTop + delta;
    prependRestoreRef.current = undefined;
  }, [id, prependRevision, scrollElementRef]);

  return {
    history,
    historyLoading,
    historyError,
    loadEarlierHistory,
  };
}
