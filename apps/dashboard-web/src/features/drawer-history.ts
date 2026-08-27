import { useEffect, useRef } from 'react';

const DRAWER_HISTORY_KEY = '__piDashboardDrawer';
let nextDrawerId = 0;

type SurfaceHistoryMarker = { id: string; depth: number };
type DrawerHistoryState = Record<string, unknown> & {
  [DRAWER_HISTORY_KEY]?: string | SurfaceHistoryMarker;
};

function surfaceMarker(value: unknown): SurfaceHistoryMarker | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const marker = value as { id?: unknown; depth?: unknown };
  return typeof marker.id === 'string' &&
    typeof marker.depth === 'number' &&
    Number.isInteger(marker.depth) &&
    marker.depth > 0
    ? { id: marker.id, depth: marker.depth }
    : undefined;
}

function historyState(): DrawerHistoryState {
  const state = window.history.state;
  return state && typeof state === 'object' ? state : {};
}

export function hasActiveDrawerHistoryEntry(): boolean {
  const value = historyState()[DRAWER_HISTORY_KEY];
  return typeof value === 'string' || surfaceMarker(value) !== undefined;
}

export function consumeActiveDrawerHistoryEntry(): boolean {
  if (!hasActiveDrawerHistoryEntry()) return false;
  const nextState = { ...historyState() };
  delete nextState[DRAWER_HISTORY_KEY];
  window.history.replaceState(nextState, '', window.location.href);
  return true;
}

/** Keep one same-URL entry while Back peels pages from an adaptive surface. */
export function useSurfaceHistory(
  open: boolean,
  depth: number,
  onDepthChange: (depth: number) => void,
): void {
  const surfaceIdRef = useRef<string | undefined>(undefined);
  const depthRef = useRef(depth);
  const onDepthChangeRef = useRef(onDepthChange);
  depthRef.current = depth;
  onDepthChangeRef.current = onDepthChange;

  useEffect(() => {
    if (!open || depth < 1) {
      const id = surfaceIdRef.current;
      surfaceIdRef.current = undefined;
      const marker = surfaceMarker(historyState()[DRAWER_HISTORY_KEY]);
      if (id && marker?.id === id) window.history.back();
      return;
    }

    let id = surfaceIdRef.current;
    if (!id) {
      nextDrawerId += 1;
      id = `surface-${nextDrawerId.toString(36)}`;
      surfaceIdRef.current = id;
    }
    const marker = surfaceMarker(historyState()[DRAWER_HISTORY_KEY]);
    if (marker?.id === id) {
      if (marker.depth !== depth)
        window.history.replaceState(
          {
            ...historyState(),
            [DRAWER_HISTORY_KEY]: { id, depth },
          },
          '',
          window.location.href,
        );
    } else {
      window.history.pushState(
        {
          ...historyState(),
          [DRAWER_HISTORY_KEY]: { id, depth },
        },
        '',
        window.location.href,
      );
    }
  }, [depth, open]);

  useEffect(() => {
    if (!open) return;
    const onPopState = () => {
      const id = surfaceIdRef.current;
      if (!id) return;
      const marker = surfaceMarker(historyState()[DRAWER_HISTORY_KEY]);
      if (marker?.id === id) return;
      const currentDepth = depthRef.current;
      if (currentDepth > 1) {
        const nextDepth = currentDepth - 1;
        window.history.pushState(
          {
            ...historyState(),
            [DRAWER_HISTORY_KEY]: { id, depth: nextDepth },
          },
          '',
          window.location.href,
        );
        onDepthChangeRef.current(nextDepth);
      } else {
        surfaceIdRef.current = undefined;
        onDepthChangeRef.current(0);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [open]);
}

export function useDrawerHistory(open: boolean, onClose: () => void): void {
  const drawerIdRef = useRef<string | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      const drawerId = drawerIdRef.current;
      drawerIdRef.current = undefined;
      if (drawerId && historyState()[DRAWER_HISTORY_KEY] === drawerId)
        window.history.back();
      return;
    }

    let drawerId = drawerIdRef.current;
    if (!drawerId) {
      nextDrawerId += 1;
      drawerId = `drawer-${nextDrawerId.toString(36)}`;
      drawerIdRef.current = drawerId;
    }
    if (historyState()[DRAWER_HISTORY_KEY] !== drawerId) {
      window.history.pushState(
        { ...historyState(), [DRAWER_HISTORY_KEY]: drawerId },
        '',
        window.location.href,
      );
    }

    const onPopState = () => {
      if (
        drawerIdRef.current === drawerId &&
        historyState()[DRAWER_HISTORY_KEY] !== drawerId
      ) {
        drawerIdRef.current = undefined;
        onCloseRef.current();
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [open]);
}
