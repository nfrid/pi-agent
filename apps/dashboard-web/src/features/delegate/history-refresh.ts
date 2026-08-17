const DELEGATE_HISTORY_MAX_RETRIES = 3;
const DELEGATE_HISTORY_RETRY_DELAY_MS = 250;

export interface DelegateHistoryRefreshCoordinator {
  markSettled(runIds: readonly string[]): void;
  observe(runIds: ReadonlySet<string>): void;
  refresh(): void;
  dispose(): void;
}

/** Refresh durable history a bounded number of times after live settlement. */
export function createDelegateHistoryRefreshCoordinator(
  refresh: () => void,
  options: {
    maxRetries?: number;
    retryDelayMs?: number;
  } = {},
): DelegateHistoryRefreshCoordinator {
  const pending = new Map<string, number>();
  const maxRetries = options.maxRetries ?? DELEGATE_HISTORY_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DELEGATE_HISTORY_RETRY_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
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
      if (shouldRefresh) refresh();
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
      if (added) refresh();
      schedule();
    },
    observe(runIds) {
      if (disposed) return;
      for (const runId of runIds) pending.delete(runId);
      if (pending.size === 0) clearTimer();
    },
    refresh() {
      if (!disposed) refresh();
    },
    dispose() {
      disposed = true;
      pending.clear();
      clearTimer();
    },
  };
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
