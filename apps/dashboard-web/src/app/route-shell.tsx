import { Outlet, useRouterState } from '@tanstack/react-router';
import {
  DashboardUtilityProvider,
  useDashboardUtility,
} from '../features/dashboard-utility-context';
import { SurfaceDrawer } from '../features/surface-drawer';
import {
  Header,
  InboxView,
  SessionsView,
  WorkspacesView,
} from '../routes/dashboard';
import { useDashboardContext } from './dashboard-context';

export function RouteShell() {
  const dashboard = useDashboardContext();
  const routeState = useRouterState({
    select: (state) => ({
      isSession: state.matches.some(
        (match) =>
          match.routeId === '/sessions/$sessionId' ||
          match.routeId === '/workspaces/$workspaceId/new' ||
          match.routeId === '/workspaces/$workspaceId/new/pending/$runtimeId',
      ),
      pathname: state.location.pathname,
    }),
  });
  if (!dashboard.snapshot) return null;
  const activeSessionId = routeState.pathname.startsWith('/sessions/')
    ? decodeURIComponent(routeState.pathname.split('/')[2] ?? '')
    : undefined;
  const pendingQuestions = Boolean(
    activeSessionId &&
      dashboard.snapshot.runtimes.some(
        (runtime) =>
          runtime.session?.id === activeSessionId &&
          runtime.pendingInteractions.length > 0,
      ),
  );
  return (
    <div className="app">
      <DashboardUtilityProvider
        blocked={pendingQuestions}
        locationKey={routeState.pathname}
      >
        <Header snapshot={dashboard.snapshot} />
        {(dashboard.error || dashboard.connectionState !== 'connected') && (
          <div className="notice sync-notice" role="status" aria-live="polite">
            {dashboard.error ??
              (dashboard.connectionState === 'reconnecting'
                ? 'Live updates disconnected; reconnecting…'
                : 'Connecting to live updates…')}
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
          store={dashboard.store}
        />
      </DashboardUtilityProvider>
    </div>
  );
}

function DashboardUtilityOverlay({
  snapshot,
  usageError,
  store,
}: {
  snapshot: NonNullable<ReturnType<typeof useDashboardContext>['snapshot']>;
  usageError?: string;
  store: ReturnType<typeof useDashboardContext>['store'];
}) {
  const utility = useDashboardUtility();
  const title =
    utility?.panel === 'workspaces'
      ? 'Workspaces'
      : utility?.panel === 'sessions'
        ? 'History'
        : utility?.panel === 'inbox'
          ? 'Inbox'
          : 'Dashboard utility';
  return (
    <SurfaceDrawer
      title={title}
      eyebrow="Workspace utility"
      className="surface-drawer utility-drawer"
      isOpen={Boolean(utility?.open && utility.panel)}
      onClose={() => utility?.close()}
    >
      {utility?.panel === 'workspaces' && (
        <WorkspacesView snapshot={snapshot} store={store} />
      )}
      {utility?.panel === 'sessions' && <SessionsView snapshot={snapshot} />}
      {utility?.panel === 'inbox' && (
        <InboxView snapshot={snapshot} usageError={usageError} />
      )}
    </SurfaceDrawer>
  );
}
