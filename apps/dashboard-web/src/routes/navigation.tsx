import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useDashboardUtility } from '../features/dashboard-utility-context';
import { usePrefersReducedMotion } from '../shared/hooks/use-prefers-reduced-motion';

export function newChatPath(
  snapshot: BrowserSnapshot,
  workspaceId?: string,
): string {
  const id =
    workspaceId ??
    snapshot.workspaces.find((workspace) => workspace.active)?.id;
  return id ? `/workspaces/${encodeURIComponent(id)}/new` : '/workspaces';
}

export function shouldUseDashboardViewTransition({
  currentPath,
  targetPath,
  reducedMotion,
}: {
  currentPath: string;
  targetPath: string;
  reducedMotion: boolean;
}): boolean {
  const current = currentPath.split(/[?#]/, 1)[0];
  const target = targetPath.split(/[?#]/, 1)[0];
  const isSessionPath = (path: string) =>
    path === '/sessions' || path.startsWith('/sessions/');
  // Live session/transcript surfaces are intentionally excluded from this experiment.
  return (
    !reducedMotion &&
    current !== target &&
    current !== '/new' &&
    target !== '/new' &&
    !isSessionPath(current) &&
    !isSessionPath(target)
  );
}

export function useDashboardNavigate(): (path: string) => void {
  const navigate = useNavigate();
  const currentPath = useRouterState({
    select: (state) => state.location.pathname,
  });
  const reducedMotion = usePrefersReducedMotion();
  const utility = useDashboardUtility();
  return useCallback(
    (path: string) => {
      // Navigation from a utility panel must never leave the old panel over the
      // destination. The panel state is intentionally independent of the URL.
      utility?.close();
      void navigate({
        to: path,
        viewTransition: shouldUseDashboardViewTransition({
          currentPath,
          targetPath: path,
          reducedMotion,
        }),
      });
    },
    [currentPath, navigate, reducedMotion, utility],
  );
}

export function Back() {
  const go = useDashboardNavigate();
  return (
    <button type="button" className="back" onClick={() => go('/')}>
      ← Dashboard
    </button>
  );
}
