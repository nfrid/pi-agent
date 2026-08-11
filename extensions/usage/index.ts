import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';
import { queryUsage } from './backends';
import { createSharedUsageQuery } from './cache';
import {
  REFRESH_INTERVAL_MS,
  SETTLED_REFRESH_DEBOUNCE_MS,
  STATUS_KEY,
} from './constants';
import { formatUsage, isCodexModel } from './display';
import { createUsageRefresh } from './refresh';
import type { UsageReport } from './types';

export type { UsageRefresh, UsageRefreshHooks } from './refresh';
export { createUsageRefresh } from './refresh';

export function registerUsage(
  pi: ExtensionAPI,
  query: (
    ctx: ExtensionContext,
    signal: AbortSignal,
  ) => Promise<UsageReport> = queryUsage,
) {
  let timer: NodeJS.Timeout | undefined;
  let currentContext: ExtensionContext | undefined;
  const sharedQuery = createSharedUsageQuery(query, {
    freshMs: REFRESH_INTERVAL_MS,
    // The built-in backend is stable across extension reloads. A supplied
    // query remains isolated by function identity, which keeps test/custom
    // backends from accidentally sharing another provider's account state.
    stable: query === queryUsage,
  });

  const clear = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const coordinator = createUsageRefresh({
    debounceMs: SETTLED_REFRESH_DEBOUNCE_MS,
    query: sharedQuery,
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

export default defineExtension('usage', (pi: ExtensionAPI) => {
  registerUsage(pi);
});
