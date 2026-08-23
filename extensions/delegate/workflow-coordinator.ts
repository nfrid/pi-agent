import { isBranchOwnerId } from './branch-ownership';
import {
  DelegateJobManager,
  type DelegateJobResult,
  type DelegateJobSnapshot,
  type DelegateJobStartOptions,
} from './jobs';
import {
  cloneDelegateLifecycle,
  ensureDelegateLifecycle,
  getDelegateLifecycle,
  hydrateDelegateLifecycle,
} from './lifecycle';
import { buildParentHandoff } from './output';

import {
  type DelegatedRun,
  type DelegateRouteState,
  type DelegateWorkflowBranchDescriptor,
  type DelegateWorkflowResultProjection,
  type DelegateWorkflowResultRecord,
  type DelegateWorkflowRunProjection,
  emptyUsage,
  getExactFinalAssistantText,
} from './types';
import {
  type BoundWorkflowSelector,
  captureWorkflowText,
  type ResolvedWorkflowInput,
  type ResolvedWorkflowInputs,
  resolveWorkflowInputs,
  type SymbolicWorkflowSelector,
  WorkflowInputBlockedError,
  type WorkflowInputKind,
  type WorkflowInputSource,
} from './workflow-inputs';
import {
  type AttemptIdentity,
  assertWorkflowAttemptTransition,
  createWorkflowModel,
  isCanonicalUuid,
  isTerminalWorkflowAttemptState,
  MAX_WORKFLOW_DEPENDENCIES,
  type WorkflowAttempt,
  type WorkflowAttemptState,
  type WorkflowModel,
  type WorkflowModelPlan,
} from './workflow-model';
import { failedLifecycleRun } from './worktree-lifecycle';

export const MAX_WORKFLOW_ATTEMPTS = 256;
/** Fixed, metadata-only reason for attempts orphaned by process recreation. */
export const WORKFLOW_RELOAD_ORPHAN_REASON =
  'Workflow blocked: execution state unavailable after reload.' as const;
const MAX_WORKFLOW_REASON_LENGTH = 256;
const MAX_WORKFLOW_TOKEN_BYTES = 16 * 1024;
const MAX_TERMINAL_FIELD_BYTES = 1024;
const DEFAULT_PREPARATION_GRACE_MS = 100;

type PreparationCleanup = () => void | Promise<void>;

export interface DelegateWorkflowLaunchContext {
  readonly attempt: WorkflowAttempt;
  readonly dependencies: readonly BoundWorkflowSelector[];
  readonly inputs: readonly ResolvedWorkflowInput[];
  readonly handoffText: string;
  /** Exact predecessor for a logical continuation, once it has settled. */
  readonly predecessor?: AttemptIdentity;
  /** Opaque token retained by the canonical predecessor result. */
  readonly continuationToken?: string;
  /** Aborted when lazy preparation is cancelled or the coordinator shuts down. */
  readonly signal: AbortSignal;
  /** Resolve another bound source without exposing it in coordinator snapshots. */
  readonly resolve: (
    identity: AttemptIdentity,
  ) => readonly ResolvedWorkflowInput[];
}

export interface DelegateWorkflowPreparedLaunch {
  readonly launch: DelegateJobStartOptions;
  /** Dispose resources created by lazy preparation when launch is cancelled. */
  readonly discard?: () => void | Promise<void>;
}

export type DelegateWorkflowLaunchFactory = (
  context: DelegateWorkflowLaunchContext,
) =>
  | DelegateJobStartOptions
  | DelegateWorkflowPreparedLaunch
  | Promise<DelegateJobStartOptions | DelegateWorkflowPreparedLaunch>;

export interface DelegateWorkflowScheduleOptions
  extends Omit<
    DelegateJobStartOptions,
    'workflowAttempt' | 'onTerminal' | 'mode' | 'tasks' | 'execute'
  > {
  /** Logical identity of the new attempt. */
  logicalId: string;
  /** Exact selected route state retained for continuation inheritance. */
  routing?: DelegateRouteState;
  /** Continue the latest attempt in this lineage instead of creating @1. */
  continuation?: boolean | string;
  /** References to attempts that must settle before this attempt launches. */
  after?: readonly string[];
  /** Symbolic sources, each of which becomes an implicit dependency. */
  inputs?: readonly SymbolicWorkflowSelector[];
  /** Mutually exclusive lazy preparation for the actual job launch. */
  prepare?: DelegateWorkflowLaunchFactory;
  /** Resource cleanup for work captured before this identity was admitted. */
  preparationCleanup?: PreparationCleanup;
  mode?: DelegateJobStartOptions['mode'];
  tasks?: string[];
  execute?: DelegateJobStartOptions['execute'];
}

export interface DelegateWorkflowInputSnapshot {
  readonly node: string;
  readonly identity: AttemptIdentity;
  readonly include?: readonly WorkflowInputKind[];
  readonly label?: string;
}

export interface DelegateWorkflowAttemptSnapshot {
  readonly attempt: WorkflowAttempt;
  /** Immutable internal owner; omitted from public/dashboard projections. */
  readonly ownerBranchId?: string;
  readonly logicalId: string;
  readonly ordinal: number;
  readonly identity: AttemptIdentity;
  readonly dependencies: readonly AttemptIdentity[];
  /** Dependencies that have not settled yet; derived, never persisted with inputs. */
  readonly waitingFor: readonly AttemptIdentity[];
  readonly inputs: readonly BoundWorkflowSelector[];
  readonly state: WorkflowAttemptState;
  readonly createdAt: number;
  readonly scheduledAt: number;
  readonly queuedAt?: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
  readonly route?: string;
  readonly allowWrites?: boolean;
  /** Internal adapter job identity, once the attempt has launched. */
  readonly jobId?: string;
  /** Durable process-host job identity for hosted attempts. */
  readonly processJobId?: string;
  /** Concise actionable setup, launch, or settlement reason. */
  readonly reason?: string;
}

export interface DelegateWorkflowSnapshot {
  readonly attempts: readonly DelegateWorkflowAttemptSnapshot[];
}

/** A local hosted link that can be safely considered for process reattachment. */
export interface DelegateRestorableHostedLink {
  readonly attempt: WorkflowAttempt;
  readonly identity: AttemptIdentity;
  readonly logicalId: string;
  readonly state: 'queued' | 'running';
  readonly sessionId: string;
  readonly processJobId: string;
  readonly ownerBranchId?: string;
}

/** Metadata-only projection suitable for durable session history. */
export interface DelegateWorkflowMetadataSnapshot {
  /** Bounded immutable branch marker used only for ancestry checks. */
  readonly ownerBranchId?: string;
  readonly logicalId: string;
  readonly attempt: number;
  readonly identity: AttemptIdentity;
  readonly state: WorkflowAttemptState;
  readonly dependencies: readonly AttemptIdentity[];
  readonly waitingFor: readonly AttemptIdentity[];
  /** Sanitized symbolic input selectors; never includes resolved evidence. */
  readonly inputs?: readonly DelegateWorkflowInputSnapshot[];
  readonly createdAt: number;
  readonly scheduledAt: number;
  readonly queuedAt?: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
  readonly route?: string;
  readonly allowWrites?: boolean;
  /** Canonical Pi child session shared by this node's continuations. */
  readonly sessionId?: string;
  /** Durable process-host job identity for hosted attempts. */
  readonly processJobId?: string;
  readonly reason?: string;
}

export interface DelegateWorkflowMetadataHistory {
  readonly version: 1;
  readonly attempts: readonly DelegateWorkflowMetadataSnapshot[];
}

export type DelegateWorkflowTerminalListener = (
  attempt: DelegateWorkflowAttemptSnapshot,
) => void;

export type DelegateWorkflowHostedLinkPersistenceAcknowledgement = (
  identity: AttemptIdentity,
) => boolean;

export interface DelegateWorkflowCoordinatorOptions {
  /** Immutable branch that owns attempts created by this coordinator. */
  ownerBranchId?: string;
  /** Hard identity admission bound; no legal references are evicted. */
  maxAttempts?: number;
  /** Existing execution adapter. */
  jobs?: DelegateJobManager;
  /** Maximum time cancellation/disposal waits for preparation cleanup. */
  preparationGraceMs?: number;
  /** Alias for jobs, useful at integration boundaries. */
  jobManager?: DelegateJobManager;
  model?: WorkflowModel;
  now?: () => number;
  onChange?: () => void;
}

