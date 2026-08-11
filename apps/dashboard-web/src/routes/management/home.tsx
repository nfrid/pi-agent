import type {
  BrowserSnapshot,
  RunSummary,
  ThreadSummary,
} from '@pi-dashboard/protocol';
import { useDashboardNavigate } from '../navigation';
import { runFor, threadNeedsAttention } from './projection';
import { Rail } from './rail';
import { ThreadCard } from './thread-card';

export function globalAttentionAndFailureShelves(
  threads: readonly ThreadSummary[],
  runs: readonly RunSummary[],
): {
  attention: readonly ThreadSummary[];
  failedOrInterrupted: readonly ThreadSummary[];
  attentionCount: number;
} {
  const latest = (thread: ThreadSummary) => runFor(thread, runs);
  const failedOrInterrupted = threads.filter((thread) => {
    const status = latest(thread)?.status ?? thread.status;
    return (
      thread.status === 'failed' ||
      status === 'failed' ||
      status === 'interrupted'
    );
  });
  const attentionCount = threads.filter((thread) =>
    threadNeedsAttention(thread, runs),
  ).length;
  return {
    attention: threads.filter(
      (thread) =>
        threadNeedsAttention(thread, runs) &&
        !failedOrInterrupted.includes(thread),
    ),
    failedOrInterrupted,
    attentionCount,
  };
}

function GlobalOverview({ snapshot }: { snapshot: BrowserSnapshot }) {
  const go = useDashboardNavigate();
  const threads = snapshot.threads ?? [];
  const runs = snapshot.runs ?? [];
  const checkouts = snapshot.checkouts ?? [];
  const projects = new Map(
    (snapshot.projects ?? []).map((project) => [project.id, project.title]),
  );
  const latest = (thread: ThreadSummary) => runFor(thread, runs);
  const running = threads.filter((thread) => {
    const status = latest(thread)?.status ?? thread.status;
    return (
      !threadNeedsAttention(thread, runs) &&
      ['active', 'preparing', 'starting', 'running'].includes(status)
    );
  });
  const queued = threads.filter(
    (thread) =>
      !threadNeedsAttention(thread, runs) &&
      (latest(thread)?.status ?? thread.status) === 'queued',
  );
  const globalShelves = globalAttentionAndFailureShelves(threads, runs);
  const { attention, failedOrInterrupted, attentionCount } = globalShelves;
  const settled = threads.filter((thread) => {
    const status = latest(thread)?.status ?? thread.status;
    return (
      ['settled', 'cancelled', 'stopped'].includes(status) &&
      !threadNeedsAttention(thread, runs) &&
      !failedOrInterrupted.includes(thread)
    );
  });
  const shelf = (
    id: string,
    title: string,
    items: readonly ThreadSummary[],
  ) => (
    <section className="management-shelf global-shelf" id={id} key={id}>
      <h2>
        {title} <span className="shelf-count">{items.length}</span>
      </h2>
      {items.length ? (
        <div className="thread-card-grid">
          {items.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              runs={runs}
              checkouts={checkouts}
              projectTitle={projects.get(thread.projectId) ?? 'Unknown project'}
            />
          ))}
        </div>
      ) : (
        <p className="empty-shelf">Nothing here.</p>
      )}
    </section>
  );
  return (
    <>
      <Rail snapshot={snapshot} />
      <section className="management-page global-overview">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Management overview</p>
            <h1>All projects</h1>
            <p className="path-label">
              {projects.size} projects · global orchestration state
            </p>
            <p className="management-summary">
              {running.length} active · {queued.length} queued ·{' '}
              {attentionCount} needs attention
            </p>
          </div>
          <button type="button" onClick={() => go('/projects')}>
            + Adopt project
          </button>
        </div>
        {shelf('global-needs-attention', 'Needs attention', attention)}
        {shelf('global-running', 'Running', running)}
        {shelf('global-queued', 'Queued', queued)}
        {shelf(
          'global-failed-interrupted',
          'Failed & interrupted',
          failedOrInterrupted,
        )}
        {shelf('global-recent', 'Recently settled', settled)}
      </section>
    </>
  );
}

export function ManagementHome({ snapshot }: { snapshot: BrowserSnapshot }) {
  const projects = snapshot.projects ?? [];
  if (!projects.length)
    return (
      <section className="management-page">
        <h1>No projects</h1>
        <p>
          Use the existing dashboard runtime view, or adopt a workspace to
          enable management.
        </p>
      </section>
    );
  return <GlobalOverview snapshot={snapshot} />;
}

export function managementProjectCount(snapshot: BrowserSnapshot): number {
  return snapshot.projects?.length ?? 0;
}
