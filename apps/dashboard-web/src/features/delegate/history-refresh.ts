const DELEGATE_HISTORY_MAX_RETRIES = 3;
const DELEGATE_HISTORY_RETRY_DELAY_MS = 250;
const DELEGATE_HISTORY_REVISION_DELAY_MS = 100;

export interface DelegateHistoryRefreshCoordinator {
  markSettled(runIds: readonly string[]): void;
  observe(runIds: ReadonlySet<string>): void;
  setFetching(fetching: boolean): void;
  refresh(): void;
  refreshRevision(): void;
  dispose(): void;
}

/** Refresh durable history a bounded number of times after live settlement. */
export function createDelegateHistoryRefreshCoordinator(
  refresh: () => undefined | Promise<unknown>,
  options: {
    maxRetries?: number;
    retryDelayMs?: number;
    onPendingChange?: (runIds: ReadonlySet<string>) => void;
    revisionDelayMs?: number;
  } = {},
): DelegateHistoryRefreshCoordinator {
  const pending = new Map<string, number>();
  const maxRetries = options.maxRetries ?? DELEGATE_HISTORY_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DELEGATE_HISTORY_RETRY_DELAY_MS;
  const revisionDelayMs =
    options.revisionDelayMs ?? DELEGATE_HISTORY_REVISION_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revisionTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let fetching = false;
  let refreshing = false;
  let refreshQueued = false;
  const notifyPending = () =>
    options.onPendingChange?.(new Set(pending.keys()));

  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const flushRefresh = () => {
    if (disposed || fetching || refreshing || !refreshQueued) return;
    refreshQueued = false;
    refreshing = true;
    void Promise.resolve()
      .then(refresh)
      .catch(() => {})
      .finally(() => {
        refreshing = false;
        if (refreshQueued) flushRefresh();
      });
  };
  const requestRefresh = () => {
    if (disposed) return;
    refreshQueued = true;
    flushRefresh();
  };
  const schedule = () => {
    if (disposed || timer !== undefined || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || pending.size === 0) return;
      let shouldRefresh = false;
      for (const [runId, attempt] of pending) {
        if (attempt >= maxRetries) {
          pending.delete(runId);
          continue;
        }
        pending.set(runId, attempt + 1);
        shouldRefresh = true;
      }
      notifyPending();
      if (shouldRefresh) requestRefresh();
      schedule();
    }, retryDelayMs);
  };

  return {
    markSettled(runIds) {
      if (disposed) return;
      let added = false;
      for (const runId of runIds) {
        if (!pending.has(runId)) {
          pending.set(runId, 0);
          added = true;
        }
      }
      if (added) {
        notifyPending();
        requestRefresh();
      }
      schedule();
    },
    observe(runIds) {
      if (disposed) return;
      let changed = false;
      for (const runId of runIds) changed = pending.delete(runId) || changed;
      if (changed) notifyPending();
      if (pending.size === 0) clearTimer();
    },
    setFetching(value) {
      fetching = value;
      if (!fetching) flushRefresh();
    },
    refresh() {
      requestRefresh();
    },
    refreshRevision() {
      if (disposed) return;
      if (fetching || refreshing) {
        requestRefresh();
        return;
      }
      if (revisionTimer !== undefined) return;
      revisionTimer = setTimeout(() => {
        revisionTimer = undefined;
        requestRefresh();
      }, revisionDelayMs);
    },
    dispose() {
      disposed = true;
      pending.clear();
      clearTimer();
      if (revisionTimer !== undefined) clearTimeout(revisionTimer);
      revisionTimer = undefined;
    },
  };
}

export function delegateHistoryPendingRunIds(
  pending: { sessionId: string; runIds: ReadonlySet<string> } | undefined,
  sessionId: string,
): ReadonlySet<string> {
  return pending?.sessionId === sessionId ? pending.runIds : new Set();
}

export function delegateHistoryRevisionChanged(
  previous: { id: string; revision: number } | undefined,
  current: { id: string; revision: number },
): boolean {
  return (
    previous !== undefined &&
    previous.id === current.id &&
    previous.revision !== current.revision
  );
}
