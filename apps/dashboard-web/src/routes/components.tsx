import { useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useDashboardContext } from '../app/dashboard-context';
import { Composer } from '../features/composer';
import { NewChatView } from '../features/new-chat';
import newChatStyles from '../features/new-chat.module.css';
import { SessionView } from '../features/session';
import {
  Dashboard,
  InboxView,
  ProjectsView,
  ProjectView,
  SessionsView,
  WorkspacesView,
  WorkspaceView,
} from './dashboard';
import { newChatPath, useDashboardNavigate } from './navigation';
import { RuntimeView } from './runtime';

export function HomeRoute() {
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <Dashboard
      snapshot={dashboard.snapshot}
      usageError={dashboard.usageError}
      store={dashboard.store}
    />
  ) : null;
}

export function SessionRoute() {
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

export function WorkspaceRoute() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId' });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <WorkspaceView id={workspaceId} snapshot={dashboard.snapshot} />
  ) : null;
}

export function NewChatRoute() {
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

export function PendingNewChatRoute() {
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

export function ProjectsRoute() {
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <ProjectsView snapshot={dashboard.snapshot} />
  ) : null;
}

export function ProjectRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <ProjectView id={projectId} snapshot={dashboard.snapshot} />
  ) : null;
}

export function WorkspacesRoute() {
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <WorkspacesView snapshot={dashboard.snapshot} store={dashboard.store} />
  ) : null;
}

export function SessionsRoute() {
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <SessionsView snapshot={dashboard.snapshot} />
  ) : null;
}

export function InboxRoute() {
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <InboxView
      snapshot={dashboard.snapshot}
      usageError={dashboard.usageError}
    />
  ) : null;
}

export function RuntimeRoute() {
  const { runtimeId } = useParams({ from: '/runtimes/$runtimeId' });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <RuntimeView id={runtimeId} snapshot={dashboard.snapshot} />
  ) : null;
}

export function LegacyNewRoute() {
  const dashboard = useDashboardContext();
  const go = useDashboardNavigate();
  const path = dashboard.snapshot
    ? newChatPath(dashboard.snapshot)
    : '/workspaces';
  useEffect(() => go(path), [go, path]);
  return (
    <output className={`new-chat-missing ${newChatStyles.newChatMissing}`}>
      <p>Opening a new chat…</p>
    </output>
  );
}
