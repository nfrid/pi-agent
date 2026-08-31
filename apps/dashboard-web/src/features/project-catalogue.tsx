import {
  createProjectMutationOptions,
  dashboardHttpClient,
  renameProjectMutationOptions,
} from '@pi-dashboard/client';
import type { BrowserSnapshot, ProjectSummary } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Back, useDashboardNavigate } from '../routes/navigation';
import { errorMessage } from '../shared/lib/error-message';
import { RuntimeCard } from './dashboard-overview';
import styles from './project-catalogue.module.css';
import { ProjectIcon } from './project-icon';
import { SessionRow } from './session-row';

export interface ProjectCounts {
  checkouts: number;
  runtimes: number;
  sessions: number;
}

export function projectCounts(
  snapshot: BrowserSnapshot,
  projectId: string,
): ProjectCounts {
  return {
    checkouts: (snapshot.checkouts ?? []).filter(
      (checkout) => checkout.projectId === projectId,
    ).length,
    runtimes: snapshot.runtimes.filter(
      (runtime) => runtime.projectId === projectId,
    ).length,
    sessions: snapshot.sessions.filter(
      (session) => session.projectId === projectId,
    ).length,
  };
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function ProjectCard({
  project,
  snapshot,
}: {
  project: ProjectSummary;
  snapshot: BrowserSnapshot;
}) {
  const go = useDashboardNavigate();
  const counts = projectCounts(snapshot, project.id);
  return (
    <button
      type="button"
      className="workspace-card"
      onClick={() => go(`/projects/${encodeURIComponent(project.id)}`)}
    >
      <span className={styles.cardIdentity}>
        <ProjectIcon projectId={project.id} title={project.title} />
        <span className="workspace-card-main">
          <strong>{project.title}</strong>
          <small className="path">{project.rootPath}</small>
        </span>
      </span>
      <span className={`workspace-state ${project.status}`}>
        <i aria-hidden="true">●</i> {project.status}
      </span>
      <span className="workspace-card-meta">
        {countLabel(counts.checkouts, 'checkout')} ·{' '}
        {countLabel(counts.runtimes, 'runtime')} ·{' '}
        {countLabel(counts.sessions, 'session')}
      </span>
    </button>
  );
}

export function ProjectsView({ snapshot }: { snapshot: BrowserSnapshot }) {
  const go = useDashboardNavigate();
  const projects = (snapshot.projects ?? []).filter(
    (project) => project.status === 'active',
  );
  const [rootPath, setRootPath] = useState('');
  const [error, setError] = useState<string>();
  const mutation = useMutation(
    createProjectMutationOptions(dashboardHttpClient),
  );
  const unassignedRuntimes = snapshot.runtimes.filter(
    (runtime) => !runtime.projectId,
  ).length;
  const unassignedSessions = snapshot.sessions.filter(
    (session) => !session.projectId,
  ).length;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = rootPath.trim();
    if (
      !candidate.startsWith('/') &&
      candidate !== '~' &&
      !candidate.startsWith('~/')
    ) {
      setError('Enter an absolute path or a path starting with ~/.');
      return;
    }
    setError(undefined);
    try {
      const result = await mutation.mutateAsync({ rootPath: candidate });
      setRootPath('');
      go(`/projects/${encodeURIComponent(result.project.id)}`);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <section className={styles.page}>
      <div className="section-heading page-heading">
        <div>
          <h1>Projects</h1>
          <p className="muted">
            Registered repositories and directories available to agents.
          </p>
        </div>
      </div>

      <form className={styles.addForm} onSubmit={(event) => void submit(event)}>
        <label htmlFor="project-root-path">Add a project</label>
        <div className={styles.addControls}>
          <input
            id="project-root-path"
            type="text"
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
            placeholder="~/code/project"
            autoComplete="off"
            disabled={mutation.isPending}
          />
          <button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
        <p className="muted">
          Git worktrees resolve to their registered repository automatically.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>

      <div className="workspace-list">
        {projects.map((project) => (
          <ProjectCard project={project} snapshot={snapshot} key={project.id} />
        ))}
      </div>
      {!projects.length && (
        <p className="empty">No projects registered. Add a directory above.</p>
      )}

      <section className={styles.unassigned} aria-label="Unassigned activity">
        <div>
          <strong>Unassigned</strong>
          <p className="muted">
            Activity outside registered projects remains available and is never
            adopted automatically.
          </p>
        </div>
        <span>
          {countLabel(unassignedRuntimes, 'runtime')} ·{' '}
          {countLabel(unassignedSessions, 'session')}
        </span>
      </section>
    </section>
  );
}

export function ProjectView({
  id,
  snapshot,
}: {
  id: string;
  snapshot: BrowserSnapshot;
}) {
  const go = useDashboardNavigate();
  const project = (snapshot.projects ?? []).find((item) => item.id === id);
  const checkouts = (snapshot.checkouts ?? []).filter(
    (checkout) => checkout.projectId === id,
  );
  const runtimes = snapshot.runtimes.filter(
    (runtime) => runtime.projectId === id,
  );
  const sessions = snapshot.sessions.filter(
    (session) => session.projectId === id,
  );
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(project?.title ?? '');
  const [renameError, setRenameError] = useState<string>();
  const renameMutation = useMutation(
    renameProjectMutationOptions(dashboardHttpClient),
  );
  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!project || !nextTitle || renameMutation.isPending) return;
    setRenameError(undefined);
    try {
      await renameMutation.mutateAsync({
        projectId: project.id,
        command: { title: nextTitle },
      });
      setRenaming(false);
    } catch (cause) {
      setRenameError(errorMessage(cause));
    }
  };

  return (
    <section className={styles.page}>
      <Back />
      <div className="section-heading page-heading">
        <div className={styles.projectHeading}>
          {project && (
            <ProjectIcon
              projectId={project.id}
              title={project.title}
              size="large"
            />
          )}
          <div>
            <h1>{project?.title ?? 'Unknown project'}</h1>
            {project && <p className="muted path">{project.rootPath}</p>}
          </div>
        </div>
        {project && (
          <div className={styles.projectActions}>
            <span className="workspace-state active">{project.status}</span>
            {renaming ? (
              <form
                className={styles.renameForm}
                onSubmit={(event) => void submitRename(event)}
              >
                <label className="sr-only" htmlFor="project-title">
                  Project name
                </label>
                <input
                  id="project-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  disabled={renameMutation.isPending}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setTitle(project.title);
                    setRenameError(undefined);
                    setRenaming(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!title.trim() || renameMutation.isPending}
                >
                  {renameMutation.isPending ? 'Saving…' : 'Save'}
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setTitle(project.title);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                go(`/projects/${encodeURIComponent(project.id)}/new`)
              }
            >
              New thread
            </button>
          </div>
        )}
      </div>
      {renameError && (
        <p className="error" role="alert">
          {renameError}
        </p>
      )}

      {!project && (
        <output className="empty">This project is no longer registered.</output>
      )}

      <div className={styles.sectionHeading}>
        <h2>Checkouts</h2>
        <span>{countLabel(checkouts.length, 'checkout')}</span>
      </div>
      <div className="workspace-list">
        {checkouts.map((checkout) => (
          <article
            className={`workspace-card ${styles.checkout}`}
            key={checkout.id}
          >
            <span className="workspace-card-main">
              <strong>{checkout.branch ?? checkout.kind}</strong>
              <small className="path">{checkout.path}</small>
            </span>
            <span className={`workspace-state ${checkout.status}`}>
              {checkout.status}
            </span>
          </article>
        ))}
      </div>
      {!checkouts.length && <p className="empty">No checkouts recorded.</p>}

      <div className={styles.sectionHeading}>
        <h2>Runtimes</h2>
        <span>{countLabel(runtimes.length, 'runtime')}</span>
      </div>
      <div className={styles.list}>
        {runtimes.map((runtime) => (
          <RuntimeCard runtime={runtime} key={runtime.runtimeId} />
        ))}
      </div>
      {!runtimes.length && (
        <p className="empty">No runtimes for this project.</p>
      )}

      <div className={styles.sectionHeading}>
        <h2>Sessions</h2>
        <span>{countLabel(sessions.length, 'session')}</span>
      </div>
      <div className={styles.list}>
        {sessions.map((session) => (
          <SessionRow session={session} key={session.id} />
        ))}
      </div>
      {!sessions.length && (
        <p className="empty">No sessions for this project.</p>
      )}
    </section>
  );
}
