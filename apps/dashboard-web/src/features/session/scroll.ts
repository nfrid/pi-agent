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

export type SessionFollowMode = 'following' | 'manual';

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
}: {
  id: string;
  data: { entries: readonly unknown[] } | undefined;
  projection: TranscriptProjection | undefined;
  sessionMounted: boolean;
  enabled: boolean;
  scrollElementRef: RefObject<SessionScrollElement | null>;
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
      if (!enabled || mountedSessionIdRef.current !== id) return;
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
    [cancelReadyTimer, enabled, id, scrollElementRef],
  );

  useLayoutEffect(() => {
    modeRef.current = 'following';
    setAwayFromLatest(false);
    setTailReadySessionId(enabled ? undefined : id);
    cancelBottomWrite();
    cancelReadyTimer();
  }, [cancelBottomWrite, cancelReadyTimer, enabled, id]);

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
    let previousScrollTop = element.scrollTop;
    const update = () => {
      const upward = element.scrollTop < previousScrollTop - 1;
      previousScrollTop = element.scrollTop;
      const distance = distanceFromScrollEnd(
        element.scrollHeight,
        element.scrollTop,
        element.clientHeight,
      );
      modeRef.current = nextFollowMode(modeRef.current, distance, upward);
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
  }, [enabled, enterManualMode, scrollElementRef, sessionMounted]);

  useLayoutEffect(() => {
    if (!enabled || !data || !projection || !sessionMounted) return;
    requestBottomWrite(tailReadySessionId !== id);
  }, [
    data,
    enabled,
    id,
    projection,
    requestBottomWrite,
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
