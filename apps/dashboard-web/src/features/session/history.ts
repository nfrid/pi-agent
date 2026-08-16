import {
  type DashboardLiveStore,
  dashboardHttpClient,
  SESSION_HISTORY_BUDGET,
  selectSessionHistoryCoverage,
  useDashboardStore,
} from '@pi-dashboard/client';
import type {
  AuthoritativeSessionSnapshot,
  SessionApiResponse,
  SessionHistory,
} from '@pi-dashboard/protocol';
import type { RefObject } from 'react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

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
  key: string;
  offset: number;
};

type HistoryRequest = {
  id: string;
  generation: number;
  requestId: number;
  controller: AbortController;
  intentRevision: number;
  anchor?: ScrollAnchor;
};

function firstVisibleAnchor(element: HTMLDivElement): ScrollAnchor | undefined {
  const viewport = element.getBoundingClientRect();
  const candidates = Array.from(
    element.querySelectorAll<HTMLElement>(
      '[data-transcript-row], [data-transcript-key]',
    ),
  );
  const visible = candidates.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.bottom >= viewport.top && rect.top <= viewport.bottom;
  });
  if (!visible) return undefined;
  const key =
    visible.dataset.transcriptRow ?? visible.dataset.transcriptKey ?? '';
  if (!key) return undefined;
  return {
    key,
    offset: visible.getBoundingClientRect().top - viewport.top,
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
}: {
  id: string;
  data: SessionApiResponse | undefined;
  store: DashboardLiveStore;
  sessionMounted: boolean;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
}) {
  const coverage = useDashboardStore(store, selectSessionHistoryCoverage(id));
  const [history, setHistory] = useState<SessionApiResponse['history']>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [prependAnchor, setPrependAnchor] = useState<
    (ScrollAnchor & { revision: number }) | undefined
  >(undefined);
  const historyRef = useRef<SessionApiResponse['history']>(undefined);
  const historySessionRef = useRef<string | undefined>(undefined);
  const historyWindowRef = useRef<string | undefined>(undefined);
  const historyGenerationRef = useRef(0);
  const historyRequestRef = useRef<HistoryRequest | undefined>(undefined);
  const historyRequestSequenceRef = useRef(0);
  const scrollIntentRevisionRef = useRef(0);
  const topIntentRef = useRef(false);
  const previousScrollTopRef = useRef<number | undefined>(undefined);
  const preserveAnchorOnCoverageRef = useRef(false);
  const loadEarlierHistoryRef = useRef<() => Promise<void>>(
    async () => undefined,
  );

  const clearAnchor = useCallback(() => {
    setPrependAnchor(undefined);
  }, []);

  const cancelScrollRestore = useCallback(() => {
    scrollIntentRevisionRef.current += 1;
    const request = historyRequestRef.current;
    if (request) request.anchor = undefined;
    clearAnchor();
  }, [clearAnchor]);

  useEffect(() => {
    void id;
    historyGenerationRef.current += 1;
    historyRequestRef.current?.controller.abort();
    historyRequestRef.current = undefined;
    historySessionRef.current = undefined;
    historyWindowRef.current = undefined;
    historyRef.current = undefined;
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
      ? {
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
        }
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
    historyGenerationRef.current += 1;
    historyRequestRef.current?.controller.abort();
    historyRequestRef.current = undefined;
    historySessionRef.current = id;
    historyWindowRef.current = nextKey;
    historyRef.current = authoritativeHistory;
    setHistory(authoritativeHistory);
    setHistoryLoading(false);
    setHistoryError(undefined);
    if (preserveAnchorOnCoverageRef.current)
      preserveAnchorOnCoverageRef.current = false;
    else clearAnchor();
  }, [clearAnchor, coverage, data, id]);

  useEffect(() => {
    const element = scrollElementRef?.current;
    if (!sessionMounted || !element) return;
    const noteIntent = () => {
      topIntentRef.current = true;
      scrollIntentRevisionRef.current += 1;
      const request = historyRequestRef.current;
      if (request) request.anchor = undefined;
      clearAnchor();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) noteIntent();
    };
    const onTouchMove = () => noteIntent();
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
        noteIntent();
    };
    const onScroll = () => {
      const top = element.scrollTop;
      const previous = previousScrollTopRef.current;
      previousScrollTopRef.current = top;
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
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('pointerdown', noteIntent, { passive: true });
    element.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    previousScrollTopRef.current = element.scrollTop;
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('pointerdown', noteIntent);
      element.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [clearAnchor, scrollElementRef, sessionMounted]);

  const loadEarlierHistory = useCallback(async () => {
    if (historyRequestRef.current) return;
    const initialHistory = historyRef.current ?? history;
    if (!initialHistory?.hasOlder || !initialHistory.nextBefore) return;
    const capturedAnchor = scrollElementRef?.current
      ? firstVisibleAnchor(scrollElementRef.current)
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
    const pages: AuthoritativeSessionSnapshot[] = [];
    const seenBefore = new Set<string>();
    const seenRanges = new Set<string>();
    const existingCoverage = store.getSnapshot().sessionHistoryCoverageById[id];
    let fetchedEntries = 0;
    let fetchedBytes = 0;
    let expected = initialHistory;
    const failClosed = (message: string): never => {
      store.resetSessionHistoryToNewest(id);
      store.reconnectSession(id);
      throw new Error(message);
    };
    try {
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
        if (
          !isContiguousOlderHistory(
            id,
            page.metadata.id,
            page.history,
            expected,
            before,
          ) ||
          !page.history
        )
          failClosed('Dashboard returned non-contiguous older history.');
        const rangeKey = `${page.history.start}:${page.history.end}`;
        if (seenRanges.has(rangeKey)) failClosed('History range cycle.');
        seenRanges.add(rangeKey);
        fetchedEntries += page.entries.length;
        fetchedBytes += jsonByteLength(page.entries);
        const pageCount = (existingCoverage?.pageCount ?? 0) + pages.length + 1;
        const entryCount =
          (existingCoverage?.entryCount ?? 0) + fetchedEntries;
        const byteCount =
          (existingCoverage?.byteCount ?? 0) + fetchedBytes;
        if (
          pageCount > SESSION_HISTORY_BUDGET.maxPages ||
          entryCount > SESSION_HISTORY_BUDGET.maxEntries ||
          byteCount > SESSION_HISTORY_BUDGET.maxBytes
        )
          failClosed('Older history exceeds the bounded page budget.');
        pages.push(page);
        expected = page.history;
        if (page.history.nextBefore) {
          if (seenBefore.has(page.history.nextBefore))
            failClosed('History cursor cycle.');
        }
        // A leading continuation must be resolved to its owner or origin
        // before any buffered page is made visible.
        if (!expected.leadingContinuation || !expected.hasOlder) break;
      }
      if (!isCurrent()) return;
      const resolvedAnchor =
        request.anchor ??
        (scrollElementRef?.current
          ? firstVisibleAnchor(scrollElementRef.current)
          : undefined);
      preserveAnchorOnCoverageRef.current = true;
      if (!store.prependSessionHistoryPages(pages, id)) {
        preserveAnchorOnCoverageRef.current = false;
        store.reconnectSession(id);
        throw new Error('Session changed while loading older history.');
      }
      const nextCoverage = store.getSnapshot().sessionHistoryCoverageById[id];
      const nextHistory = nextCoverage
        ? {
            version: nextCoverage.version,
            start: nextCoverage.coveredStart,
            end: nextCoverage.coveredEnd,
            hasOlder: nextCoverage.hasOlder,
            ...(nextCoverage.nextBefore === undefined
              ? {}
              : { nextBefore: nextCoverage.nextBefore }),
            ...(nextCoverage.leadingContinuation === undefined
              ? {}
              : { leadingContinuation: nextCoverage.leadingContinuation }),
          }
        : expected;
      historyRef.current = nextHistory;
      setHistory(nextHistory);
      if (
        resolvedAnchor &&
        request.intentRevision === scrollIntentRevisionRef.current
      )
        setPrependAnchor({
          ...resolvedAnchor,
          revision: request.requestId,
        });
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
  useEffect(() => {
    if (
      !sessionMounted ||
      !history?.leadingContinuation ||
      historyRequestRef.current
    )
      return;
    void loadEarlierHistory();
  }, [history, loadEarlierHistory, sessionMounted]);

  return {
    history,
    historyLoading,
    historyError,
    loadEarlierHistory,
    cancelScrollRestore,
    prependAnchor,
  };
}
