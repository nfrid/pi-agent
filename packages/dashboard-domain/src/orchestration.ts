import type {
  CheckoutStatus,
  ProjectStatus,
  RunStatus,
  ThreadStatus,
} from '@pi-dashboard/protocol';

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'preparing',
  'starting',
  'running',
  'waiting',
];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'settled',
  'failed',
  'cancelled',
  'interrupted',
];

const projectTransitions: Readonly<
  Record<ProjectStatus, readonly ProjectStatus[]>
> = {
  active: ['archived'],
  archived: [],
};
const checkoutTransitions: Readonly<
  Record<CheckoutStatus, readonly CheckoutStatus[]>
> = {
  preparing: ['ready', 'failed', 'retired'],
  ready: ['dirty', 'merging', 'retired', 'failed'],
  dirty: ['ready', 'merging', 'retired', 'failed'],
  merging: ['ready', 'dirty', 'retired', 'failed'],
  failed: ['preparing', 'retired'],
  retired: [],
};
const threadTransitions: Readonly<
  Record<ThreadStatus, readonly ThreadStatus[]>
> = {
  draft: ['queued', 'active'],
  queued: ['active', 'needs-input', 'failed', 'stopped'],
  active: ['needs-input', 'settled', 'failed', 'stopped'],
  'needs-input': ['active', 'settled', 'failed', 'stopped'],
  settled: ['queued', 'active'],
  failed: ['queued', 'active'],
  stopped: ['queued'],
  archived: [],
};
const runTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['preparing', 'cancelled', 'interrupted'],
  preparing: ['queued', 'starting', 'failed', 'cancelled', 'interrupted'],
  starting: ['queued', 'running', 'failed', 'cancelled', 'interrupted'],
  running: ['waiting', 'settled', 'failed', 'cancelled', 'interrupted'],
  waiting: ['running', 'settled', 'failed', 'cancelled', 'interrupted'],
  settled: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export function canTransitionProject(
  from: ProjectStatus,
  to: ProjectStatus,
): boolean {
  return from === to || projectTransitions[from].includes(to);
}
export function canTransitionCheckout(
  from: CheckoutStatus,
  to: CheckoutStatus,
): boolean {
  return from === to || checkoutTransitions[from].includes(to);
}
export function canTransitionThread(
  from: ThreadStatus,
  to: ThreadStatus,
): boolean {
  return from === to || threadTransitions[from].includes(to);
}
export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return from === to || runTransitions[from].includes(to);
}

/** Archive is a visibility operation and is forbidden while any run is live. */
export function canArchiveThread(runStatuses: readonly RunStatus[]): boolean {
  return runStatuses.every((status) => TERMINAL_RUN_STATUSES.includes(status));
}

/** Restore never changes a run; it only chooses the remembered projection. */
export function restoreThreadStatus(
  remembered: ThreadStatus | undefined,
  latestRunStatus?: RunStatus,
): Exclude<ThreadStatus, 'archived'> {
  if (remembered && remembered !== 'archived') return remembered;
  if (latestRunStatus === undefined) return 'draft';
  return latestRunStatus === 'waiting'
    ? 'needs-input'
    : latestRunStatus === 'settled'
      ? 'settled'
      : latestRunStatus === 'failed'
        ? 'failed'
        : latestRunStatus === 'cancelled' || latestRunStatus === 'interrupted'
          ? 'stopped'
          : latestRunStatus === 'queued'
            ? 'queued'
            : 'active';
}

export class InvalidTransitionError extends Error {
  readonly code = 'invalid-state-transition';

  constructor(entity: string, from: string, to: string) {
    super(`Illegal ${entity} transition: ${from} -> ${to}.`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to))
    throw new InvalidTransitionError('run', from, to);
}

export type {
  Checkout,
  CheckoutKind,
  CheckoutStatus,
  CheckoutSummary,
  CommandReceipt,
  ModelSelection,
  OrchestrationRuntime,
  Project,
  ProjectStatus,
  ProjectSummary,
  Run,
  RunMode,
  RunStatus,
  RunSummary,
  Thread,
  ThreadStatus,
  ThreadSummary,
} from '@pi-dashboard/protocol';