interface WorkflowRecord {
  attempt: WorkflowAttempt;
  /** Immutable owner branch; imported records retain their original owner. */
  ownerBranchId?: string;
  dependencies: readonly AttemptIdentity[];
  state: WorkflowAttemptState;
  createdAt: number;
  scheduledAt: number;
  queuedAt?: number;
  startedAt?: number;
  settledAt?: number;
  route?: string;
  routing?: DelegateRouteState;
  allowWrites?: boolean;
  jobId?: string;
  processJobId?: string;
  reason?: string;
  launched: boolean;
  cancellationRequested: boolean;
  cancellationWaiters: Array<() => void>;
  cancellationInFlight?: Promise<void>;
  result?: DelegateWorkflowResultRecord;
  selectors: readonly BoundWorkflowSelector[];
  /** Retained separately so restored records can expose selector metadata. */
  inputMetadata: readonly DelegateWorkflowInputSnapshot[];
  prepare?: DelegateWorkflowLaunchFactory;
  preparationInFlight?: Promise<void>;
  preparationController?: AbortController;
  launch?: DelegateJobStartOptions;
  discard?: () => void | Promise<void>;
  preparationCleanup?: PreparationCleanup;
  preparationCleanupDone?: boolean;
  preparationDiscarded?: boolean;
  preparationDiscardInFlight?: Promise<void>;
  continuationPredecessor?: AttemptIdentity;
  /** Canonical predecessor token captured before lazy preparation starts. */
  continuationToken?: string;
  /** Canonical Pi child session shared by this node's continuations. */
  sessionId?: string;
}

function inputMetadata(
  selectors: readonly BoundWorkflowSelector[],
): readonly DelegateWorkflowInputSnapshot[] {
  return Object.freeze(
    selectors.map((selector) =>
      Object.freeze({
        node: selector.selector.node,
        identity: selector.identity,
        ...(selector.selector.include
          ? { include: Object.freeze([...selector.selector.include]) }
          : {}),
        ...(selector.selector.label === undefined
          ? {}
          : { label: selector.selector.label }),
      }),
    ),
  );
}

function copyRouting(
  routing: DelegateRouteState | undefined,
): DelegateRouteState | undefined {
  return routing ? Object.freeze({ ...routing }) : undefined;
}

function boundedReason(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  const normalized = text.trim() || 'Delegate workflow attempt failed.';
  return normalized.length > MAX_WORKFLOW_REASON_LENGTH
    ? `${normalized.slice(0, MAX_WORKFLOW_REASON_LENGTH - 1)}…`
    : normalized;
}

function boundedSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256)
    return undefined;
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return undefined;
  return value;
}

function validProcessLink(
  sessionId: unknown,
  processJobId: unknown,
): sessionId is string {
  const hasSession = sessionId !== undefined;
  const hasProcessJob = processJobId !== undefined;
  if (hasSession !== hasProcessJob) return false;
  if (!hasSession) return true;
  return (
    boundedSessionId(sessionId) !== undefined && isCanonicalUuid(processJobId)
  );
}

function compactSessionId(
  evidence: DelegateWorkflowResultRecord | undefined,
): string | undefined {
  return (
    evidence?.runs.find((run) => run.sessionId)?.sessionId ??
    evidence?.continuationToken ??
    evidence?.runs.find((run) => run.continuation)?.continuation
  );
}

function validateScheduleInput(options: DelegateWorkflowScheduleOptions): void {
  if (typeof options.logicalId !== 'string')
    throw new Error('Invalid workflow logical ID: expected a string.');
  if (
    options.continuation !== undefined &&
    typeof options.continuation !== 'boolean' &&
    typeof options.continuation !== 'string'
  )
    throw new Error('Invalid workflow continuation reference.');
  if (options.after !== undefined && !Array.isArray(options.after))
    throw new Error('Invalid workflow dependencies: expected an array.');
  if (options.after && options.after.length > MAX_WORKFLOW_DEPENDENCIES)
    throw new Error(
      `A workflow attempt may declare at most ${MAX_WORKFLOW_DEPENDENCIES} explicit dependencies.`,
    );
  if (options.after?.some((reference) => typeof reference !== 'string'))
    throw new Error(
      'Invalid workflow dependency: expected a string reference.',
    );
  if (options.inputs !== undefined && !Array.isArray(options.inputs))
    throw new Error('Invalid symbolic workflow inputs: expected an array.');
  if (options.prepare !== undefined && typeof options.prepare !== 'function')
    throw new Error('Invalid lazy workflow launch factory.');
  if (
    options.preparationCleanup !== undefined &&
    typeof options.preparationCleanup !== 'function'
  )
    throw new Error('Invalid workflow preparation cleanup.');
  const lazy = options.prepare !== undefined;
  if (lazy && options.execute !== undefined)
    throw new Error(
      'Static execute options and lazy preparation are mutually exclusive.',
    );
  if (!lazy) {
    if (options.mode !== 'single' && options.mode !== 'parallel')
      throw new Error('Invalid delegate mode.');
    if (
      !Array.isArray(options.tasks) ||
      options.tasks.some((task) => typeof task !== 'string')
    )
      throw new Error('Invalid delegate tasks: expected an array of strings.');
    if (typeof options.execute !== 'function')
      throw new Error('Invalid delegate launch: execute must be a function.');
    if (options.inputs?.length)
      throw new Error('Symbolic workflow inputs require lazy preparation.');
  }
  if (options.route !== undefined && typeof options.route !== 'string')
    throw new Error('Invalid delegate route.');
}

function copyAttempt(attempt: WorkflowAttempt): WorkflowAttempt {
  return Object.freeze({ ...attempt });
}

function boundedTerminalField(value: string, fallback: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_TERMINAL_FIELD_BYTES)
    return value;
  return fallback;
}

function copyArtifact(
  value: DelegatedRun['artifact'],
): DelegatedRun['artifact'] {
  return value ? Object.freeze({ ...value }) : undefined;
}

function copyBranch(
  worktree: DelegatedRun['worktree'],
): DelegateWorkflowBranchDescriptor | undefined {
  if (!worktree) return undefined;
  const within = (value: unknown, maxBytes: number): value is string =>
    typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
  if (
    !within(worktree.id, 128) ||
    !within(worktree.repositoryRoot, 4096) ||
    !within(worktree.worktreePath, 4096) ||
    !within(worktree.branch, 512) ||
    (worktree.headCommit !== undefined && !within(worktree.headCommit, 128))
  )
    return undefined;
  return Object.freeze({
    id: worktree.id,
    repositoryRoot: worktree.repositoryRoot,
    worktreePath: worktree.worktreePath,
    branch: worktree.branch,
    ...(worktree.headCommit === undefined
      ? {}
      : { headCommit: worktree.headCommit }),
  });
}

function compactRun(run: DelegatedRun): DelegateWorkflowRunProjection {
  const lifecycle =
    ['error', 'aborted', 'timed-out'].includes(run.state) &&
    !getDelegateLifecycle(run)
      ? ensureDelegateLifecycle(run)
      : getDelegateLifecycle(run, {
          includeArtifact: true,
          includeBoundedFallback: true,
        });
  const compactLifecycle = lifecycle
    ? cloneDelegateLifecycle(lifecycle, { includeArtifact: true })
    : undefined;
  const report = (() => {
    const text = getExactFinalAssistantText(run.messages);
    return text.trim() ? captureWorkflowText(text) : undefined;
  })();
  const continuation = run.continuation?.trim();
  return Object.freeze({
    runId: boundedTerminalField(run.runId, 'unknown-run'),
    name: boundedTerminalField(run.name, 'Subagent'),
    task: boundedTerminalField(run.task, '[oversized task omitted]'),
    exitCode: run.exitCode,
    state: run.state,
    ...(run.model
      ? { model: boundedTerminalField(run.model, '[oversized model omitted]') }
      : {}),
    ...(run.routing ? { routing: copyRouting(run.routing) } : {}),
    ...(run.sessionId
      ? { sessionId: boundedTerminalField(run.sessionId, '[session omitted]') }
      : {}),
    ...(run.lineageId
      ? { lineageId: boundedTerminalField(run.lineageId, '[lineage omitted]') }
      : {}),
    ...(run.context ? { context: run.context } : {}),
    ...(run.allowWrites === undefined ? {} : { allowWrites: run.allowWrites }),
    ...(run.isolation ? { isolation: run.isolation } : {}),
    ...(continuation &&
    Buffer.byteLength(continuation, 'utf8') <= MAX_WORKFLOW_TOKEN_BYTES
      ? { continuation }
      : {}),
    ...(copyBranch(run.worktree) ? { worktree: copyBranch(run.worktree) } : {}),
    ...(copyArtifact(run.artifact)
      ? { artifact: copyArtifact(run.artifact) }
      : {}),
    ...(compactLifecycle ? { lifecycle: compactLifecycle } : {}),
    ...(run.retryable ? { retryable: true } : {}),
    ...(run.queuedAt === undefined ? {} : { queuedAt: run.queuedAt }),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.workflowAttempt
      ? { workflowAttempt: Object.freeze({ ...run.workflowAttempt }) }
      : {}),
    ...(report ? { report } : {}),
  });
}

