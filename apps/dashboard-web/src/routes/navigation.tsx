import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useDashboardUtility } from '../features/dashboard-utility-context';
import { consumeActiveDrawerHistoryEntry } from '../features/drawer-history';
import { usePrefersReducedMotion } from '../shared/hooks/use-prefers-reduced-motion';

export function newProjectThreadPath(
  snapshot: Pick<BrowserSnapshot, 'projects'>,
  projectId?: string,
): string {
  const id =
    projectId ??
    snapshot.projects?.find((project) => project.status === 'active')?.id;
  return id ? `/projects/${encodeURIComponent(id)}/new` : '/projects';
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
    path.startsWith('/sessions/') || path.startsWith('/drafts/');
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

export type DashboardNavigateOptions = {
  replace?: boolean;
};

export function dashboardNavigateOptions(options?: DashboardNavigateOptions): {
  replace?: true;
} {
  return options?.replace ? { replace: true } : {};
}

export function useDashboardNavigate(): (
  path: string,
  options?: DashboardNavigateOptions,
) => void {
  const navigate = useNavigate();
  const currentPath = useRouterState({
    select: (state) => state.location.pathname,
  });
  const reducedMotion = usePrefersReducedMotion();
  const utility = useDashboardUtility();
  return useCallback(
    (path: string, options?: DashboardNavigateOptions) => {
      // Navigation from a utility panel must never leave the old panel over the
      // destination. The panel state is intentionally independent of the URL.
      utility?.close();
      const replaceDrawerEntry = consumeActiveDrawerHistoryEntry();
      void navigate({
        to: path,
        ...dashboardNavigateOptions({
          replace: options?.replace || replaceDrawerEntry,
        }),
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
