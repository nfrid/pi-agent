import type {
  CheckoutSummary,
  RunSummary,
  ThreadSummary,
} from '@pi-dashboard/protocol';
import { useDashboardNavigate } from '../navigation';
import { checkoutFor, errorText, runFor, runTiming, when } from './projection';

function ThreadCard({
  thread,
  runs,
  checkouts,
  projectTitle,
}: {
  thread: ThreadSummary;
  runs: readonly RunSummary[];
  checkouts: readonly CheckoutSummary[];
  projectTitle?: string;
}) {
  const go = useDashboardNavigate();
  const run = runFor(thread, runs);
  const checkout = checkoutFor(thread, checkouts);
  return (
    <article className="management-thread-card">
      <button
        type="button"
        className="thread-card-link"
        onClick={() => go(`/threads/${encodeURIComponent(thread.id)}`)}
      >
        {projectTitle && <p className="thread-card-project">{projectTitle}</p>}
        <h3>{thread.title}</h3>
        <p className="thread-card-meta">
          {checkout?.branch ?? checkout?.kind ?? 'No checkout'} ·{' '}
          {run?.status ?? thread.status}
        </p>
        <p className="thread-card-meta">
          {run?.model
            ? `${run.model.provider}/${run.model.model}${run.model.thinking ? ` · thinking ${run.model.thinking}` : ''}`
            : 'Model default'}{' '}
          · {when(thread.updatedAt)}
        </p>
        {errorText(run) && <p className="error">{errorText(run)}</p>}
        <p className="thread-card-meta">
          {run ? runTiming(run) : 'Queued'}
          {checkout?.changedFileCount !== undefined
            ? ` · ${checkout.changedFileCount} changed files`
            : ''}
        </p>
      </button>
    </article>
  );
}

export { ThreadCard };
