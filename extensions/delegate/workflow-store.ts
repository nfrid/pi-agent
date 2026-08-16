import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { isBranchOwnerId } from './branch-ownership';
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
/** A lifecycle journal entry is intentionally much smaller than a checkpoint. */
export const MAX_WORKFLOW_DELTA_ATTEMPTS = 32;

export interface WorkflowStoreState {
  readonly version: 1;
  readonly attempts: readonly DelegateWorkflowMetadataSnapshot[];
}

export interface WorkflowStoreSnapshotEntry {
  readonly version: 1;
  readonly kind: 'snapshot';
  readonly state: WorkflowStoreState;
}

export interface WorkflowStoreDeltaEntry {
  readonly version: 1;
  readonly kind: 'delta';
  /** Complete replacement records for only the attempts changed since the last append. */
  readonly state: WorkflowStoreState;
}

export type WorkflowStoreEntry =
  | WorkflowStoreSnapshotEntry
  | WorkflowStoreDeltaEntry;

type AppendOnly = Pick<ExtensionAPI, 'appendEntry'>;
type SessionBranch = Pick<ExtensionContext, 'sessionManager'>;

type PersistedMetadata = Map<string, DelegateWorkflowMetadataSnapshot>;
const persistedMetadata = new WeakMap<
  DelegateWorkflowCoordinator,
  PersistedMetadata
>();

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
    (value.ownerBranchId !== undefined &&
      !isBranchOwnerId(value.ownerBranchId)) ||
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
  if (value.allowWrites !== undefined && typeof value.allowWrites !== 'boolean')
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

function metadataKey(attempt: DelegateWorkflowMetadataSnapshot): string {
  return `${attempt.ownerBranchId ?? ''}\u0000${attempt.identity}`;
}

