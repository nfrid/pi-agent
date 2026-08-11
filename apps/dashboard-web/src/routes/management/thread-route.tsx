import type { DashboardLiveStore } from '@pi-dashboard/client';
import {
  archiveThreadMutationOptions,
  cancelRunMutationOptions,
  dashboardHttpClient,
  invalidateDashboardQueries,
  mergeCheckoutMutationOptions,
  retireCheckoutMutationOptions,
  retryThreadMutationOptions,
  reviewCheckoutMutationOptions,
} from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Composer } from '../../features/composer';
import { SessionView } from '../../features/session';
import { useDashboardNavigate } from '../navigation';
import { threadActionAvailability, when } from './projection';
import { Rail } from './rail';

export function ThreadRoute({
  threadId,
  snapshot,
  store,
}: {
  threadId: string;
  snapshot: BrowserSnapshot;
  store: DashboardLiveStore;
}) {
  const thread = snapshot.threads?.find((item) => item.id === threadId);
  const go = useDashboardNavigate();
  const queryClient = useQueryClient();
  const runs = (snapshot.runs ?? [])
    .filter((run) => run.threadId === threadId)
    .sort((a, b) => b.attempt - a.attempt || b.createdAt - a.createdAt);
  const selected = runs[0];
  const checkout = selected
    ? snapshot.checkouts?.find((item) => item.id === selected.checkoutId)
    : undefined;
  const selectedRunId = selected?.id;
  const selectedSessionId = selected?.piSessionId;
  const [replacementSessionId, setReplacementSessionId] = useState<string>();
  const effectiveSessionId = replacementSessionId ?? selectedSessionId;
  const handleSessionReplacement = useCallback(
    (sessionId: string) => setReplacementSessionId(sessionId),
    [],
  );
  useEffect(() => {
    void selectedRunId;
    void selectedSessionId;
    setReplacementSessionId(undefined);
  }, [selectedRunId, selectedSessionId]);
  const [feedback, setFeedback] = useState<string>();
  const [review, setReview] = useState<unknown>();
  const refresh = async () => invalidateDashboardQueries(queryClient);
  const cancel = useMutation({
    ...cancelRunMutationOptions(dashboardHttpClient),
    onSuccess: async () => {
      setFeedback('Interrupt requested.');
      await refresh();
    },
  });
  const retry = useMutation({
    ...retryThreadMutationOptions(dashboardHttpClient),
    onSuccess: async () => {
      setFeedback('Retry queued.');
      await refresh();
    },
  });
  const archive = useMutation({
    ...archiveThreadMutationOptions(dashboardHttpClient),
    onSuccess: async () => {
      setFeedback('Thread archived.');
      await refresh();
    },
  });
  const reviewMutation = useMutation({
    ...reviewCheckoutMutationOptions(dashboardHttpClient),
    onSuccess: (result) => setReview(result),
  });
  const merge = useMutation({
    ...mergeCheckoutMutationOptions(dashboardHttpClient),
    onSuccess: async () => {
      setFeedback('Checkout merged.');
      await refresh();
    },
  });
  const retire = useMutation({
    ...retireCheckoutMutationOptions(dashboardHttpClient),
    onSuccess: async () => {
      setFeedback('Checkout retired.');
      await refresh();
    },
  });
  if (!thread)
    return (
      <section className="management-page">
        <h1>Thread not found</h1>
        <button type="button" onClick={() => go('/')}>
          Dashboard
        </button>
      </section>
    );
  const availability = threadActionAvailability(selected, checkout);
  const busy =
    cancel.isPending ||
    retry.isPending ||
    archive.isPending ||
    merge.isPending ||
    retire.isPending;
  const actionError =
    cancel.error ??
    retry.error ??
    archive.error ??
    merge.error ??
    retire.error ??
    reviewMutation.error;
  const confirmAction = (message: string, action: () => void) => {
    if (globalThis.confirm(message)) action();
  };
  const sessionId = effectiveSessionId;
  const reviewRecord =
    review && typeof review === 'object' && !Array.isArray(review)
      ? (review as {
          state?: string;
          stat?: string;
          diff?: string;
          pathSummary?: {
            total?: number;
            matchedPaths?: string[];
          };
        })
      : undefined;
  return (
    <>
      <Rail snapshot={snapshot} activeProjectId={thread.projectId} />
      <section className="management-page thread-detail">
        <button
          type="button"
          className="back"
          onClick={() =>
            go(`/projects/${encodeURIComponent(thread.projectId)}`)
          }
        >
          ← Project
        </button>
        <div className="page-heading">
          <div>
            <p className="eyebrow">Thread</p>
            <h1>{thread.title}</h1>
            <p className="path-label">
              {thread.status} · updated {when(thread.updatedAt)}
            </p>
          </div>
          <div className="action-row">
            <button
              type="button"
              disabled={!availability.canInterrupt || busy}
              onClick={() => selected && cancel.mutate({ runId: selected.id })}
            >
              Interrupt run
            </button>
            <button
              type="button"
              disabled={!availability.canRetry || busy}
              onClick={() => retry.mutate({ threadId })}
            >
              Retry
            </button>
            <button
              type="button"
              disabled={!availability.canArchive || busy}
              onClick={() =>
                confirmAction('Archive this thread?', () =>
                  archive.mutate({ threadId }),
                )
              }
            >
              Archive
            </button>
          </div>
        </div>
        {feedback && (
          <p className="success" role="status">
            {feedback}
          </p>
        )}
        {actionError && (
          <p className="error" role="alert">
            {String(actionError)}
          </p>
        )}
        <section className="detail-panel">
          <h2>Run history</h2>
          {runs.length ? (
            runs.map((run) => (
              <article className="run-history-row" key={run.id}>
                <strong>Attempt {run.attempt}</strong>
                <span className="run-history-meta">{run.status}</span>
                <span className="run-history-meta">
                  created {when(run.createdAt)}
                </span>
                <span className="run-history-meta">
                  {run.startedAt ? `started ${when(run.startedAt)}` : ''}{' '}
                  {run.finishedAt ? `settled ${when(run.finishedAt)}` : ''}
                </span>
                {run.error && <p className="error run-error">{run.error}</p>}
              </article>
            ))
          ) : (
            <p>No attempts yet.</p>
          )}
        </section>
        <section className="detail-panel">
          <h2>Checkout</h2>
          {checkout ? (
            <>
              <p>
                {checkout.kind} · {checkout.status}
              </p>
              <p>
                {checkout.path}
                {checkout.branch ? ` · ${checkout.branch}` : ''}
                {checkout.changedFileCount !== undefined
                  ? ` · ${checkout.changedFileCount} changed files`
                  : ''}
              </p>
              <div className="action-row">
                <button
                  type="button"
                  disabled={!availability.canReview || reviewMutation.isPending}
                  onClick={() => reviewMutation.mutate(checkout.id)}
                >
                  Review checkout
                </button>
                <button
                  type="button"
                  disabled={!availability.canMerge || busy}
                  onClick={() =>
                    confirmAction('Merge this checkout?', () =>
                      merge.mutate({ checkoutId: checkout.id }),
                    )
                  }
                >
                  Merge
                </button>
                <button
                  type="button"
                  disabled={!availability.canRetire || busy}
                  onClick={() =>
                    confirmAction('Retire this checkout?', () =>
                      retire.mutate({ checkoutId: checkout.id }),
                    )
                  }
                >
                  Retire
                </button>
              </div>
              {reviewRecord && (
                <div className="bounded-review">
                  <p>
                    {reviewRecord.state ?? 'Review'} ·{' '}
                    {reviewRecord.pathSummary?.total ?? 0} changed paths
                  </p>
                  <p>
                    {reviewRecord.pathSummary?.matchedPaths?.join(', ') ||
                      'No changed paths reported.'}
                  </p>
                  <pre>{(reviewRecord.stat ?? '').slice(0, 5_000)}</pre>
                  <pre>{(reviewRecord.diff ?? '').slice(0, 15_000)}</pre>
                </div>
              )}
            </>
          ) : (
            <p>No checkout.</p>
          )}
        </section>
        {selected && (
          <section className="detail-panel">
            <h2>Runtime lineage</h2>
            <p>
              Provider: {selected.runtimeProvider} · runtime{' '}
              {selected.runtimeId ?? 'not started'} · Pi session{' '}
              {sessionId ?? 'not attached'}
            </p>
          </section>
        )}
        {sessionId && (
          <section className="detail-panel transcript-embed">
            <h2>Transcript</h2>
            <SessionView
              id={sessionId}
              snapshot={snapshot}
              store={store}
              Composer={Composer}
              embedded
              onSessionReplacement={handleSessionReplacement}
            />
          </section>
        )}
      </section>
    </>
  );
}
