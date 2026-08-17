import { type TouchEvent, useEffect, useRef } from 'react';
import { type SwipeEventData, useSwipeable } from 'react-swipeable';

const EDGE_SWIPE_THRESHOLD = 52;
const EDGE_SWIPE_DOMINANCE = 1.25;
const EDGE_SWIPE_ZONE = 32;

const MIN_HORIZONTAL_DISTANCE = 72;
const HORIZONTAL_DOMINANCE_RATIO = 1.5;
const MIN_HORIZONTAL_VELOCITY = 0.12;
const MAX_SWIPE_DURATION = 700;

export function isIntentionalRightSwipe({
  absX,
  absY,
  vxvy,
}: Pick<SwipeEventData, 'absX' | 'absY' | 'vxvy'>): boolean {
  return (
    absX >= MIN_HORIZONTAL_DISTANCE &&
    absX >= absY * HORIZONTAL_DOMINANCE_RATIO &&
    vxvy[0] >= MIN_HORIZONTAL_VELOCITY
  );
}

/** Touch-only swipe handling that preserves vertical scrolling inside sheets. */
export function useSwipeToDismiss(onDismiss: () => void) {
  return useSwipeable({
    delta: { right: MIN_HORIZONTAL_DISTANCE },
    onSwipedRight: (event) => {
      if (isIntentionalRightSwipe(event)) onDismiss();
    },
    preventScrollOnSwipe: false,
    swipeDuration: MAX_SWIPE_DURATION,
    trackMouse: false,
    trackTouch: true,
    touchEventOptions: { passive: true },
  });
}

/** Edge swipe to open and swipe-left to close for left-side navigation drawers. */
export function useAgentNavSwipe({
  enabled,
  open,
  onOpenChange,
  onTouchStart,
  onTouchEnd,
}: {
  enabled: boolean;
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  onTouchStart?: (event: TouchEvent) => void;
  onTouchEnd?: (event: TouchEvent) => void;
}) {
  const touchStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const edgeTouchStart = useRef<{ x: number; y: number } | undefined>(
    undefined,
  );

  const handleTouchStart = (event: TouchEvent) => {
    onTouchStart?.(event);
    const touch = event.changedTouches[0];
    if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event: TouchEvent) => {
    onTouchEnd?.(event);
    const start = touchStart.current;
    const touch = event.changedTouches[0];
    touchStart.current = undefined;
    if (!start || !touch || !enabled) return;
    const dx = touch.clientX - start.x;
    const dy = Math.abs(touch.clientY - start.y);
    if (
      start.x < EDGE_SWIPE_ZONE &&
      dx > EDGE_SWIPE_THRESHOLD &&
      dx > dy * EDGE_SWIPE_DOMINANCE
    )
      onOpenChange?.(true);
    if (
      open &&
      dx < -EDGE_SWIPE_THRESHOLD &&
      Math.abs(dx) > dy * EDGE_SWIPE_DOMINANCE
    )
      onOpenChange?.(false);
  };

  useEffect(() => {
    if (!enabled) return;
    const onStart = (event: globalThis.TouchEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-swipe-dismiss="right"]')
      )
        return;
      const touch = event.changedTouches[0];
      if (touch && touch.clientX < EDGE_SWIPE_ZONE) {
        event.preventDefault();
        edgeTouchStart.current = { x: touch.clientX, y: touch.clientY };
      }
    };
    const onEnd = (event: globalThis.TouchEvent) => {
      const start = edgeTouchStart.current;
      const touch = event.changedTouches[0];
      edgeTouchStart.current = undefined;
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = Math.abs(touch.clientY - start.y);
      if (dx > EDGE_SWIPE_THRESHOLD && dx > dy * EDGE_SWIPE_DOMINANCE)
        onOpenChange?.(true);
      else if (
        open &&
        dx < -EDGE_SWIPE_THRESHOLD &&
        Math.abs(dx) > dy * EDGE_SWIPE_DOMINANCE
      )
        onOpenChange?.(false);
    };
    window.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [enabled, onOpenChange, open]);

  return { onTouchStart: handleTouchStart, onTouchEnd: handleTouchEnd };
}
