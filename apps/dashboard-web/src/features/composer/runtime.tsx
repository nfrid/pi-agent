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
): StartRuntimeRequest | undefined {
  if (!projectId || !checkoutId) return undefined;
  return {
    projectId,
    checkoutId,
    sessionId,
    ...(initialPrompt ? { initialPrompt } : {}),
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
  if (!usage?.contextWindow) return undefined;
  const percent =
    usage.tokens === null
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
    text: `${percent ?? '?'}% [${used}/${formatContextTokens(usage.contextWindow)}]`,
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
  supportsImages: boolean;
};

function currentModelSupportsImages(
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
  const model = persistedModel ?? configuredModelOptions(runtimes)[0];
  const thinkingLevels = runtimes.flatMap(
    (runtime) => runtime.thinkingLevels ?? [],
  );
  const thinking = session?.lastKnownThinking ?? thinkingLevels[0];
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(session?.lastKnownContextTokens === undefined
      ? {}
      : { contextTokens: session.lastKnownContextTokens }),
    supportsImages: currentModelSupportsImages(persistedModel, runtimes),
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
  hasAttachments: boolean,
): { commandType: ComposerMode; queues: boolean } {
  const commandType = composerCommandType(runtime, mode);
  if (hasAttachments || hasSettledBackground(runtime))
    return { commandType, queues: false };
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
