import type { TranscriptProjection } from '@pi-dashboard/domain';
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { shouldShowJumpToLatest } from '../../app-helpers';
import { FOLLOW_REARM_DISTANCE_PX } from '../../entities/transcript/virtual-scroll';

export { FOLLOW_REARM_DISTANCE_PX } from '../../entities/transcript/virtual-scroll';

const SESSION_TAIL_SETTLE_MS = 64;
const SESSION_SCROLL_MEMORY_VERSION = 1;
const SESSION_SCROLL_MEMORY_PREFIX = 'pi.dashboard.session-scroll.v1:';

export type SessionFollowMode = 'following' | 'manual';

export type SessionScrollMemory = {
  version: typeof SESSION_SCROLL_MEMORY_VERSION;
  mode: SessionFollowMode;
  rowKey?: string;
  rowOffset?: number;
  scrollTop: number;
  oldestOrdinal?: number;
};

function sessionScrollMemoryKey(sessionId: string, serverId: string): string {
  return `${SESSION_SCROLL_MEMORY_PREFIX}${serverId}:${sessionId}`;
}

export function readSessionScrollMemory(
  sessionId: string,
  serverId: string,
): SessionScrollMemory | undefined {
  try {
    const raw = window.sessionStorage.getItem(
      sessionScrollMemoryKey(sessionId, serverId),
    );
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<SessionScrollMemory>;
    if (
      value.version !== SESSION_SCROLL_MEMORY_VERSION ||
      (value.mode !== 'following' && value.mode !== 'manual') ||
      typeof value.scrollTop !== 'number' ||
      !Number.isFinite(value.scrollTop) ||
      (value.rowKey !== undefined && typeof value.rowKey !== 'string') ||
      (value.rowOffset !== undefined &&
        (typeof value.rowOffset !== 'number' ||
          !Number.isFinite(value.rowOffset))) ||
      (value.oldestOrdinal !== undefined &&
        (typeof value.oldestOrdinal !== 'number' ||
          !Number.isFinite(value.oldestOrdinal)))
    )
      return undefined;
    return value as SessionScrollMemory;
  } catch {
    return undefined;
  }
}

function writeSessionScrollMemory(
  key: string,
  memory: SessionScrollMemory,
): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(memory));
  } catch {
    // Storage is optional (privacy mode, quota, and disabled browser storage).
  }
}

function visibleTranscriptAnchor(element: HTMLDivElement) {
  const viewportTop = element.getBoundingClientRect().top;
  const row = Array.from(
    element.querySelectorAll<HTMLElement>(
      '[data-transcript-key], [data-transcript-row]',
    ),
  ).find(
    (candidate) => candidate.getBoundingClientRect().bottom >= viewportTop,
  );
  const rowKey = row?.dataset.transcriptKey ?? row?.dataset.transcriptRow;
  return row && rowKey
    ? {
        rowKey,
        rowOffset: row.getBoundingClientRect().top - viewportTop,
      }
    : {};
}

