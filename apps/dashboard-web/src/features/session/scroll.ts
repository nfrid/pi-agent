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

function sessionScrollMemoryKey(sessionId: string, serverId?: string): string {
  return `${SESSION_SCROLL_MEMORY_PREFIX}${serverId ?? 'unknown'}:${sessionId}`;
}

export function readSessionScrollMemory(
  sessionId: string,
  serverId?: string,
): SessionScrollMemory | undefined {
  try {
    const keys = [sessionScrollMemoryKey(sessionId, serverId)];
    if (serverId !== undefined)
      keys.push(sessionScrollMemoryKey(sessionId, undefined));
    else {
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index);
        if (key?.endsWith(`:${sessionId}`)) keys.push(key);
      }
    }
    const raw = keys.reduce<string | null>(
      (value, key) => value ?? window.sessionStorage.getItem(key),
      null,
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
  sessionId: string,
  serverId: string | undefined,
  memory: SessionScrollMemory,
): void {
  try {
    window.sessionStorage.setItem(
      sessionScrollMemoryKey(sessionId, serverId),
      JSON.stringify(memory),
    );
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
  historyStart,
  historyHasOlder,
  oldestOrdinal,
  sessionMounted,
  enabled,
  scrollElementRef,
  loadThroughOrdinal,
  cancelHistoryRestore,
}: {
  id: string;
  serverId?: string;
  historyStart?: number;
  historyHasOlder?: boolean;
  oldestOrdinal?: number;
  sessionMounted: boolean;
  enabled: boolean;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  loadThroughOrdinal: (ordinal: number) => Promise<boolean>;
  cancelHistoryRestore: () => void;
}) {
  const storageMemory = readSessionScrollMemory(id, serverId);
  const storageKey = sessionScrollMemoryKey(id, serverId);
  const [restoreState, setRestoreState] = useState<{
    key: string;
    status: 'pending' | 'complete' | 'cancelled';
  }>({ key: storageKey, status: 'pending' });
  const loadTargetRef = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    setRestoreState({ key: storageKey, status: 'pending' });
    loadTargetRef.current = undefined;
  }, [storageKey]);

  const hasMemory = Boolean(
    enabled &&
      storageMemory &&
      restoreState.key === storageKey &&
      restoreState.status === 'pending',
  );
  const needsHistory = Boolean(
    hasMemory &&
      storageMemory?.oldestOrdinal !== undefined &&
      historyStart !== undefined &&
      historyStart > storageMemory.oldestOrdinal &&
      historyHasOlder === true,
  );
  useEffect(() => {
    if (!needsHistory || !storageMemory || historyStart === undefined) return;
    const target = storageMemory.oldestOrdinal;
    if (
      target === undefined ||
      loadTargetRef.current === `${storageKey}:${target}`
    )
      return;
    loadTargetRef.current = `${storageKey}:${target}`;
    void loadThroughOrdinal(target).catch(() => undefined);
  }, [
    historyStart,
    loadThroughOrdinal,
    needsHistory,
    storageKey,
    storageMemory,
  ]);

  const cancelRestore = useCallback(() => {
    if (!hasMemory) return;
    cancelHistoryRestore();
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
    if (!enabled || !sessionMounted || !element) return;
    let mode: SessionFollowMode = storageMemory?.mode ?? 'following';
    let touchY: number | undefined;
    let downwardIntent = false;
    const save = () => {
      if (hasMemory) return;
      const anchor = visibleTranscriptAnchor(element);
      const distance = distanceFromScrollEnd(
        element.scrollHeight,
        element.scrollTop,
        element.clientHeight,
      );
      if (downwardIntent && distance <= FOLLOW_REARM_DISTANCE_PX)
        mode = 'following';
      downwardIntent = false;
      writeSessionScrollMemory(id, serverId, {
        version: SESSION_SCROLL_MEMORY_VERSION,
        mode,
        scrollTop: element.scrollTop,
        ...(anchor.rowKey ? anchor : {}),
        ...(oldestOrdinal === undefined ? {} : { oldestOrdinal }),
      });
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        mode = 'manual';
        cancelRestore();
      } else if (event.deltaY > 0) {
        downwardIntent = true;
        cancelRestore();
      }
    };
    const onPointerDown = () => {
      mode = 'manual';
      cancelRestore();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== undefined && nextY !== undefined && nextY !== touchY) {
        mode = 'manual';
        cancelRestore();
      }
      touchY = nextY;
    };
    const onScroll = () => save();
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('pointerdown', onPointerDown, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('scroll', onScroll);
      save();
    };
  }, [
    cancelRestore,
    enabled,
    hasMemory,
    id,
    oldestOrdinal,
    scrollElementRef,
    serverId,
    sessionMounted,
    storageMemory?.mode,
  ]);

  const restorationReady =
    !hasMemory || historyStart === undefined || !needsHistory;
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
  initialMode = 'following',
  suppressInitialBottom = false,
  restorationReady = true,
}: {
  id: string;
  data: { entries: readonly unknown[] } | undefined;
  projection: TranscriptProjection | undefined;
  sessionMounted: boolean;
  enabled: boolean;
  scrollElementRef: RefObject<SessionScrollElement | null>;
  initialMode?: SessionFollowMode;
  suppressInitialBottom?: boolean;
  restorationReady?: boolean;
}) {
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [tailScrollRequest, setTailScrollRequest] = useState(0);
  const [tailReadySessionId, setTailReadySessionId] = useState<
    string | undefined
  >(undefined);
  const modeRef = useRef<SessionFollowMode>('following');
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
  }, [cancelBottomWrite, cancelReadyTimer, id]);

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
    [cancelReadyTimer, enabled, id, scrollElementRef, suppressInitialBottom],
  );

  useLayoutEffect(() => {
    modeRef.current = initialMode;
    setAwayFromLatest(false);
    setTailReadySessionId(enabled ? undefined : id);
    cancelBottomWrite();
    cancelReadyTimer();
  }, [cancelBottomWrite, cancelReadyTimer, enabled, id, initialMode]);

  useLayoutEffect(() => {
    if (enabled && sessionMounted && restorationReady)
      modeRef.current = initialMode;
  }, [enabled, initialMode, restorationReady, sessionMounted]);

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
  }, [enabled, requestBottomWrite, scrollElementRef, sessionMounted]);

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
    setTailScrollRequest((current) => current + 1);
    requestBottomWrite(true);
  }, [enabled, id, requestBottomWrite]);

  return {
    awayFromLatest: enabled ? awayFromLatest : false,
    controlLayerRef,
    jumpToLatest,
    sessionPageRef,
    stopFollowing: enterManualMode,
    tailReadySessionId,
    tailScrollRequest,
  };
}
