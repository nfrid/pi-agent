import { Outlet, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { AgentThreadNav } from '../features/agent-thread-nav';
import {
  DashboardSurfaceProvider,
  useDashboardSurfaces,
} from '../features/dashboard-surface-context';
import { SessionNavigationContext } from '../features/session-navigation-context';
import { SurfaceStack } from '../features/surface-stack';
import { Header, SettingsView } from '../routes/dashboard';
import { useDashboardContext } from './dashboard-context';

function routeIdentity(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const value = pathname.slice(prefix.length).split('/')[0];
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function RouteShell() {
  const dashboard = useDashboardContext();
  const [agentNavOpen, setAgentNavOpen] = useState(false);
  const routeState = useRouterState({
    select: (state) => ({
      isSession: state.matches.some(
        (match) =>
          match.routeId === '/sessions/$sessionId' ||
          match.routeId === '/projects/$projectId/new' ||
          match.routeId === '/projects/$projectId/new/pending/$threadId' ||
          match.routeId === '/drafts/$draftId' ||
          match.routeId === '/drafts/$draftId/pending/$threadId',
      ),
      pathname: state.location.pathname,
    }),
  });
  if (!dashboard.snapshot) return null;
  const currentSessionId = routeIdentity(routeState.pathname, '/sessions/');
  const currentDraftId = routeIdentity(routeState.pathname, '/drafts/');
  const routeContent = routeState.isSession ? (
    <div className="session-layout">
      <AgentThreadNav
        snapshot={dashboard.snapshot}
        mode="session"
        currentSessionId={currentSessionId}
        currentDraftId={currentDraftId}
        open={agentNavOpen}
        onOpenChange={setAgentNavOpen}
      />
      <SessionNavigationContext.Provider
        value={{ open: agentNavOpen, setOpen: setAgentNavOpen }}
      >
        <div className="session-route-view">
          <Outlet />
        </div>
      </SessionNavigationContext.Provider>
    </div>
  ) : (
    <Outlet />
  );
  return (
    <div className="app">
      <DashboardSurfaceProvider
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
          {routeContent}
        </main>
        <DashboardSurfaceOverlay snapshot={dashboard.snapshot} />
      </DashboardSurfaceProvider>
    </div>
  );
}

function DashboardSurfaceOverlay({
  snapshot,
}: {
  snapshot: NonNullable<ReturnType<typeof useDashboardContext>['snapshot']>;
}) {
  const surfaces = useDashboardSurfaces();
  const pages =
    surfaces?.stack.map((surface) => ({
      id: surface.type,
      title: 'Settings',
      eyebrow: 'Dashboard utility',
      children: <SettingsView snapshot={snapshot} />,
    })) ?? [];
  return (
    <SurfaceStack
      pages={pages}
      kind="utility"
      size="compact"
      className="surface-drawer utility-drawer"
      isOpen={pages.length > 0}
      onDepthChange={(depth) => surfaces?.truncate(depth)}
      onClose={() => surfaces?.close()}
    />
  );
}
