import type {
  RuntimeSnapshot,
  StartRuntimeRequest,
} from '@pi-dashboard/protocol';

export function resumeRuntimeRequest(
  workspaceId: string | undefined,
  sessionId: string,
  acknowledgeSharedWorkingDirectory = false,
): StartRuntimeRequest | undefined {
  if (!workspaceId) return undefined;
  return {
    workspaceId,
    sessionId,
    ...(acknowledgeSharedWorkingDirectory
      ? { acknowledgeSharedWorkingDirectory: true }
      : {}),
  };
}

export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${Number.parseFloat((tokens / 1_000_000).toFixed(1))}m`;
  if (tokens >= 1_000)
    return `${Number.parseFloat((tokens / 1_000).toFixed(1))}k`;
  return `${tokens}`;
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