export function useSessionScrollMemory({
  id,
  serverId,
  history,
  historyAvailable,
  sessionMounted,
  enabled,
  scrollElementRef,
  modeRef,
  loadThroughOrdinal,
  cancelHistoryRestore,
}: {
  id: string;
  serverId: string;
  history?: { start: number; hasOlder: boolean };
  historyAvailable: boolean;
  sessionMounted: boolean;
  enabled: boolean;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  modeRef: { current: SessionFollowMode };
  loadThroughOrdinal: (ordinal: number) => Promise<boolean>;
  cancelHistoryRestore: () => void;
}) {
  const storageKey = sessionScrollMemoryKey(id, serverId);
  const latchedMemoryRef = useRef<{
    key: string;
    value?: SessionScrollMemory;
  }>({ key: '', value: undefined });
  if (latchedMemoryRef.current.key !== storageKey)
    latchedMemoryRef.current = {
      key: storageKey,
      value: enabled ? readSessionScrollMemory(id, serverId) : undefined,
    };
  const storageMemory = latchedMemoryRef.current.value;
  const [restoreState, setRestoreState] = useState<{
    key: string;
    status: 'pending' | 'complete' | 'cancelled';
  }>({ key: storageKey, status: 'pending' });
  const historyRequestRef = useRef<
    { key: string; generation: number } | undefined
  >(undefined);
  const historyGenerationRef = useRef(0);
  const activeIdentityRef = useRef(storageKey);
  const activeElementRef = useRef<HTMLDivElement | null>(null);
  const activeOrdinalRef = useRef<number | undefined>(undefined);
  const lastSnapshotRef = useRef<
    { key: string; value: SessionScrollMemory } | undefined
  >(undefined);
  const saveElement = useCallback(
    (
      key: string,
      element: HTMLDivElement,
      oldestOrdinal: number | undefined,
      persist = true,
    ) => {
      const anchor = visibleTranscriptAnchor(element);
      const value: SessionScrollMemory = {
        version: SESSION_SCROLL_MEMORY_VERSION,
        mode: modeRef.current,
        scrollTop: element.scrollTop,
        ...(anchor.rowKey ? anchor : {}),
        ...(oldestOrdinal === undefined ? {} : { oldestOrdinal }),
      };
      lastSnapshotRef.current = { key, value };
      if (persist) writeSessionScrollMemory(key, value);
    },
    [modeRef],
  );
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);

  useLayoutEffect(() => {
    if (activeIdentityRef.current !== storageKey && enabled) {
      const previousKey = activeIdentityRef.current;
      const previous = lastSnapshotRef.current;
      if (previous?.key === previousKey)
        writeSessionScrollMemory(previous.key, previous.value);
      else {
        const element = activeElementRef.current;
        if (element)
          saveElement(previousKey, element, activeOrdinalRef.current);
      }
    }
    activeIdentityRef.current = storageKey;
    setRestoreState({ key: storageKey, status: 'pending' });
    setHistoryLoadFailed(false);
    historyGenerationRef.current += 1;
    historyRequestRef.current = undefined;
  }, [enabled, saveElement, storageKey]);

  const identityReady = restoreState.key === storageKey;
  const hasMemory = Boolean(
    enabled &&
      storageMemory &&
      identityReady &&
      restoreState.status === 'pending',
  );
  const historyPending = Boolean(
    hasMemory &&
      storageMemory?.oldestOrdinal !== undefined &&
      historyAvailable &&
      history === undefined,
  );
  const needsHistory = Boolean(
    hasMemory &&
      storageMemory?.oldestOrdinal !== undefined &&
      history?.start !== undefined &&
      history.start > storageMemory.oldestOrdinal &&
      history.hasOlder,
  );
  useEffect(() => {
    if (!needsHistory || !storageMemory || history === undefined) return;
    const target = storageMemory.oldestOrdinal;
    if (target === undefined) return;
    const key = `${storageKey}:${target}`;
    const current = historyRequestRef.current;
    if (current?.key === key) return;
    const request = { key, generation: historyGenerationRef.current + 1 };
    historyGenerationRef.current = request.generation;
    historyRequestRef.current = request;
    void loadThroughOrdinal(target)
      .then((loaded) => {
        if (
          historyRequestRef.current !== request ||
          activeIdentityRef.current !== storageKey
        )
          return;
        if (!loaded) setHistoryLoadFailed(true);
      })
      .catch(() => {
        if (
          historyRequestRef.current !== request ||
          activeIdentityRef.current !== storageKey
        )
          return;
        setHistoryLoadFailed(true);
      });
  }, [history, loadThroughOrdinal, needsHistory, storageKey, storageMemory]);

  const cancelRestore = useCallback(() => {
    if (!hasMemory) return;
    cancelHistoryRestore();
    historyGenerationRef.current += 1;
    historyRequestRef.current = undefined;
    setRestoreState((current) =>
      current.key === storageKey
        ? { ...current, status: 'cancelled' }
        : current,
    );
  }, [cancelHistoryRestore, hasMemory, storageKey]);
  const completeRestore = useCallback(() => {
    setRestoreState((current) =>
      current.key === storageKey ? { ...current, status: 'complete' } : current,
    );
  }, [storageKey]);
  useEffect(() => {
    const element = scrollElementRef.current;
    if (!enabled || !sessionMounted || !identityReady || !element) return;
    activeElementRef.current = element;
    activeOrdinalRef.current = history?.start;
    if (!hasMemory) saveElement(storageKey, element, history?.start);
    let touchY: number | undefined;
    let saveFrame: number | undefined;
    const save = () => {
      if (hasMemory) return;
      saveElement(storageKey, element, history?.start);
    };
    const onScroll = () => {
      if (!hasMemory) saveElement(storageKey, element, history?.start, false);
      if (saveFrame !== undefined) window.cancelAnimationFrame(saveFrame);
      saveFrame = window.requestAnimationFrame(() => {
        saveFrame = undefined;
        if (activeIdentityRef.current === storageKey) save();
      });
    };
    const cancel = () => cancelRestore();
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== undefined && nextY !== undefined && nextY !== touchY)
        cancelRestore();
      touchY = nextY;
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
        cancelRestore();
    };
    element.addEventListener('wheel', cancel, { passive: true });
    element.addEventListener('pointerdown', cancel, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      element.removeEventListener('wheel', cancel);
      element.removeEventListener('pointerdown', cancel);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKeyDown);
      if (saveFrame !== undefined) window.cancelAnimationFrame(saveFrame);
      saveFrame = undefined;
      if (activeIdentityRef.current === storageKey) save();
    };
  }, [
    cancelRestore,
    enabled,
    hasMemory,
    history,
    identityReady,
    saveElement,
    scrollElementRef,
    sessionMounted,
    storageKey,
  ]);

  const restorationReady =
    !hasMemory || historyLoadFailed || (!historyPending && !needsHistory);
  useLayoutEffect(() => {
    if (hasMemory && restorationReady && storageMemory?.mode === 'following')
      completeRestore();
  }, [completeRestore, hasMemory, restorationReady, storageMemory]);
  return {
    initialMode: storageMemory?.mode ?? 'following',
    restoring: hasMemory,
    restorationComplete: Boolean(storageMemory && !hasMemory),
    restoreRequest: hasMemory && restorationReady ? storageMemory : undefined,
    cancelRestore,
    completeRestore,
  };
}

