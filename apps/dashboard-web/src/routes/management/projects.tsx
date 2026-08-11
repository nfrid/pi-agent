import {
  adoptProjectMutationOptions,
  adoptSessionMutationOptions,
  dashboardHttpClient,
  invalidateDashboardQueries,
} from '@pi-dashboard/client';
import type { BrowserSnapshot, ProjectSummary } from '@pi-dashboard/protocol';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useDashboardNavigate } from '../navigation';
import { unassignedSessions } from './paths';
import { runningRunStatuses } from './projection';
import { Rail } from './rail';
import { ProjectShelves } from './shelves';

export function ProjectsRoute({ snapshot }: { snapshot: BrowserSnapshot }) {
  const go = useDashboardNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    ...adoptProjectMutationOptions(dashboardHttpClient),
    onSuccess: async (result) => {
      await invalidateDashboardQueries(queryClient);
      go(`/projects/${encodeURIComponent(result.project.id)}`);
    },
  });
  const [workspaceId, setWorkspaceId] = useState(
    snapshot.workspaces[0]?.id ?? '',
  );
  const [title, setTitle] = useState('');
  const [isolation, setIsolation] = useState<'worktree' | 'main'>('worktree');
  const [maxParallelRuns, setMaxParallelRuns] = useState('1');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId) return;
    mutation.mutate({
      workspaceId,
      ...(title.trim() ? { title: title.trim() } : {}),
      defaultIsolation: isolation,
      maxParallelRuns: Math.max(1, Number(maxParallelRuns) || 1),
    });
  };
  return (
    <>
      <Rail snapshot={snapshot} />
      <section className="management-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Management</p>
            <h1>Projects</h1>
          </div>
          <button type="button" onClick={() => go('/')}>
            Dashboard
          </button>
        </div>
        <form className="management-form" onSubmit={submit}>
          <h2>Adopt a workspace</h2>
          <label>
            Workspace
            <select
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              {snapshot.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name} · {workspace.canonicalPath}
                </option>
              ))}
            </select>
          </label>
          <label>
            Project title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Defaults to workspace name"
            />
          </label>
          <label>
            Default isolation
            <select
              value={isolation}
              onChange={(event) =>
                setIsolation(event.target.value as 'worktree' | 'main')
              }
            >
              <option value="worktree">Worktree</option>
              <option value="main">Main checkout</option>
            </select>
          </label>
          <label>
            Max parallel runs
            <input
              type="number"
              min="1"
              value={maxParallelRuns}
              onChange={(event) => setMaxParallelRuns(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!workspaceId || mutation.isPending}>
            {mutation.isPending ? 'Adopting…' : 'Adopt project'}
          </button>
          {mutation.error && <p className="error">{String(mutation.error)}</p>}
        </form>
        {(snapshot.projects ?? []).length === 0 && (
          <p className="empty-state">
            No projects yet. Adopt an existing workspace to start durable queued
            work.
          </p>
        )}
        {(snapshot.projects ?? []).map((project) => (
          <button
            type="button"
            className="project-list-row"
            key={project.id}
            onClick={() => go(`/projects/${encodeURIComponent(project.id)}`)}
          >
            <strong>{project.title}</strong>
            <span>
              {project.activeRunCount} active · max {project.maxParallelRuns}
            </span>
            <small>{project.rootPath}</small>
          </button>
        ))}
      </section>
    </>
  );
}

export function ProjectRoute({
  projectId,
  snapshot,
}: {
  projectId: string;
  snapshot: BrowserSnapshot;
}) {
  const project = snapshot.projects?.find((item) => item.id === projectId);
  const go = useDashboardNavigate();
  if (!project)
    return (
      <section className="management-page">
        <h1>Project not found</h1>
        <button type="button" onClick={() => go('/projects')}>
          Projects
        </button>
      </section>
    );
  return (
    <>
      <Rail snapshot={snapshot} activeProjectId={project.id} />
      <section className="management-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Project</p>
            <h1>{project.title}</h1>
            <p className="path-label">{project.rootPath}</p>
          </div>
          <button
            type="button"
            onClick={() =>
              go(`/projects/${encodeURIComponent(project.id)}/new`)
            }
          >
            + New thread
          </button>
        </div>
        <p className="management-summary">
          {
            (snapshot.runs ?? []).filter(
              (run) =>
                runningRunStatuses.has(run.status) &&
                snapshot.threads?.find((thread) => thread.id === run.threadId)
                  ?.projectId === project.id,
            ).length
          }{' '}
          active ·{' '}
          {
            (snapshot.runs ?? []).filter(
              (run) =>
                run.status === 'queued' &&
                snapshot.threads?.find((thread) => thread.id === run.threadId)
                  ?.projectId === project.id,
            ).length
          }{' '}
          queued · max {project.maxParallelRuns} parallel runs · attention{' '}
          {
            (snapshot.threads ?? []).filter(
              (thread) =>
                thread.projectId === project.id &&
                (thread.status === 'needs-input' || thread.status === 'failed'),
            ).length
          }
        </p>
        <ProjectShelves project={project} snapshot={snapshot} />
        <LegacySessions project={project} snapshot={snapshot} />
      </section>
    </>
  );
}

function LegacySessions({
  project,
  snapshot,
}: {
  project: ProjectSummary;
  snapshot: BrowserSnapshot;
}) {
  const queryClient = useQueryClient();
  const go = useDashboardNavigate();
  const mutation = useMutation({
    ...adoptSessionMutationOptions(dashboardHttpClient),
    onSuccess: async (result) => {
      await invalidateDashboardQueries(queryClient);
      go(`/threads/${encodeURIComponent(result.thread.id)}`);
    },
  });
  const sessions = unassignedSessions(snapshot, project);
  if (!sessions.length) return null;
  return (
    <section className="legacy-sessions">
      <h2>Unassigned Pi sessions</h2>
      <p>These legacy sessions are not owned by a thread.</p>
      {sessions.map((session) => (
        <div className="legacy-session-row" key={session.id}>
          <span className="legacy-session-info">
            <strong>{session.title ?? session.name ?? session.id}</strong>
            <small>{session.cwd}</small>
          </span>
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({ projectId: project.id, sessionId: session.id })
            }
          >
            Adopt as thread
          </button>
        </div>
      ))}
      {mutation.error && (
        <p className="error" role="alert">
          Unable to adopt session: {String(mutation.error)}
        </p>
      )}
    </section>
  );
}
