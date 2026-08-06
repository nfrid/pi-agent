import { type SwipeEventData, useSwipeable } from 'react-swipeable';

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
