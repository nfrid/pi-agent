import {
  type DashboardLiveStore,
  useDashboardStore,
} from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useEffect, useRef, useState } from 'react';
import { useDashboardNavigate } from '../routes/navigation';
import { useComposerDraft } from './composer/draft';
import {
  deleteDraft,
  draftPath,
  getOrCreateDraft,
  readDrafts,
  useDrafts,
} from './drafts';
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

export function latestRunForThread<
  T extends { threadId: string; attempt: number; createdAt: number },
>(runs: readonly T[], threadId: string): T | undefined {
  return runs
    .filter((run) => run.threadId === threadId)
    .reduce<T | undefined>(
      (latest, run) =>
        !latest ||
        run.attempt > latest.attempt ||
        (run.attempt === latest.attempt && run.createdAt > latest.createdAt)
          ? run
          : latest,
      undefined,
    );
}

export function ProjectNewThreadView({
  projectId,
  draftId,
  pendingThreadId,
  snapshot,
  store,
}: {
  projectId?: string;
  draftId?: string;
  pendingThreadId?: string;
  snapshot: BrowserSnapshot;
  store: DashboardLiveStore;
}) {
  const go = useDashboardNavigate();
  const drafts = useDrafts();
  const draft = drafts.find((candidate) => candidate.id === draftId);
  const fallbackDraft =
    draft ?? readDrafts().find((candidate) => candidate.id === draftId);
  const resolvedProjectId = projectId ?? fallbackDraft?.projectId;
  const { clearDraft } = useComposerDraft(draftId ?? '__legacy-pending__');
  const project = (snapshot.projects ?? []).find(
    (candidate) => candidate.id === resolvedProjectId,
  );
  const [error, setError] = useState<string>();
  const promotionCompleted = useRef(false);
  const pendingRun = useDashboardStore(store, (state) =>
    pendingThreadId
      ? latestRunForThread(state.runs ?? [], pendingThreadId)
      : undefined,
  );
  const pendingRuntime = useDashboardStore(store, (state) =>
    pendingRun?.runtimeId
      ? state.runtimesById[pendingRun.runtimeId]
      : undefined,
  );

  useEffect(() => {
    if (!pendingThreadId && project && resolvedProjectId) {
      // New threads begin in the persisted main checkout. Isolation is an
      // explicit draft choice, not a project-wide default.
      const draft = getOrCreateDraft(project.id, 'main');
      go(draftPath(draft.id), { replace: true });
    }
  }, [go, pendingThreadId, project, resolvedProjectId]);

  useEffect(() => {
    const sessionId = pendingRuntime?.session.id;
    if (!sessionId || promotionCompleted.current) return;
    promotionCompleted.current = true;
    if (draftId) {
      clearDraft();
      deleteDraft(draftId);
    }
    go(`/sessions/${encodeURIComponent(sessionId)}`, { replace: true });
  }, [clearDraft, draftId, go, pendingRuntime?.session.id]);

  useEffect(() => {
    if (pendingRun?.status !== 'failed' && pendingRun?.status !== 'interrupted')
      return;
    setError(
      pendingRun.error ??
        (pendingRun.status === 'interrupted'
          ? 'The run was interrupted before its runtime started.'
          : 'The run failed before its runtime started.'),
    );
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
          onClick={() =>
            go(
              draftId
                ? draftPath(draftId)
                : `/projects/${encodeURIComponent(resolvedProjectId ?? '')}`,
              { replace: Boolean(draftId) },
            )
          }
        >
          {draftId ? 'Return to draft' : 'Back to project'}
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
