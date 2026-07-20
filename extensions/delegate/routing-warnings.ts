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

export function writeWarnings(
  cwds: string[],
  writeModes: boolean[],
  scopes: Array<string[] | undefined>,
): string[][] {
  const warnings = scopes.map(() => [] as string[]);
  for (let i = 0; i < scopes.length; i++) {
    if (!writeModes[i]) continue;
    for (let j = i + 1; j < scopes.length; j++) {
      if (!writeModes[j] || path.resolve(cwds[i]) !== path.resolve(cwds[j]))
        continue;
      const left = scopes[i]?.filter(Boolean) ?? [];
      const right = scopes[j]?.filter(Boolean) ?? [];
      const warning =
        left.length === 0 || right.length === 0
          ? `Parallel write tasks ${i + 1} and ${j + 1} share a working directory and at least one has no declared scope; their patches may conflict, so review both before applying either.`
          : scopesOverlap(
                normalizedScopes(cwds[i], left),
                normalizedScopes(cwds[j], right),
              )
            ? `Parallel write tasks ${i + 1} and ${j + 1} have overlapping declared scopes; their patches may conflict, so review both before applying either.`
            : undefined;
      if (warning) {
        warnings[i].push(warning);
        warnings[j].push(warning);
      }
    }
  }
  return warnings;
}
