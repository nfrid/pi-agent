import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {
  DelegateWorkflowCoordinator,
  DelegateWorkflowMetadataHistory,
  DelegateWorkflowMetadataSnapshot,
} from './workflow-coordinator';
import type { WorkflowAttemptState } from './workflow-model';

/** Custom entry type for append-only workflow lifecycle metadata. */
export const WORKFLOW_ENTRY_TYPE = 'delegate-workflow:v1';
export const MAX_WORKFLOW_HISTORY_ATTEMPTS = 256;
export const MAX_WORKFLOW_HISTORY_REASON = 256;
export const MAX_WORKFLOW_HISTORY_ROUTE = 512;

export interface WorkflowStoreEntry {
  readonly version: 1;
  readonly kind: 'snapshot';
  readonly state: DelegateWorkflowMetadataHistory;
}

type AppendOnly = Pick<ExtensionAPI, 'appendEntry'>;
type SessionBranch = Pick<ExtensionContext, 'sessionManager'>;

const WORKFLOW_STATES: ReadonlySet<WorkflowAttemptState> = new Set([
  'scheduled',
  'queued',
  'running',
  'success',
  'error',
  'timed-out',
  'aborted',
  'cancelled',
  'blocked',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 80 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function validAttempt(
  value: unknown,
): value is DelegateWorkflowMetadataSnapshot {
  if (!isRecord(value)) return false;
  if (
    typeof value.logicalId !== 'string' ||
    value.logicalId.length === 0 ||
    value.logicalId.length > 64 ||
    typeof value.attempt !== 'number' ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    !validIdentity(value.identity) ||
    value.identity !== `${value.logicalId}@${value.attempt}` ||
    typeof value.state !== 'string' ||
    !WORKFLOW_STATES.has(value.state as WorkflowAttemptState) ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > 32 ||
    value.dependencies.some((dependency) => !validIdentity(dependency)) ||
    !Array.isArray(value.waitingFor) ||
    value.waitingFor.length > 32 ||
    value.waitingFor.some((dependency) => !validIdentity(dependency)) ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.scheduledAt)
  )
    return false;
  for (const key of ['queuedAt', 'startedAt', 'settledAt'] as const)
    if (value[key] !== undefined && !validTimestamp(value[key])) return false;
  if (
    value.route !== undefined &&
    (typeof value.route !== 'string' ||
      value.route.length === 0 ||
      value.route.length > MAX_WORKFLOW_HISTORY_ROUTE)
  )
    return false;
  if (
    value.reason !== undefined &&
    (typeof value.reason !== 'string' ||
      value.reason.length === 0 ||
      value.reason.length > MAX_WORKFLOW_HISTORY_REASON)
  )
    return false;
  return true;
}

function isWorkflowStoreEntry(value: unknown): value is WorkflowStoreEntry {
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'snapshot')
    return false;
  const state = value.state;
  return (
    isRecord(state) &&
    state.version === 1 &&
    Array.isArray(state.attempts) &&
    state.attempts.length <= MAX_WORKFLOW_HISTORY_ATTEMPTS &&
    state.attempts.every(validAttempt)
  );
}

function boundedState(
  state: DelegateWorkflowMetadataHistory,
): DelegateWorkflowMetadataHistory {
  const attempts = state.attempts
    .slice(-MAX_WORKFLOW_HISTORY_ATTEMPTS)
    .map((attempt) => ({
      logicalId: attempt.logicalId.slice(0, 64),
      attempt: attempt.attempt,
      identity: attempt.identity.slice(0, 80),
      state: attempt.state,
      dependencies: Object.freeze(
        attempt.dependencies.slice(0, 32).map((value) => value.slice(0, 80)),
      ),
      waitingFor: Object.freeze(
        attempt.waitingFor.slice(0, 32).map((value) => value.slice(0, 80)),
      ),
      createdAt: attempt.createdAt,
      scheduledAt: attempt.scheduledAt,
      ...(attempt.queuedAt === undefined ? {} : { queuedAt: attempt.queuedAt }),
      ...(attempt.startedAt === undefined
        ? {}
        : { startedAt: attempt.startedAt }),
      ...(attempt.settledAt === undefined
        ? {}
        : { settledAt: attempt.settledAt }),
      ...(attempt.route === undefined
        ? {}
        : { route: attempt.route.slice(0, MAX_WORKFLOW_HISTORY_ROUTE) }),
      ...(attempt.reason === undefined
        ? {}
        : { reason: attempt.reason.slice(0, MAX_WORKFLOW_HISTORY_REASON) }),
    }));
  return Object.freeze({ version: 1, attempts: Object.freeze(attempts) });
}

/** Append one metadata-only snapshot. Execution payloads are never accepted. */
export function persistWorkflowState(
  coordinator: DelegateWorkflowCoordinator,
  pi: AppendOnly,
): void {
  const state = boundedState(coordinator.metadataSnapshot());
  pi.appendEntry(WORKFLOW_ENTRY_TYPE, {
    version: 1,
    kind: 'snapshot',
    state,
  } satisfies WorkflowStoreEntry);
}

function workflowHistory(
  ctx: SessionBranch,
): DelegateWorkflowMetadataHistory[] | undefined {
  const history: DelegateWorkflowMetadataHistory[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      !isRecord(entry) ||
      entry.type !== 'custom' ||
      entry.customType !== WORKFLOW_ENTRY_TYPE
    )
      continue;
    if (!isWorkflowStoreEntry(entry.data)) return undefined;
    history.push(entry.data.state);
  }
  return history;
}

/** Return all valid append-only snapshots on the current branch. */
export function workflowStoreHistory(
  ctx: SessionBranch,
): readonly DelegateWorkflowMetadataHistory[] | undefined {
  return workflowHistory(ctx);
}

/** Return the latest valid metadata snapshot on the current branch. */
export function latestWorkflowState(
  ctx: SessionBranch,
): DelegateWorkflowMetadataHistory | undefined {
  return workflowHistory(ctx)?.at(-1);
}

/** Attach append-only persistence to coordinator lifecycle changes. */
export function attachWorkflowStore(
  coordinator: DelegateWorkflowCoordinator,
  pi: AppendOnly,
): () => void {
  return coordinator.subscribeChanges(() =>
    persistWorkflowState(coordinator, pi),
  );
}

/** Small adapter facade useful at extension/session boundaries. */
export class WorkflowStore {
  persist(coordinator: DelegateWorkflowCoordinator, pi: AppendOnly): void {
    persistWorkflowState(coordinator, pi);
  }

  latest(ctx: SessionBranch): DelegateWorkflowMetadataHistory | undefined {
    return latestWorkflowState(ctx);
  }

  attach(coordinator: DelegateWorkflowCoordinator, pi: AppendOnly): () => void {
    return attachWorkflowStore(coordinator, pi);
  }
}

export function createWorkflowStore(): WorkflowStore {
  return new WorkflowStore();
}
