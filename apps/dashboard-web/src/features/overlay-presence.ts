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
  const [retained, setRetained] = useState(open);
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
      prefersReducedMotion() ? 0 : DASHBOARD_MOTION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [open, retained]);

  return { present, exiting };
}
