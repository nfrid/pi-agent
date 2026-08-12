import type { TranscriptProjection } from '@pi-dashboard/domain';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { isNearPageBottom, shouldShowJumpToLatest } from '../../app-helpers';
import { visualViewportKeyboardInset } from './viewport';

const SESSION_TAIL_SETTLE_MS = 64;

export function useSessionScroll({
  id,
  data,
  projection,
  sessionMounted,
}: {
  id: string;
  data: { entries: readonly unknown[] } | undefined;
  projection: TranscriptProjection | undefined;
  sessionMounted: boolean;
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

  useLayoutEffect(() => {
    // SessionRoute is reused while only the route id changes. Arm the new
    // session before its existing projection can paint at the old scroll
    // position.
    initialTailSessionRef.current = id;
    userScrollIntentRef.current = false;
    stickToBottomRef.current = true;
    setTailReadySessionId(undefined);
    setAwayFromLatest(false);
    if (initialTailSettleTimerRef.current !== undefined) {
      window.clearTimeout(initialTailSettleTimerRef.current);
      initialTailSettleTimerRef.current = undefined;
    }
    if (tailReadyTimerRef.current !== undefined) {
      window.clearTimeout(tailReadyTimerRef.current);
      tailReadyTimerRef.current = undefined;
    }
  }, [id]);

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
    const cancelPendingTailScroll = () => {
      cancelExplicitJumpFrames();
      userScrollIntentRef.current = true;
      stickToBottomRef.current = false;
      initialTailSessionRef.current = undefined;
      setTailReadySessionId(id);
      if (initialTailSettleTimerRef.current !== undefined) {
        window.clearTimeout(initialTailSettleTimerRef.current);
        initialTailSettleTimerRef.current = undefined;
      }
      if (autoScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = undefined;
      }
      if (layoutScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(layoutScrollFrameRef.current);
        layoutScrollFrameRef.current = undefined;
      }
      if (tailReadyTimerRef.current !== undefined) {
        window.clearTimeout(tailReadyTimerRef.current);
        tailReadyTimerRef.current = undefined;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = document.documentElement;
      if (
        event.clientX >= root.clientWidth ||
        event.clientY >= root.clientHeight
      )
        cancelPendingTailScroll();
    };
    let touchY: number | undefined;
    let previousScrollY = window.scrollY;
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
      const scrolledUp = window.scrollY < previousScrollY - 1;
      previousScrollY = window.scrollY;
      if (scrolledUp && initialTailSessionRef.current !== id)
        cancelPendingTailScroll();
      const nearLatest = isNearPageBottom(
        document.documentElement.scrollHeight,
        window.scrollY,
        window.innerHeight,
      );
      if (stickToBottomRef.current && !userScrollIntentRef.current) {
        setAwayFromLatest(false);
        if (!nearLatest && layoutScrollFrameRef.current === undefined) {
          layoutScrollFrameRef.current = window.requestAnimationFrame(() => {
            layoutScrollFrameRef.current = undefined;
            if (stickToBottomRef.current && !userScrollIntentRef.current)
              window.scrollTo(0, document.documentElement.scrollHeight);
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
          document.documentElement.scrollHeight,
          window.scrollY,
          window.innerHeight,
        ),
      );
    };
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    update();
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [cancelExplicitJumpFrames, id]);

  useLayoutEffect(() => {
    if (!data || !projection) return;
    const enteringSession = scrolledSessionRef.current !== id;
    if (enteringSession) {
      userScrollIntentRef.current = false;
      stickToBottomRef.current = true;
      initialTailSessionRef.current = id;
      if (initialTailSettleTimerRef.current !== undefined) {
        window.clearTimeout(initialTailSettleTimerRef.current);
        initialTailSettleTimerRef.current = undefined;
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
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
      // Virtualization can increase the document height before this frame and
      // make the scroll listener clear stickiness. Entering a session must
      // still establish the initial tail position.
      if (
        userScrollIntentRef.current ||
        (!enteringSession && !stickToBottomRef.current)
      ) {
        setTailReadySessionId(id);
        return;
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      stickToBottomRef.current = true;
      if (tailReadyTimerRef.current !== undefined)
        window.clearTimeout(tailReadyTimerRef.current);
      // Keep the curtain opaque while virtualization and the fixed composer
      // finish their first layout pass. Cancellation still reveals the page
      // immediately through cancelPendingTailScroll above.
      tailReadyTimerRef.current = window.setTimeout(() => {
        tailReadyTimerRef.current = undefined;
        if (userScrollIntentRef.current) {
          setTailReadySessionId(id);
          return;
        }
        setTailReadySessionId(id);
        if (initialTailSettleTimerRef.current !== undefined)
          window.clearTimeout(initialTailSettleTimerRef.current);
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
  }, [data, projection, id]);

  useEffect(
    () => () => {
      cancelExplicitJumpFrames();
      if (autoScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = undefined;
      }
      if (layoutScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(layoutScrollFrameRef.current);
        layoutScrollFrameRef.current = undefined;
      }
      if (tailReadyTimerRef.current !== undefined) {
        window.clearTimeout(tailReadyTimerRef.current);
        tailReadyTimerRef.current = undefined;
      }
      if (initialTailSettleTimerRef.current !== undefined) {
        window.clearTimeout(initialTailSettleTimerRef.current);
        initialTailSettleTimerRef.current = undefined;
      }
    },
    [cancelExplicitJumpFrames],
  );

  useLayoutEffect(() => {
    void id;
    if (!sessionMounted) return;
    const page = sessionPageRef.current;
    const controlLayer = controlLayerRef.current;
    if (!page || !controlLayer) return;
    const update = (preserveLatest: boolean) => {
      const viewport = window.visualViewport;
      const keyboardInset = viewport
        ? visualViewportKeyboardInset(
            window.innerHeight,
            viewport.height,
            viewport.offsetTop,
          )
        : 0;
      page.style.setProperty(
        '--session-control-height',
        `${Math.ceil(controlLayer.getBoundingClientRect().height)}px`,
      );
      page.style.setProperty(
        '--keyboard-inset',
        `${Math.ceil(keyboardInset)}px`,
      );
      page.toggleAttribute('data-keyboard-open', keyboardInset > 0);
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
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
    };
    const onResize = () => update(true);
    const onViewportScroll = () => update(false);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(onResize);
    // The transcript, especially its virtualized rows, can finish measuring
    // after the first navigation frame. Keep a newly opened session pinned to
    // its tail while the page height settles, unless the user scrolls away.
    observer?.observe(page);
    observer?.observe(controlLayer);
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
  }, [id, sessionMounted]);

  const jumpToLatest = useCallback(() => {
    if (mountedSessionIdRef.current !== id) return;
    cancelExplicitJumpFrames();
    userScrollIntentRef.current = false;
    stickToBottomRef.current = true;
    initialTailSessionRef.current = id;
    if (initialTailSettleTimerRef.current !== undefined)
      window.clearTimeout(initialTailSettleTimerRef.current);
    initialTailSettleTimerRef.current = window.setTimeout(() => {
      initialTailSettleTimerRef.current = undefined;
      if (initialTailSessionRef.current === id)
        initialTailSessionRef.current = undefined;
    }, 400);
    setAwayFromLatest(false);
    setTailScrollRequest((current) => current + 1);
    window.scrollTo(0, document.documentElement.scrollHeight);
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
      window.scrollTo(0, document.documentElement.scrollHeight);
      // Clearing the rich editor and remeasuring virtual rows can change the
      // document height one frame after submission. Honor the explicit jump
      // through that second layout pass unless the user scrolls away.
      scheduleExplicitJumpFrame(() => {
        if (
          mountedSessionIdRef.current === id &&
          stickToBottomRef.current &&
          !userScrollIntentRef.current
        )
          window.scrollTo(0, document.documentElement.scrollHeight);
      });
    });
  }, [cancelExplicitJumpFrames, id]);

  return {
    awayFromLatest,
    controlLayerRef,
    jumpToLatest,
    sessionPageRef,
    tailReadySessionId,
    tailScrollRequest,
  };
}
