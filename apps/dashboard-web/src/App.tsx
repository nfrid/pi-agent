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
import { NewChatView } from './features/new-chat';
import { SessionView } from './features/session';
import {
  Dashboard,
  Header,
  InboxView,
  SessionsView,
  WorkspacesView,
  WorkspaceView,
} from './routes/dashboard';
import { newChatPath, useDashboardNavigate } from './routes/navigation';
import { RuntimeView } from './routes/runtime';
import './management.css';
import {
  ManagementHome,
  NewThreadRoute,
  ProjectRoute,
  ProjectsRoute,
  ThreadRoute,
} from './routes/management';

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
  composerDraftStorageKey,
  contextIndicatorData,
  formatContextTokens,
  queueCommand,
  queuedMessagesForRuntime,
  queueRemoveCommand,
  readComposerDraft,
  resumeRuntimeRequest,
  runtimeSupportsImages,
  shouldShowQueuePanel,
  upsertQueuedMessage,
  writeComposerDraft,
} from './features/composer';
export {
  ExtensionSurfaceStack,
  renderLiveExtensionSurface,
  runtimeExtensionSurfaces,
} from './features/extension-surfaces';
export {
  newChatModelOptions,
  newChatRequest,
  newChatThinkingLevels,
  pendingChatPath,
  preferredNewChatRuntime,
  sessionPathForRuntime,
} from './features/new-chat';
export {
  groupThreads,
  isTerminalRun,
  latestRunForThread,
  managementStatusCounts,
  pathWithin,
  runTiming,
  sessionRouteTarget,
  threadActionAvailability,
  threadNeedsAttention,
  unassignedSessions,
} from './routes/management';
export { newChatPath } from './routes/navigation';
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
        (match) =>
          match.routeId === '/sessions/$sessionId' ||
          match.routeId === '/threads/$threadId' ||
          match.routeId === '/workspaces/$workspaceId/new' ||
          match.routeId === '/workspaces/$workspaceId/new/pending/$runtimeId',
      ),
      pathname: state.location.pathname,
    }),
  });
  if (!dashboard.snapshot) return null;
  const activeSessionId = routeState.pathname.startsWith('/sessions/')
    ? decodeURIComponent(routeState.pathname.split('/')[2] ?? '')
    : routeState.pathname.startsWith('/threads/')
      ? dashboard.snapshot.runs?.find(
          (run) =>
            run.threadId ===
              decodeURIComponent(routeState.pathname.split('/')[2] ?? '') &&
            run.piSessionId,
        )?.piSessionId
      : undefined;
  const pendingQuestions = Boolean(
    activeSessionId &&
      dashboard.snapshot.runtimes.some(
        (runtime) =>
          runtime.session?.id === activeSessionId &&
          runtime.pendingInteractions.length > 0,
      ),
  );
  const compactingRuntimes = dashboard.snapshot.runtimes.filter(
    (runtime) => runtime.online !== false && runtime.liveState === 'compacting',
  );
  return (
    <div className="app">
      <DashboardUtilityProvider
        blocked={pendingQuestions}
        locationKey={routeState.pathname}
      >
        <Header snapshot={dashboard.snapshot} />
        {compactingRuntimes.length > 0 && (
          <div
            className="compaction-progress-notice"
            role="status"
            aria-live="assertive"
          >
            <span className="compaction-progress-spinner" aria-hidden="true" />
            <span>
              <strong>Compacting context…</strong>
              <small>
                {compactingRuntimes.length === 1
                  ? 'The transcript will refresh when the new summary is ready.'
                  : `${compactingRuntimes.length} sessions are being compacted.`}
              </small>
            </span>
          </div>
        )}
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
  if ((dashboard.snapshot.projects?.length ?? 0) > 0)
    return <ManagementHome snapshot={dashboard.snapshot} />;
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
  const ownedRun = dashboard.snapshot?.runs?.find(
    (run) => run.piSessionId === sessionId,
  );
  const go = useDashboardNavigate();
  useEffect(() => {
    if (ownedRun) go(`/threads/${encodeURIComponent(ownedRun.threadId)}`);
  }, [go, ownedRun]);
  if (!dashboard.snapshot) return null;
  if (ownedRun) return <section role="status">Opening managed thread…</section>;
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

function NewChatRoute() {
  const { workspaceId } = useParams({
    from: '/workspaces/$workspaceId/new',
  });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <NewChatView
      workspaceId={workspaceId}
      snapshot={dashboard.snapshot}
      store={dashboard.store}
    />
  ) : null;
}

function PendingNewChatRoute() {
  const { workspaceId, runtimeId } = useParams({
    from: '/workspaces/$workspaceId/new/pending/$runtimeId',
  });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <NewChatView
      workspaceId={workspaceId}
      pendingRuntimeId={runtimeId}
      snapshot={dashboard.snapshot}
      store={dashboard.store}
    />
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

function ManagementProjectsRoute() {
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <ProjectsRoute snapshot={dashboard.snapshot} />
  ) : null;
}
function ManagementProjectRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <ProjectRoute projectId={projectId} snapshot={dashboard.snapshot} />
  ) : null;
}
function ManagementNewThreadRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId/new' });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <NewThreadRoute projectId={projectId} snapshot={dashboard.snapshot} />
  ) : null;
}
function ManagementThreadRoute() {
  const { threadId } = useParams({ from: '/threads/$threadId' });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <ThreadRoute
      threadId={threadId}
      snapshot={dashboard.snapshot}
      store={dashboard.store}
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

function LegacyNewRoute() {
  const dashboard = useDashboardContext();
  const go = useDashboardNavigate();
  const path = dashboard.snapshot
    ? newChatPath(dashboard.snapshot)
    : '/workspaces';
  useEffect(() => go(path), [go, path]);
  return (
    <section className="new-chat-missing" role="status">
      <p>Opening a new chat…</p>
    </section>
  );
}

const rootRoute = createRootRoute({ component: RouteShell });
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeRoute,
});
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ManagementProjectsRoute,
});
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: ManagementProjectRoute,
});
const projectNewThreadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId/new',
  component: ManagementNewThreadRoute,
});
const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/threads/$threadId',
  component: ManagementThreadRoute,
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
const newChatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/new',
  component: NewChatRoute,
});
const pendingNewChatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId/new/pending/$runtimeId',
  component: PendingNewChatRoute,
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
const legacyNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/new',
  component: LegacyNewRoute,
});
export const dashboardRouteTree = rootRoute.addChildren([
  homeRoute,
  projectsRoute,
  projectRoute,
  projectNewThreadRoute,
  threadRoute,
  sessionsRoute,
  sessionRoute,
  workspacesRoute,
  workspaceRoute,
  newChatRoute,
  pendingNewChatRoute,
  inboxRoute,
  runtimeRoute,
  legacyNewRoute,
]);
export const dashboardRouterInstance = createRouter({
  routeTree: dashboardRouteTree,
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof dashboardRouterInstance;
  }
}
