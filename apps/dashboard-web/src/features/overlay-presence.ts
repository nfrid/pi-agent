import { useEffect, useState } from 'react';

export const DASHBOARD_MOTION_MS = 160;

type MatchMediaWindow = Window &
  typeof globalThis & { matchMedia?: (query: string) => MediaQueryList };

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as MatchMediaWindow).matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches,
  );
}

/** Keep custom panels mounted long enough for their exit animation to finish. */
export function useOverlayPresence(open: boolean): {
  present: boolean;
  exiting: boolean;
} {
  const [present, setPresent] = useState(open);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (open) {
      setPresent(true);
      setExiting(false);
      return;
    }
    if (!present) return;
    setExiting(true);
    const timeout = window.setTimeout(
      () => {
        setPresent(false);
        setExiting(false);
      },
      prefersReducedMotion() ? 0 : DASHBOARD_MOTION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [open, present]);

  return { present, exiting };
}
