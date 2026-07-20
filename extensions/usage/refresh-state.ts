export interface RefreshOptions<Context, Report> {
  debounceMs: number;
  query: (ctx: Context, signal: AbortSignal) => Promise<Report>;
  canRefresh: (ctx: Context) => boolean;
  isFresh: (report: Report, ctx: Context) => boolean;
  onLoading: (ctx: Context) => void;
  onReport: (report: Report, ctx: Context) => void;
  onError: (ctx: Context) => void;
  onClear: (ctx: Context) => void;
}

interface Batch<Context> {
  ctx: Context;
  generation: number;
  waiters: Array<() => void>;
}

export interface RefreshCoordinator<Context> {
  sessionStart(ctx: Context): Promise<void>;
  modelChanged(ctx: Context): Promise<void>;
  sessionShutdown(ctx: Context): void;
  settled(ctx: Context): void;
  periodic(ctx: Context): Promise<void>;
  manual(ctx: Context): Promise<void>;
}

/** Coordinates refresh sources and owns their lifecycle generation. */
export function createRefreshCoordinator<Context, Report>(
  options: RefreshOptions<Context, Report>,
): RefreshCoordinator<Context> {
  let active = false;
  let generation = 0;
  let cache: Report | undefined;
  let inFlight = false;
  let trailing: Batch<Context> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let queryController: AbortController | undefined;

  const advanceGeneration = (): void => {
    generation++;
    cache = undefined;
    queryController?.abort();
    clearDebounce();
    if (trailing) {
      resolve(trailing);
      trailing = undefined;
    }
  };

  const clearDebounce = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = undefined;
  };

  const isCurrent = (batch: Batch<Context>): boolean =>
    active && batch.generation === generation;

  const resolve = (batch: Batch<Context>): void => {
    for (const waiter of batch.waiters) waiter();
  };

  const start = (batch: Batch<Context>): void => {
    inFlight = true;
    const controller = new AbortController();
    queryController = controller;
    if (isCurrent(batch)) options.onLoading(batch.ctx);

    void options
      .query(batch.ctx, controller.signal)
      .then((report) => {
        if (!isCurrent(batch) || !options.canRefresh(batch.ctx)) return;
        cache = report;
        options.onReport(report, batch.ctx);
      })
      .catch(() => {
        if (isCurrent(batch) && options.canRefresh(batch.ctx)) {
          options.onError(batch.ctx);
        }
      })
      .finally(() => {
        if (queryController === controller) queryController = undefined;
        inFlight = false;
        resolve(batch);
        const next = trailing;
        trailing = undefined;
        if (next && isCurrent(next)) start(next);
        else if (next) resolve(next);
      });
  };

  const request = (
    ctx: Context,
    force: boolean,
    allowTrailing: boolean,
  ): Promise<void> => {
    if (!active) return Promise.resolve();
    if (!options.canRefresh(ctx)) {
      options.onClear(ctx);
      return Promise.resolve();
    }
    if (!force && cache && options.isFresh(cache, ctx)) {
      options.onReport(cache, ctx);
      return Promise.resolve();
    }

    let done: (() => void) | undefined;
    const promise = new Promise<void>((resolvePromise) => {
      done = resolvePromise;
    });
    const waiter = done as () => void;

    if (inFlight) {
      if (!allowTrailing) {
        waiter();
        return promise;
      }
      if (!trailing || trailing.generation !== generation) {
        trailing = { ctx, generation, waiters: [] };
      } else {
        trailing.ctx = ctx;
      }
      trailing.waiters.push(waiter);
      return promise;
    }

    start({ ctx, generation, waiters: [waiter] });
    return promise;
  };

  return {
    sessionStart(ctx) {
      active = true;
      advanceGeneration();
      return request(ctx, true, true);
    },
    modelChanged(ctx) {
      advanceGeneration();
      if (!active) return Promise.resolve();
      return request(ctx, true, true);
    },
    sessionShutdown(ctx) {
      active = false;
      advanceGeneration();
      options.onClear(ctx);
    },
    settled(ctx) {
      if (!active) return;
      clearDebounce();
      const settledGeneration = generation;
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        if (!active || settledGeneration !== generation) return;
        void request(ctx, true, true);
      }, options.debounceMs);
      debounceTimer.unref?.();
    },
    periodic(ctx) {
      return request(ctx, false, false);
    },
    manual(ctx) {
      return request(ctx, true, true);
    },
  };
}
