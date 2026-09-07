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
const RESTORE_SETTLE_TIMEOUT_MS = 1_500;

export type SessionFollowMode = 'following' | 'manual';

export type SessionScrollMemory = {
  version: typeof SESSION_SCROLL_MEMORY_VERSION;
  mode: SessionFollowMode;
  rowKey?: string;
  rowOffset?: number;
  scrollTop: number;
  oldestOrdinal?: number;
};

export type SessionScrollRestore = SessionScrollMemory & {
  visitToken: number;
};

type HistoryState = { start: number; hasOlder: boolean };

type Visit = {
  key: string;
  token: number;
  mode: SessionFollowMode;
  memory?: SessionScrollMemory;
  phase: 'following' | 'restoring' | 'reading';
  lastSnapshot?: SessionScrollMemory;
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

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, [contenteditable="true"], [role="textbox"]',
      ),
    )
  );
}

export function distanceFromScrollEnd(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

/**
 * Kept as a pure boundary helper. The controller intentionally does not call
 * this for ordinary scroll/measurement events: only explicit user intent or
 * Jump latest can change a manual visit back to following.
 */
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
  serverId,
  history,
  historyAvailable = false,
  loadThroughOrdinal,
  cancelHistoryRestore,
  data,
  projection,
  sessionMounted,
  enabled,
  scrollElementRef,
}: {
  id: string;
  serverId?: string;
  history?: HistoryState;
  historyAvailable?: boolean;
  loadThroughOrdinal?: (ordinal: number) => Promise<boolean>;
  cancelHistoryRestore?: () => void;
  data: { entries: readonly unknown[] } | undefined;
  projection: TranscriptProjection | undefined;
  sessionMounted: boolean;
  enabled: boolean;
  scrollElementRef: RefObject<SessionScrollElement | null>;
}) {
  const storageKey =
    enabled && serverId ? sessionScrollMemoryKey(id, serverId) : '';
  const memory =
    enabled && serverId ? readSessionScrollMemory(id, serverId) : undefined;
  const nextTokenRef = useRef(0);
  const visitRef = useRef<Visit>({
    key: '',
    token: 0,
    mode: 'following',
    phase: 'following',
  });
  const previousVisitRef = useRef<Visit | undefined>(undefined);
  if (visitRef.current.key !== storageKey) {
    previousVisitRef.current = visitRef.current.key
      ? visitRef.current
      : undefined;
    const mode = memory?.mode ?? 'following';
    visitRef.current = {
      key: storageKey,
      token: ++nextTokenRef.current,
      mode,
      memory,
      phase: mode === 'manual' ? 'restoring' : 'following',
    };
  }
  const visit = visitRef.current;
  const modeRef = useRef<SessionFollowMode>(visit.mode);
  modeRef.current = visit.mode;
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [tailReadySessionId, setTailReadySessionId] = useState<
    string | undefined
  >(enabled ? undefined : id);
  const [tailRequest, setTailRequest] = useState({ id, revision: 0 });
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);

  const tailScrollRequest = tailRequest.id === id ? tailRequest.revision : 0;
  const controlLayerRef = useRef<HTMLDivElement>(null);
  const sessionPageRef = useRef<HTMLElement>(null);
  const bottomFrameRef = useRef<number | undefined>(undefined);
  const readyTimerRef = useRef<number | undefined>(undefined);
  const restoreTimerRef = useRef<number | undefined>(undefined);
  const historyRequestRef = useRef<string | undefined>(undefined);
  const restoreRequestRef = useRef<SessionScrollRestore | undefined>(undefined);

  const isCurrentVisit = useCallback(
    (candidate: Visit = visitRef.current) =>
      candidate.key === storageKey &&
      candidate.token === visitRef.current.token,
    [storageKey],
  );

  const cancelScheduledWork = useCallback(() => {
    if (bottomFrameRef.current !== undefined)
      window.cancelAnimationFrame(bottomFrameRef.current);
    if (readyTimerRef.current !== undefined)
      window.clearTimeout(readyTimerRef.current);
    if (restoreTimerRef.current !== undefined)
      window.clearTimeout(restoreTimerRef.current);
    bottomFrameRef.current = undefined;
    readyTimerRef.current = undefined;
    restoreTimerRef.current = undefined;
  }, []);

  const saveVisit = useCallback(
    (candidate: Visit, persist: boolean) => {
      const element = scrollElementRef.current;
      if (!enabled || !candidate.key || !element) return;
      const anchor = visibleTranscriptAnchor(element);
      if (candidate.phase === 'restoring' && !persist) return;
      const value: SessionScrollMemory = {
        version: SESSION_SCROLL_MEMORY_VERSION,
        mode: candidate.mode,
        scrollTop: element.scrollTop,
        ...(anchor.rowKey ? anchor : {}),
        ...(history?.start === undefined
          ? {}
          : { oldestOrdinal: history.start }),
      };
      candidate.lastSnapshot = value;
      if (persist) writeSessionScrollMemory(candidate.key, value);
    },
    [enabled, history, scrollElementRef],
  );

  const persistLastVisit = useCallback((candidate: Visit) => {
    if (!candidate.key || !candidate.lastSnapshot) return;
    writeSessionScrollMemory(candidate.key, candidate.lastSnapshot);
  }, []);

  const enterManual = useCallback(() => {
    const current = visitRef.current;
    if (!isCurrentVisit(current)) return;
    current.mode = 'manual';
    if (current.phase === 'restoring') {
      current.phase = 'reading';
      cancelHistoryRestore?.();
      historyRequestRef.current = undefined;
      if (restoreTimerRef.current !== undefined)
        window.clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = undefined;
      restoreRequestRef.current = undefined;
    }
    cancelScheduledWork();
    setAwayFromLatest(true);
    setTailReadySessionId(id);
    saveVisit(current, true);
  }, [
    cancelHistoryRestore,
    cancelScheduledWork,
    id,
    isCurrentVisit,
    saveVisit,
  ]);

  const requestBottomWrite = useCallback(
    (markReady: boolean) => {
      const candidate = visitRef.current;
      if (
        !enabled ||
        !sessionMounted ||
        !isCurrentVisit(candidate) ||
        candidate.mode !== 'following' ||
        candidate.phase !== 'following'
      )
        return;
      if (bottomFrameRef.current !== undefined)
        window.cancelAnimationFrame(bottomFrameRef.current);
      bottomFrameRef.current = window.requestAnimationFrame(() => {
        bottomFrameRef.current = undefined;
        const current = visitRef.current;
        const element = scrollElementRef.current;
        if (
          !element ||
          !isCurrentVisit(current) ||
          current.mode !== 'following' ||
          current.phase !== 'following'
        )
          return;
        element.scrollTop = element.scrollHeight;
        setAwayFromLatest(false);
        if (!markReady) return;
        if (readyTimerRef.current !== undefined)
          window.clearTimeout(readyTimerRef.current);
        readyTimerRef.current = window.setTimeout(() => {
          readyTimerRef.current = undefined;
          if (isCurrentVisit(current)) setTailReadySessionId(id);
        }, SESSION_TAIL_SETTLE_MS);
      });
    },
    [enabled, id, isCurrentVisit, scrollElementRef, sessionMounted],
  );

  const completeRestore = useCallback(() => {
    const current = visitRef.current;
    if (!isCurrentVisit(current) || current.phase !== 'restoring') return;
    current.phase = 'reading';
    restoreRequestRef.current = undefined;
    if (restoreTimerRef.current !== undefined)
      window.clearTimeout(restoreTimerRef.current);
    restoreTimerRef.current = undefined;
    setTailReadySessionId(id);
    saveVisit(current, true);
  }, [id, isCurrentVisit, saveVisit]);

  const cancelRestore = useCallback(() => {
    const current = visitRef.current;
    if (!isCurrentVisit(current) || current.phase !== 'restoring') return;
    current.phase = 'reading';
    cancelHistoryRestore?.();
    historyRequestRef.current = undefined;
    restoreRequestRef.current = undefined;
    if (restoreTimerRef.current !== undefined)
      window.clearTimeout(restoreTimerRef.current);
    restoreTimerRef.current = undefined;
    setTailReadySessionId(id);
  }, [cancelHistoryRestore, id, isCurrentVisit]);

  useLayoutEffect(() => {
    const previous = previousVisitRef.current;
    previousVisitRef.current = undefined;
    cancelScheduledWork();
    historyRequestRef.current = undefined;
    restoreRequestRef.current = undefined;
    setHistoryLoadFailed(false);
    setAwayFromLatest(false);
    setTailRequest({ id, revision: 0 });
    setTailReadySessionId(enabled ? undefined : id);
    if (previous && enabled) persistLastVisit(previous);
    if (!enabled) return;
    // The new visit starts with its persisted intent. No DOM event or layout
    // measurement can change it to following.
    if (visit.token === visitRef.current.token)
      modeRef.current = visitRef.current.mode;
  }, [cancelScheduledWork, enabled, id, persistLastVisit, visit.token]);

  const rememberedFollowing = visit.memory?.mode === 'following';
  useLayoutEffect(() => {
    // A remembered following visit may retain a rendered snapshot while its
    // reconnect is settling. Keep that cached transcript visible; the initial
    // unseen visit still waits for its bounded tail settle below.
    if (enabled && sessionMounted && rememberedFollowing)
      setTailReadySessionId(id);
  }, [enabled, id, rememberedFollowing, sessionMounted]);

  const needsHistory = Boolean(
    enabled &&
      visit.phase === 'restoring' &&
      visit.memory?.mode === 'manual' &&
      visit.memory.oldestOrdinal !== undefined &&
      historyAvailable &&
      history &&
      history.start > visit.memory.oldestOrdinal &&
      history.hasOlder,
  );
  const restoreReady = !needsHistory || historyLoadFailed;
  const restoring = visit.phase === 'restoring';
  let restoreRequest: SessionScrollRestore | undefined;
  if (restoring && restoreReady && visit.memory?.mode === 'manual') {
    if (!restoreRequestRef.current)
      restoreRequestRef.current = {
        ...visit.memory,
        visitToken: visit.token,
      };
    restoreRequest = restoreRequestRef.current;
  }

  useEffect(() => {
    if (
      !needsHistory ||
      !visit.memory ||
      visit.memory.oldestOrdinal === undefined ||
      !loadThroughOrdinal
    )
      return;
    const requestKey = `${storageKey}:${visit.token}:${visit.memory.oldestOrdinal}`;
    if (historyRequestRef.current === requestKey) return;
    historyRequestRef.current = requestKey;
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled || historyRequestRef.current !== requestKey) return;
      settled = true;
      if (!loaded) setHistoryLoadFailed(true);
    };
    void loadThroughOrdinal(visit.memory.oldestOrdinal)
      .then((loaded) => finish(loaded))
      .catch(() => finish(false));
    restoreTimerRef.current = window.setTimeout(
      () => finish(false),
      RESTORE_SETTLE_TIMEOUT_MS,
    );
    return () => {
      settled = true;
      if (restoreTimerRef.current !== undefined)
        window.clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = undefined;
    };
  }, [loadThroughOrdinal, needsHistory, storageKey, visit.memory, visit.token]);

  useEffect(() => {
    const element = scrollElementRef.current;
    if (!enabled || !sessionMounted || !element || !storageKey) return;
    const current = visitRef.current;
    let touchY: number | undefined;
    const onScroll = () => {
      if (!isCurrentVisit(current)) return;
      setAwayFromLatest(
        current.mode === 'manual' &&
          shouldShowJumpToLatest(
            element.scrollHeight,
            element.scrollTop,
            element.clientHeight,
          ),
      );
      // Restoration and measurement scroll events are observations only. They
      // never change follow intent and cannot overwrite manual memory.
      saveVisit(current, current.phase !== 'restoring');
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) enterManual();
    };
    const onPointerDown = () => enterManual();
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== undefined && nextY !== undefined && nextY > touchY)
        enterManual();
      touchY = nextY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
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
        enterManual();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('pointerdown', onPointerDown, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    saveVisit(current, current.phase !== 'restoring');
    return () => {
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKeyDown);
      if (isCurrentVisit(current))
        saveVisit(current, current.phase !== 'restoring');
    };
  }, [
    enabled,
    enterManual,
    isCurrentVisit,
    saveVisit,
    scrollElementRef,
    sessionMounted,
    storageKey,
  ]);

  useLayoutEffect(() => {
    if (!enabled || !data || !projection || !sessionMounted || restoring)
      return;
    requestBottomWrite(tailReadySessionId !== id);
  }, [
    data,
    enabled,
    id,
    projection,
    requestBottomWrite,
    restoring,
    sessionMounted,
    tailReadySessionId,
  ]);

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
      if (
        followResize &&
        visitRef.current.mode === 'following' &&
        visitRef.current.phase === 'following'
      )
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

  useEffect(() => () => cancelScheduledWork(), [cancelScheduledWork]);

  const jumpToLatest = useCallback(() => {
    const current = visitRef.current;
    if (!enabled || !isCurrentVisit(current)) return;
    current.mode = 'following';
    current.phase = 'following';
    restoreRequestRef.current = undefined;
    setAwayFromLatest(false);
    setTailReadySessionId(undefined);
    setTailRequest((request) => ({
      id,
      revision: request.id === id ? request.revision + 1 : 1,
    }));
    requestBottomWrite(true);
  }, [enabled, id, isCurrentVisit, requestBottomWrite]);

  return {
    awayFromLatest: enabled ? awayFromLatest : false,
    controlLayerRef,
    jumpToLatest,
    sessionPageRef,
    stopFollowing: enterManual,
    tailReadySessionId,
    tailScrollRequest,
    tailScrollRequestSessionId: id,
    modeRef,
    restoring,
    restoreRequest,
    completeRestore,
    cancelRestore,
    restorationComplete: !restoring,
    historyAvailable,
  };
}
