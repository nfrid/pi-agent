import {
  type DashboardLiveStore,
  dashboardHttpClient,
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
  useLayoutEffect,
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

export function useOlderSessionHistory({
  id,
  data,
  store,
  scrollElementRef,
  sessionMounted,
  virtualized = false,
}: {
  id: string;
  data: SessionApiResponse | undefined;
  store: DashboardLiveStore;
  sessionMounted: boolean;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  /** VirtualizedTranscript is the sole owner of virtual row restoration. */
  virtualized?: boolean;
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
  const restoredRevisionRef = useRef(0);
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
  });

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
    let expected = initialHistory;
    try {
      while (expected.hasOlder && expected.nextBefore) {
        const before = expected.nextBefore;
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
          )
        ) {
          // Route the malformed response through the store's fail-closed
          // validator so verified coverage is reset, not merely retried.
          store.prependSessionHistoryPages([...pages, page]);
          throw new Error('Dashboard returned non-contiguous older history.');
        }
        pages.push(page);
        if (!page.history)
          throw new Error('Dashboard returned missing history metadata.');
        expected = page.history;
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
      if (!store.prependSessionHistoryPages(pages)) {
        preserveAnchorOnCoverageRef.current = false;
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

  // Non-virtualized rows restore the first visible semantic key in layout.
  // There is intentionally no height delta fallback or timeout writer.
  useLayoutEffect(() => {
    if (virtualized || !scrollElementRef?.current || !prependAnchor) return;
    if (restoredRevisionRef.current === prependAnchor.revision) return;
    const element = scrollElementRef.current;
    const target = Array.from(
      element.querySelectorAll<HTMLElement>(
        '[data-transcript-row], [data-transcript-key]',
      ),
    ).find(
      (candidate) =>
        (candidate.dataset.transcriptRow ?? candidate.dataset.transcriptKey) ===
        prependAnchor.key,
    );
    if (!target) return;
    if (prependAnchor.revision <= 0) return;
    const offset =
      target.getBoundingClientRect().top - element.getBoundingClientRect().top;
    element.scrollTop += offset - prependAnchor.offset;
    restoredRevisionRef.current = prependAnchor.revision;
  }, [prependAnchor, scrollElementRef, virtualized]);

  return {
    history,
    historyLoading,
    historyError,
    loadEarlierHistory,
    cancelScrollRestore,
    prependAnchor,
  };
}
