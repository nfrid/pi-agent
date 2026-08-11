import type {
  BrowserSnapshot,
  CheckoutSummary,
  RunSummary,
  ThreadSummary,
} from '@pi-dashboard/protocol';

export type ThreadShelf =
  | 'pinned'
  | 'attention'
  | 'running'
  | 'queued'
  | 'recent'
  | 'archived';

const activeRunStatuses = new Set([
  'queued',
  'preparing',
  'starting',
  'running',
  'waiting',
]);
const settledRunStatuses = new Set(['settled', 'cancelled', 'interrupted']);
const attentionRunStatuses = new Set(['waiting', 'failed']);
const reviewableCheckoutStatuses = new Set(['ready', 'dirty', 'failed']);
const mergeableCheckoutStatuses = new Set(['ready', 'dirty']);
const interruptibleRunStatuses = new Set([
  'queued',
  'preparing',
  'starting',
  'running',
  'waiting',
]);
const runningRunStatuses = new Set(['preparing', 'starting', 'running']);

/** Pure, stable management projection. A thread appears in exactly one shelf. */
export function groupThreads(
  threads: readonly ThreadSummary[],
  runs: readonly RunSummary[],
): Record<ThreadShelf, readonly ThreadSummary[]> {
  const latest = new Map<string, RunSummary>();
  for (const run of [...runs].sort(
    (a, b) =>
      b.attempt - a.attempt ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
  )) {
    if (!latest.has(run.threadId)) latest.set(run.threadId, run);
  }
  const shelves: Record<ThreadShelf, ThreadSummary[]> = {
    pinned: [],
    attention: [],
    running: [],
    queued: [],
    recent: [],
    archived: [],
  };
  const sorted = [...threads].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
  for (const thread of sorted) {
    const run = latest.get(thread.id);
    const status = run?.status ?? thread.status;
    const needsAttention =
      thread.status === 'needs-input' ||
      thread.status === 'failed' ||
      attentionRunStatuses.has(status);
    const shelf: ThreadShelf =
      thread.status === 'archived'
        ? 'archived'
        : thread.pinnedAt !== undefined
          ? 'pinned'
          : needsAttention
            ? 'attention'
            : status === 'running' ||
                status === 'preparing' ||
                status === 'starting'
              ? 'running'
              : status === 'queued'
                ? 'queued'
                : 'recent';
    shelves[shelf].push(thread);
  }
  return shelves;
}

function when(value: number | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString([], {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}
function runFor(
  thread: ThreadSummary,
  runs: readonly RunSummary[],
): RunSummary | undefined {
  return [...runs]
    .filter((run) => run.threadId === thread.id)
    .sort((a, b) => b.attempt - a.attempt || b.createdAt - a.createdAt)[0];
}
function checkoutFor(
  thread: ThreadSummary,
  checkouts: readonly CheckoutSummary[],
): CheckoutSummary | undefined {
  return thread.checkoutId
    ? checkouts.find((checkout) => checkout.id === thread.checkoutId)
    : undefined;
}
function errorText(run: RunSummary | undefined): string | undefined {
  return run?.error;
}

export function threadNeedsAttention(
  thread: ThreadSummary,
  runs: readonly RunSummary[],
): boolean {
  const latest = runFor(thread, runs);
  return (
    thread.status === 'needs-input' ||
    thread.status === 'failed' ||
    attentionRunStatuses.has(latest?.status ?? '')
  );
}

export interface ThreadActionAvailability {
  canInterrupt: boolean;
  canRetry: boolean;
  canReview: boolean;
  canMerge: boolean;
  canRetire: boolean;
  canArchive: boolean;
}

export function threadActionAvailability(
  run: RunSummary | undefined,
  checkout: CheckoutSummary | undefined,
): ThreadActionAvailability {
  const active = Boolean(
    (run && activeRunStatuses.has(run.status)) || checkout?.activeRunId,
  );
  const reviewable = Boolean(
    checkout &&
      checkout.kind === 'worktree' &&
      checkout.changedFileCount !== undefined,
  );
  return {
    canInterrupt: Boolean(run && interruptibleRunStatuses.has(run.status)),
    canRetry: Boolean(
      run &&
        !active &&
        checkout &&
        checkout.status !== 'retired' &&
        checkout.status !== 'merging',
    ),
    canReview: Boolean(
      !active &&
        reviewable &&
        checkout &&
        reviewableCheckoutStatuses.has(checkout.status),
    ),
    canMerge: Boolean(
      !active &&
        reviewable &&
        checkout &&
        mergeableCheckoutStatuses.has(checkout.status),
    ),
    canRetire: Boolean(
      !active &&
        reviewable &&
        checkout &&
        reviewableCheckoutStatuses.has(checkout.status),
    ),
    canArchive: !active,
  };
}

export function managementStatusCounts(
  snapshot: Pick<BrowserSnapshot, 'threads' | 'runs'>,
): {
  active: number;
  queued: number;
  attention: number;
  failed: number;
  interrupted: number;
} {
  const runs = snapshot.runs ?? [];
  const latest = new Map<string, RunSummary>();
  for (const run of [...runs].sort(
    (a, b) => b.attempt - a.attempt || b.createdAt - a.createdAt,
  )) {
    if (!latest.has(run.threadId)) latest.set(run.threadId, run);
  }
  return {
    active: runs.filter((run) => runningRunStatuses.has(run.status)).length,
    queued: runs.filter((run) => run.status === 'queued').length,
    attention: (snapshot.threads ?? []).filter(
      (thread) =>
        thread.status === 'needs-input' ||
        thread.status === 'failed' ||
        attentionRunStatuses.has(latest.get(thread.id)?.status ?? ''),
    ).length,
    failed: runs.filter((run) => run.status === 'failed').length,
    interrupted: runs.filter((run) => run.status === 'interrupted').length,
  };
}

export function runTiming(
  run: Pick<RunSummary, 'createdAt' | 'startedAt' | 'finishedAt'>,
  now = Date.now(),
): string {
  if (run.finishedAt !== undefined) return `Settled ${when(run.finishedAt)}`;
  const start = run.startedAt ?? run.createdAt;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return `${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`} elapsed`;
}

export function sessionRouteTarget(
  sessionId: string,
  runs: readonly RunSummary[],
): string | undefined {
  const run = runs.find((candidate) => candidate.piSessionId === sessionId);
  return run ? `/threads/${encodeURIComponent(run.threadId)}` : undefined;
}

export function latestRunForThread(
  threadId: string,
  runs: readonly RunSummary[],
): RunSummary | undefined {
  return runs
    .filter((run) => run.threadId === threadId)
    .sort((a, b) => b.attempt - a.attempt || b.createdAt - a.createdAt)[0];
}

export function isTerminalRun(status: RunSummary['status']): boolean {
  return settledRunStatuses.has(status) || status === 'failed';
}

export {
  activeRunStatuses,
  attentionRunStatuses,
  checkoutFor,
  errorText,
  runFor,
  runningRunStatuses,
  settledRunStatuses,
  when,
};
