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
import {
  createRun,
  type DelegatedRun,
  type DelegateIsolationState,
  type DelegateRouteState,
  getRunState,
} from './types';

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
  const {
    id,
    backend,
    repositoryRoot,
    worktreePath,
    workingDirectory,
    baseHead,
    dependencyMode,
    runOutcome,
    validation,
    status,
    patch,
  } = record;
  return {
    id,
    backend,
    repositoryRoot,
    worktreePath,
    workingDirectory,
    baseHead,
    dependencyMode,
    runOutcome,
    validation,
    status,
    ...(patch ? { patch: { ...patch, ...(handle ? { handle } : {}) } } : {}),
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
