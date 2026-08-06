import {
  dashboardHttpClient,
  snapshotQueryOptions,
  snapshotRequestGeneration,
  usageQueryOptions,
} from '@pi-dashboard/client';

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
  useRouterState,
} from '@tanstack/react-router';
import {
  createContext,
  type FormEvent,
  useContext,
  useEffect,
  useState,
} from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useDashboardShell } from './dashboard-transport';
import { Composer } from './features/composer';
import { DashboardDialog } from './features/dashboard-dialog';
import {
  DashboardUtilityProvider,
  useDashboardUtility,
} from './features/dashboard-utility-context';
import { SessionView } from './features/session';
import {
  Dashboard,
  Header,
  InboxView,
  SessionsView,
  WorkspacesView,
  WorkspaceView,
} from './routes/dashboard';
import { LaunchView, RuntimeView } from './routes/runtime';

export {
  isNearPageBottom,
  sessionCursorRangeCovered,
  sessionDisplayTitle,
  sessionNavigationTarget,
  shouldApplySessionMetadata,
  shouldShowJumpToLatest,
} from './app-helpers';
export {
  api,
  asBrowserSnapshot,
  asSessionResponse,
} from './dashboard-transport';
export {
  buildTranscriptLandmarks,
  shouldShowActivityLead,
} from './entities/transcript';
export {
  AgentThreadNav,
  agentThreadRows,
  boundedAgentThreadRows,
} from './features/agent-thread-nav';
export {
  addImageAttachments,
  contextIndicatorData,
  formatContextTokens,
  queueCommand,
  queuedMessagesForRuntime,
  queueRemoveCommand,
  runtimeSupportsImages,
  shouldShowQueuePanel,
} from './features/composer';
export {
  ExtensionSurfaceStack,
  renderLiveExtensionSurface,
  runtimeExtensionSurfaces,
} from './features/extension-surfaces';
export { toTranscriptEntries } from './transcript';

const DashboardContext = createContext<
  ReturnType<typeof useDashboardShell> | undefined
>(undefined);
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

function useDashboardContext(): ReturnType<typeof useDashboardShell> {
  const value = useContext(DashboardContext);
  if (!value) throw new Error('Dashboard context is unavailable.');
  return value;
}

function AuthPrompt() {
  const [value, setValue] = useState('');
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    localStorage.setItem('pi-dashboard-token', value.trim());
    window.location.reload();
  };
  return (
    <main className="shell centered">
      <h1>Pi Dashboard</h1>
      <p>Enter the browser token printed by the dashboard daemon.</p>
      <form className="auth-form" onSubmit={save}>
        <input
          aria-label="Dashboard token"
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="current-password"
        />
        <AriaButton type="submit">Connect</AriaButton>
      </form>
    </main>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <DashboardApp />
    </QueryClientProvider>
  );
}

function DashboardApp() {
  const dashboard = useDashboardShell();
  const snapshotQuery = useQuery(
    snapshotQueryOptions(dashboardHttpClient, () =>
      dashboard.store.getGeneration(),
    ),
  );
  const usageQuery = useQuery(usageQueryOptions(dashboardHttpClient));
  useEffect(() => {
    if (snapshotQuery.data) {
      const requestGeneration = snapshotRequestGeneration(snapshotQuery.data);
      if (requestGeneration !== undefined)
        dashboard.store.installSnapshot(snapshotQuery.data, {
          source: 'http',
          requestGeneration,
        });
    }
    if (snapshotQuery.error)
      dashboard.store.setError(
        snapshotQuery.error instanceof Error
          ? snapshotQuery.error.message
          : String(snapshotQuery.error),
      );
  }, [dashboard.store, snapshotQuery.data, snapshotQuery.error]);
  useEffect(() => {
    if (usageQuery.data?.usage !== undefined)
      dashboard.store.updateUsage(usageQuery.data.usage);
    if (usageQuery.data?.error)
      dashboard.store.setUsageError(usageQuery.data.error);
  }, [dashboard.store, usageQuery.data]);
  if (
    !dashboard.snapshot &&
    snapshotQuery.error instanceof Error &&
    snapshotQuery.error.message.includes('Authentication')
  )
    return <AuthPrompt />;
  if (!dashboard.snapshot)
    return (
      <main className="shell centered">
        <h1>Pi Dashboard</h1>
        <p className="error">{dashboard.error ?? 'Connecting…'}</p>
        <button type="button" onClick={() => void snapshotQuery.refetch()}>
          Retry
        </button>
      </main>
    );
  return (
    <DashboardContext.Provider value={dashboard}>
      <RouterProvider router={dashboardRouterInstance} />
    </DashboardContext.Provider>
  );
}

function RouteShell() {
  const dashboard = useDashboardContext();
  const routeState = useRouterState({
    select: (state) => ({
      isSession: state.matches.some(
        (match) => match.routeId === '/sessions/$sessionId',
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
          className={`shell ${routeState.isSession ? 'session-shell' : ''}`}
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
    <DashboardDialog
      title={title}
      eyebrow="Workspace utility"
      className="surface-dialog utility-dialog"
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
    </DashboardDialog>
  );
}

function HomeRoute() {
  const dashboard = useDashboardContext();
  if (!dashboard.snapshot) return null;
  return (
    <Dashboard
      snapshot={dashboard.snapshot}
      usageError={dashboard.usageError}
      store={dashboard.store}
    />
  );
}

function SessionRoute() {
  const { sessionId } = useParams({ from: '/sessions/$sessionId' });
  const dashboard = useDashboardContext();
  if (!dashboard.snapshot) return null;
  return (
    <SessionView
      id={sessionId}
      snapshot={dashboard.snapshot}
      store={dashboard.store}
      Composer={Composer}
    />
  );
}

function WorkspaceRoute() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId' });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <WorkspaceView id={workspaceId} snapshot={dashboard.snapshot} />
  ) : null;
}

function WorkspacesRoute() {
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <WorkspacesView snapshot={dashboard.snapshot} store={dashboard.store} />
  ) : null;
}

function SessionsRoute() {
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <SessionsView snapshot={dashboard.snapshot} />
  ) : null;
}

function InboxRoute() {
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <InboxView
      snapshot={dashboard.snapshot}
      usageError={dashboard.usageError}
    />
  ) : null;
}

function RuntimeRoute() {
  const { runtimeId } = useParams({ from: '/runtimes/$runtimeId' });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <RuntimeView id={runtimeId} snapshot={dashboard.snapshot} />
  ) : null;
}

function NewRoute() {
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <LaunchView snapshot={dashboard.snapshot} store={dashboard.store} />
  ) : null;
}

const rootRoute = createRootRoute({ component: RouteShell });
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeRoute,
});
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsRoute,
});
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$sessionId',
  component: SessionRoute,
});
const workspacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces',
  component: WorkspacesRoute,
});
const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId',
  component: WorkspaceRoute,
});
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxRoute,
});
const runtimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runtimes/$runtimeId',
  component: RuntimeRoute,
});
const newRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/new',
  component: NewRoute,
});
export const dashboardRouteTree = rootRoute.addChildren([
  homeRoute,
  sessionsRoute,
  sessionRoute,
  workspacesRoute,
  workspaceRoute,
  inboxRoute,
  runtimeRoute,
  newRoute,
]);
export const dashboardRouterInstance = createRouter({
  routeTree: dashboardRouteTree,
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof dashboardRouterInstance;
  }
}
