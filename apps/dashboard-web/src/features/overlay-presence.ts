import { type RefObject, useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '../shared/hooks/use-prefers-reduced-motion';

export const DASHBOARD_MOTION_MS = 160;

/** Restore focus to the element that opened an overlay when it closes. */
export function useOverlayFocusRestore(
  open: boolean,
  fallbackSelector = '.composer textarea, main button',
) {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      wasOpenRef.current = true;
      return;
    }
    if (!open && wasOpenRef.current) {
      const previous = previousFocusRef.current;
      if (previous?.isConnected && previous.getClientRects().length > 0)
        previous.focus({ preventScroll: true });
      else
        document
          .querySelector<HTMLElement>(fallbackSelector)
          ?.focus({ preventScroll: true });
      previousFocusRef.current = null;
      wasOpenRef.current = false;
    }
  }, [fallbackSelector, open]);

  return {
    rememberFocus() {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
    },
  };
}

/** Keep custom panels mounted long enough for their exit animation to finish. */
export function useOverlayPresence(open: boolean): {
  present: boolean;
  exiting: boolean;
} {
  const [retained, setRetained] = useState(open);
  const reducedMotion = usePrefersReducedMotion();
  const present = open || retained;
  const exiting = retained && !open;

  useEffect(() => {
    if (open) {
      setRetained(true);
      return;
    }
    if (!retained) return;
    const timeout = window.setTimeout(
      () => setRetained(false),
      reducedMotion ? 0 : DASHBOARD_MOTION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [open, retained, reducedMotion]);

  return { present, exiting };
}

/** Trap Tab focus inside an overlay container on mobile viewports. */
export function useOverlayFocusTrap(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  options?: {
    mobile?: boolean;
    restoreFocusRef?: RefObject<HTMLElement | null>;
    skipRestoreSelector?: string;
  },
) {
  useEffect(() => {
    if (!open || !options?.mobile) return;
    const container = containerRef.current;
    const frame = window.requestAnimationFrame(() => {
      container
        ?.querySelector<HTMLElement>('input, button:not(:disabled), [href]')
        ?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !containerRef.current) return;
      const focusable = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(
          'input, button:not(:disabled), [href]',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      if (
        options.restoreFocusRef?.current &&
        !document.querySelector(options.skipRestoreSelector ?? '')
      ) {
        options.restoreFocusRef.current.focus({ preventScroll: true });
      }
    };
  }, [
    containerRef,
    open,
    options?.mobile,
    options?.restoreFocusRef,
    options?.skipRestoreSelector,
  ]);
}
