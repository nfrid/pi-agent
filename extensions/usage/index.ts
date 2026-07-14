import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { REFRESH_INTERVAL_MS, STATUS_KEY } from './constants';
import { formatUsage } from './format';
import { isCodexModel } from './model';
import { queryUsage } from './query';
import type { UsageReport } from './types';

export default function usage(pi: ExtensionAPI) {
  let cache: UsageReport | undefined;
  let refreshPromise: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const clear = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const refresh = (ctx: ExtensionContext, force = false) => {
    if (!ctx.hasUI) return;
    if (!isCodexModel(ctx.model)) {
      clear(ctx);
      return;
    }
    if (refreshPromise) return;
    if (
      !force &&
      cache &&
      Date.now() - cache.capturedAt < REFRESH_INTERVAL_MS
    ) {
      ctx.ui.setStatus(STATUS_KEY, formatUsage(cache, ctx));
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg('dim', 'loading…'));
    refreshPromise = queryUsage(ctx)
      .then((report) => {
        cache = report;
        if (isCodexModel(ctx.model)) {
          ctx.ui.setStatus(STATUS_KEY, formatUsage(report, ctx));
        }
      })
      .catch(() => {
        if (isCodexModel(ctx.model))
          ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg('error', 'usage error'));
      })
      .finally(() => {
        refreshPromise = undefined;
      });
  };

  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return;
    refresh(ctx, true);
    if (timer) clearInterval(timer);
    timer = setInterval(() => refresh(ctx), REFRESH_INTERVAL_MS);
    timer.unref?.();
  });

  pi.on('model_select', (_event, ctx) => refresh(ctx));
  pi.on('turn_end', (_event, ctx) => refresh(ctx, true));
  pi.on('agent_end', (_event, ctx) => refresh(ctx, true));

  pi.registerCommand('usage', {
    description: 'Refresh Codex 5h / weekly usage in the footer',
    handler: async (_args, ctx) => {
      refresh(ctx, true);
    },
  });

  pi.on('session_shutdown', (_event, ctx) => {
    clear(ctx);
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}
