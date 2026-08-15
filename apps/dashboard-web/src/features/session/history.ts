import {
  type DashboardLiveStore,
  dashboardHttpClient,
} from '@pi-dashboard/client';
import type {
  SessionApiResponse,
  SessionHistory,
} from '@pi-dashboard/protocol';
import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

export function sessionHistoryWindowKey(
  cursor: number | undefined,
  history: SessionHistory | undefined,
): string | undefined {
  if (!history) return undefined;
  return JSON.stringify([
    cursor,
    history.version,
    history.start,
    history.end,
    history.hasOlder,
    history.nextBefore,
  ]);
}

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
  sessionMounted,
}: {
  id: string;
  data: SessionApiResponse | undefined;
  store: DashboardLiveStore;
  sessionMounted: boolean;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
}) {
  const [history, setHistory] = useState<SessionApiResponse['history']>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [prependRevision, setPrependRevision] = useState(0);
  const historySessionRef = useRef<string | undefined>(undefined);
  // The feed snapshot is authoritative for the newest history window. Track
  // its range/cursor so a same-session rebase cannot leave stale pagination
  // metadata claiming that discarded older rows were already loaded.
  const historyWindowRef = useRef<string | undefined>(undefined);
  const historyGenerationRef = useRef(0);
  const historyRequestRef = useRef<HistoryRequest | undefined>(undefined);
  const historyRequestSequenceRef = useRef(0);
  const scrollIntentRevisionRef = useRef(0);
  const prependRestoreRef = useRef<PrependRestore | undefined>(undefined);
  const prependRestoreFrameRef = useRef<number | undefined>(undefined);
  const prependRestoreFrameCountRef = useRef(0);
  const prependRestoreDeadlineRef = useRef(0);
  const cancelPrependRestoreFrame = useCallback(() => {
    if (prependRestoreFrameRef.current !== undefined) {
      window.cancelAnimationFrame(prependRestoreFrameRef.current);
      prependRestoreFrameRef.current = undefined;
    }
  }, []);
  const clearPrependRestore = useCallback(() => {
    prependRestoreRef.current = undefined;
    prependRestoreFrameCountRef.current = 0;
    prependRestoreDeadlineRef.current = 0;
    cancelPrependRestoreFrame();
  }, [cancelPrependRestoreFrame]);
  const cancelScrollRestore = useCallback(() => {
    scrollIntentRevisionRef.current += 1;
    const request = historyRequestRef.current;
    if (request) request.scrollAnchor = undefined;
    clearPrependRestore();
  }, [clearPrependRestore]);

  useEffect(() => {
    if (!id) return;
    historyGenerationRef.current += 1;
    historyRequestRef.current?.controller.abort();
    historyRequestRef.current = undefined;
    clearPrependRestore();
    historySessionRef.current = undefined;
    historyWindowRef.current = undefined;
    setHistory(undefined);
    setHistoryLoading(false);
    setHistoryError(undefined);
    return () => {
      historyGenerationRef.current += 1;
      historyRequestRef.current?.controller.abort();
      historyRequestRef.current = undefined;
      clearPrependRestore();
    };
  }, [clearPrependRestore, id]);

  useEffect(() => {
    if (!sessionMounted) clearPrependRestore();
  }, [clearPrependRestore, sessionMounted]);

  useEffect(() => {
    const scrollElement = scrollElementRef?.current;
    if (!sessionMounted || !scrollElement) return;
    const noteScrollIntent = () => {
      scrollIntentRevisionRef.current += 1;
      const request = historyRequestRef.current;
      if (request) request.scrollAnchor = undefined;
      clearPrependRestore();
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
    window.addEventListener('keydown', onKeyDown);
    return () => {
      scrollElement.removeEventListener('pointerdown', noteScrollIntent);
      scrollElement.removeEventListener('wheel', noteScrollIntent);
      scrollElement.removeEventListener('touchstart', noteScrollIntent);
      scrollElement.removeEventListener('touchmove', noteScrollIntent);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [clearPrependRestore, scrollElementRef, sessionMounted]);

  useEffect(() => {
    if (data?.metadata.id !== id) return;
    const windowKey = sessionHistoryWindowKey(data.cursor, data.history);
    if (
      historySessionRef.current !== id ||
      historyWindowRef.current !== windowKey
    ) {
      // A new authoritative window invalidates every page request based on
      // the old range. Advance the generation before installing its metadata
      // so an already-resolving page cannot prepend into the new baseline.
      historyGenerationRef.current += 1;
      historyRequestRef.current?.controller.abort();
      historyRequestRef.current = undefined;
      historySessionRef.current = id;
      historyWindowRef.current = windowKey;
      clearPrependRestore();
      setHistoryLoading(false);
      setHistoryError(undefined);
      setHistory(data.history);
    }
  }, [clearPrependRestore, data, id]);

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
        clearPrependRestore();
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
      if (prependRestoreRef.current) {
        prependRestoreFrameCountRef.current = 0;
        prependRestoreDeadlineRef.current = Date.now() + 2_000;
      }
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
  }, [
    clearPrependRestore,
    history,
    historyLoading,
    id,
    scrollElementRef,
    store,
  ]);

  useEffect(() => {
    // These values are the render signal for the prepended transcript.
    void data;
    void history;
    void prependRevision;
    const scrollElement = scrollElementRef?.current;
    const restore = prependRestoreRef.current;
    if (!sessionMounted || !scrollElement || !restore) return;
    let lastObservedHeight = restore.scrollHeight;
    let stableHeightFrames = 0;
    const isValidRestore = () => {
      const current = prependRestoreRef.current;
      return (
        current === restore &&
        restore.id === id &&
        restore.generation === historyGenerationRef.current &&
        restore.intentRevision === scrollIntentRevisionRef.current
      );
    };
    const applyRestore = () => {
      prependRestoreFrameRef.current = undefined;
      prependRestoreFrameCountRef.current += 1;
      if (
        prependRestoreFrameCountRef.current > 120 ||
        Date.now() > prependRestoreDeadlineRef.current
      ) {
        clearPrependRestore();
        return;
      }
      if (!isValidRestore()) {
        clearPrependRestore();
        return;
      }
      const currentHeight = scrollElement.scrollHeight;
      const delta = currentHeight - restore.scrollHeight;
      // History state can commit before virtualization has rendered the
      // prepended rows. Keep the anchor until the actual height delta exists
      // and remains stable for a frame.
      if (delta === 0) {
        lastObservedHeight = currentHeight;
        stableHeightFrames = 0;
        scheduleRestore();
        return;
      }
      if (currentHeight !== lastObservedHeight) {
        lastObservedHeight = currentHeight;
        stableHeightFrames = 0;
      } else stableHeightFrames += 1;
      scrollElement.scrollTop = restore.scrollTop + delta;
      if (stableHeightFrames < 8) {
        scheduleRestore();
        return;
      }
      clearPrependRestore();
    };
    const scheduleRestore = () => {
      if (prependRestoreFrameRef.current === undefined)
        prependRestoreFrameRef.current =
          window.requestAnimationFrame(applyRestore);
    };
    const observer =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(() => {
            cancelPrependRestoreFrame();
            applyRestore();
          });
    observer?.observe(scrollElement, {
      attributes: true,
      attributeFilter: ['style'],
      childList: true,
      subtree: true,
    });
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            cancelPrependRestoreFrame();
            applyRestore();
          });
    resizeObserver?.observe(scrollElement);
    const transcriptContent = scrollElement.querySelector<HTMLElement>(
      '.transcript, .transcript-virtualizer',
    );
    if (transcriptContent && transcriptContent !== scrollElement)
      resizeObserver?.observe(transcriptContent);
    applyRestore();

    return () => {
      observer?.disconnect();
      resizeObserver?.disconnect();
      cancelPrependRestoreFrame();
    };
  }, [
    cancelPrependRestoreFrame,
    clearPrependRestore,
    data,
    history,
    id,
    prependRevision,
    scrollElementRef,
    sessionMounted,
  ]);

  return {
    history,
    historyLoading,
    historyError,
    loadEarlierHistory,
    cancelScrollRestore,
  };
}
