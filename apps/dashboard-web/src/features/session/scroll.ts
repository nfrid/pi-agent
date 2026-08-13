import type { TranscriptProjection } from '@pi-dashboard/domain';
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { isNearPageBottom, shouldShowJumpToLatest } from '../../app-helpers';

const SESSION_TAIL_SETTLE_MS = 64;

type SessionScrollElement = HTMLDivElement;

export function useSessionScroll({
  id,
  data,
  projection,
  sessionMounted,
  scrollElementRef,
}: {
  id: string;
  data: { entries: readonly unknown[] } | undefined;
  projection: TranscriptProjection | undefined;
  sessionMounted: boolean;
  scrollElementRef: RefObject<SessionScrollElement | null>;
}) {
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [tailScrollRequest, setTailScrollRequest] = useState(0);
  const [tailReadySessionId, setTailReadySessionId] = useState<
    string | undefined
  >(undefined);
  const scrolledSessionRef = useRef<string | undefined>(undefined);
  const autoScrollFrameRef = useRef<number | undefined>(undefined);
  const tailReadyTimerRef = useRef<number | undefined>(undefined);
  const layoutScrollFrameRef = useRef<number | undefined>(undefined);
  const explicitJumpFramesRef = useRef<number[]>([]);
  const mountedSessionIdRef = useRef<string | undefined>(undefined);
  const initialTailSessionRef = useRef<string | undefined>(undefined);
  const initialTailSettleTimerRef = useRef<number | undefined>(undefined);
  const userScrollIntentRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const sessionPageRef = useRef<HTMLElement>(null);
  const controlLayerRef = useRef<HTMLDivElement>(null);

  const cancelExplicitJumpFrames = useCallback(() => {
    for (const frame of explicitJumpFramesRef.current)
      window.cancelAnimationFrame(frame);
    explicitJumpFramesRef.current = [];
  }, []);

  const clearTimers = useCallback(() => {
    if (tailReadyTimerRef.current !== undefined) {
      window.clearTimeout(tailReadyTimerRef.current);
      tailReadyTimerRef.current = undefined;
    }
    if (initialTailSettleTimerRef.current !== undefined) {
      window.clearTimeout(initialTailSettleTimerRef.current);
      initialTailSettleTimerRef.current = undefined;
    }
  }, []);

  useLayoutEffect(() => {
    initialTailSessionRef.current = id;
    userScrollIntentRef.current = false;
    stickToBottomRef.current = true;
    setTailReadySessionId(undefined);
    setAwayFromLatest(false);
    clearTimers();
  }, [clearTimers, id]);

  useLayoutEffect(() => {
    cancelExplicitJumpFrames();
    mountedSessionIdRef.current = sessionMounted ? id : undefined;
    return () => {
      cancelExplicitJumpFrames();
      if (mountedSessionIdRef.current === id)
        mountedSessionIdRef.current = undefined;
    };
  }, [cancelExplicitJumpFrames, id, sessionMounted]);

  useEffect(() => {
    if (!sessionMounted) return;
    const scrollElement = scrollElementRef.current;
    if (!scrollElement) return;
    const cancelPendingTailScroll = () => {
      cancelExplicitJumpFrames();
      userScrollIntentRef.current = true;
      stickToBottomRef.current = false;
      initialTailSessionRef.current = undefined;
      setTailReadySessionId(id);
      clearTimers();
      if (autoScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = undefined;
      }
      if (layoutScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(layoutScrollFrameRef.current);
        layoutScrollFrameRef.current = undefined;
      }
    };
    let touchY: number | undefined;
    let previousScrollTop = scrollElement.scrollTop;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) cancelPendingTailScroll();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== undefined && nextY !== undefined && nextY > touchY)
        cancelPendingTailScroll();
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
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.code))
        cancelPendingTailScroll();
    };
    const update = () => {
      const scrolledUp = scrollElement.scrollTop < previousScrollTop - 1;
      previousScrollTop = scrollElement.scrollTop;
      if (scrolledUp && initialTailSessionRef.current !== id)
        cancelPendingTailScroll();
      const nearLatest = isNearPageBottom(
        scrollElement.scrollHeight,
        scrollElement.scrollTop,
        scrollElement.clientHeight,
      );
      if (stickToBottomRef.current && !userScrollIntentRef.current) {
        setAwayFromLatest(false);
        if (!nearLatest && layoutScrollFrameRef.current === undefined) {
          layoutScrollFrameRef.current = window.requestAnimationFrame(() => {
            layoutScrollFrameRef.current = undefined;
            if (stickToBottomRef.current && !userScrollIntentRef.current)
              scrollElement.scrollTop = scrollElement.scrollHeight;
          });
        }
        return;
      }
      if (nearLatest) {
        userScrollIntentRef.current = false;
        stickToBottomRef.current = true;
      }
      setAwayFromLatest(
        shouldShowJumpToLatest(
          scrollElement.scrollHeight,
          scrollElement.scrollTop,
          scrollElement.clientHeight,
        ),
      );
    };
    scrollElement.addEventListener('scroll', update, { passive: true });
    scrollElement.addEventListener('wheel', onWheel, { passive: true });
    scrollElement.addEventListener('touchstart', onTouchStart, {
      passive: true,
    });
    scrollElement.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    update();
    return () => {
      scrollElement.removeEventListener('scroll', update);
      scrollElement.removeEventListener('wheel', onWheel);
      scrollElement.removeEventListener('touchstart', onTouchStart);
      scrollElement.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    cancelExplicitJumpFrames,
    clearTimers,
    id,
    scrollElementRef,
    sessionMounted,
  ]);

  useLayoutEffect(() => {
    const scrollElement = scrollElementRef.current;
    if (!data || !projection || !scrollElement) return;
    const enteringSession = scrolledSessionRef.current !== id;
    if (enteringSession) {
      userScrollIntentRef.current = false;
      stickToBottomRef.current = true;
      initialTailSessionRef.current = id;
      clearTimers();
      scrollElement.scrollTop = scrollElement.scrollHeight;
    }
    if (enteringSession && autoScrollFrameRef.current !== undefined) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = undefined;
    }
    if (!enteringSession && !stickToBottomRef.current) return;
    scrolledSessionRef.current = id;
    if (autoScrollFrameRef.current !== undefined) return;
    const frame = window.requestAnimationFrame(() => {
      if (autoScrollFrameRef.current === frame)
        autoScrollFrameRef.current = undefined;
      if (
        userScrollIntentRef.current ||
        (!enteringSession && !stickToBottomRef.current)
      ) {
        setTailReadySessionId(id);
        return;
      }
      scrollElement.scrollTop = scrollElement.scrollHeight;
      stickToBottomRef.current = true;
      clearTimers();
      tailReadyTimerRef.current = window.setTimeout(() => {
        tailReadyTimerRef.current = undefined;
        if (userScrollIntentRef.current) {
          setTailReadySessionId(id);
          return;
        }
        setTailReadySessionId(id);
        initialTailSettleTimerRef.current = window.setTimeout(() => {
          initialTailSettleTimerRef.current = undefined;
          if (initialTailSessionRef.current === id)
            initialTailSessionRef.current = undefined;
        }, 400);
      }, SESSION_TAIL_SETTLE_MS);
    });
    autoScrollFrameRef.current = frame;
    return () => {
      if (autoScrollFrameRef.current !== frame) return;
      window.cancelAnimationFrame(frame);
      autoScrollFrameRef.current = undefined;
    };
  }, [clearTimers, data, id, projection, scrollElementRef]);

  useEffect(
    () => () => {
      cancelExplicitJumpFrames();
      if (autoScrollFrameRef.current !== undefined)
        window.cancelAnimationFrame(autoScrollFrameRef.current);
      if (layoutScrollFrameRef.current !== undefined)
        window.cancelAnimationFrame(layoutScrollFrameRef.current);
      clearTimers();
    },
    [cancelExplicitJumpFrames, clearTimers],
  );

  useLayoutEffect(() => {
    if (!sessionMounted) return;
    const page = sessionPageRef.current;
    const controlLayer = controlLayerRef.current;
    const scrollElement = scrollElementRef.current;
    if (!page || !controlLayer || !scrollElement) return;
    const update = (preserveLatest: boolean) => {
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
      const initialTailPending =
        initialTailSessionRef.current === id && !userScrollIntentRef.current;
      if (
        !preserveLatest ||
        (!stickToBottomRef.current && !initialTailPending) ||
        userScrollIntentRef.current
      )
        return;
      if (layoutScrollFrameRef.current !== undefined)
        window.cancelAnimationFrame(layoutScrollFrameRef.current);
      layoutScrollFrameRef.current = window.requestAnimationFrame(() => {
        layoutScrollFrameRef.current = undefined;
        if (
          (!stickToBottomRef.current && initialTailSessionRef.current !== id) ||
          userScrollIntentRef.current
        )
          return;
        scrollElement.scrollTop = scrollElement.scrollHeight;
      });
    };
    const onResize = () => update(true);
    const onViewportScroll = () => update(false);
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
    update(true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onViewportScroll);
      if (layoutScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(layoutScrollFrameRef.current);
        layoutScrollFrameRef.current = undefined;
      }
    };
  }, [id, scrollElementRef, sessionMounted]);

  const jumpToLatest = useCallback(() => {
    const scrollElement = scrollElementRef.current;
    if (mountedSessionIdRef.current !== id || !scrollElement) return;
    cancelExplicitJumpFrames();
    userScrollIntentRef.current = false;
    stickToBottomRef.current = true;
    initialTailSessionRef.current = id;
    clearTimers();
    initialTailSettleTimerRef.current = window.setTimeout(() => {
      initialTailSettleTimerRef.current = undefined;
      if (initialTailSessionRef.current === id)
        initialTailSessionRef.current = undefined;
    }, 400);
    setAwayFromLatest(false);
    setTailScrollRequest((current) => current + 1);
    scrollElement.scrollTop = scrollElement.scrollHeight;
    const scheduleExplicitJumpFrame = (callback: () => void) => {
      let frame: number;
      frame = window.requestAnimationFrame(() => {
        explicitJumpFramesRef.current = explicitJumpFramesRef.current.filter(
          (pending) => pending !== frame,
        );
        callback();
      });
      explicitJumpFramesRef.current.push(frame);
    };
    scheduleExplicitJumpFrame(() => {
      if (
        mountedSessionIdRef.current !== id ||
        !stickToBottomRef.current ||
        userScrollIntentRef.current
      )
        return;
      scrollElement.scrollTop = scrollElement.scrollHeight;
      scheduleExplicitJumpFrame(() => {
        if (
          mountedSessionIdRef.current === id &&
          stickToBottomRef.current &&
          !userScrollIntentRef.current
        )
          scrollElement.scrollTop = scrollElement.scrollHeight;
      });
    });
  }, [cancelExplicitJumpFrames, clearTimers, id, scrollElementRef]);

  return {
    awayFromLatest,
    controlLayerRef,
    jumpToLatest,
    sessionPageRef,
    tailReadySessionId,
    tailScrollRequest,
  };
}
