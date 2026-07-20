import * as path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { artifactProducer } from '../artifacts';
import {
  captureIsolationPatch,
  discardIsolation,
  failIsolationRun,
  type IsolationRecord,
  isolationPatchBytes,
  loadIsolation,
  type PreparedIsolation,
} from './isolation';
import { buildParentHandoff } from './output';
import {
  removeDelegateSession,
  type resolveDelegateSession,
  updateDelegateSessionRouting,
} from './session';
import {
  createRun,
  type DelegateDetails,
  type DelegatedRun,
  type DelegateIsolationState,
  type DelegateRouteState,
  getExactFinalAssistantText,
  getRunState,
  isRunError,
} from './types';

export function makeDetails(
  mode: DelegateDetails['mode'],
  runs: DelegatedRun[],
): DelegateDetails {
  return { mode, runs };
}

export async function buildArtifactBackedHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runs: DelegatedRun[],
  put = artifactProducer.put,
): Promise<string> {
  let handoff = buildParentHandoff(runs);
  const failedRuns = new Set<DelegatedRun>();
  // Artifact only the final assistant bytes that parent handoff caps or
  // normalization actually omit. Child sessions and run messages remain authoritative.
  for (let pass = 0; pass < runs.length; pass++) {
    let changed = false;
    for (const run of runs) {
      if (run.artifact || failedRuns.has(run)) continue;
      const exact = getExactFinalAssistantText(run.messages);
      if (!exact || handoff.includes(exact)) continue;
      try {
        run.artifact = await put(pi, ctx, {
          bytes: exact,
          producer: 'delegate',
          contentClass: 'delegate-output',
          mediaType: 'text/plain; charset=utf-8',
          creationSource: 'delegate.result',
        });
        changed = true;
      } catch {
        // Artifact policy/filesystem/size failures must not change child outcome.
        run.warnings = [
          ...(run.warnings ?? []),
          'Exact output artifact unavailable; child session remains authoritative.',
        ];
        failedRuns.add(run);
        changed = true;
      }
    }
    if (!changed) break;
    handoff = buildParentHandoff(runs);
  }
  return handoff;
}

export function invalidParams(message: string): never {
  throw new Error(message);
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

export async function delegateToolResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  mode: DelegateDetails['mode'],
  runs: DelegatedRun[],
) {
  const handoff = await buildArtifactBackedHandoff(pi, ctx, runs);
  throwIfAllRunsFailed(runs, handoff);
  return {
    content: [{ type: 'text' as const, text: handoff }],
    details: makeDetails(mode, runs),
  };
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

export function failedLifecycleRun(
  task: string,
  routing: DelegateRouteState | undefined,
  metadata: Parameters<typeof createRun>[2],
  error: unknown,
): DelegatedRun {
  const now = Date.now();
  return {
    ...createRun(task, routing, metadata),
    exitCode: 1,
    stopReason: 'error',
    errorMessage: `Delegate lifecycle failed: ${error instanceof Error ? error.message : String(error)}`,
    state: 'error',
    startedAt: now,
    finishedAt: now,
  };
}

export function isolationDetails(
  record: IsolationRecord,
  handle?: string,
): DelegateIsolationState {
  return {
    id: record.id,
    backend: record.backend,
    repositoryRoot: record.repositoryRoot,
    worktreePath: record.worktreePath,
    workingDirectory: record.workingDirectory,
    baseHead: record.baseHead,
    dependencyMode: record.dependencyMode,
    runOutcome: record.runOutcome,
    validation: record.validation,
    status: record.status,
    ...(record.patch
      ? {
          patch: {
            ...(handle ? { handle } : {}),
            ...record.patch,
          },
        }
      : {}),
  };
}

export async function discardFreshIsolation(
  isolation: PreparedIsolation,
): Promise<{ warning?: string; details?: DelegateIsolationState }> {
  try {
    await discardIsolation(isolation.record.id);
    return {};
  } catch (error) {
    const record = loadIsolation(isolation.record.id) ?? isolation.record;
    return {
      warning: `Isolation cleanup failed; retained isolation ${record.id} for manual diagnosis: ${error instanceof Error ? error.message : String(error)}`,
      details: isolationDetails(record),
    };
  }
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

export async function markLifecycleFailure(
  run: DelegatedRun,
  isolation: PreparedIsolation,
  error: unknown,
): Promise<void> {
  const record = await failIsolationRun(isolation.record.id, error).catch(
    () => loadIsolation(isolation.record.id) ?? isolation.record,
  );
  run.exitCode = 1;
  run.state = 'error';
  run.stopReason = 'error';
  run.errorMessage = `Delegate lifecycle failed: ${error instanceof Error ? error.message : String(error)}`;
  run.warnings = [
    ...(run.warnings ?? []),
    `Isolation ${record.id} was retained for diagnosis after a lifecycle failure.`,
  ];
  run.isolation = isolationDetails(record);
}

export async function finalizeIsolatedRun(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: DelegatedRun,
  isolation: PreparedIsolation | undefined,
): Promise<void> {
  if (!isolation) return;
  const state = getRunState(run);
  let record: IsolationRecord;
  try {
    record = await captureIsolationPatch(isolation.record.id, {
      outcome:
        state === 'success' ||
        state === 'error' ||
        state === 'aborted' ||
        state === 'timed-out'
          ? state
          : 'unknown',
    });
  } catch (error) {
    record = await failIsolationRun(isolation.record.id, error).catch(
      () => isolation.record,
    );
    run.state = 'error';
    run.stopReason = 'error';
    run.errorMessage = `Isolated delegate finalization failed: ${error instanceof Error ? error.message : String(error)}`;
    run.warnings = [
      ...(run.warnings ?? []),
      'The worktree was retained for diagnosis and its patch cannot be applied.',
    ];
  }
  const patch = record.patch;
  let handle: string | undefined;
  const bytes = isolationPatchBytes(record);
  if (patch && bytes && bytes.length > 0) {
    try {
      const artifact = await artifactProducer.put(pi, ctx, {
        bytes,
        producer: 'delegate',
        contentClass: 'tool-output',
        mediaType: 'text/x-diff; charset=utf-8',
        creationSource: 'delegate.patch',
        itemCount: patch.changedPaths.length,
      });
      handle = artifact.handle;
    } catch {
      run.warnings = [
        ...(run.warnings ?? []),
        'Exact patch artifact unavailable; the retained isolated worktree remains authoritative.',
      ];
    }
  }
  run.isolation = isolationDetails(record, handle);
  if (patch && !patch.diffCheckPassed)
    run.warnings = [
      ...(run.warnings ?? []),
      'Patch failed diff validation and cannot be applied.',
    ];
  if (patch?.requiresIsolatedDependencyValidation)
    run.warnings = [
      ...(run.warnings ?? []),
      'Dependency manifests changed; application is blocked until isolated dependency validation is recorded.',
    ];
}

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
