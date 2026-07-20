import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { queryUsage } from './backends';
import {
  REFRESH_INTERVAL_MS,
  SETTLED_REFRESH_DEBOUNCE_MS,
  STATUS_KEY,
} from './constants';
import { formatUsage, isCodexModel } from './display';
import type { UsageReport } from './types';

const registered = new WeakSet<object>();

interface RefreshOptions<Context, Report> {
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

export function registerUsage(
  pi: ExtensionAPI,
  query: (
    ctx: ExtensionContext,
    signal: AbortSignal,
  ) => Promise<UsageReport> = queryUsage,
) {
  let timer: NodeJS.Timeout | undefined;
  let currentContext: ExtensionContext | undefined;

  const clear = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const coordinator = createRefreshCoordinator<ExtensionContext, UsageReport>({
    debounceMs: SETTLED_REFRESH_DEBOUNCE_MS,
    query,
    canRefresh: (ctx) => ctx.hasUI && isCodexModel(ctx.model),
    isFresh: (report) => Date.now() - report.capturedAt < REFRESH_INTERVAL_MS,
    onLoading: (ctx) =>
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg('dim', 'loading…')),
    onReport: (report, ctx) =>
      ctx.ui.setStatus(STATUS_KEY, formatUsage(report, ctx)),
    onError: (ctx) =>
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg('error', 'usage error')),
    onClear: clear,
  });

  pi.on('session_start', (_event, ctx) => {
    currentContext = ctx;
    void coordinator.sessionStart(ctx);
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (currentContext) void coordinator.periodic(currentContext);
    }, REFRESH_INTERVAL_MS);
    timer.unref?.();
  });

  pi.on('model_select', (_event, ctx) => {
    currentContext = ctx;
    void coordinator.modelChanged(ctx);
  });
  pi.on('agent_settled', (_event, ctx) => {
    currentContext = ctx;
    coordinator.settled(ctx);
  });

  pi.registerCommand('usage', {
    description: 'Refresh Codex 5h / weekly usage in the footer',
    handler: async (_args, ctx) => {
      await coordinator.manual(ctx);
    },
  });

  pi.on('session_shutdown', (_event, ctx) => {
    coordinator.sessionShutdown(ctx);
    currentContext = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}

export default function usage(pi: ExtensionAPI) {
  if (registered.has(pi)) return;
  registered.add(pi);
  registerUsage(pi);
}
