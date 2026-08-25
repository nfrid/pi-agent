import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  generateSessionTitle as generateSharedSessionTitle,
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

type TitleGenerator = typeof generateSessionTitle;
type ConfigLoader = typeof loadSessionTitleConfig;

export function registerAutomaticSessionTitles(
  pi: ExtensionAPI,
  generate: TitleGenerator = generateSessionTitle,
  loadConfig: ConfigLoader = loadSessionTitleConfig,
): void {
  let config: SessionTitleConfig | undefined;
  let eligible = false;
  let started = false;
  let sessionController: AbortController | undefined;

  pi.on('session_start', (event, ctx) => {
    sessionController?.abort();
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
    sessionController = undefined;
    config = undefined;
    eligible = false;
  });
}

export default defineExtension('session-title', (pi: ExtensionAPI) => {
  registerAutomaticSessionTitles(pi);
});
