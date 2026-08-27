import { useEffect, useRef } from 'react';

const DRAWER_HISTORY_KEY = '__piDashboardDrawer';
let nextDrawerId = 0;

type DrawerHistoryState = Record<string, unknown> & {
  [DRAWER_HISTORY_KEY]?: string;
};

function historyState(): DrawerHistoryState {
  const state = window.history.state;
  return state && typeof state === 'object' ? state : {};
}

export function hasActiveDrawerHistoryEntry(): boolean {
  return typeof historyState()[DRAWER_HISTORY_KEY] === 'string';
}

export function consumeActiveDrawerHistoryEntry(): boolean {
  if (!hasActiveDrawerHistoryEntry()) return false;
  const nextState = { ...historyState() };
  delete nextState[DRAWER_HISTORY_KEY];
  window.history.replaceState(nextState, '', window.location.href);
  return true;
}

/** Add a same-URL history entry so browser Back dismisses the open drawer. */
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
