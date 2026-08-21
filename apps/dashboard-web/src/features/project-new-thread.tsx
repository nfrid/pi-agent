import {
  createThreadMutationOptions,
  type DashboardLiveStore,
  dashboardHttpClient,
  useDashboardStore,
} from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { useDashboardNavigate } from '../routes/navigation';
import { errorMessage } from '../shared/lib/error-message';
import styles from './project-catalogue.module.css';

function threadTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, ' ').trim();
  return [...normalized].slice(0, 96).join('');
}

export function projectPendingPath(
  projectId: string,
  threadId: string,
): string {
  return `/projects/${encodeURIComponent(projectId)}/new/pending/${encodeURIComponent(threadId)}`;
}

export function ProjectNewThreadView({
  projectId,
  pendingThreadId,
  snapshot,
  store,
}: {
  projectId: string;
  pendingThreadId?: string;
  snapshot: BrowserSnapshot;
  store: DashboardLiveStore;
}) {
  const go = useDashboardNavigate();
  const project = (snapshot.projects ?? []).find(
    (candidate) => candidate.id === projectId,
  );
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string>();
  const mutation = useMutation(
    createThreadMutationOptions(dashboardHttpClient),
  );
  const pendingRun = useDashboardStore(store, (state) =>
    pendingThreadId
      ? state.runs?.find((candidate) => candidate.threadId === pendingThreadId)
      : undefined,
  );
  const pendingRuntime = useDashboardStore(store, (state) =>
    pendingRun?.runtimeId
      ? state.runtimesById[pendingRun.runtimeId]
      : undefined,
  );

  useEffect(() => {
    const sessionId = pendingRuntime?.session.id;
    if (sessionId) go(`/sessions/${encodeURIComponent(sessionId)}`);
  }, [go, pendingRuntime?.session.id]);

  useEffect(() => {
    if (pendingRun?.status !== 'failed') return;
    setError(pendingRun.error ?? 'The run failed before its runtime started.');
  }, [pendingRun?.error, pendingRun?.status]);

  if (!project) {
    return (
      <section className={styles.page}>
        <h1>Project not found</h1>
        <p className="error" role="alert">
          This project is no longer available.
        </p>
        <button type="button" onClick={() => go('/projects')}>
          Choose a project
        </button>
      </section>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || mutation.isPending) return;
    setError(undefined);
    try {
      const result = await mutation.mutateAsync({
        projectId,
        command: {
          title: threadTitle(text),
          prompt: text,
          isolation: project.defaultIsolation,
        },
      });
      go(projectPendingPath(projectId, result.thread.id));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  if (pendingThreadId) {
    return (
      <section className={styles.page} aria-live="polite">
        <p className="eyebrow">{project.title}</p>
        <h1>Starting thread</h1>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <output className={styles.pending}>
            Preparing the checkout and runtime…
          </output>
        )}
        <button
          type="button"
          className="secondary-button"
          onClick={() => go(`/projects/${encodeURIComponent(projectId)}`)}
        >
          Back to project
        </button>
      </section>
    );
  }

  return (
    <section className={styles.page}>
      <div className="section-heading page-heading">
        <div>
          <p className="eyebrow">{project.title}</p>
          <h1>New thread</h1>
          <p className="muted path">{project.rootPath}</p>
        </div>
      </div>
      <form
        className={styles.threadForm}
        onSubmit={(event) => void submit(event)}
      >
        <label htmlFor="project-thread-prompt">Task</label>
        <textarea
          id="project-thread-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe what the agent should do"
          rows={8}
          disabled={mutation.isPending}
        />
        <p className="muted">
          Isolation: {project.defaultIsolation ?? 'worktree'}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={!prompt.trim() || mutation.isPending}>
          {mutation.isPending ? 'Creating…' : 'Create thread'}
        </button>
      </form>
    </section>
  );
}
