import {
  createRun,
  type DelegatedRun,
  type DelegateRouteState,
  getRunState,
} from './types';
import {
  finishWorktree,
  loadWorktree,
  type PreparedWorktree,
  type WorktreeRecord,
  type WorktreeSummary,
  worktreeSummary,
} from './worktree';

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

export function worktreeDetails(record: WorktreeRecord): WorktreeSummary {
  return worktreeSummary(record);
}

export function markLifecycleFailure(
  run: DelegatedRun,
  worktree: PreparedWorktree,
  error: unknown,
): void {
  const record = loadWorktree(worktree.record.id) ?? worktree.record;
  run.exitCode = 1;
  run.state = 'error';
  run.stopReason = 'error';
  run.errorMessage = `Delegate lifecycle failed: ${error instanceof Error ? error.message : String(error)}`;
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
    state === 'success' ? 'success' : state === 'aborted' ? 'aborted' : 'error';
  try {
    const record = await finishWorktree(worktree.record.id, {
      taskName,
      outcome,
    });
    run.worktree = worktreeSummary(record);
    if (record.error) run.warnings = [...(run.warnings ?? []), record.error];
  } catch (error) {
    run.warnings = [
      ...(run.warnings ?? []),
      `Could not settle worktree ${worktree.record.branch}: ${error instanceof Error ? error.message : String(error)}`,
    ];
    run.worktree = worktreeSummary(worktree.record);
  }
}
