import { type DelegatedRun, isRunError } from './types';

export function invalidParams(message: string): never {
  throw new Error(message);
}

export function assertDistinctContinuationTokens(
  tokens: Array<string | undefined>,
): void {
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!token) continue;
    if (seen.has(token))
      invalidParams(
        'Each parallel task must use a distinct continuation token.',
      );
    seen.add(token);
  }
}

export function throwIfAllRunsFailed(
  runs: DelegatedRun[],
  handoff: string,
): void {
  if (
    runs.length > 0 &&
    runs.every((run) => run.exitCode !== -1 && isRunError(run))
  )
    throw new Error(handoff);
}
