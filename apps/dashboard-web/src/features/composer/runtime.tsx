import type {
  RuntimeSnapshot,
  StartRuntimeRequest,
} from '@pi-dashboard/protocol';
import { formatCompactCount } from '../../shared/lib/format';
import { hasSettledBackground } from '../presentation-status';

export function resumeRuntimeRequest(
  workspaceId: string | undefined,
  sessionId: string,
): StartRuntimeRequest | undefined {
  if (!workspaceId) return undefined;
  return {
    workspaceId,
    sessionId,
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
    (runtime.liveState === 'waiting' && !hasSettledBackground(runtime)) ||
    runtime.pendingInteractions.length > 0
  );
}