export function distanceFromScrollEnd(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function nextFollowMode(
  current: SessionFollowMode,
  distanceFromEnd: number,
  upwardIntent: boolean,
): SessionFollowMode {
  if (upwardIntent) return 'manual';
  return distanceFromEnd <= FOLLOW_REARM_DISTANCE_PX ? 'following' : current;
}

type SessionScrollElement = HTMLDivElement;

export function useSessionScroll({
  id,
  data,
  projection,
  sessionMounted,
  enabled,
  scrollElementRef,
  modeRef: modeRefProp,
  initialMode = 'following',
  suppressInitialBottom = false,
  restorationReady = false,
}: {
  id: string;
  data: { entries: readonly unknown[] } | undefined;
  projection: TranscriptProjection | undefined;
  sessionMounted: boolean;
  enabled: boolean;
  scrollElementRef: RefObject<SessionScrollElement | null>;
  modeRef?: { current: SessionFollowMode };
  initialMode?: SessionFollowMode;
  suppressInitialBottom?: boolean;
  restorationReady?: boolean;
}) {
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [tailRequest, setTailRequest] = useState({ id, revision: 0 });
  const tailScrollRequest = tailRequest.id === id ? tailRequest.revision : 0;
  const [tailReadySessionId, setTailReadySessionId] = useState<
    string | undefined
  >(undefined);
  const ownedModeRef = useRef<SessionFollowMode>('following');
  const modeRef = modeRefProp ?? ownedModeRef;
  const mountedSessionIdRef = useRef<string | undefined>(undefined);
  const bottomFrameRef = useRef<number | undefined>(undefined);
  const bottomWriteMarksReadyRef = useRef(false);
  const readyTimerRef = useRef<number | undefined>(undefined);
  const sessionPageRef = useRef<HTMLElement>(null);
  const controlLayerRef = useRef<HTMLDivElement>(null);

  const cancelBottomWrite = useCallback(() => {
    if (bottomFrameRef.current === undefined) return;
    window.cancelAnimationFrame(bottomFrameRef.current);
    bottomFrameRef.current = undefined;
    bottomWriteMarksReadyRef.current = false;
  }, []);

  const cancelReadyTimer = useCallback(() => {
    if (readyTimerRef.current === undefined) return;
    window.clearTimeout(readyTimerRef.current);
    readyTimerRef.current = undefined;
  }, []);

  const enterManualMode = useCallback(() => {
    modeRef.current = 'manual';
    cancelBottomWrite();
    cancelReadyTimer();
    setTailReadySessionId(id);
  }, [cancelBottomWrite, cancelReadyTimer, id, modeRef]);

  const requestBottomWrite = useCallback(
    (markReady: boolean) => {
      if (
        !enabled ||
        mountedSessionIdRef.current !== id ||
        suppressInitialBottom
      )
        return;
      bottomWriteMarksReadyRef.current ||= markReady;
      if (bottomFrameRef.current !== undefined)
        window.cancelAnimationFrame(bottomFrameRef.current);
      bottomFrameRef.current = window.requestAnimationFrame(() => {
        bottomFrameRef.current = undefined;
        const shouldMarkReady = bottomWriteMarksReadyRef.current;
        bottomWriteMarksReadyRef.current = false;
        const element = scrollElementRef.current;
        if (
          !element ||
          mountedSessionIdRef.current !== id ||
          modeRef.current !== 'following'
        )
          return;
        element.scrollTop = element.scrollHeight;
        setAwayFromLatest(false);
        if (!shouldMarkReady) return;
        cancelReadyTimer();
        readyTimerRef.current = window.setTimeout(() => {
          readyTimerRef.current = undefined;
          setTailReadySessionId(id);
        }, SESSION_TAIL_SETTLE_MS);
      });
    },
    [
      cancelReadyTimer,
      enabled,
      id,
      modeRef,
      scrollElementRef,
      suppressInitialBottom,
    ],
  );

  useLayoutEffect(() => {
    modeRef.current = initialMode;
    setTailRequest({ id, revision: 0 });
    setAwayFromLatest(false);
    setTailReadySessionId(enabled ? undefined : id);
    cancelBottomWrite();
    cancelReadyTimer();
  }, [cancelBottomWrite, cancelReadyTimer, enabled, id, initialMode, modeRef]);

  useLayoutEffect(() => {
    mountedSessionIdRef.current = enabled && sessionMounted ? id : undefined;
    return () => {
      if (mountedSessionIdRef.current === id)
        mountedSessionIdRef.current = undefined;
    };
  }, [enabled, id, sessionMounted]);

  useEffect(() => {
    if (!enabled || !sessionMounted) return;
    const element = scrollElementRef.current;
    if (!element) return;
    let touchY: number | undefined;
    const update = () => {
      if (suppressInitialBottom) return;
      const distance = distanceFromScrollEnd(
        element.scrollHeight,
        element.scrollTop,
        element.clientHeight,
      );
      modeRef.current = nextFollowMode(modeRef.current, distance, false);
      if (modeRef.current === 'following') setAwayFromLatest(false);
      else
        setAwayFromLatest(
          shouldShowJumpToLatest(
            element.scrollHeight,
            element.scrollTop,
            element.clientHeight,
          ),
        );
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) enterManualMode();
    };
    const onPointerDown = () => enterManualMode();
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== undefined && nextY !== undefined && nextY > touchY)
        enterManualMode();
      touchY = nextY;
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
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.code)) enterManualMode();
    };
    element.addEventListener('scroll', update, { passive: true });
    element.addEventListener('pointerdown', onPointerDown, { passive: true });
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    update();
    return () => {
      element.removeEventListener('scroll', update);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    enabled,
    enterManualMode,
    modeRef,
    scrollElementRef,
    sessionMounted,
    suppressInitialBottom,
  ]);

  useLayoutEffect(() => {
    if (suppressInitialBottom) {
      cancelBottomWrite();
      return;
    }
    if (!enabled || !data || !projection || !sessionMounted) return;
    requestBottomWrite(tailReadySessionId !== id);
  }, [
    cancelBottomWrite,
    data,
    enabled,
    id,
    projection,
    requestBottomWrite,
    sessionMounted,
    suppressInitialBottom,
    tailReadySessionId,
  ]);

  useLayoutEffect(() => {
    if (enabled && sessionMounted && restorationReady)
      setTailReadySessionId(id);
  }, [enabled, id, restorationReady, sessionMounted]);

  useLayoutEffect(() => {
    if (!enabled || !sessionMounted) return;
    const page = sessionPageRef.current;
    const controlLayer = controlLayerRef.current;
    const scrollElement = scrollElementRef.current;
    if (!page || !controlLayer || !scrollElement) return;
    const updateViewport = (followResize: boolean) => {
      const viewport = window.visualViewport;
      const visibleBottom = viewport
        ? viewport.offsetTop + viewport.height
        : window.innerHeight;
      const availableHeight = Math.max(
        0,
        visibleBottom - page.getBoundingClientRect().top,
      );
      page.style.setProperty(
        '--session-viewport-height',
        `${Math.ceil(availableHeight)}px`,
      );
      if (followResize && modeRef.current === 'following')
        requestBottomWrite(false);
    };
    const onResize = () => updateViewport(true);
    const onViewportScroll = () => updateViewport(false);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(onResize);
    observer?.observe(page);
    observer?.observe(controlLayer);
    observer?.observe(scrollElement);
    const transcriptContent = scrollElement.querySelector(
      '.transcript-virtualizer',
    );
    if (transcriptContent) observer?.observe(transcriptContent);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onViewportScroll);
    updateViewport(true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onViewportScroll);
    };
  }, [enabled, modeRef, requestBottomWrite, scrollElementRef, sessionMounted]);

  useEffect(
    () => () => {
      cancelBottomWrite();
      cancelReadyTimer();
    },
    [cancelBottomWrite, cancelReadyTimer],
  );

  const jumpToLatest = useCallback(() => {
    if (!enabled || mountedSessionIdRef.current !== id) return;
    modeRef.current = 'following';
    setAwayFromLatest(false);
    setTailRequest((current) => ({
      id,
      revision: current.id === id ? current.revision + 1 : 1,
    }));
    requestBottomWrite(true);
  }, [enabled, id, modeRef, requestBottomWrite]);

  return {
    awayFromLatest: enabled ? awayFromLatest : false,
    controlLayerRef,
    jumpToLatest,
    sessionPageRef,
    stopFollowing: enterManualMode,
    tailReadySessionId,
    tailScrollRequest,
    tailScrollRequestSessionId: id,
    modeRef,
  };
}
