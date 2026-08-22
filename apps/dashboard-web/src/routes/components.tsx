import { useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useDashboardContext } from '../app/dashboard-context';
import { Composer } from '../features/composer';
import { DraftThreadView } from '../features/draft-thread';
import { SessionView } from '../features/session';
import {
  Dashboard,
  InboxView,
  ProjectNewThreadView,
  ProjectsView,
  ProjectView,
  SessionsView,
} from './dashboard';
import { newProjectThreadPath, useDashboardNavigate } from './navigation';
import { RuntimeView } from './runtime';

export function HomeRoute() {
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <Dashboard snapshot={dashboard.snapshot} />
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

export function ProjectNewThreadRoute() {
  const { projectId } = useParams({ from: '/projects/$projectId/new' });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <ProjectNewThreadView
      projectId={projectId}
      snapshot={dashboard.snapshot}
      store={dashboard.store}
    />
  ) : null;
}

export function DraftRoute() {
  const { draftId } = useParams({ from: '/drafts/$draftId' });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <DraftThreadView
      key={draftId}
      draftId={draftId}
      snapshot={dashboard.snapshot}
    />
  ) : null;
}

export function DraftPendingThreadRoute() {
  const { draftId, threadId } = useParams({
    from: '/drafts/$draftId/pending/$threadId',
  });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <ProjectNewThreadView
      draftId={draftId}
      pendingThreadId={threadId}
      snapshot={dashboard.snapshot}
      store={dashboard.store}
    />
  ) : null;
}

export function ProjectPendingThreadRoute() {
  const { projectId, threadId } = useParams({
    from: '/projects/$projectId/new/pending/$threadId',
  });
  const dashboard = useDashboardContext();
  return dashboard.snapshot ? (
    <ProjectNewThreadView
      projectId={projectId}
      pendingThreadId={threadId}
      snapshot={dashboard.snapshot}
      store={dashboard.store}
    />
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
    ? newProjectThreadPath(dashboard.snapshot)
    : '/projects';
  useEffect(() => go(path, { replace: true }), [go, path]);
  return <output className="route-loading">Opening a new thread…</output>;
}
