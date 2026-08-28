import type { DashboardLiveStore } from '@pi-dashboard/client';
import type {
  RuntimeSnapshot,
  SessionIndexEntry,
  StartRuntimeRequest,
} from '@pi-dashboard/protocol';
import { formatCompactCount } from '../../shared/lib/format';
import {
  configuredModelOptions,
  modelOptionValue,
  type RuntimeModelOption,
} from '../model-option';
import { hasSettledBackground } from '../presentation-status';

export async function waitForStartedRuntime(
  store: DashboardLiveStore,
  runtimeId: string,
  timeoutMs = 30_000,
): Promise<RuntimeSnapshot> {
  const current = () => store.getSnapshot().runtimesById[runtimeId];
  const ready = current();
  if (ready) return ready;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('The new runtime did not connect in time.'));
    }, timeoutMs);
    const unsubscribe = store.subscribe(() => {
      const runtime = current();
      if (!runtime) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(runtime);
    });
  });
}

export function resumeRuntimeRequest(
  projectId: string | undefined,
  checkoutId: string | undefined,
  sessionId: string,
  initialPrompt?: string,
  model?: StartRuntimeRequest['model'],
): StartRuntimeRequest | undefined {
  if (!projectId || !checkoutId) return undefined;
  return {
    projectId,
    checkoutId,
    sessionId,
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(model ? { model } : {}),
  };
}

export function formatContextTokens(tokens: number): string {
  return formatCompactCount(tokens);
}

export function contextIndicatorData(
  usage: RuntimeSnapshot['contextUsage'],
):
  | { percent?: number; text: string; level: 'normal' | 'warning' | 'error' }
  | undefined {
  if (!usage) return undefined;
  const percent =
    usage.tokens === null || !usage.contextWindow
      ? undefined
      : Math.round(usage.percent ?? (usage.tokens / usage.contextWindow) * 100);
  const level =
    percent !== undefined && percent >= 80
      ? 'error'
      : percent !== undefined && percent >= 50
        ? 'warning'
        : 'normal';
  const used = usage.tokens === null ? '?' : formatContextTokens(usage.tokens);
  return {
    percent,
    text: `${percent ?? '?'}% [${used}/${
      usage.contextWindow ? formatContextTokens(usage.contextWindow) : '?'
    }]`,
    level,
  };
}

export function runtimeSupportsImages(runtime: RuntimeSnapshot): boolean {
  return runtime.model?.supportsImages === true;
}

export type DormantResumeMetadata = {
  model?: RuntimeModelOption;
  thinking?: string;
  contextTokens?: number;
};

export function modelSupportsImages(
  model: RuntimeModelOption | undefined,
  runtimes: readonly RuntimeSnapshot[],
): boolean {
  if (!model) return false;
  const value = modelOptionValue(model.provider, model.model);
  return runtimes.some(
    (runtime) =>
      (runtime.model &&
        modelOptionValue(runtime.model.provider, runtime.model.model) ===
          value &&
        runtime.model.supportsImages === true) ||
      runtime.modelCatalog?.some(
        (option) =>
          modelOptionValue(option.provider, option.model) === value &&
          option.supportsImages === true,
      ),
  );
}

export function dormantResumeMetadata(
  session: SessionIndexEntry | undefined,
  runtimes: readonly RuntimeSnapshot[],
): DormantResumeMetadata {
  const persistedModel = session?.lastKnownModel;
  const configuredModels = configuredModelOptions(runtimes);
  const persistedOption = persistedModel
    ? configuredModels.find(
        (model) =>
          modelOptionValue(model.provider, model.model) ===
          modelOptionValue(persistedModel.provider, persistedModel.model),
      )
    : undefined;
  const model = persistedOption ?? persistedModel ?? configuredModels[0];
  const thinkingLevels = [
    ...new Set([
      ...runtimes.flatMap((runtime) => runtime.thinkingLevels ?? []),
      ...(session?.lastKnownThinking ? [session.lastKnownThinking] : []),
    ]),
  ];
  const thinking = session?.lastKnownThinking ?? thinkingLevels[0];
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(session?.lastKnownContextTokens === undefined
      ? {}
      : { contextTokens: session.lastKnownContextTokens }),
  };
}

export function dormantContextUsage(
  session: SessionIndexEntry | undefined,
  model: RuntimeModelOption | undefined,
  runtimes: readonly RuntimeSnapshot[],
): RuntimeSnapshot['contextUsage'] {
  const value = model
    ? modelOptionValue(model.provider, model.model)
    : undefined;
  const contextWindow =
    model?.contextWindow ??
    (value
      ? runtimes.find(
          (runtime) =>
            runtime.model &&
            modelOptionValue(runtime.model.provider, runtime.model.model) ===
              value &&
            runtime.contextUsage?.contextWindow,
        )?.contextUsage?.contextWindow
      : undefined);
  const tokens = session?.lastKnownContextTokens ?? null;
  return {
    tokens,
    contextWindow: contextWindow ?? 0,
    percent:
      tokens === null || !contextWindow ? null : (tokens / contextWindow) * 100,
  };
}

export type ComposerMode = 'prompt' | 'steer' | 'followUp';

export function composerMode(
  runtime: RuntimeSnapshot | undefined,
): ComposerMode {
  return runtime?.liveState === 'working' && !hasSettledBackground(runtime)
    ? 'steer'
    : 'prompt';
}

export function composerCommandType(
  runtime: RuntimeSnapshot,
  mode: ComposerMode,
): ComposerMode {
  return runtime.liveState === 'idle' || hasSettledBackground(runtime)
    ? 'prompt'
    : mode;
}

export function composerSubmissionPolicy(
  runtime: RuntimeSnapshot,
  mode: ComposerMode,
  _hasAttachments: boolean,
): { commandType: ComposerMode; queues: boolean } {
  const commandType = composerCommandType(runtime, mode);
  if (hasSettledBackground(runtime)) return { commandType, queues: false };
  return {
    commandType,
    queues:
      runtime.liveState === 'compacting' ||
      (runtime.liveState === 'working' && mode !== 'followUp'),
  };
}

export function composerIsDisabled(
  runtime: RuntimeSnapshot | undefined,
): boolean {
  return (
    !runtime ||
    runtime.online === false ||
    runtime.liveState === 'stopping' ||
    (runtime.liveState === 'waiting' && !hasSettledBackground(runtime))
  );
}
