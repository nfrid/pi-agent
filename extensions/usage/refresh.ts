import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { UsageReport } from './types';

export interface UsageRefreshHooks {
  debounceMs: number;
  query: (ctx: ExtensionContext, signal: AbortSignal) => Promise<UsageReport>;
  canRefresh: (ctx: ExtensionContext) => boolean;
  isFresh: (report: UsageReport) => boolean;
  onLoading: (ctx: ExtensionContext) => void;
  onReport: (report: UsageReport, ctx: ExtensionContext) => void;
  onError: (ctx: ExtensionContext) => void;
  onClear: (ctx: ExtensionContext) => void;
}

interface RefreshBatch {
  ctx: ExtensionContext;
  generation: number;
  waiters: Array<() => void>;
}

export interface UsageRefresh {
  sessionStart(ctx: ExtensionContext): Promise<void>;
  modelChanged(ctx: ExtensionContext): Promise<void>;
  sessionShutdown(ctx: ExtensionContext): void;
  settled(ctx: ExtensionContext): void;
  periodic(ctx: ExtensionContext): Promise<void>;
  manual(ctx: ExtensionContext): Promise<void>;
}

/** Coordinates usage refresh sources for one footer status slot. */
export function createUsageRefresh(hooks: UsageRefreshHooks): UsageRefresh {
  let active = false;
  let generation = 0;
  let cache: UsageReport | undefined;
  let inFlight = false;
  let trailing: RefreshBatch | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let queryController: AbortController | undefined;

  const finishWaiters = (batch: RefreshBatch): void => {
    for (const waiter of batch.waiters) waiter();
  };

  const clearDebounce = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = undefined;
  };

  const advanceGeneration = (): void => {
    generation++;
    cache = undefined;
    queryController?.abort();
    clearDebounce();
    if (trailing) {
      finishWaiters(trailing);
      trailing = undefined;
    }
  };

  const isCurrent = (batch: RefreshBatch): boolean =>
    active && batch.generation === generation;

  const start = (batch: RefreshBatch): void => {
    inFlight = true;
    const controller = new AbortController();
    queryController = controller;
    if (isCurrent(batch)) hooks.onLoading(batch.ctx);

    void hooks
      .query(batch.ctx, controller.signal)
      .then((report) => {
        if (!isCurrent(batch) || !hooks.canRefresh(batch.ctx)) return;
        cache = report;
        hooks.onReport(report, batch.ctx);
      })
      .catch(() => {
        if (isCurrent(batch) && hooks.canRefresh(batch.ctx))
          hooks.onError(batch.ctx);
      })
      .finally(() => {
        if (queryController === controller) queryController = undefined;
        inFlight = false;
        finishWaiters(batch);
        const next = trailing;
        trailing = undefined;
        if (next && isCurrent(next)) start(next);
        else if (next) finishWaiters(next);
      });
  };

  const request = (
    ctx: ExtensionContext,
    force: boolean,
    allowTrailing: boolean,
  ): Promise<void> => {
    if (!active) return Promise.resolve();
    if (!hooks.canRefresh(ctx)) {
      hooks.onClear(ctx);
      return Promise.resolve();
    }
    if (!force && cache && hooks.isFresh(cache)) {
      hooks.onReport(cache, ctx);
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
      hooks.onClear(ctx);
    },
    settled(ctx) {
      if (!active) return;
      clearDebounce();
      const settledGeneration = generation;
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        if (!active || settledGeneration !== generation) return;
        void request(ctx, true, true);
      }, hooks.debounceMs);
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
