import {
  buildLifecycleDiagnostic,
  setDelegateLifecycle,
  setDelegateLifecycleText,
} from './lifecycle';
import {
  continuationRecoveryNote,
  createRun,
  type DelegatedRun,
  type DelegateLifecycleReason,
  type DelegateRouteState,
  getRunState,
} from './types';
import {
  finishWorktree,
  loadWorktree,
  type PreparedWorktree,
  retireWorktreeSnapshot,
  type WorktreeRecord,
  type WorktreeSummary,
  worktreeSummary,
} from './worktree';

export function failedLifecycleRun(
  task: string,
  routing: DelegateRouteState | undefined,
  metadata: Parameters<typeof createRun>[2],
  error: unknown,
  reason: DelegateLifecycleReason = 'provider-runner-error',
): DelegatedRun {
  const now = Date.now();
  const failed = {
    ...createRun(task, routing, metadata),
    exitCode: 1,
    stopReason: 'error',
    errorMessage: `Delegate lifecycle failed: ${error instanceof Error ? error.message : String(error)}`,
    state: 'error' as const,
    startedAt: now,
    finishedAt: now,
  };
  setDelegateLifecycle(failed, reason, failed.errorMessage);
  return failed;
}

export function worktreeDetails(record: WorktreeRecord): WorktreeSummary {
  return worktreeSummary(record);
}

export function markLifecycleFailure(
  run: DelegatedRun,
  worktree: PreparedWorktree,
  error: unknown,
  reason: DelegateLifecycleReason = 'lifecycle-cleanup-failure',
): void {
  const record = loadWorktree(worktree.record.id) ?? worktree.record;
  run.exitCode = 1;
  run.state = 'error';
  run.stopReason = 'error';
  run.errorMessage = `Delegate lifecycle failed: ${error instanceof Error ? error.message : String(error)}`;
  setDelegateLifecycle(run, reason, run.errorMessage);
  run.warnings = [
    ...(run.warnings ?? []),
    `Worktree ${record.branch} was retained for diagnosis.`,
  ];
  run.worktree = worktreeSummary(record);
}

/**
 * Settle the branch once the child exits. The parent integrates it from here,
 * so the only job is to make sure the work is committed and described.
 */
export async function finalizeWorktreeRun(
  run: DelegatedRun,
  worktree: PreparedWorktree | undefined,
  taskName: string,
): Promise<void> {
  if (!worktree) return;
  const state = getRunState(run);
  const outcome =
    state === 'success' || state === 'aborted' || state === 'timed-out'
      ? state
      : 'error';
  const previousError = loadWorktree(worktree.record.id)?.error;
  try {
    const record = await finishWorktree(worktree.record.id, {
      taskName,
      outcome,
    });
    const cleanReadOnlySnapshot =
      state === 'success' &&
      !run.allowWrites &&
      !record.error &&
      !worktreeSummary(record).hasWork;
    const settled = cleanReadOnlySnapshot
      ? await retireWorktreeSnapshot(record.id)
      : record;
    run.worktree = worktreeSummary(settled);
    if (settled.error && !continuationRecoveryNote(run))
      run.warnings = [...(run.warnings ?? []), settled.error];
    if (settled.error && settled.error !== previousError) {
      run.state = 'error';
      run.stopReason = 'error';
      run.exitCode = run.exitCode === 0 ? 1 : run.exitCode;
      run.errorMessage = `Delegate lifecycle cleanup failed: ${settled.error}`;
      setDelegateLifecycleText(
        run,
        'lifecycle-cleanup-failure',
        buildLifecycleDiagnostic('lifecycle-cleanup-failure', run.errorMessage),
      );
    }
  } catch (error) {
    run.state = 'error';
    run.stopReason = 'error';
    run.exitCode = run.exitCode === 0 ? 1 : run.exitCode;
    run.errorMessage = `Delegate lifecycle cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    setDelegateLifecycle(run, 'lifecycle-cleanup-failure', run.errorMessage);
    run.warnings = [
      ...(run.warnings ?? []),
      `Could not settle worktree ${worktree.record.branch}: ${error instanceof Error ? error.message : String(error)}`,
    ];
    run.worktree = worktreeSummary(worktree.record);
  }
}
