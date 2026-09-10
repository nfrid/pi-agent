import { type MouseEvent, useEffect, useRef } from 'react';
import { type SwipeEventData, useSwipeable } from 'react-swipeable';

const EDGE_SWIPE_THRESHOLD = 52;
const EDGE_SWIPE_DOMINANCE = 1.25;
const EDGE_SWIPE_ZONE = 32;

const MIN_HORIZONTAL_DISTANCE = 72;
const HORIZONTAL_DOMINANCE_RATIO = 1.5;
const MIN_HORIZONTAL_VELOCITY = 0.12;
const MAX_SWIPE_DURATION = 700;

type SwipeSide = 'left' | 'right';

function isIntentionalSwipe(
  { absX, absY, vxvy }: Pick<SwipeEventData, 'absX' | 'absY' | 'vxvy'>,
  side: SwipeSide,
): boolean {
  return (
    absX >= MIN_HORIZONTAL_DISTANCE &&
    absX >= absY * HORIZONTAL_DOMINANCE_RATIO &&
    (side === 'right'
      ? vxvy[0] >= MIN_HORIZONTAL_VELOCITY
      : vxvy[0] <= -MIN_HORIZONTAL_VELOCITY)
  );
}

export function isIntentionalRightSwipe(
  event: Pick<SwipeEventData, 'absX' | 'absY' | 'vxvy'>,
): boolean {
  return isIntentionalSwipe(event, 'right');
}

export function isIntentionalLeftSwipe(
  event: Pick<SwipeEventData, 'absX' | 'absY' | 'vxvy'>,
): boolean {
  return isIntentionalSwipe(event, 'left');
}

function isIgnoredSwipeTarget(
  target: EventTarget | null,
  owner: HTMLElement | null,
): boolean {
  if (!(target instanceof Element)) return true;
  const portal = target.closest(
    '[data-surface-portal-root], [data-surface-layer]',
  );
  if (portal && !owner?.contains(target)) return true;
  if (
    target.closest(
      'input, textarea, select, [contenteditable="true"], [data-horizontal-scroller]',
    )
  )
    return true;
  let element: Element | null = target;
  while (element) {
    if (element instanceof HTMLElement) {
      const overflow = getComputedStyle(element).overflowX;
      if (
        (overflow === 'auto' || overflow === 'scroll') &&
        element.scrollWidth > element.clientWidth
      )
        return true;
    }
    element = element.parentElement;
  }
  return false;
}

/** Touch-only swipe handling that preserves vertical scrolling inside sheets. */
export function useSwipeToDismiss(
  onDismiss: () => void,
  side: SwipeSide = 'right',
) {
  const eligible = useRef(false);
  const suppressClick = useRef(false);
  const ownerRef = useRef<HTMLElement | null>(null);
  const handlers = useSwipeable({
    delta: MIN_HORIZONTAL_DISTANCE,
    onTouchStartOrOnMouseDown: ({ event }) => {
      suppressClick.current = false;
      eligible.current = !isIgnoredSwipeTarget(event.target, ownerRef.current);
    },
    onSwiping: (event) => {
      if (
        eligible.current &&
        event.absX >= MIN_HORIZONTAL_DISTANCE &&
        event.absX >= event.absY * HORIZONTAL_DOMINANCE_RATIO
      )
        suppressClick.current = true;
    },
    onTouchEndOrOnMouseUp: () => {
      if (suppressClick.current)
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
    },
    onSwipedRight: (event) => {
      if (
        side === 'right' &&
        eligible.current &&
        isIntentionalSwipe(event, side)
      )
        onDismiss();
    },
    onSwipedLeft: (event) => {
      if (
        side === 'left' &&
        eligible.current &&
        isIntentionalSwipe(event, side)
      )
        onDismiss();
    },
    preventScrollOnSwipe: false,
    swipeDuration: MAX_SWIPE_DURATION,
    trackMouse: false,
    trackTouch: true,
    touchEventOptions: { passive: true },
  });
  return {
    ...handlers,
    ref: (element: HTMLElement | null) => {
      ownerRef.current = element;
      handlers.ref(element);
    },
    onClickCapture: (event: MouseEvent) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

/** Shared edge-open gesture for side panels. The listener remains stable while callbacks update. */
export function useSidePanelEdgeSwipe({
  enabled,
  open,
  side,
  onOpen,
}: {
  enabled: boolean;
  open: boolean;
  side: SwipeSide;
  onOpen: () => void;
}) {
  const openRef = useRef(open);
  const callbackRef = useRef(onOpen);
  openRef.current = open;
  callbackRef.current = onOpen;

  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | undefined;
    const onStart = (event: globalThis.TouchEvent) => {
      start = undefined;
      const touchCount = event.touches.length || event.changedTouches.length;
      if (
        touchCount !== 1 ||
        document.querySelector('[data-side-panel-root], .surface-drawer-layer')
      )
        return;
      if (
        event.target instanceof Element &&
        isIgnoredSwipeTarget(event.target, null)
      )
        return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const atEdge =
        side === 'left'
          ? touch.clientX <= EDGE_SWIPE_ZONE
          : touch.clientX >= window.innerWidth - EDGE_SWIPE_ZONE;
      if (atEdge && !openRef.current) {
        if (event.cancelable) event.preventDefault();
        start = { x: touch.clientX, y: touch.clientY };
      }
    };
    const onEnd = (event: globalThis.TouchEvent) => {
      const initial = start;
      const touch = event.changedTouches[0];
      start = undefined;
      if (!initial || !touch) return;
      const dx = touch.clientX - initial.x;
      const dy = Math.abs(touch.clientY - initial.y);
      const outward = side === 'left' ? dx > 0 : dx < 0;
      if (
        !openRef.current &&
        outward &&
        Math.abs(dx) >= EDGE_SWIPE_THRESHOLD &&
        Math.abs(dx) > dy * EDGE_SWIPE_DOMINANCE
      )
        callbackRef.current();
    };
    const onCancel = () => {
      start = undefined;
    };
    window.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onCancel);
    };
  }, [enabled, side]);
}
