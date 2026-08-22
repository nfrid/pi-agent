import {
  type DashboardLiveStore,
  useDashboardStore,
} from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useEffect, useState } from 'react';
import { useDashboardNavigate } from '../routes/navigation';
import { draftPath, getOrCreateDraft } from './drafts';
import styles from './project-catalogue.module.css';

export function threadTitle(prompt: string): string {
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
  const [error, setError] = useState<string>();
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
    if (!pendingThreadId && project) {
      const draft = getOrCreateDraft(
        project.id,
        project.defaultIsolation ?? 'worktree',
      );
      go(draftPath(draft.id));
    }
  }, [go, pendingThreadId, project]);

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
      <p className="eyebrow">{project.title}</p>
      <h1>Opening draft…</h1>
      <p className="muted">Preparing a local draft for this project.</p>
    </section>
  );
}
