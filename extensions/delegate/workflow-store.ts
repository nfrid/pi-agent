import { isDeepStrictEqual } from 'node:util';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { isBranchOwnerId } from './branch-ownership';
import type {
  DelegateWorkflowResultRecord,
  DelegateWorkflowRunProjection,
  DelegateWorkflowTextEvidence,
} from './types';
import type {
  DelegateWorkflowCoordinator,
  DelegateWorkflowMetadataHistory,
  DelegateWorkflowMetadataSnapshot,
} from './workflow-coordinator';
import {
  isCanonicalUuid,
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
export const MAX_WORKFLOW_HISTORY_NAME = 2_000;
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

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function validEvidence(value: unknown): value is DelegateWorkflowTextEvidence {
  if (!isRecord(value) || !onlyKeys(value, ['text', 'bytes', 'oversized']))
    return false;
  if (
    typeof value.text !== 'string' ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    (value.oversized !== undefined && value.oversized !== true)
  )
    return false;
  const actual = Buffer.byteLength(value.text, 'utf8');
  return value.oversized === true
    ? value.text === '[oversized workflow evidence omitted]' &&
        value.bytes > 16 * 1024
    : value.bytes === actual && actual <= 16 * 1024;
}

function validCacheFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    onlyKeys(value, ['path', 'size']) &&
    typeof value.path === 'string' &&
    Buffer.byteLength(value.path, 'utf8') <= 4096 &&
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    value.size <= 16 * 1024 * 1024
  );
}

const RUN_STATES = new Set([
  'queued',
  'running',
  'success',
  'error',
  'aborted',
  'timed-out',
]);

function validDurableRun(
  value: unknown,
): value is DelegateWorkflowRunProjection {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      'runId',
      'name',
      'task',
      'exitCode',
      'state',
      'model',
      'routing',
      'sessionId',
      'lineageId',
      'context',
      'allowWrites',
      'capabilities',
      'isolation',
      'continuation',
      'worktree',
      'outputFile',
      'lifecycle',
      'retryable',
      'queuedAt',
      'startedAt',
      'finishedAt',
      'workflowAttempt',
    ]) ||
    typeof value.runId !== 'string' ||
    Buffer.byteLength(value.runId, 'utf8') > 1024 ||
    typeof value.name !== 'string' ||
    Buffer.byteLength(value.name, 'utf8') > 1024 ||
    typeof value.task !== 'string' ||
    Buffer.byteLength(value.task, 'utf8') > 1024 ||
    typeof value.exitCode !== 'number' ||
    !Number.isSafeInteger(value.exitCode) ||
    typeof value.state !== 'string' ||
    !RUN_STATES.has(value.state)
  )
    return false;
  for (const key of ['model', 'sessionId', 'lineageId'] as const)
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' ||
        Buffer.byteLength(value[key], 'utf8') > 1024)
    )
      return false;
  if (
    value.context !== undefined &&
    !['branch', 'fresh', 'continuation'].includes(String(value.context))
  )
    return false;
  if (
    value.isolation !== undefined &&
    value.isolation !== 'shared' &&
    value.isolation !== 'worktree'
  )
    return false;
  if (value.allowWrites !== undefined && typeof value.allowWrites !== 'boolean')
    return false;
  if (value.retryable !== undefined && value.retryable !== true) return false;
  if (
    value.capabilities !== undefined &&
    (!Array.isArray(value.capabilities) ||
      value.capabilities.length > 1 ||
      value.capabilities.some((item) => item !== 'web'))
  )
    return false;
  if (
    value.continuation !== undefined &&
    (typeof value.continuation !== 'string' ||
      Buffer.byteLength(value.continuation, 'utf8') > 16 * 1024)
  )
    return false;
  for (const key of ['queuedAt', 'startedAt', 'finishedAt'] as const)
    if (value[key] !== undefined && !validTimestamp(value[key])) return false;
  if (value.outputFile !== undefined && !validCacheFile(value.outputFile))
    return false;
  if (value.worktree !== undefined) {
    const worktree = value.worktree;
    if (
      !isRecord(worktree) ||
      !onlyKeys(worktree, [
        'id',
        'repositoryRoot',
        'worktreePath',
        'branch',
        'headCommit',
      ]) ||
      typeof worktree.id !== 'string' ||
      Buffer.byteLength(worktree.id, 'utf8') > 128 ||
      typeof worktree.repositoryRoot !== 'string' ||
      Buffer.byteLength(worktree.repositoryRoot, 'utf8') > 4096 ||
      typeof worktree.worktreePath !== 'string' ||
      Buffer.byteLength(worktree.worktreePath, 'utf8') > 4096 ||
      typeof worktree.branch !== 'string' ||
      Buffer.byteLength(worktree.branch, 'utf8') > 512 ||
      (worktree.headCommit !== undefined &&
        (typeof worktree.headCommit !== 'string' ||
          Buffer.byteLength(worktree.headCommit, 'utf8') > 128))
    )
      return false;
  }
  if (value.workflowAttempt !== undefined) {
    const attempt = value.workflowAttempt;
    if (
      !isRecord(attempt) ||
      !onlyKeys(attempt, ['logicalId', 'ordinal', 'identity']) ||
      typeof attempt.logicalId !== 'string' ||
      !isLogicalId(attempt.logicalId) ||
      typeof attempt.ordinal !== 'number' ||
      !Number.isSafeInteger(attempt.ordinal) ||
      attempt.ordinal < 1 ||
      attempt.ordinal > MAX_ATTEMPT_ORDINAL ||
      attempt.identity !== `${attempt.logicalId}@${attempt.ordinal}`
    )
      return false;
  }
  // Routing and lifecycle are bounded compact projections. The total record
  // cap below protects their optional diagnostic strings and future fields.
  if (
    value.routing !== undefined &&
    (!isRecord(value.routing) ||
      Buffer.byteLength(JSON.stringify(value.routing), 'utf8') > 4096)
  )
    return false;
  if (
    value.lifecycle !== undefined &&
    (!isRecord(value.lifecycle) ||
      Buffer.byteLength(JSON.stringify(value.lifecycle), 'utf8') > 20 * 1024)
  )
    return false;
  return true;
}

