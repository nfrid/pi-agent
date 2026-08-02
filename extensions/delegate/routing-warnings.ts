import * as path from 'node:path';
import {
  removeDelegateSession,
  type resolveDelegateSession,
  updateDelegateSessionRouting,
} from './session';
import type { DelegateRouteState } from './types';

export function mergeDelegateRouteRequest(
  requested: unknown,
  persisted?: DelegateRouteState,
): unknown {
  return requested ?? persisted?.route;
}

export function persistSessionRoute(
  session: NonNullable<ReturnType<typeof resolveDelegateSession>>,
  routing: DelegateRouteState,
) {
  const updated = updateDelegateSessionRouting(session.token, routing);
  if (!updated)
    throw new Error('Could not persist the continuation route override.');
  return updated;
}

export function removeSessionSafely(
  session: NonNullable<ReturnType<typeof resolveDelegateSession>>,
): string | undefined {
  try {
    removeDelegateSession(session);
    return undefined;
  } catch (error) {
    return `Delegate session cleanup failed for ${session.token}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function normalizedScopes(cwd: string, scopes: string[]): string[] {
  return scopes.map((scope) => path.resolve(cwd, scope));
}

export function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some((left) =>
    b.some(
      (right) =>
        left === right ||
        left.startsWith(`${right}${path.sep}`) ||
        right.startsWith(`${left}${path.sep}`),
    ),
  );
}

export interface WriteWarningTask {
  requestedCwd: string;
  writeRequested: boolean;
  scope?: string[];
  warnings: string[];
}

/** Attach pairwise warnings directly to their task records. */
export function writeWarnings(tasks: WriteWarningTask[]): void {
  for (const [leftIndex, leftTask] of tasks.entries()) {
    if (!leftTask.writeRequested) continue;
    for (const [rightIndex, rightTask] of tasks.entries()) {
      if (
        rightIndex <= leftIndex ||
        !rightTask.writeRequested ||
        path.resolve(leftTask.requestedCwd) !==
          path.resolve(rightTask.requestedCwd)
      )
        continue;
      const left = leftTask.scope?.filter(Boolean) ?? [];
      const right = rightTask.scope?.filter(Boolean) ?? [];
      const warning =
        left.length === 0 || right.length === 0
          ? `Parallel write tasks ${leftIndex + 1} and ${rightIndex + 1} share a working directory and at least one has no declared scope; their patches may conflict, so review both before applying either.`
          : scopesOverlap(
                normalizedScopes(leftTask.requestedCwd, left),
                normalizedScopes(rightTask.requestedCwd, right),
              )
            ? `Parallel write tasks ${leftIndex + 1} and ${rightIndex + 1} have overlapping declared scopes; their patches may conflict, so review both before applying either.`
            : undefined;
      if (warning) {
        leftTask.warnings.push(warning);
        rightTask.warnings.push(warning);
      }
    }
  }
}
