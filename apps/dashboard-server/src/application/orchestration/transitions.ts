import {
  canTransitionThread,
  type RunStatus,
  type ThreadStatus,
} from '@pi-dashboard/domain';
import type { OrchestrationRuntime } from '@pi-dashboard/protocol';

/**
 * Project a run status onto the owning thread. Used by the repository when a
 * run transition commits, and by the service layer when deciding thread intent.
 */
export function threadStatusForRun(runStatus: RunStatus): ThreadStatus {
  return runStatus === 'waiting'
    ? 'needs-input'
    : runStatus === 'completed'
      ? 'completed'
      : runStatus === 'failed'
        ? 'failed'
        : runStatus === 'cancelled' || runStatus === 'interrupted'
          ? 'stopped'
          : runStatus === 'queued'
            ? 'queued'
            : 'active';
}

export function canApplyThreadStatus(
  from: ThreadStatus,
  to: ThreadStatus,
): boolean {
  return canTransitionThread(from, to);
}

export function canTransitionRuntime(
  from: OrchestrationRuntime['status'],
  to: OrchestrationRuntime['status'],
): boolean {
  return (
    from === to ||
    (from === 'starting' && ['running', 'stopped', 'failed'].includes(to)) ||
    (from === 'running' && ['stopped', 'failed'].includes(to))
  );
}

export function assertRuntimeTransition(
  from: OrchestrationRuntime['status'],
  to: OrchestrationRuntime['status'],
): void {
  if (!canTransitionRuntime(from, to))
    throw new Error(`Illegal runtime transition: ${from} -> ${to}.`);
}
