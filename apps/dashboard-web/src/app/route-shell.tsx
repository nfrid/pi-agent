import { Outlet, useRouterState } from '@tanstack/react-router';
import {
  DashboardUtilityProvider,
  useDashboardUtility,
} from '../features/dashboard-utility-context';
import { SurfaceDrawer } from '../features/surface-drawer';
import { Header, InboxView, SessionsView } from '../routes/dashboard';
import { useDashboardContext } from './dashboard-context';

export function RouteShell() {
  const dashboard = useDashboardContext();
  const routeState = useRouterState({
    select: (state) => ({
      isSession: state.matches.some(
        (match) =>
          match.routeId === '/sessions/$sessionId' ||
          match.routeId === '/projects/$projectId/new' ||
          match.routeId === '/projects/$projectId/new/pending/$threadId' ||
          match.routeId === '/drafts/$draftId',
      ),
      pathname: state.location.pathname,
    }),
  });
  if (!dashboard.snapshot) return null;
  return (
    <div className="app">
      <DashboardUtilityProvider
        blocked={false}
        locationKey={routeState.pathname}
      >
        <Header snapshot={dashboard.snapshot} />
        {(dashboard.error || dashboard.connectionState !== 'connected') && (
          <div className="notice sync-notice" role="status" aria-live="polite">
            {dashboard.error ??
              (dashboard.connectionState === 'connecting'
                ? 'Connecting to live updates…'
                : 'Live updates unavailable.')}
          </div>
        )}
        <main
          className={`shell route-content ${routeState.isSession ? 'session-shell' : ''}`}
        >
          <Outlet />
        </main>
        <DashboardUtilityOverlay
          snapshot={dashboard.snapshot}
          usageError={dashboard.usageError}
        />
      </DashboardUtilityProvider>
    </div>
  );
}

function DashboardUtilityOverlay({
  snapshot,
  usageError,
}: {
  snapshot: NonNullable<ReturnType<typeof useDashboardContext>['snapshot']>;
  usageError?: string;
}) {
  const utility = useDashboardUtility();
  const title =
    utility?.panel === 'sessions'
      ? 'History'
      : utility?.panel === 'inbox'
        ? 'Inbox'
        : 'Dashboard utility';
  return (
    <SurfaceDrawer
      title={title}
      eyebrow="Dashboard utility"
      className="surface-drawer utility-drawer"
      isOpen={Boolean(utility?.open && utility.panel)}
      onClose={() => utility?.close()}
    >
      {utility?.panel === 'sessions' && <SessionsView snapshot={snapshot} />}
      {utility?.panel === 'inbox' && (
        <InboxView snapshot={snapshot} usageError={usageError} />
      )}
    </SurfaceDrawer>
  );
}