function validState(
  value: unknown,
  kind: WorkflowStoreEntry['kind'],
): value is WorkflowStoreState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.attempts) ||
    value.attempts.length >
      (kind === 'snapshot'
        ? MAX_WORKFLOW_HISTORY_ATTEMPTS
        : MAX_WORKFLOW_DELTA_ATTEMPTS) ||
    value.attempts.some((attempt) => !validAttempt(attempt))
  )
    return false;
  const keys = new Set<string>();
  return value.attempts.every((attempt) => {
    const key = metadataKey(attempt);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function parseWorkflowStoreEntry(
  value: unknown,
): WorkflowStoreEntry | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const kind = value.kind;
  if (
    (kind !== 'snapshot' && kind !== 'delta') ||
    !validState(value.state, kind)
  )
    return undefined;
  return value as unknown as WorkflowStoreEntry;
}

function boundedState(
  state: DelegateWorkflowMetadataHistory,
): DelegateWorkflowMetadataHistory {
  const attempts = state.attempts
    .slice(-MAX_WORKFLOW_HISTORY_ATTEMPTS)
    .map((attempt) => ({
      ...(attempt.ownerBranchId
        ? { ownerBranchId: attempt.ownerBranchId }
        : {}),
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
      ...(attempt.allowWrites === undefined
        ? {}
        : { allowWrites: attempt.allowWrites }),
      ...(attempt.reason === undefined
        ? {}
        : { reason: attempt.reason.slice(0, MAX_WORKFLOW_HISTORY_REASON) }),
    }));
  return Object.freeze({ version: 1, attempts: Object.freeze(attempts) });
}

function metadataMap(
  state: DelegateWorkflowMetadataHistory,
): PersistedMetadata {
  return new Map(
    state.attempts.map((attempt) => [metadataKey(attempt), attempt]),
  );
}

function sameMetadata(
  left: DelegateWorkflowMetadataSnapshot,
  right: DelegateWorkflowMetadataSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface WorkflowStoreWriteGuard {
  /** False defers the owner write until its branch runtime is active again. */
  isOwnerActive?: () => boolean;
  /** Host adapters can update their leaf-to-runtime alias after appendEntry. */
  onPersist?: () => void;
}

function appendCheckpoint(
  coordinator: DelegateWorkflowCoordinator,
  pi: AppendOnly,
  guard: WorkflowStoreWriteGuard,
): void {
  if (guard.isOwnerActive && !guard.isOwnerActive()) return;
  const state = boundedState(coordinator.metadataSnapshot());
  pi.appendEntry(WORKFLOW_ENTRY_TYPE, {
    version: 1,
    kind: 'snapshot',
    state,
  } satisfies WorkflowStoreSnapshotEntry);
  persistedMetadata.set(coordinator, metadataMap(state));
  guard.onPersist?.();
}

/**
 * Persist lifecycle changes as complete metadata records. A callback can emit
 * several small journal entries, but never repeats unchanged attempts.
 */
export function persistWorkflowDelta(
  coordinator: DelegateWorkflowCoordinator,
  pi: AppendOnly,
  guard: WorkflowStoreWriteGuard = {},
): void {
  if (guard.isOwnerActive && !guard.isOwnerActive()) return;
  const state = boundedState(coordinator.metadataSnapshot());
  const previous = persistedMetadata.get(coordinator) ?? new Map();
  const changed = state.attempts.filter((attempt) => {
    const prior = previous.get(metadataKey(attempt));
    return prior === undefined || !sameMetadata(prior, attempt);
  });
  if (changed.length === 0) return;

  const next = new Map(previous);
  let persisted = false;
  for (
    let offset = 0;
    offset < changed.length;
    offset += MAX_WORKFLOW_DELTA_ATTEMPTS
  ) {
    const attempts = changed.slice(
      offset,
      offset + MAX_WORKFLOW_DELTA_ATTEMPTS,
    );
    const delta = {
      version: 1,
      kind: 'delta',
      state: Object.freeze({ version: 1, attempts: Object.freeze(attempts) }),
    } satisfies WorkflowStoreDeltaEntry;
    pi.appendEntry(WORKFLOW_ENTRY_TYPE, delta);
    for (const attempt of attempts) next.set(metadataKey(attempt), attempt);
    persisted = true;
  }
  if (persisted) {
    persistedMetadata.set(coordinator, next);
    guard.onPersist?.();
  }
}

/** Append one bounded metadata checkpoint (the compatibility v1 format). */
export function persistWorkflowState(
  coordinator: DelegateWorkflowCoordinator,
  pi: AppendOnly,
  guard: WorkflowStoreWriteGuard = {},
): void {
  appendCheckpoint(coordinator, pi, guard);
}

interface FoldedWorkflowHistory {
  readonly states: DelegateWorkflowMetadataHistory[];
}

function workflowHistory(
  ctx: SessionBranch,
): FoldedWorkflowHistory | undefined {
  const folded = new Map<string, DelegateWorkflowMetadataSnapshot>();
  const states: DelegateWorkflowMetadataHistory[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      !isRecord(entry) ||
      entry.type !== 'custom' ||
      entry.customType !== WORKFLOW_ENTRY_TYPE
    )
      continue;
    const parsed = parseWorkflowStoreEntry(entry.data);
    // One malformed journal record invalidates the whole fold. In particular,
    // do not expose a valid prefix as if it were the current workflow state.
    if (!parsed) return undefined;
    if (parsed.kind === 'snapshot') folded.clear();
    for (const attempt of parsed.state.attempts) {
      const key = metadataKey(attempt);
      folded.delete(key);
      folded.set(key, attempt);
    }
    while (folded.size > MAX_WORKFLOW_HISTORY_ATTEMPTS) {
      const oldest = folded.keys().next().value;
      if (oldest === undefined) break;
      folded.delete(oldest);
    }
    states.push(boundedState({ version: 1, attempts: [...folded.values()] }));
  }
  return { states };
}

/** Return each folded state from valid v1 snapshots and v1 deltas. */
export function workflowStoreHistory(
  ctx: SessionBranch,
): readonly DelegateWorkflowMetadataHistory[] | undefined {
  return workflowHistory(ctx)?.states;
}

/** Return the latest folded metadata state on the current branch. */
export function latestWorkflowState(
  ctx: SessionBranch,
): DelegateWorkflowMetadataHistory | undefined {
  return workflowHistory(ctx)?.states.at(-1);
}

/** Attach append-only delta persistence to coordinator lifecycle changes. */
export function attachWorkflowStore(
  coordinator: DelegateWorkflowCoordinator,
  pi: AppendOnly,
  guard: WorkflowStoreWriteGuard = {},
): () => void {
  return coordinator.subscribeChanges(() =>
    persistWorkflowDelta(coordinator, pi, guard),
  );
}

/** Small adapter facade useful at extension/session boundaries. */
export class WorkflowStore {
  persist(
    coordinator: DelegateWorkflowCoordinator,
    pi: AppendOnly,
    guard: WorkflowStoreWriteGuard = {},
  ): void {
    persistWorkflowState(coordinator, pi, guard);
  }

  latest(ctx: SessionBranch): DelegateWorkflowMetadataHistory | undefined {
    return latestWorkflowState(ctx);
  }

  attach(
    coordinator: DelegateWorkflowCoordinator,
    pi: AppendOnly,
    guard: WorkflowStoreWriteGuard = {},
  ): () => void {
    return attachWorkflowStore(coordinator, pi, guard);
  }
}

export function createWorkflowStore(): WorkflowStore {
  return new WorkflowStore();
}
