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
import {
  isCanonicalWorkflowAttemptReference,
  isLogicalId,
  MAX_ATTEMPT_ORDINAL,
  MAX_LOGICAL_ID_LENGTH,
  MAX_WORKFLOW_DEPENDENCIES,
  type WorkflowAttemptState,
} from './workflow-model';

/** Custom entry type for append-only workflow lifecycle metadata. */
export const WORKFLOW_ENTRY_TYPE = 'delegate-workflow:v1';
export const MAX_WORKFLOW_HISTORY_ATTEMPTS = 256;
export const MAX_WORKFLOW_HISTORY_REASON = 256;
export const MAX_WORKFLOW_HISTORY_ROUTE = 512;
export const MAX_WORKFLOW_HISTORY_INPUTS = 4;
export const MAX_WORKFLOW_HISTORY_INPUT_LABEL = 120;
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

/**
 * Seed a newly restored coordinator with the durable baseline it was loaded
 * from. Later lifecycle changes are then emitted as deltas instead of an
 * unchanged checkpoint, while records imported from a live ancestor remain
 * dirty until their owner can persist them.
 */
export function seedWorkflowPersistence(
  coordinator: DelegateWorkflowCoordinator,
  state: DelegateWorkflowMetadataHistory | undefined,
): void {
  if (!state) return;
  const bounded = boundedState(state);
  if (bounded) persistedMetadata.set(coordinator, metadataMap(bounded));
}

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

function validBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function validInputMetadata(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_WORKFLOW_HISTORY_INPUTS)
    return false;
  const kinds = new Set(['report', 'handoff', 'branch', 'metadata']);
  return value.every((input) => {
    if (!isRecord(input)) return false;
    if (
      typeof input.node !== 'string' ||
      !isLogicalId(input.node) ||
      typeof input.identity !== 'string' ||
      !isCanonicalWorkflowAttemptReference(input.identity)
    )
      return false;
    if (input.include !== undefined) {
      if (
        !Array.isArray(input.include) ||
        input.include.length > 4 ||
        new Set(input.include).size !== input.include.length ||
        input.include.some(
          (kind) => typeof kind !== 'string' || !kinds.has(kind),
        )
      )
        return false;
    }
    return (
      input.label === undefined ||
      validBoundedText(input.label, MAX_WORKFLOW_HISTORY_INPUT_LABEL)
    );
  });
}

function validAttempt(
  value: unknown,
): value is DelegateWorkflowMetadataSnapshot {
  if (!isRecord(value)) return false;
  if (
    (value.ownerBranchId !== undefined &&
      !isBranchOwnerId(value.ownerBranchId)) ||
    typeof value.logicalId !== 'string' ||
    !isLogicalId(value.logicalId) ||
    value.logicalId.length > MAX_LOGICAL_ID_LENGTH ||
    typeof value.attempt !== 'number' ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    value.attempt > MAX_ATTEMPT_ORDINAL ||
    !isCanonicalWorkflowAttemptReference(value.identity) ||
    value.identity !== `${value.logicalId}@${value.attempt}` ||
    typeof value.state !== 'string' ||
    !WORKFLOW_STATES.has(value.state as WorkflowAttemptState) ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > MAX_WORKFLOW_DEPENDENCIES ||
    value.dependencies.some(
      (dependency) => !isCanonicalWorkflowAttemptReference(dependency),
    ) ||
    new Set(value.dependencies).size !== value.dependencies.length ||
    value.dependencies.includes(value.identity as string) ||
    !Array.isArray(value.waitingFor) ||
    value.waitingFor.length > MAX_WORKFLOW_DEPENDENCIES ||
    (value.inputs !== undefined && !validInputMetadata(value.inputs)) ||
    value.waitingFor.some(
      (dependency) => !isCanonicalWorkflowAttemptReference(dependency),
    ) ||
    new Set(value.waitingFor).size !== value.waitingFor.length ||
    value.waitingFor.some(
      (dependency) => !(value.dependencies as unknown[]).includes(dependency),
    ) ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.scheduledAt)
  )
    return false;
  for (const key of ['queuedAt', 'startedAt', 'settledAt'] as const)
    if (value[key] !== undefined && !validTimestamp(value[key])) return false;
  if (
    value.route !== undefined &&
    !validBoundedText(value.route, MAX_WORKFLOW_HISTORY_ROUTE)
  )
    return false;
  if (value.allowWrites !== undefined && typeof value.allowWrites !== 'boolean')
    return false;
  if (
    value.reason !== undefined &&
    !validBoundedText(value.reason, MAX_WORKFLOW_HISTORY_REASON)
  )
    return false;
  if (value.sessionId !== undefined && !validBoundedText(value.sessionId, 256))
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
): DelegateWorkflowMetadataHistory | undefined {
  // The coordinator is the admission boundary. Persistence must not repair a
  // malformed state by clipping fields or evicting records.
  if (!validState(state, 'snapshot')) return undefined;
  const attempts = state.attempts.map((attempt) =>
    Object.freeze({
      ...(attempt.ownerBranchId
        ? { ownerBranchId: attempt.ownerBranchId }
        : {}),
      logicalId: attempt.logicalId,
      attempt: attempt.attempt,
      identity: attempt.identity,
      state: attempt.state,
      dependencies: Object.freeze([...attempt.dependencies]),
      waitingFor: Object.freeze([...attempt.waitingFor]),
      ...(attempt.inputs
        ? {
            inputs: Object.freeze(
              attempt.inputs.map((input) =>
                Object.freeze({
                  node: input.node,
                  identity: input.identity,
                  ...(input.include
                    ? { include: Object.freeze([...input.include]) }
                    : {}),
                  ...(input.label === undefined ? {} : { label: input.label }),
                }),
              ),
            ),
          }
        : {}),
      createdAt: attempt.createdAt,
      scheduledAt: attempt.scheduledAt,
      ...(attempt.queuedAt === undefined ? {} : { queuedAt: attempt.queuedAt }),
      ...(attempt.startedAt === undefined
        ? {}
        : { startedAt: attempt.startedAt }),
      ...(attempt.settledAt === undefined
        ? {}
        : { settledAt: attempt.settledAt }),
      ...(attempt.route === undefined ? {} : { route: attempt.route }),
      ...(attempt.allowWrites === undefined
        ? {}
        : { allowWrites: attempt.allowWrites }),
      ...(attempt.sessionId === undefined
        ? {}
        : { sessionId: attempt.sessionId }),
      ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
    }),
  );
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
  if (!state) return;
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
  if (!state) return;
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
    const state = boundedState({ version: 1, attempts: [...folded.values()] });
    if (!state) return undefined;
    states.push(state);
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
