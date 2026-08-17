import {
  type DashboardLiveStore,
  dashboardHttpClient,
  SESSION_HISTORY_BUDGET,
  type SessionHistoryCoverage,
  selectSessionHistoryCoverage,
  useDashboardStore,
} from '@pi-dashboard/client';
import type {
  AuthoritativeSessionSnapshot,
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
    ...(history.leadingContinuation === undefined
      ? []
      : [history.leadingContinuation]),
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
    pageHistory.nextBefore !== currentNextBefore &&
    (!pageHistory.hasOlder || Boolean(pageHistory.nextBefore))
  );
}

type ScrollAnchor = {
  scrollTop: number;
  scrollHeight: number;
};

type PrependAnchor = ScrollAnchor & { revision: number };

type HistoryRequest = {
  id: string;
  generation: number;
  requestId: number;
  controller: AbortController;
  intentRevision: number;
  anchor?: ScrollAnchor;
};

function captureScrollOffset(element: HTMLDivElement): ScrollAnchor {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
  };
}

function historyFromCoverage(coverage: SessionHistoryCoverage): SessionHistory {
  return {
    version: coverage.version,
    start: coverage.coveredStart,
    end: coverage.coveredEnd,
    hasOlder: coverage.hasOlder,
    ...(coverage.nextBefore === undefined
      ? {}
      : { nextBefore: coverage.nextBefore }),
    ...(coverage.leadingContinuation === undefined
      ? {}
      : { leadingContinuation: coverage.leadingContinuation }),
  };
}

function jsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? 0
      : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function useOlderSessionHistory({
  id,
  data,
  store,
  scrollElementRef,
  sessionMounted,
  autoloadAll = false,
}: {
  id: string;
  data: SessionApiResponse | undefined;
  store: DashboardLiveStore;
  sessionMounted: boolean;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  /** Drain remaining older pages without a user pagination control. */
  autoloadAll?: boolean;
}) {
  const coverage = useDashboardStore(store, selectSessionHistoryCoverage(id));
  const [history, setHistory] = useState<SessionApiResponse['history']>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [prependAnchor, setPrependAnchor] = useState<PrependAnchor | undefined>(
    undefined,
  );
  const historyRef = useRef<SessionApiResponse['history']>(undefined);
  const historySessionRef = useRef<string | undefined>(undefined);
  const historyWindowRef = useRef<string | undefined>(undefined);
  const historyGenerationRef = useRef(0);
  const historyRequestRef = useRef<HistoryRequest | undefined>(undefined);
  const historyRequestSequenceRef = useRef(0);
  const scrollIntentRevisionRef = useRef(0);
  const topIntentRef = useRef(false);
  const previousScrollTopRef = useRef<number | undefined>(undefined);
  const pointerGestureRef = useRef(false);
  const pendingPrependAnchorRef = useRef<PrependAnchor | undefined>(undefined);
  const preserveAnchorOnCoverageRef = useRef(false);
  const preserveErrorOnCoverageRef = useRef(false);
  const loadEarlierHistoryRef = useRef<() => Promise<void>>(
    async () => undefined,
  );

  const clearAnchor = useCallback(() => {
    pendingPrependAnchorRef.current = undefined;
    setPrependAnchor(undefined);
  }, []);

  const cancelScrollRestore = useCallback(() => {
    scrollIntentRevisionRef.current += 1;
    const request = historyRequestRef.current;
    if (request) request.anchor = undefined;
    clearAnchor();
  }, [clearAnchor]);

  const completePrependRestore = useCallback((revision: number) => {
    setPrependAnchor((current) =>
      current?.revision === revision ? undefined : current,
    );
  }, []);

  useEffect(() => {
    void id;
    historyGenerationRef.current += 1;
    historyRequestRef.current?.controller.abort();
    historyRequestRef.current = undefined;
    historySessionRef.current = undefined;
    historyWindowRef.current = undefined;
    historyRef.current = undefined;
    preserveErrorOnCoverageRef.current = false;
    setHistory(undefined);
    setHistoryLoading(false);
    setHistoryError(undefined);
    clearAnchor();
    return () => {
      historyGenerationRef.current += 1;
      historyRequestRef.current?.controller.abort();
      historyRequestRef.current = undefined;
    };
  }, [clearAnchor, id]);

  // Coverage is the store-owned authority. In particular, a live append can
  // advance data.cursor without changing the oldest verified nextBefore.
  useEffect(() => {
    if (data?.metadata.id !== id && !coverage) return;
    const authoritativeHistory = coverage
      ? historyFromCoverage(coverage)
      : data?.history;
    if (!authoritativeHistory) return;
    const nextKey = coverage
      ? JSON.stringify([
          coverage.generation,
          coverage.serverId,
          coverage.runtimeEpoch,
          coverage.version,
          coverage.hasOlder,
          coverage.coveredStart,
          coverage.coveredEnd,
          coverage.nextBefore,
          coverage.leadingContinuation,
        ])
      : sessionHistoryWindowKey(data?.cursor, authoritativeHistory);
    if (
      historySessionRef.current === id &&
      historyWindowRef.current === nextKey
    ) {
      historyRef.current = authoritativeHistory;
      return;
    }
    const requestContinues =
      coverage !== undefined && historyRequestRef.current?.id === id;
    if (!requestContinues) {
      historyGenerationRef.current += 1;
      historyRequestRef.current?.controller.abort();
      historyRequestRef.current = undefined;
    }
    historySessionRef.current = id;
    historyWindowRef.current = nextKey;
    historyRef.current = authoritativeHistory;
    setHistory(authoritativeHistory);
    if (!requestContinues) setHistoryLoading(false);
    if (preserveErrorOnCoverageRef.current)
      preserveErrorOnCoverageRef.current = false;
    else setHistoryError(undefined);
    if (preserveAnchorOnCoverageRef.current)
      preserveAnchorOnCoverageRef.current = false;
    else if (!requestContinues) clearAnchor();
  }, [clearAnchor, coverage, data, id]);

  useEffect(() => {
    const element = scrollElementRef?.current;
    if (!sessionMounted || !element) return;
    const cancelPendingRestore = () => {
      scrollIntentRevisionRef.current += 1;
      const request = historyRequestRef.current;
      if (request) request.anchor = undefined;
      clearAnchor();
    };
    const noteUpIntent = () => {
      topIntentRef.current = true;
      // Trackpads keep emitting upward wheel events after reaching scrollTop 0.
      // That inertia is the same load-earlier gesture, not a request to discard
      // the message currently anchoring the viewport.
      if (element.scrollTop > 96) cancelPendingRestore();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) noteUpIntent();
      else if (event.deltaY > 0) {
        topIntentRef.current = false;
        cancelPendingRestore();
      }
    };
    const onPointerDown = () => {
      pointerGestureRef.current = true;
      if (prependAnchor) {
        topIntentRef.current = false;
        cancelPendingRestore();
      } else noteUpIntent();
    };
    const onPointerEnd = () => {
      pointerGestureRef.current = false;
      const pendingAnchor = pendingPrependAnchorRef.current;
      pendingPrependAnchorRef.current = undefined;
      if (pendingAnchor) setPrependAnchor(pendingAnchor);
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
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.code)) noteUpIntent();
      else if (
        ['ArrowDown', 'PageDown', 'End'].includes(event.code) ||
        (event.code === 'Space' && !event.shiftKey)
      ) {
        topIntentRef.current = false;
        cancelPendingRestore();
      } else if (event.code === 'Space') noteUpIntent();
    };
    const onScroll = () => {
      const top = element.scrollTop;
      const previous = previousScrollTopRef.current;
      previousScrollTopRef.current = top;
      if (previous !== undefined && top > previous + 1) {
        topIntentRef.current = false;
        if (pointerGestureRef.current || historyRequestRef.current)
          cancelPendingRestore();
      }
      if (
        topIntentRef.current &&
        top <= 96 &&
        (previous === undefined || previous > 96 || top === 0)
      ) {
        topIntentRef.current = false;
        void loadEarlierHistoryRef.current();
      }
    };
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('pointerdown', onPointerDown, { passive: true });
    element.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointerup', onPointerEnd, { passive: true });
    window.addEventListener('pointercancel', onPointerEnd, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    previousScrollTopRef.current = element.scrollTop;
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [clearAnchor, prependAnchor, scrollElementRef, sessionMounted]);

  const loadEarlierHistory = useCallback(async () => {
    if (historyRequestRef.current) return;
    const initialHistory = historyRef.current ?? history;
    if (!initialHistory?.hasOlder || !initialHistory.nextBefore) return;
    const capturedAnchor = scrollElementRef?.current
      ? captureScrollOffset(scrollElementRef.current)
      : undefined;
    const request: HistoryRequest = {
      id,
      generation: historyGenerationRef.current,
      requestId: historyRequestSequenceRef.current + 1,
      controller: new AbortController(),
      intentRevision: scrollIntentRevisionRef.current,
      ...(capturedAnchor ? { anchor: capturedAnchor } : {}),
    };
    historyRequestSequenceRef.current = request.requestId;
    historyRequestRef.current = request;
    setHistoryLoading(true);
    setHistoryError(undefined);
    const isCurrent = () =>
      historyRequestRef.current === request &&
      historyGenerationRef.current === request.generation &&
      request.id === id &&
      !request.controller.signal.aborted;
    const failClosed = (message: string): never => {
      preserveErrorOnCoverageRef.current = true;
      store.resetSessionHistoryToNewest(id);
      store.reconnectSession(id);
      throw new Error(message);
    };
    try {
      let coverageRetries = 0;
      while (true) {
        const attemptState = store.getSnapshot();
        const existingCoverage = attemptState.sessionHistoryCoverageById[id];
        let expected = existingCoverage
          ? historyFromCoverage(existingCoverage)
          : initialHistory;
        if (!expected.hasOlder || !expected.nextBefore) return;
        const pages: AuthoritativeSessionSnapshot[] = [];
        const seenBefore = new Set<string>();
        const seenRanges = new Set<string>();
        let fetchedEntries = 0;
        let fetchedBytes = 0;
        while (expected.hasOlder && expected.nextBefore) {
          const before = expected.nextBefore;
          if (seenBefore.has(before)) failClosed('History cursor cycle.');
          seenBefore.add(before);
          const page = await dashboardHttpClient.sessionBefore(
            id,
            before,
            request.controller.signal,
          );
          if (!isCurrent()) return;
          const pageHistory =
            page.history ??
            failClosed('Dashboard returned missing history metadata.');
          if (
            existingCoverage &&
            ((page.serverId ?? attemptState.serverId) !==
              existingCoverage.serverId ||
              (page.runtimeEpoch !== undefined &&
                page.runtimeEpoch !== existingCoverage.runtimeEpoch))
          )
            failClosed(
              'Dashboard returned history for a different session generation.',
            );
          if (
            !isContiguousOlderHistory(
              id,
              page.metadata.id,
              pageHistory,
              expected,
              before,
            )
          ) {
            failClosed('Dashboard returned non-contiguous older history.');
          }
          const rangeKey = `${pageHistory.start}:${pageHistory.end}`;
          if (seenRanges.has(rangeKey)) failClosed('History range cycle.');
          seenRanges.add(rangeKey);
          fetchedEntries += page.entries.length;
          fetchedBytes += jsonByteLength(page.entries);
          const pageCount =
            (existingCoverage?.pageCount ?? 0) + pages.length + 1;
          const entryCount =
            (existingCoverage?.entryCount ?? 0) + fetchedEntries;
          const byteCount = (existingCoverage?.byteCount ?? 0) + fetchedBytes;
          if (
            pageCount > SESSION_HISTORY_BUDGET.maxPages ||
            entryCount > SESSION_HISTORY_BUDGET.maxEntries ||
            byteCount > SESSION_HISTORY_BUDGET.maxBytes
          )
            failClosed('Older history exceeds the bounded page budget.');
          pages.push(page);
          expected = pageHistory;
          if (pageHistory.nextBefore) {
            if (seenBefore.has(pageHistory.nextBefore))
              failClosed('History cursor cycle.');
          }
          // A leading continuation must be resolved to its owner or origin
          // before any buffered page is made visible.
          if (!expected.leadingContinuation || !expected.hasOlder) break;
        }
        if (!isCurrent()) return;
        if (
          store.getSnapshot().sessionHistoryCoverageById[id] !==
          existingCoverage
        ) {
          if (coverageRetries >= 1)
            throw new Error(
              'Session kept changing while loading older history.',
            );
          coverageRetries += 1;
          continue;
        }
        // Recapture immediately before the atomic prepend. This offsets only
        // the inserted history, excluding live tail growth during the request.
        const resolvedAnchor = scrollElementRef?.current
          ? captureScrollOffset(scrollElementRef.current)
          : request.anchor;
        preserveAnchorOnCoverageRef.current = true;
        preserveErrorOnCoverageRef.current = true;
        if (!store.prependSessionHistoryPages(pages, id)) {
          preserveAnchorOnCoverageRef.current = false;
          store.reconnectSession(id);
          throw new Error('Session changed while loading older history.');
        }
        preserveErrorOnCoverageRef.current = false;
        const nextCoverage = store.getSnapshot().sessionHistoryCoverageById[id];
        const nextHistory = nextCoverage
          ? historyFromCoverage(nextCoverage)
          : expected;
        historyRef.current = nextHistory;
        setHistory(nextHistory);
        if (
          resolvedAnchor &&
          request.intentRevision === scrollIntentRevisionRef.current
        ) {
          const nextAnchor = {
            ...resolvedAnchor,
            revision: request.requestId,
          };
          if (pointerGestureRef.current)
            pendingPrependAnchorRef.current = nextAnchor;
          else setPrependAnchor(nextAnchor);
        }
        return;
      }
    } catch (loadError) {
      if (!isCurrent()) return;
      if (loadError instanceof Error && loadError.name === 'AbortError') return;
      setHistoryError(
        loadError instanceof Error
          ? loadError.message
          : 'Could not load older history.',
      );
    } finally {
      if (isCurrent()) {
        historyRequestRef.current = undefined;
        setHistoryLoading(false);
      }
    }
  }, [history, id, scrollElementRef, store]);
  loadEarlierHistoryRef.current = loadEarlierHistory;

  // A partial head is never rendered as a hanging activity. Resolve its owner
  // automatically; the visible control remains available for retry/error UI.
  // Inspectors can also drain every remaining older page so the composed
  // transcript is complete without a pagination control.
  useEffect(() => {
    if (!sessionMounted || historyRequestRef.current) return;
    const shouldAutoload =
      Boolean(history?.leadingContinuation) ||
      (autoloadAll &&
        history?.hasOlder === true &&
        Boolean(history.nextBefore));
    if (!shouldAutoload) return;
    void loadEarlierHistory();
  }, [autoloadAll, history, loadEarlierHistory, sessionMounted]);

  return {
    history,
    historyLoading,
    historyError,
    loadEarlierHistory,
    cancelScrollRestore,
    completePrependRestore,
    prependAnchor,
  };
}