function compactResult(
  result: DelegateJobResult,
): DelegateWorkflowResultRecord {
  const sourceRuns = result.retainedRuns ?? result.runs;
  const runs = Object.freeze(sourceRuns.map(compactRun));
  const reports = Object.freeze(
    runs.flatMap((run) => (run.report ? [run.report] : [])),
  );
  const rawTokens = sourceRuns
    .map((run) => run.continuation?.trim())
    .filter((token): token is string => Boolean(token));
  const oversizedToken = rawTokens.some(
    (token) => Buffer.byteLength(token, 'utf8') > MAX_WORKFLOW_TOKEN_BYTES,
  );
  const tokens = [...new Set(rawTokens)].filter(
    (token) => Buffer.byteLength(token, 'utf8') <= MAX_WORKFLOW_TOKEN_BYTES,
  );
  return Object.freeze({
    version: 1,
    reports,
    handoff: captureWorkflowText(result.handoff ?? ''),
    runs,
    ...(tokens.length === 1 ? { continuationToken: tokens[0] } : {}),
    continuationAmbiguous: tokens.length > 1,
    ...(oversizedToken ? { continuationUnavailable: true as const } : {}),
  });
}

function emptyResult(reason: string): DelegateWorkflowResultRecord {
  return Object.freeze({
    version: 1,
    reports: Object.freeze([]),
    handoff: captureWorkflowText(reason),
    runs: Object.freeze([]),
    continuationAmbiguous: false,
  });
}

function canonicalContinuationToken(
  result: DelegateWorkflowResultRecord | undefined,
  predecessorSessionId?: string,
): string | undefined {
  if (!result) {
    if (predecessorSessionId) return predecessorSessionId;
    throw new WorkflowInputBlockedError(
      'Logical continuation is unavailable: the predecessor session identity was not retained.',
    );
  }
  if (result.continuationUnavailable)
    throw new WorkflowInputBlockedError(
      'Logical continuation is unavailable: the predecessor token exceeded the workflow input cap.',
    );
  if (result.continuationAmbiguous)
    throw new WorkflowInputBlockedError(
      'Logical continuation is ambiguous across predecessor runs.',
    );
  if (result.continuationToken) return result.continuationToken;
  if (predecessorSessionId) return predecessorSessionId;
  throw new WorkflowInputBlockedError(
    'Logical continuation is unavailable: the predecessor retained no continuation token or session identity.',
  );
}

function normalizePreparedLaunch(
  value: DelegateJobStartOptions | DelegateWorkflowPreparedLaunch,
): DelegateWorkflowPreparedLaunch {
  if (
    value &&
    typeof value === 'object' &&
    'launch' in value &&
    value.launch &&
    typeof value.launch === 'object'
  )
    return value as DelegateWorkflowPreparedLaunch;
  return { launch: value as DelegateJobStartOptions };
}

function publicRunFromCompact(
  run: DelegateWorkflowRunProjection,
  includeArtifacts = false,
): DelegatedRun {
  const projected: DelegatedRun = {
    runId: run.runId,
    name: run.name,
    task: run.task,
    exitCode: run.exitCode,
    messages: [],
    stderr: '',
    usage: emptyUsage(),
    activities: [],
    state: run.state,
    ...(run.model ? { model: run.model } : {}),
    ...(run.routing ? { routing: copyRouting(run.routing) } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(run.lineageId ? { lineageId: run.lineageId } : {}),
    ...(run.context ? { context: run.context } : {}),
    ...(run.allowWrites === undefined ? {} : { allowWrites: run.allowWrites }),
    ...(run.isolation ? { isolation: run.isolation } : {}),
    ...(run.continuation ? { continuation: run.continuation } : {}),
    ...(run.retryable ? { retryable: true } : {}),
    ...(run.queuedAt === undefined ? {} : { queuedAt: run.queuedAt }),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.workflowAttempt
      ? { workflowAttempt: Object.freeze({ ...run.workflowAttempt }) }
      : {}),
    ...(includeArtifacts && run.artifact
      ? { artifact: { ...run.artifact } }
      : {}),
    ...(run.retryable ? { retryable: true } : {}),
  };
  if (run.lifecycle) {
    const lifecycle = cloneDelegateLifecycle(run.lifecycle, {
      includeArtifact: includeArtifacts,
    });
    if (lifecycle) {
      projected.lifecycle = lifecycle;
      hydrateDelegateLifecycle(projected, lifecycle);
    }
  }
  return projected;
}

function publicResultFromCompact(
  result: DelegateWorkflowResultRecord,
): DelegateWorkflowResultProjection {
  return Object.freeze({
    runs: Object.freeze(
      result.runs.map((run) => publicRunFromCompact(run, true)),
    ),
    handoff: result.handoff.text,
  });
}

function setupFailureResult(
  record: WorkflowRecord,
  reason: string,
): DelegateJobResult {
  const task = record.launch?.tasks[0] ?? record.attempt.identity;
  const run = failedLifecycleRun(
    task,
    undefined,
    {
      name: record.launch?.name ?? record.attempt.identity,
      backgroundJobId: record.jobId,
      workflowAttempt: record.attempt,
      warnings: [],
    },
    reason,
    'setup-failure',
  );
  if (record.continuationToken) run.continuation = record.continuationToken;
  return { runs: [run], handoff: buildParentHandoff([run]) };
}

/**
 * Owns workflow identity, dependency barriers, and attempt lifecycle. Jobs are
 * intentionally only an execution adapter; settled children are reduced to
 * bounded canonical evidence before workflow readiness is published.
 */
export class DelegateWorkflowCoordinator {
  readonly model: WorkflowModel;
  private readonly jobs: DelegateJobManager;
  private readonly ownsJobs: boolean;
  readonly ownerBranchId: string | undefined;
  readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly preparationGraceMs: number;
  private readonly onChange?: () => void;
  private readonly terminalListeners =
    new Set<DelegateWorkflowTerminalListener>();
  private readonly changeListeners = new Set<() => void>();
  private readonly records = new Map<AttemptIdentity, WorkflowRecord>();
  /** Records imported from an ancestor are shared and never locally mutable. */
  private readonly importedRecordIdentities = new Set<AttemptIdentity>();
  private readonly results = new Map<
    AttemptIdentity,
    DelegateWorkflowResultRecord
  >();
  private disposed = false;
  private readonly importedSources = new Set<DelegateWorkflowCoordinator>();
  private readonly importedSourceDetachers = new Map<
    DelegateWorkflowCoordinator,
    () => void
  >();
  /** Guards the one terminal callback belonging to each restored observation. */
  private readonly restoredTerminalObservations = new Set<string>();
  /** Hosted jobs waiting for their queued process link to be durably acknowledged. */
  private readonly pendingHostedLaunches = new Set<AttemptIdentity>();
  private hostedLinkPersistenceAcknowledgement?: DelegateWorkflowHostedLinkPersistenceAcknowledgement;
  /** Claims an active restored identity before an adapter record is created. */
  private readonly restoredHostedClaims = new Set<AttemptIdentity>();

  constructor(options: DelegateWorkflowCoordinatorOptions = {}) {
    if (
      options.ownerBranchId !== undefined &&
      !isBranchOwnerId(options.ownerBranchId)
    )
      throw new Error('Invalid delegate workflow owner branch ID.');
    this.ownerBranchId = options.ownerBranchId;
    if (
      options.maxAttempts !== undefined &&
      (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1)
    )
      throw new Error('Invalid workflow attempt admission bound.');
    this.maxAttempts = options.maxAttempts ?? MAX_WORKFLOW_ATTEMPTS;
    this.model = options.model ?? createWorkflowModel();
    this.jobs = options.jobs ?? options.jobManager ?? new DelegateJobManager();
    this.ownsJobs =
      options.jobs === undefined && options.jobManager === undefined;
    this.now = options.now ?? Date.now;
    if (
      options.preparationGraceMs !== undefined &&
      (!Number.isSafeInteger(options.preparationGraceMs) ||
        options.preparationGraceMs < 0)
    )
      throw new Error('Invalid workflow preparation grace period.');
    this.preparationGraceMs =
      options.preparationGraceMs ?? DEFAULT_PREPARATION_GRACE_MS;
    this.onChange = options.onChange;
  }

