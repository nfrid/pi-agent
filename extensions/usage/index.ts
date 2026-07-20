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
import { createRefreshCoordinator } from './refresh-state';
import type { UsageReport } from './types';

const registered = new WeakSet<object>();

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
