import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  generateSessionTitle as generateSharedSessionTitle,
  generateSessionTitleFromHistory as generateSharedSessionTitleFromHistory,
  type SessionTitleConfig,
} from '@pi-agent/session-title';
import { defineExtension } from '../shared/runtime/extension';
import { loadSessionTitleConfig } from './config';

export { sanitizeSessionTitle } from '@pi-agent/session-title';

function hasUserMessage(entries: readonly unknown[]): boolean {
  return entries.some((value) => {
    if (!value || typeof value !== 'object') return false;
    const entry = value as { type?: unknown; message?: unknown };
    if (entry.type !== 'message' || !entry.message) return false;
    return (entry.message as { role?: unknown }).role === 'user';
  });
}

export function generateSessionTitle(
  ctx: ExtensionContext,
  prompt: string,
  signal: AbortSignal,
  config: SessionTitleConfig,
): Promise<string | undefined> {
  return generateSharedSessionTitle(ctx.modelRegistry, prompt, signal, config);
}

export function regenerateSessionTitle(
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
  config: SessionTitleConfig,
): Promise<string | undefined> {
  return generateSharedSessionTitleFromHistory(
    ctx.modelRegistry,
    ctx.sessionManager.getBranch(),
    signal,
    config,
  );
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: 'info' | 'warning' | 'error',
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

type TitleGenerator = typeof generateSessionTitle;
type TitleRegenerator = typeof regenerateSessionTitle;
type ConfigLoader = typeof loadSessionTitleConfig;

export function registerAutomaticSessionTitles(
  pi: ExtensionAPI,
  generate: TitleGenerator = generateSessionTitle,
  loadConfig: ConfigLoader = loadSessionTitleConfig,
  regenerate: TitleRegenerator = regenerateSessionTitle,
): void {
  let config: SessionTitleConfig | undefined;
  let eligible = false;
  let started = false;
  let sessionController: AbortController | undefined;
  let regenerationController: AbortController | undefined;

  pi.registerCommand('retitle', {
    description: 'Regenerate the session title from conversation history',
    handler: async (_args, ctx) => {
      const currentConfig = loadConfig();
      if (!currentConfig.enabled) {
        notify(ctx, 'Automatic session titles are disabled.', 'warning');
        return;
      }
      if (currentConfig.error) {
        notify(ctx, currentConfig.error, 'error');
        return;
      }

      regenerationController?.abort();
      const commandController = new AbortController();
      regenerationController = commandController;
      const sessionSignal = sessionController?.signal;
      const signal = AbortSignal.any([
        commandController.signal,
        AbortSignal.timeout(currentConfig.timeoutMs),
        ...(sessionSignal ? [sessionSignal] : []),
      ]);
      if (ctx.hasUI) ctx.ui.setStatus('session-title', 'regenerating title…');
      try {
        const title = await regenerate(ctx, signal, currentConfig);
        if (!title || signal.aborted) {
          if (!sessionSignal?.aborted && !commandController.signal.aborted)
            notify(
              ctx,
              signal.aborted
                ? 'Session title regeneration timed out.'
                : 'No title could be generated from this session yet.',
              'warning',
            );
          return;
        }
        pi.setSessionName(title);
        notify(ctx, `Session title: ${title}`, 'info');
      } catch (error) {
        if (!signal.aborted) {
          console.warn('Session title regeneration failed:', error);
          notify(ctx, 'Session title regeneration failed.', 'error');
        }
      } finally {
        if (regenerationController === commandController) {
          regenerationController = undefined;
          if (ctx.hasUI) ctx.ui.setStatus('session-title', undefined);
        }
      }
    },
  });

  pi.on('session_start', (event, ctx) => {
    sessionController?.abort();
    regenerationController?.abort();
    sessionController = new AbortController();
    config = loadConfig();
    started = false;
    eligible =
      event.reason === 'new' &&
      config.enabled &&
      config.error === undefined &&
      pi.getSessionName() === undefined &&
      !hasUserMessage(ctx.sessionManager.getEntries());
    if (config.error) console.warn(config.error);
  });

  pi.on('before_agent_start', (event, ctx) => {
    if (!eligible || started || pi.getSessionName() !== undefined) return;
    const prompt = event.prompt.trim();
    if (!prompt || !config) return;

    started = true;
    const sessionSignal = sessionController?.signal;
    if (!sessionSignal) return;
    const signal = AbortSignal.any([
      sessionSignal,
      AbortSignal.timeout(config.timeoutMs),
    ]);

    void generate(ctx, prompt, signal, config)
      .then((title) => {
        if (title && !signal.aborted && pi.getSessionName() === undefined) {
          pi.setSessionName(title);
        }
      })
      .catch((error: unknown) => {
        if (!signal.aborted) {
          console.warn('Automatic session title generation failed:', error);
        }
      });
  });

  pi.on('session_shutdown', () => {
    sessionController?.abort();
    regenerationController?.abort();
    sessionController = undefined;
    regenerationController = undefined;
    config = undefined;
    eligible = false;
  });
}

export default defineExtension('session-title', (pi: ExtensionAPI) => {
  registerAutomaticSessionTitles(pi);
});