function validDurableResult(
  value: unknown,
): value is DelegateWorkflowResultRecord {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      'version',
      'reports',
      'handoff',
      'runs',
      'continuationToken',
      'continuationAmbiguous',
      'continuationUnavailable',
    ]) ||
    value.version !== 1 ||
    !Array.isArray(value.reports) ||
    value.reports.length !== 0 ||
    !validEvidence(value.handoff) ||
    !Array.isArray(value.runs) ||
    value.runs.length > 32 ||
    value.runs.some((run) => !validDurableRun(run)) ||
    typeof value.continuationAmbiguous !== 'boolean' ||
    (value.continuationUnavailable !== undefined &&
      value.continuationUnavailable !== true) ||
    (value.continuationToken !== undefined &&
      (typeof value.continuationToken !== 'string' ||
        Buffer.byteLength(value.continuationToken, 'utf8') > 16 * 1024))
  )
    return false;
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 64 * 1024;
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
    value.name !== undefined &&
    !validBoundedText(value.name, MAX_WORKFLOW_HISTORY_NAME)
  )
    return false;
  if (
    value.route !== undefined &&
    !validBoundedText(value.route, MAX_WORKFLOW_HISTORY_ROUTE)
  )
    return false;
  if (value.allowWrites !== undefined && typeof value.allowWrites !== 'boolean')
    return false;
  if (
    value.capabilities !== undefined &&
    (!Array.isArray(value.capabilities) ||
      value.capabilities.length > 1 ||
      new Set(value.capabilities).size !== value.capabilities.length ||
      value.capabilities.some((capability) => capability !== 'web'))
  )
    return false;
  if (
    value.reason !== undefined &&
    !validBoundedText(value.reason, MAX_WORKFLOW_HISTORY_REASON)
  )
    return false;
  if (value.sessionId !== undefined && !validBoundedText(value.sessionId, 256))
    return false;
  if (value.processJobId !== undefined && !isCanonicalUuid(value.processJobId))
    return false;
  if (value.result !== undefined && !validDurableResult(value.result))
    return false;
  if (
    value.result !== undefined &&
    !isTerminalWorkflowAttemptStateForStore(value.state as WorkflowAttemptState)
  )
    return false;
  const hasSession = value.sessionId !== undefined;
  const hasProcessJob = value.processJobId !== undefined;
  if (hasProcessJob && !hasSession) return false;
  if (
    (value.state === 'queued' || value.state === 'running') &&
    hasSession !== hasProcessJob
  )
    return false;
  return true;
}

function isTerminalWorkflowAttemptStateForStore(
  state: WorkflowAttemptState,
): boolean {
  return !['scheduled', 'queued', 'running'].includes(state);
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
      ...(attempt.name === undefined ? {} : { name: attempt.name }),
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
      ...(attempt.capabilities?.length
        ? { capabilities: Object.freeze([...attempt.capabilities]) }
        : {}),
      ...(attempt.sessionId === undefined
        ? {}
        : { sessionId: attempt.sessionId }),
      ...(attempt.processJobId === undefined
        ? {}
        : { processJobId: attempt.processJobId }),
      ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
      ...(attempt.result === undefined ? {} : { result: attempt.result }),
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
  return isDeepStrictEqual(left, right);
}

function isPersisted(
  coordinator: DelegateWorkflowCoordinator,
  identity: string,
): boolean {
  const current = coordinator
    .metadataSnapshot()
    .attempts.find((attempt) => attempt.identity === identity);
  if (!current) return false;
  const persisted = persistedMetadata
    .get(coordinator)
    ?.get(metadataKey(current));
  return persisted !== undefined && sameMetadata(persisted, current);
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
  coordinator.retryPendingHostedLaunches();
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
  if (changed.length === 0) {
    coordinator.retryPendingHostedLaunches();
    return;
  }

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
    coordinator.retryPendingHostedLaunches();
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
  const acknowledgeHostedLink = (identity: string): boolean => {
    // This is deliberately synchronous. A hosted adapter launch is admitted
    // only after the owner guard allows this flush and its durable baseline
    // contains the exact queued link.
    persistWorkflowDelta(coordinator, pi, guard);
    if (guard.isOwnerActive && !guard.isOwnerActive()) return false;
    return isPersisted(coordinator, identity);
  };
  const detachAcknowledgement =
    coordinator.setHostedLinkPersistenceAcknowledgement(acknowledgeHostedLink);
  const detachChanges = coordinator.subscribeChanges(() =>
    persistWorkflowDelta(coordinator, pi, guard),
  );
  return () => {
    detachChanges();
    detachAcknowledgement();
  };
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