  /** Validate and bind one complete schedule before changing model identity. */
  schedule(
    options: DelegateWorkflowScheduleOptions,
  ): DelegateWorkflowAttemptSnapshot {
    if (this.disposed)
      throw new Error('Delegate workflow coordinator is disposed.');
    validateScheduleInput(options);
    // Admission is checked before planning or binding any new identity. A
    // legal existing reference is never evicted to make room for another one.
    if (this.records.size >= this.maxAttempts)
      throw new Error(
        `Delegate workflow attempt limit of ${this.maxAttempts} has been reached.`,
      );
    const plan = options.continuation
      ? this.model.planContinuation(
          typeof options.continuation === 'string'
            ? options.continuation
            : options.logicalId,
        )
      : this.model.planFresh(options.logicalId);
    const selectors = this.bindSelectors(options.inputs ?? []);
    const dependencies = this.bindDependencies(
      plan,
      options.after ?? [],
      selectors,
    );

    // This is the adapter's only preflight. No model or coordinator identity
    // has been committed before every reference and launch input is checked.
    if (this.dependenciesReady(dependencies)) this.jobs.assertAccepting();

    const timestamp = this.now();
    const record: WorkflowRecord = {
      attempt: copyAttempt(plan.attempt),
      ownerBranchId: this.ownerBranchId,
      dependencies: Object.freeze([...dependencies]),
      state: 'scheduled',
      createdAt: timestamp,
      scheduledAt: timestamp,
      route: options.routing?.route ?? options.route,
      routing: copyRouting(options.routing),
      allowWrites: options.allowWrites,
      launched: false,
      cancellationRequested: false,
      cancellationWaiters: [],
      selectors,
      inputMetadata: inputMetadata(selectors),
      prepare: options.prepare,
      preparationCleanup: options.preparationCleanup,
      continuationPredecessor: plan.predecessor?.identity,
      launch:
        options.prepare === undefined
          ? {
              name: options.name,
              ownerSessionId: options.ownerSessionId,
              ownerBranchId: this.ownerBranchId,
              mode: options.mode as DelegateJobStartOptions['mode'],
              tasks: [...(options.tasks ?? [])],
              execute: options.execute as DelegateJobStartOptions['execute'],
              materialize: options.materialize,
              deliveryEpoch: options.deliveryEpoch,
              route: options.route,
              allowWrites: options.allowWrites,
              sessionId: options.sessionId,
              processJobId: options.processJobId,
              feedback: options.feedback,
            }
          : undefined,
    };

    // The plan was fully validated and is now the single identity mutation.
    this.model.commit(plan);
    this.records.set(record.attempt.identity, record);
    this.changed();

    if (this.dependenciesReady(record.dependencies)) this.launch(record);
    return this.snapshotRecord(record);
  }

  /** Subscribe to terminal settlement without exposing execution adapter events. */
  subscribeTerminal(listener: DelegateWorkflowTerminalListener): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  /** Subscribe to lifecycle changes for append-only metadata stores. */
  subscribeChanges(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * Require an attached store to acknowledge hosted links before execution.
   * The acknowledgement is intentionally narrow: unhosted attempts retain the
   * coordinator's existing synchronous launch path.
   */
  setHostedLinkPersistenceAcknowledgement(
    acknowledgement:
      | DelegateWorkflowHostedLinkPersistenceAcknowledgement
      | undefined,
  ): () => void {
    this.hostedLinkPersistenceAcknowledgement = acknowledgement;
    return () => {
      if (this.hostedLinkPersistenceAcknowledgement === acknowledgement)
        this.hostedLinkPersistenceAcknowledgement = undefined;
    };
  }

  /** Retry hosted launches released by a successful owner persistence flush. */
  retryPendingHostedLaunches(): void {
    if (this.disposed || !this.hostedLinkPersistenceAcknowledgement) return;
    for (const identity of [...this.pendingHostedLaunches]) {
      const record = this.records.get(identity);
      this.pendingHostedLaunches.delete(identity);
      if (
        !record ||
        record.jobId !== undefined ||
        record.state !== 'queued' ||
        record.cancellationRequested
      )
        continue;
      this.startJob(record, record.launch);
    }
  }

  /** Return bounded coordinator metadata without resolved inputs or results. */
  metadataSnapshot(): DelegateWorkflowMetadataHistory {
    return Object.freeze({
      version: 1,
      attempts: Object.freeze(
        this.model
          .snapshot()
          .attempts.map((attempt) => this.records.get(attempt.identity))
          .filter((record): record is WorkflowRecord => record !== undefined)
          .map((record) => {
            const waitingFor = record.dependencies.filter((identity) => {
              const dependency = this.records.get(identity);
              return (
                dependency !== undefined &&
                !isTerminalWorkflowAttemptState(dependency.state)
              );
            });
            return Object.freeze({
              ...(record.ownerBranchId
                ? { ownerBranchId: record.ownerBranchId }
                : {}),
              logicalId: record.attempt.logicalId,
              attempt: record.attempt.ordinal,
              identity: record.attempt.identity,
              state: record.state,
              dependencies: Object.freeze([...record.dependencies]),
              waitingFor: Object.freeze(waitingFor),
              createdAt: record.createdAt,
              scheduledAt: record.scheduledAt,
              ...(record.queuedAt === undefined
                ? {}
                : { queuedAt: record.queuedAt }),
              ...(record.startedAt === undefined
                ? {}
                : { startedAt: record.startedAt }),
              ...(record.settledAt === undefined
                ? {}
                : { settledAt: record.settledAt }),
              ...(record.route === undefined ? {} : { route: record.route }),
              ...(record.allowWrites === undefined
                ? {}
                : { allowWrites: record.allowWrites }),
              ...(boundedSessionId(record.sessionId)
                ? { sessionId: record.sessionId }
                : {}),
              ...(isCanonicalUuid(record.processJobId)
                ? { processJobId: record.processJobId }
                : {}),
              ...(record.selectors.length > 0
                ? { inputs: inputMetadata(record.selectors) }
                : {}),
              ...(record.reason === undefined ? {} : { reason: record.reason }),
            });
          }),
      ),
    });
  }

  /** Resolve a latest/exact reference to a detached workflow snapshot. */
  get(reference: string): DelegateWorkflowAttemptSnapshot | undefined {
    try {
      const attempt = this.model.lookup(reference);
      const record = this.records.get(attempt.identity);
      return record ? this.snapshotRecord(record) : undefined;
    } catch {
      return undefined;
    }
  }

  require(reference: string): DelegateWorkflowAttemptSnapshot {
    const attempt = this.model.lookup(reference);
    const record = this.records.get(attempt.identity);
    if (!record)
      throw new Error(`Unknown workflow attempt "${attempt.identity}".`);
    return this.snapshotRecord(record);
  }

  /** Return the exact retained route state without exposing it in snapshots. */
  getRouting(reference: string): DelegateRouteState | undefined {
    const attempt = this.model.lookup(reference);
    return copyRouting(this.records.get(attempt.identity)?.routing);
  }

  list(): DelegateWorkflowAttemptSnapshot[] {
    return this.model
      .snapshot()
      .attempts.map((attempt) => this.records.get(attempt.identity))
      .filter((record): record is WorkflowRecord => record !== undefined)
      .map((record) => this.snapshotRecord(record));
  }

  /**
   * Enumerate only locally-owned active attempts with a complete hosted link.
   * Imported records and terminal tombstones are deliberately excluded.
   */
  listRestorableHostedLinks(): DelegateRestorableHostedLink[] {
    return this.model
      .snapshot()
      .attempts.map((attempt) => this.records.get(attempt.identity))
      .filter(
        (record): record is WorkflowRecord =>
          record !== undefined &&
          !this.importedRecordIdentities.has(record.attempt.identity) &&
          (record.state === 'queued' || record.state === 'running') &&
          record.jobId === undefined &&
          record.sessionId !== undefined &&
          record.processJobId !== undefined &&
          validProcessLink(record.sessionId, record.processJobId),
      )
      .map((record) =>
        Object.freeze({
          attempt: copyAttempt(record.attempt),
          identity: record.attempt.identity,
          logicalId: record.attempt.logicalId,
          state: record.state as 'queued' | 'running',
          sessionId: record.sessionId as string,
          processJobId: record.processJobId as string,
          ...(record.ownerBranchId
            ? { ownerBranchId: record.ownerBranchId }
            : {}),
        }),
      );
  }

  /** Alias used by restore adapters at integration boundaries. */
  enumerateRestorableHostedLinks(): DelegateRestorableHostedLink[] {
    return this.listRestorableHostedLinks();
  }

  /**
   * Claim an active restored identity before starting an adapter observation.
   * The claim closes the gap between manager start and workflow binding, where
   * a duplicate reconciliation could otherwise create an orphan observer.
   */
  claimRestoredHostedJob(reference: string): boolean {
    const record = this.requireRecord(reference);
    if (this.importedRecordIdentities.has(record.attempt.identity))
      throw new Error('Imported workflow attempts cannot be restored locally.');
    if (
      isTerminalWorkflowAttemptState(record.state) ||
      record.jobId !== undefined ||
      this.restoredHostedClaims.has(record.attempt.identity)
    )
      return false;
    this.restoredHostedClaims.add(record.attempt.identity);
    return true;
  }

  /** Release a claim when adapter creation or binding fails. */
  releaseRestoredHostedJobClaim(reference: string): void {
    try {
      this.restoredHostedClaims.delete(
        this.requireRecord(reference).attempt.identity,
      );
    } catch {
      // A disposed coordinator has already discarded the claim.
    }
  }

  /**
   * Attach an in-memory manager record to this exact workflow identity. This
   * method never launches a workflow or changes the durable process link.
   */
  bindRestoredHostedJob(
    reference: string,
    job: DelegateJobSnapshot,
  ): DelegateWorkflowAttemptSnapshot {
    const record = this.requireRecord(reference);
    if (this.importedRecordIdentities.has(record.attempt.identity))
      throw new Error('Imported workflow attempts cannot be restored locally.');
    if (job.attemptIdentity !== record.attempt.identity)
      throw new Error(
        `Restored delegate job ${job.id} is not linked to workflow attempt ${record.attempt.identity}.`,
      );
    if (this.jobs.getOwnerBranchId(job.id) !== record.ownerBranchId)
      throw new Error(
        `Restored delegate job ${job.id} is not owned by workflow branch ${record.ownerBranchId ?? 'the local branch'}.`,
      );
    if (record.jobId !== undefined) {
      if (record.jobId !== job.id)
        throw new Error(
          `Workflow attempt ${record.attempt.identity} is already bound to delegate job ${record.jobId}.`,
        );
      this.restoredHostedClaims.delete(record.attempt.identity);
      return this.snapshotRecord(record);
    }
    if (record.state !== 'queued' && record.state !== 'running')
      throw new Error(
        `Only queued or running workflow attempts can be restored (${record.attempt.identity} is ${record.state}).`,
      );
    record.jobId = job.id;
    this.restoredHostedClaims.delete(record.attempt.identity);
    if (job.state === 'running' && record.state === 'queued') {
      record.startedAt ??= job.startedAt ?? this.now();
      this.transition(record, 'running');
    }
    this.changed();
    return this.snapshotRecord(record);
  }

  /** Short name for adapters that call the manager record an observation. */
  bindRestoredObservation(
    reference: string,
    job: DelegateJobSnapshot,
  ): DelegateWorkflowAttemptSnapshot {
    return this.bindRestoredHostedJob(reference, job);
  }

  /**
   * Deliver the observation's terminal result through the canonical reducer.
   * The job identity and exact workflow identity are checked before the
   * reducer is called, and duplicate notifications are ignored.
   */
  acceptRestoredHostedTerminal(
    reference: string,
    job: DelegateJobSnapshot,
    result: DelegateJobResult,
  ): void {
    const record = this.requireRecord(reference);
    // A stale callback must never bind a new job or replace terminal evidence.
    // Binding is synchronous after observeExisting returns, so a callback with
    // no matching bound identity belongs to a failed/orphaned observation.
    if (isTerminalWorkflowAttemptState(record.state) || record.jobId !== job.id)
      return;
    const key = `${record.attempt.identity}:${job.id}`;
    if (this.restoredTerminalObservations.has(key)) return;
    this.restoredTerminalObservations.add(key);
    this.handleTerminal(record, result, job);
  }

  /** Settle a synchronous restore validation failure without launching anything. */
  settleRestoredFailure(
    reference: string,
    state: 'blocked' | 'error',
    reason: string,
  ): DelegateWorkflowAttemptSnapshot {
    const record = this.requireRecord(reference);
    if (this.importedRecordIdentities.has(record.attempt.identity))
      throw new Error('Imported workflow attempts cannot be settled locally.');
    if (!isTerminalWorkflowAttemptState(record.state))
      this.settle(record, state, boundedReason(reason));
    return this.snapshotRecord(record);
  }

  snapshot(): DelegateWorkflowSnapshot {
    return Object.freeze({ attempts: Object.freeze(this.list()) });
  }

  /** Return a detached bounded terminal projection; child execution data is omitted. */
  getResult(reference: string): DelegateWorkflowResultProjection | undefined {
    try {
      const result = this.results.get(this.model.lookup(reference).identity);
      return result ? publicResultFromCompact(result) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Return the minimal run projection used to refresh terminal status. */
  getTerminalRun(reference: string): DelegatedRun | undefined {
    try {
      const result = this.results.get(this.model.lookup(reference).identity);
      const run = result?.runs[0];
      return run ? publicRunFromCompact(run) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Internal compact evidence source for symbolic workflow resolution. */
  getResultEvidence(
    reference: string,
  ): DelegateWorkflowResultRecord | undefined {
    try {
      return this.results.get(this.model.lookup(reference).identity);
    } catch {
      return undefined;
    }
  }

  /**
   * Import attempts owned by an ancestor runtime. Records are intentionally
   * shared, so a still-running ancestor job settles dependent workflows in
   * every descendant projection without creating a second job or cancelling
   * the owner runtime.
   */
  importFrom(source: DelegateWorkflowCoordinator): () => void {
    if (source === this) return () => {};
    if (source.ownerBranchId === undefined)
      throw new Error(
        'Cannot import a workflow runtime without branch ownership.',
      );
    this.importSourceRecords(source);
    if (this.importedSources.has(source))
      return this.importedSourceDetachers.get(source) ?? (() => {});
    this.importedSources.add(source);
    const detach = source.subscribeChanges(() =>
      this.reconcileImportedDependants(),
    );
    this.importedSourceDetachers.set(source, detach);
    return detach;
  }

  /** Restore metadata that remains after an owner runtime was not cached. */
  restoreMetadata(
    state: DelegateWorkflowMetadataHistory,
    ownerBranchId?: string,
  ): void {
    const attempts = [...state.attempts].sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.attempt - right.attempt,
    );
    for (const metadata of attempts) {
      if (this.records.size >= this.maxAttempts) break;
      const currentOwner = this.ownerBranchId ?? ownerBranchId;
      if (!isBranchOwnerId(currentOwner)) continue;
      // Explicit owners are authoritative. Only legacy ownerless records bind
      // to the supplied/current owner; a sibling's same public identity must
      // remain unavailable to this coordinator and its restore adapters.
      const owner = metadata.ownerBranchId ?? currentOwner;
      if (owner !== currentOwner) continue;
      const attempt = Object.freeze({
        logicalId: metadata.logicalId,
        ordinal: metadata.attempt,
        identity: metadata.identity,
      });
      try {
        this.model.importAttempt(attempt);
      } catch {
        continue;
      }
      if (this.records.has(attempt.identity)) continue;
      const linked =
        metadata.sessionId !== undefined || metadata.processJobId !== undefined;
      const validLink = validProcessLink(
        metadata.sessionId,
        metadata.processJobId,
      );
      const orphaned =
        !isTerminalWorkflowAttemptState(metadata.state) &&
        (!validLink || !linked);
      const settledAt = orphaned
        ? Math.max(
            this.now(),
            metadata.createdAt,
            metadata.scheduledAt,
            metadata.queuedAt ?? 0,
            metadata.startedAt ?? 0,
            metadata.settledAt ?? 0,
          )
        : metadata.settledAt;
      const record: WorkflowRecord = {
        attempt,
        ownerBranchId: owner,
        dependencies: Object.freeze([...metadata.dependencies]),
        state: orphaned ? 'blocked' : metadata.state,
        createdAt: metadata.createdAt,
        scheduledAt: metadata.scheduledAt,
        queuedAt: metadata.queuedAt,
        startedAt: metadata.startedAt,
        settledAt,
        route: metadata.route,
        allowWrites: metadata.allowWrites,
        jobId: undefined,
        processJobId: validLink ? metadata.processJobId : undefined,
        reason: orphaned ? WORKFLOW_RELOAD_ORPHAN_REASON : metadata.reason,
        launched: true,
        cancellationRequested: false,
        cancellationWaiters: [],
        selectors: Object.freeze(
          (metadata.inputs ?? []).map((input) =>
            Object.freeze({
              selector: Object.freeze({
                node: input.node,
                ...(input.include
                  ? { include: Object.freeze([...input.include]) }
                  : {}),
                ...(input.label === undefined ? {} : { label: input.label }),
              }),
              identity: input.identity,
            }),
          ),
        ),
        inputMetadata: Object.freeze(
          (metadata.inputs ?? []).map((input) =>
            Object.freeze({
              ...input,
              ...(input.include
                ? { include: Object.freeze([...input.include]) }
                : {}),
            }),
          ),
        ),
      };
      this.rememberChildSession(record, metadata.sessionId);
      if (orphaned) {
        record.result = compactResult(
          setupFailureResult(record, WORKFLOW_RELOAD_ORPHAN_REASON),
        );
        this.results.set(attempt.identity, record.result);
      }
      this.records.set(attempt.identity, record);
    }
    this.reconcileImportedDependants();
  }

  private importSourceRecords(source: DelegateWorkflowCoordinator): void {
    const records = [...source.records.values()]
      .filter((record) => record.ownerBranchId === source.ownerBranchId)
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.attempt.logicalId.localeCompare(right.attempt.logicalId) ||
          left.attempt.ordinal - right.attempt.ordinal,
      );
    for (const record of records) {
      if (this.importedRecordIdentities.has(record.attempt.identity)) continue;
      try {
        this.importRecord(record, source.results.get(record.attempt.identity));
      } catch {
        // A conflicting identity or exhausted admission slot stays hidden.
      }
    }
  }

  private importRecord(
    record: WorkflowRecord,
    result: DelegateWorkflowResultRecord | undefined,
  ): void {
    const existing = this.records.get(record.attempt.identity);
    if (existing && existing !== record) {
      if (existing.ownerBranchId !== record.ownerBranchId)
        throw new Error(
          `Conflicting workflow owner for ${record.attempt.identity}.`,
        );
      return;
    }
    if (!existing) {
      if (this.records.size >= this.maxAttempts)
        throw new Error(
          `Delegate workflow attempt limit of ${this.maxAttempts} has been reached while importing an ancestor.`,
        );
      try {
        this.model.importAttempt(record.attempt);
      } catch (error) {
        // A local attempt with the same public identity is only valid when it
        // is the same owner record. Never silently merge sibling attempts.
        if (
          !this.model
            .snapshot()
            .attempts.some(
              (attempt) => attempt.identity === record.attempt.identity,
            )
        )
          throw error;
      }
      this.records.set(record.attempt.identity, record);
      this.importedRecordIdentities.add(record.attempt.identity);
    }
    if (result) this.results.set(record.attempt.identity, result);
  }

  private reconcileImportedDependants(): void {
    for (const source of this.importedSources) {
      this.importSourceRecords(source);
      for (const record of source.records.values()) {
        if (
          record.ownerBranchId !== source.ownerBranchId ||
          !this.importedRecordIdentities.has(record.attempt.identity) ||
          this.records.get(record.attempt.identity) !== record
        )
          continue;
        const result = source.results.get(record.attempt.identity);
        if (result) this.results.set(record.attempt.identity, result);
      }
    }
    for (const dependent of this.records.values()) {
      if (
        dependent.state === 'scheduled' &&
        this.dependenciesReady(dependent.dependencies)
      )
        this.launch(dependent);
    }
    this.onChange?.();
  }

  /**
   * Resolve already-bound symbolic sources for another coordinator. Callers
   * should use only the explicit selectors appropriate for their surface; the
   * returned values are bounded by workflow-inputs and are never snapshots.
   */
  resolveBoundWorkflowInputs(
    selectors: readonly BoundWorkflowSelector[],
  ): ResolvedWorkflowInputs {
    return resolveWorkflowInputs(selectors, (identity) =>
      this.sourceFor(identity),
    );
  }

  /** Cancel scheduled attempts locally, or delegate active cancellation to jobs. */
  async cancel(
    references: string | readonly string[],
    waitForPreparation = true,
    detachHosted = false,
  ): Promise<DelegateWorkflowAttemptSnapshot[]> {
    const requested =
      typeof references === 'string' ? [references] : references;
    const records: WorkflowRecord[] = [];
    const seen = new Set<AttemptIdentity>();
    for (const reference of requested) {
      const record = this.requireRecord(reference);
      if (seen.has(record.attempt.identity)) continue;
      seen.add(record.attempt.identity);
      records.push(record);
    }

    const localRecords = records.filter(
      (record) => !this.importedRecordIdentities.has(record.attempt.identity),
    );

    // Mark the complete request before settling one scheduled record. That
    // prevents an upstream barrier release from launching a requested child.
    for (const record of localRecords) {
      if (!isTerminalWorkflowAttemptState(record.state)) {
        record.cancellationRequested = true;
        this.abortPreparation(
          record,
          new Error('Workflow preparation was cancelled.'),
        );
      }
    }

    const active = localRecords.filter(
      (record) => record.state === 'queued' || record.state === 'running',
    );
    const launching = active.filter((record) => record.jobId === undefined);
    const waitingForLaunch = launching.map((record) =>
      this.waitForCancellation(record),
    );
    for (const record of launching) {
      if (!this.pendingHostedLaunches.delete(record.attempt.identity)) continue;
      this.settle(record, 'cancelled', 'Cancelled before launch.');
    }
    const preparationWork = new Set<Promise<void>>();
    if (waitForPreparation)
      for (const record of localRecords) {
        if (record.preparationInFlight)
          preparationWork.add(record.preparationInFlight);
        if (record.preparationDiscardInFlight)
          preparationWork.add(record.preparationDiscardInFlight);
      }
    const preparing = [...preparationWork].map((work) =>
      this.waitForPreparationGrace(work),
    );
    for (const record of localRecords)
      if (record.state === 'scheduled')
        this.settle(record, 'cancelled', 'Cancelled before launch.');

    await Promise.all([
      ...active
        .filter((record) => record.jobId !== undefined)
        .map((record) =>
          detachHosted
            ? this.detachStartedJob(record)
            : this.cancelStartedJob(record),
        ),
      ...waitingForLaunch,
      ...preparing,
      ...localRecords.map((record) => this.discardPrepared(record)),
    ]);
    return records.map((record) => this.snapshotRecord(record));
  }

  /** Mark a not-yet-launched attempt blocked and release its dependants. */
  block(reference: string, reason: string): DelegateWorkflowAttemptSnapshot {
    const record = this.requireRecord(reference);
    if (record.state !== 'scheduled')
      throw new Error(`Only scheduled workflow attempts can be blocked.`);
    if (this.importedRecordIdentities.has(record.attempt.identity))
      throw new Error('Imported workflow attempts cannot be blocked locally.');
    this.settle(record, 'blocked', boundedReason(reason));
    void this.discardPrepared(record);
    return this.snapshotRecord(record);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const identities = this.list()
      .filter((attempt) => !this.importedRecordIdentities.has(attempt.identity))
      .map((attempt) => attempt.identity);
    await this.cancel(identities, true, true);
    if (this.ownsJobs) await this.jobs.dispose();
    for (const detach of this.importedSourceDetachers.values()) detach();
    this.importedSourceDetachers.clear();
    this.importedSources.clear();
    this.records.clear();
    this.pendingHostedLaunches.clear();
    this.importedRecordIdentities.clear();
    this.restoredTerminalObservations.clear();
    this.restoredHostedClaims.clear();
    this.results.clear();
    this.changed();
  }

  private bindSelectors(
    selectors: readonly SymbolicWorkflowSelector[],
  ): readonly BoundWorkflowSelector[] {
    if (selectors.length > 4)
      throw new Error(
        'A workflow attempt may declare at most 4 symbolic selectors.',
      );
    const bound = selectors.map((selector) => {
      if (!selector || typeof selector !== 'object')
        throw new Error('Invalid symbolic workflow selector.');
      if (typeof selector.node !== 'string')
        throw new Error('Invalid symbolic workflow selector node.');
      if (selector.include !== undefined && !Array.isArray(selector.include))
        throw new Error('Invalid symbolic workflow selector include list.');
      const include = selector.include?.map((kind) => {
        if (
          kind !== 'report' &&
          kind !== 'handoff' &&
          kind !== 'branch' &&
          kind !== 'metadata'
        )
          throw new Error(
            `Invalid symbolic workflow input kind "${String(kind)}".`,
          );
        return kind;
      });
      if (selector.include && selector.include.length === 0)
        throw new Error('Symbolic workflow selector include cannot be empty.');
      if (include && new Set(include).size !== include.length)
        throw new Error(
          'Duplicate symbolic workflow input kinds are not allowed.',
        );
      if (
        selector.label !== undefined &&
        (typeof selector.label !== 'string' || selector.label.length > 120)
      )
        throw new Error(
          'Symbolic workflow selector label exceeds 120 characters.',
        );
      const label = selector.label?.trim();
      const attempt = this.model.bind(selector.node);
      if (!this.records.has(attempt.identity))
        throw new Error(
          `Unknown workflow attempt "${attempt.identity}" in coordinator.`,
        );
      return Object.freeze({
        selector: Object.freeze({
          node: selector.node,
          ...(include ? { include: Object.freeze(include) } : {}),
          ...(label ? { label } : {}),
        }),
        identity: attempt.identity,
      });
    });
    const identities = new Set<AttemptIdentity>();
    for (const selector of bound) {
      if (identities.has(selector.identity))
        throw new Error(
          `Duplicate symbolic workflow source "${selector.identity}". Combine its requested inputs in one selector.`,
        );
      identities.add(selector.identity);
    }
    return Object.freeze(bound);
  }

  private bindDependencies(
    plan: WorkflowModelPlan,
    references: readonly string[],
    selectors: readonly BoundWorkflowSelector[],
  ): AttemptIdentity[] {
    const dependencies: AttemptIdentity[] = [];
    if (plan.predecessor) {
      if (!this.records.has(plan.predecessor.identity))
        throw new Error(
          `Unknown workflow attempt "${plan.predecessor.identity}" in coordinator.`,
        );
      dependencies.push(plan.predecessor.identity);
    }
    const explicit = new Set<AttemptIdentity>();
    for (const reference of references) {
      const dependency = this.model.bind(reference);
      if (!this.records.has(dependency.identity))
        throw new Error(
          `Unknown workflow attempt "${dependency.identity}" in coordinator.`,
        );
      if (
        explicit.has(dependency.identity) ||
        dependencies.includes(dependency.identity)
      )
        throw new Error(
          `Duplicate workflow dependency "${dependency.identity}".`,
        );
      explicit.add(dependency.identity);
      dependencies.push(dependency.identity);
    }
    for (const selector of selectors)
      if (!dependencies.includes(selector.identity))
        dependencies.push(selector.identity);
    if (dependencies.length > MAX_WORKFLOW_DEPENDENCIES)
      throw new Error(
        `A workflow attempt may persist at most ${MAX_WORKFLOW_DEPENDENCIES} combined dependencies.`,
      );
    return dependencies;
  }

  private requireRecord(reference: string): WorkflowRecord {
    const attempt = this.model.lookup(reference);
    const record = this.records.get(attempt.identity);
    if (!record)
      throw new Error(`Unknown workflow attempt "${attempt.identity}".`);
    return record;
  }

  private launch(record: WorkflowRecord): void {
    if (record.launched || isTerminalWorkflowAttemptState(record.state)) return;
    record.launched = true;
    if (record.cancellationRequested) {
      this.settle(record, 'cancelled', 'Cancelled before launch.');
      return;
    }
    if (record.prepare) {
      record.reason = 'Preparing symbolic workflow inputs.';
      const controller = new AbortController();
      record.preparationController = controller;
      if (record.cancellationRequested || this.disposed)
        controller.abort(new Error('Workflow preparation was cancelled.'));
      this.changed();
      const work = this.prepareAndLaunch(record, controller.signal);
      record.preparationInFlight = work;
      // Do not use a bare finally here: its returned rejecting promise would
      // become an unhandled rejection when a factory fails late.
      void work.then(
        () => {
          if (record.preparationInFlight === work) {
            record.preparationInFlight = undefined;
            record.preparationController = undefined;
            if (isTerminalWorkflowAttemptState(record.state))
              record.prepare = undefined;
          }
        },
        () => {
          if (record.preparationInFlight === work) {
            record.preparationInFlight = undefined;
            record.preparationController = undefined;
            if (isTerminalWorkflowAttemptState(record.state))
              record.prepare = undefined;
          }
        },
      );
      return;
    }
    this.startJob(record, record.launch);
  }

  private async prepareAndLaunch(
    record: WorkflowRecord,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const predecessor = record.continuationPredecessor;
      const predecessorResult = predecessor
        ? this.results.get(predecessor)
        : undefined;
      const continuationToken = predecessor
        ? canonicalContinuationToken(
            predecessorResult,
            this.records.get(predecessor)?.sessionId,
          )
        : undefined;
      record.continuationToken = continuationToken;
      this.rememberChildSession(record, continuationToken);
      const resolved = resolveWorkflowInputs(record.selectors, (identity) =>
        this.sourceFor(identity),
      );
      if (
        signal.aborted ||
        record.cancellationRequested ||
        isTerminalWorkflowAttemptState(record.state)
      ) {
        await this.discardPrepared(record);
        return;
      }
      const prepare = record.prepare;
      if (!prepare) throw new Error('Missing workflow launch factory.');
      const prepared = await prepare({
        attempt: copyAttempt(record.attempt),
        dependencies: record.selectors,
        inputs: resolved.inputs,
        handoffText: resolved.handoffText,
        predecessor,
        continuationToken,
        signal,
        resolve: (identity) =>
          resolved.inputs.filter((input) => input.identity === identity),
      });
      const normalized = normalizePreparedLaunch(prepared);
      record.discard = normalized.discard;
      await this.releasePreparation(record);
      if (
        record.cancellationRequested ||
        isTerminalWorkflowAttemptState(record.state)
      ) {
        await this.discardPrepared(record);
        if (!isTerminalWorkflowAttemptState(record.state))
          this.settle(record, 'cancelled', 'Cancelled before launch.');
        return;
      }
      this.validatePreparedLaunch(normalized.launch);
      if (normalized.launch.route !== undefined)
        record.route = normalized.launch.route;
      this.startJob(record, normalized.launch);
    } catch (error) {
      const discard = this.discardPrepared(record);
      if (discard) await discard;
      if (isTerminalWorkflowAttemptState(record.state)) return;
      this.settle(
        record,
        error instanceof WorkflowInputBlockedError ? 'blocked' : 'error',
        boundedReason(error),
      );
    }
  }

  private discardPrepared(record: WorkflowRecord): Promise<void> | undefined {
    const work: Promise<void>[] = [];
    const discard = record.discard;
    if (discard && !record.preparationDiscarded) {
      record.preparationDiscarded = true;
      record.discard = undefined;
      work.push(this.runBoundedCleanup(discard, record));
    }
    if (record.preparationCleanup && !record.preparationCleanupDone) {
      const cleanup = record.preparationCleanup;
      record.preparationCleanupDone = true;
      record.preparationCleanup = undefined;
      work.push(this.runBoundedCleanup(cleanup, record));
    }
    if (!work.length) return undefined;
    const combined = Promise.all(work).then(() => undefined);
    record.preparationDiscardInFlight = combined;
    return combined.finally(() => {
      if (record.preparationDiscardInFlight === combined)
        record.preparationDiscardInFlight = undefined;
    });
  }

  private async releasePreparation(record: WorkflowRecord): Promise<void> {
    const cleanup = record.preparationCleanup;
    if (!cleanup || record.preparationCleanupDone) return;
    record.preparationCleanupDone = true;
    record.preparationCleanup = undefined;
    await this.runBoundedCleanup(cleanup, record);
  }

  private async runBoundedCleanup(
    cleanup: PreparationCleanup,
    record: WorkflowRecord,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = Promise.resolve()
      .then(cleanup)
      .catch((error) => {
        if (!record.reason) record.reason = boundedReason(error);
      });
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.preparationGraceMs);
    });
    await Promise.race([observed, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    // `observed` owns the rejection handler even if the grace period wins;
    // late cleanup is allowed to finish without leaking an unhandled rejection.
    void observed;
  }

  private waitForPreparationGrace(work: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = work.then(
      () => undefined,
      () => undefined,
    );
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.preparationGraceMs);
    });
    return Promise.race([observed, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  private abortPreparation(record: WorkflowRecord, reason: unknown): void {
    if (!record.preparationController) return;
    if (!record.preparationController.signal.aborted)
      record.preparationController.abort(reason);
  }

  private validatePreparedLaunch(
    value: unknown,
  ): asserts value is DelegateJobStartOptions {
    if (!value || typeof value !== 'object')
      throw new Error('Lazy workflow launch factory must return job options.');
    const launch = value as Partial<DelegateJobStartOptions>;
    if (launch.mode !== 'single' && launch.mode !== 'parallel')
      throw new Error('Lazy workflow launch factory returned an invalid mode.');
    if (
      !Array.isArray(launch.tasks) ||
      launch.tasks.some((task) => typeof task !== 'string')
    )
      throw new Error('Lazy workflow launch factory returned invalid tasks.');
    if (typeof launch.execute !== 'function')
      throw new Error(
        'Lazy workflow launch factory returned no execute function.',
      );
  }

  private startJob(
    record: WorkflowRecord,
    launch: DelegateJobStartOptions | undefined,
  ): void {
    if (this.disposed || record.cancellationRequested) {
      if (!isTerminalWorkflowAttemptState(record.state))
        this.settle(record, 'cancelled', 'Cancelled before launch.');
      return;
    }
    if (!launch) {
      this.settle(
        record,
        'error',
        'No static or lazy workflow launch options were supplied.',
      );
      return;
    }
    if (this.disposed || record.cancellationRequested) {
      this.settle(record, 'cancelled', 'Cancelled before launch.');
      return;
    }
    if (!validProcessLink(launch.sessionId, launch.processJobId)) {
      this.settle(
        record,
        'error',
        'Hosted process link requires a child session ID and canonical process job ID together.',
      );
      return;
    }
    const hosted =
      launch.sessionId !== undefined || launch.processJobId !== undefined;
    record.launch = launch;
    record.reason = undefined;
    if (record.state !== 'queued') {
      record.sessionId = launch.sessionId;
      record.processJobId = launch.processJobId;
      record.queuedAt = this.now();
      this.transition(record, 'queued');
    }
    try {
      // Persist the durable child/session link while still queued. The adapter
      // can execute synchronously from jobs.start, so this must precede it.
      this.changed();
      if (
        hosted &&
        this.hostedLinkPersistenceAcknowledgement &&
        !this.hostedLinkPersistenceAcknowledgement(record.attempt.identity)
      ) {
        this.pendingHostedLaunches.add(record.attempt.identity);
        return;
      }
      this.pendingHostedLaunches.delete(record.attempt.identity);
      // Lazy capacity is checked here, immediately before the adapter call.
      this.jobs.assertAccepting();
      const job = this.jobs.start({
        ...launch,
        ownerBranchId: record.ownerBranchId,
        workflowAttempt: record.attempt,
        onTerminal: (result, snapshot) =>
          this.handleTerminal(record, result, snapshot),
      });
      record.jobId = job.id;
      record.discard = undefined;
      // A cancellation can be requested by an adapter change hook while
      // start() is still assigning its opaque job identity. Abort this exact
      // job as soon as the identity is available.
      if (record.cancellationRequested) void this.cancelStartedJob(record);
      if (job.state === 'running') {
        record.startedAt = job.startedAt ?? this.now();
        this.transition(record, 'running');
      }
      this.changed();
    } catch (error) {
      this.settle(
        record,
        record.cancellationRequested ? 'cancelled' : 'error',
        record.cancellationRequested
          ? 'Cancelled before launch completed.'
          : `Launch failed: ${boundedReason(error)}`,
      );
    }
  }

  private sourceFor(identity: AttemptIdentity): WorkflowInputSource {
    const record = this.records.get(identity);
    if (!record)
      throw new WorkflowInputBlockedError(
        `Required symbolic source ${identity} is unavailable.`,
      );
    return {
      attempt: copyAttempt(record.attempt),
      state: record.state,
      settledAt: record.settledAt,
      startedAt: record.startedAt,
      route: record.route,
      jobId: record.jobId,
      result: this.results.get(identity),
    };
  }

  private dependenciesReady(dependencies: readonly AttemptIdentity[]): boolean {
    return dependencies.every((identity) => {
      const dependency = this.records.get(identity);
      return (
        dependency !== undefined &&
        isTerminalWorkflowAttemptState(dependency.state)
      );
    });
  }

  private waitForCancellation(record: WorkflowRecord): Promise<void> {
    if (isTerminalWorkflowAttemptState(record.state)) return Promise.resolve();
    return new Promise((resolve) => record.cancellationWaiters.push(resolve));
  }

  private detachStartedJob(record: WorkflowRecord): Promise<void> {
    if (record.cancellationInFlight) return record.cancellationInFlight;
    const jobId = record.jobId;
    if (!jobId) return this.waitForCancellation(record);
    const work = (async () => {
      try {
        await this.jobs.detach([jobId]);
      } finally {
        this.resolveCancellationWaiters(record);
      }
    })();
    record.cancellationInFlight = work;
    return work;
  }

  private cancelStartedJob(record: WorkflowRecord): Promise<void> {
    if (record.cancellationInFlight) return record.cancellationInFlight;
    const jobId = record.jobId;
    if (!jobId) return this.waitForCancellation(record);
    const work = (async () => {
      try {
        await this.jobs.cancel([jobId]);
        if (!isTerminalWorkflowAttemptState(record.state))
          this.settle(record, 'cancelled', 'Delegate job was cancelled.');
      } catch (error) {
        if (!isTerminalWorkflowAttemptState(record.state))
          this.settle(record, 'cancelled', boundedReason(error));
      } finally {
        this.resolveCancellationWaiters(record);
      }
    })();
    record.cancellationInFlight = work;
    return work;
  }

  private resolveCancellationWaiters(record: WorkflowRecord): void {
    const waiters = record.cancellationWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private handleTerminal(
    record: WorkflowRecord,
    result: DelegateJobResult,
    job: DelegateJobSnapshot,
  ): void {
    // Compact before publishing readiness. The full adapter result is used
    // only on this stack frame and is never assigned to a workflow record/map.
    const evidence = compactResult(result);
    record.result = evidence;
    this.results.set(record.attempt.identity, evidence);
    this.rememberChildSession(
      record,
      compactSessionId(evidence) ?? record.continuationToken,
    );
    if (isTerminalWorkflowAttemptState(record.state)) {
      this.pendingHostedLaunches.delete(record.attempt.identity);
      record.launch = undefined;
      // Drop lazy closures immediately. A late preparation still writes its
      // returned discard handle and calls discardPrepared exactly once.
      record.prepare = undefined;
      return;
    }

    let state: WorkflowAttemptState;
    if (record.cancellationRequested) state = 'cancelled';
    else if (
      job.state === 'error' &&
      result.runs.length > 0 &&
      result.runs.every((run) => run.state === 'timed-out')
    )
      state = 'timed-out';
    else if (job.state === 'success') state = 'success';
    else if (job.state === 'aborted') state = 'aborted';
    else state = 'error';
    const runReason = result.runs.find((run) => run.errorMessage)?.errorMessage;
    const reason =
      job.error ??
      runReason ??
      (state === 'error' ? 'Delegate job settled with an error.' : undefined);
    this.settle(record, state, reason);
  }

  private settle(
    record: WorkflowRecord,
    state: WorkflowAttemptState,
    reason?: string,
  ): void {
    if (isTerminalWorkflowAttemptState(record.state)) return;
    this.pendingHostedLaunches.delete(record.attempt.identity);
    this.transition(record, state);
    record.settledAt = this.now();
    if (reason) record.reason = boundedReason(reason);
    this.resolveCancellationWaiters(record);
    if (!record.result) {
      const evidence =
        state === 'error' || state === 'blocked'
          ? compactResult(
              setupFailureResult(
                record,
                record.reason ?? `Workflow attempt ${state}.`,
              ),
            )
          : emptyResult(record.reason ?? `Workflow attempt ${state}.`);
      record.result = evidence;
      this.results.set(record.attempt.identity, evidence);
    }
    this.rememberChildSession(
      record,
      compactSessionId(record.result) ?? record.continuationToken,
    );
    // The launch adapter can close over child sessions and execution state.
    // Once terminal evidence exists, drop it rather than keeping that graph
    // alive alongside the compact canonical record.
    record.launch = undefined;
    // Terminal records must not retain the lazy factory while an abortable
    // preparation settles in the background.
    record.prepare = undefined;
    this.changed();
    const settledSnapshot = this.snapshotRecord(record);
    for (const listener of this.terminalListeners) {
      try {
        listener(settledSnapshot);
      } catch {
        // Observers must not be able to prevent dependent workflows releasing.
      }
    }
    for (const dependent of this.records.values()) {
      if (
        dependent.state === 'scheduled' &&
        dependent.dependencies.includes(record.attempt.identity) &&
        this.dependenciesReady(dependent.dependencies)
      )
        this.launch(dependent);
    }
  }

  private transition(
    record: WorkflowRecord,
    state: WorkflowAttemptState,
  ): void {
    assertWorkflowAttemptTransition(record.state, state);
    record.state = state;
  }

  private rememberChildSession(
    record: WorkflowRecord,
    sessionId: string | undefined,
  ): void {
    const next = boundedSessionId(sessionId);
    if (next) record.sessionId = next;
  }

  private snapshotRecord(
    record: WorkflowRecord,
  ): DelegateWorkflowAttemptSnapshot {
    const attempt = copyAttempt(record.attempt);
    return Object.freeze({
      attempt,
      ...(record.ownerBranchId ? { ownerBranchId: record.ownerBranchId } : {}),
      logicalId: attempt.logicalId,
      ordinal: attempt.ordinal,
      identity: attempt.identity,
      dependencies: Object.freeze([...record.dependencies]),
      waitingFor: Object.freeze(
        record.dependencies.filter((identity) => {
          const dependency = this.records.get(identity);
          return (
            !dependency || !isTerminalWorkflowAttemptState(dependency.state)
          );
        }),
      ),
      inputs: Object.freeze(
        record.selectors.map((selector) =>
          Object.freeze({
            selector: Object.freeze({
              ...selector.selector,
              ...(selector.selector.include
                ? { include: Object.freeze([...selector.selector.include]) }
                : {}),
            }),
            identity: selector.identity,
          }),
        ),
      ),
      state: record.state,
      createdAt: record.createdAt,
      scheduledAt: record.scheduledAt,
      queuedAt: record.queuedAt,
      startedAt: record.startedAt,
      settledAt: record.settledAt,
      route: record.route,
      allowWrites: record.allowWrites,
      jobId: record.jobId,
      processJobId: record.processJobId,
      reason: record.reason,
    });
  }

  private changed(): void {
    this.onChange?.();
    for (const listener of this.changeListeners) listener();
  }
}

export function createDelegateWorkflowCoordinator(
  options: DelegateWorkflowCoordinatorOptions = {},
): DelegateWorkflowCoordinator {
  return new DelegateWorkflowCoordinator(options);
}
