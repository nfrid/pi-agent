import {
  DelegateJobManager,
  type DelegateJobResult,
  type DelegateJobSnapshot,
  type DelegateJobStartOptions,
} from './jobs';
import {
  type AttemptIdentity,
  assertWorkflowAttemptTransition,
  createWorkflowModel,
  isTerminalWorkflowAttemptState,
  type WorkflowAttempt,
  type WorkflowAttemptState,
  type WorkflowModel,
  type WorkflowModelPlan,
} from './workflow-model';

const MAX_WORKFLOW_REASON_LENGTH = 256;

export interface DelegateWorkflowScheduleOptions
  extends Omit<DelegateJobStartOptions, 'workflowAttempt' | 'onTerminal'> {
  /** Logical identity of the new attempt. */
  logicalId: string;
  /** Continue the latest attempt in this lineage instead of creating @1. */
  continuation?: boolean;
  /** References to attempts that must settle before this attempt launches. */
  after?: readonly string[];
}

export interface DelegateWorkflowAttemptSnapshot {
  readonly attempt: WorkflowAttempt;
  readonly logicalId: string;
  readonly ordinal: number;
  readonly identity: AttemptIdentity;
  readonly dependencies: readonly AttemptIdentity[];
  readonly state: WorkflowAttemptState;
  readonly createdAt: number;
  readonly scheduledAt: number;
  readonly queuedAt?: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
  readonly route?: string;
  /** Internal adapter job identity, once the attempt has launched. */
  readonly jobId?: string;
  /** Concise actionable setup, launch, or settlement reason. */
  readonly reason?: string;
}

export interface DelegateWorkflowSnapshot {
  readonly attempts: readonly DelegateWorkflowAttemptSnapshot[];
}

export interface DelegateWorkflowCoordinatorOptions {
  /** Existing execution adapter. */
  jobs?: DelegateJobManager;
  /** Alias for jobs, useful at integration boundaries. */
  jobManager?: DelegateJobManager;
  model?: WorkflowModel;
  now?: () => number;
  onChange?: () => void;
}

interface WorkflowRecord {
  attempt: WorkflowAttempt;
  dependencies: readonly AttemptIdentity[];
  state: WorkflowAttemptState;
  createdAt: number;
  scheduledAt: number;
  queuedAt?: number;
  startedAt?: number;
  settledAt?: number;
  route?: string;
  jobId?: string;
  reason?: string;
  launched: boolean;
  cancellationRequested: boolean;
  cancellationWaiters: Array<() => void>;
  cancellationInFlight?: Promise<void>;
  result?: DelegateJobResult;
  launch: DelegateJobStartOptions;
}

function boundedReason(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  const normalized = text.trim() || 'Delegate workflow attempt failed.';
  return normalized.length > MAX_WORKFLOW_REASON_LENGTH
    ? `${normalized.slice(0, MAX_WORKFLOW_REASON_LENGTH - 1)}…`
    : normalized;
}

function validateScheduleInput(options: DelegateWorkflowScheduleOptions): void {
  if (typeof options.logicalId !== 'string')
    throw new Error('Invalid workflow logical ID: expected a string.');
  if (
    options.continuation !== undefined &&
    typeof options.continuation !== 'boolean'
  )
    throw new Error('Invalid workflow continuation flag.');
  if (options.after !== undefined && !Array.isArray(options.after))
    throw new Error('Invalid workflow dependencies: expected an array.');
  if (options.after?.some((reference) => typeof reference !== 'string'))
    throw new Error(
      'Invalid workflow dependency: expected a string reference.',
    );
  if (options.mode !== 'single' && options.mode !== 'parallel')
    throw new Error('Invalid delegate mode.');
  if (
    !Array.isArray(options.tasks) ||
    options.tasks.some((task) => typeof task !== 'string')
  )
    throw new Error('Invalid delegate tasks: expected an array of strings.');
  if (typeof options.execute !== 'function')
    throw new Error('Invalid delegate launch: execute must be a function.');
  if (options.route !== undefined && typeof options.route !== 'string')
    throw new Error('Invalid delegate route.');
}

function copyAttempt(attempt: WorkflowAttempt): WorkflowAttempt {
  return Object.freeze({ ...attempt });
}

function emptyResult(reason: string): DelegateJobResult {
  return { runs: [], handoff: reason };
}

/**
 * Owns workflow identity, dependency barriers, and attempt lifecycle. Jobs are
 * intentionally only an execution adapter; exact results live here and are not
 * subject to the adapter's bounded public snapshot retention.
 */
export class DelegateWorkflowCoordinator {
  readonly model: WorkflowModel;
  private readonly jobs: DelegateJobManager;
  private readonly ownsJobs: boolean;
  private readonly now: () => number;
  private readonly onChange?: () => void;
  private readonly records = new Map<AttemptIdentity, WorkflowRecord>();
  private readonly results = new Map<AttemptIdentity, DelegateJobResult>();

  constructor(options: DelegateWorkflowCoordinatorOptions = {}) {
    this.model = options.model ?? createWorkflowModel();
    this.jobs = options.jobs ?? options.jobManager ?? new DelegateJobManager();
    this.ownsJobs =
      options.jobs === undefined && options.jobManager === undefined;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
  }

  /** Validate and bind one complete schedule before changing model identity. */
  schedule(
    options: DelegateWorkflowScheduleOptions,
  ): DelegateWorkflowAttemptSnapshot {
    validateScheduleInput(options);
    const plan = options.continuation
      ? this.model.planContinuation(options.logicalId)
      : this.model.planFresh(options.logicalId);
    const dependencies = this.bindDependencies(plan, options.after ?? []);

    // This is the adapter's only preflight. No model or coordinator identity
    // has been committed before every reference and launch input is checked.
    if (this.dependenciesReady(dependencies)) this.jobs.assertAccepting();

    const timestamp = this.now();
    const record: WorkflowRecord = {
      attempt: copyAttempt(plan.attempt),
      dependencies: Object.freeze([...dependencies]),
      state: 'scheduled',
      createdAt: timestamp,
      scheduledAt: timestamp,
      route: options.route,
      launched: false,
      cancellationRequested: false,
      cancellationWaiters: [],
      launch: {
        name: options.name,
        ownerSessionId: options.ownerSessionId,
        mode: options.mode,
        tasks: [...options.tasks],
        execute: options.execute,
        materialize: options.materialize,
        deliveryEpoch: options.deliveryEpoch,
        route: options.route,
        allowWrites: options.allowWrites,
        feedback: options.feedback,
      },
    };

    // The plan was fully validated and is now the single identity mutation.
    this.model.commit(plan);
    this.records.set(record.attempt.identity, record);
    this.changed();

    if (this.dependenciesReady(record.dependencies)) this.launch(record);
    return this.snapshotRecord(record);
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

  list(): DelegateWorkflowAttemptSnapshot[] {
    return this.model
      .snapshot()
      .attempts.map((attempt) => this.records.get(attempt.identity))
      .filter((record): record is WorkflowRecord => record !== undefined)
      .map((record) => this.snapshotRecord(record));
  }

  snapshot(): DelegateWorkflowSnapshot {
    return Object.freeze({ attempts: Object.freeze(this.list()) });
  }

  /** Return the exact unbounded result retained for symbolic child piping. */
  getResult(reference: string): DelegateJobResult | undefined {
    try {
      return this.results.get(this.model.lookup(reference).identity);
    } catch {
      return undefined;
    }
  }

  /** Cancel scheduled attempts locally, or delegate active cancellation to jobs. */
  async cancel(
    references: string | readonly string[],
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

    // Mark the complete request before settling one scheduled record. That
    // prevents an upstream barrier release from launching a requested child.
    for (const record of records)
      if (!isTerminalWorkflowAttemptState(record.state))
        record.cancellationRequested = true;

    const active = records.filter(
      (record) => record.state === 'queued' || record.state === 'running',
    );
    const launching = active.filter((record) => record.jobId === undefined);
    const waitingForLaunch = launching.map((record) =>
      this.waitForCancellation(record),
    );
    for (const record of records)
      if (record.state === 'scheduled')
        this.settle(record, 'cancelled', 'Cancelled before launch.');

    await Promise.all([
      ...active
        .filter((record) => record.jobId !== undefined)
        .map((record) => this.cancelStartedJob(record)),
      ...waitingForLaunch,
    ]);
    return records.map((record) => this.snapshotRecord(record));
  }

  /** Mark a not-yet-launched attempt blocked and release its dependants. */
  block(reference: string, reason: string): DelegateWorkflowAttemptSnapshot {
    const record = this.requireRecord(reference);
    if (record.state !== 'scheduled')
      throw new Error(`Only scheduled workflow attempts can be blocked.`);
    this.settle(record, 'blocked', boundedReason(reason));
    return this.snapshotRecord(record);
  }

  async dispose(): Promise<void> {
    if (this.ownsJobs) await this.jobs.dispose();
    this.records.clear();
    this.changed();
  }

  private bindDependencies(
    plan: WorkflowModelPlan,
    references: readonly string[],
  ): AttemptIdentity[] {
    const dependencies: AttemptIdentity[] = [];
    if (plan.predecessor) {
      if (!this.records.has(plan.predecessor.identity))
        throw new Error(
          `Unknown workflow attempt "${plan.predecessor.identity}" in coordinator.`,
        );
      dependencies.push(plan.predecessor.identity);
    }
    for (const reference of references) {
      const dependency = this.model.bind(reference);
      if (!this.records.has(dependency.identity))
        throw new Error(
          `Unknown workflow attempt "${dependency.identity}" in coordinator.`,
        );
      if (
        dependency.identity === plan.attempt.identity ||
        dependencies.includes(dependency.identity)
      )
        throw new Error(
          `Duplicate workflow dependency "${dependency.identity}".`,
        );
      dependencies.push(dependency.identity);
    }
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
    record.queuedAt = this.now();
    this.transition(record, 'queued');
    try {
      const job = this.jobs.start({
        ...record.launch,
        workflowAttempt: record.attempt,
        onTerminal: (result, snapshot) =>
          this.handleTerminal(record, result, snapshot),
      });
      record.jobId = job.id;
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
    record.result = result;
    this.results.set(record.attempt.identity, result);
    if (isTerminalWorkflowAttemptState(record.state)) return;

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
    this.transition(record, state);
    record.settledAt = this.now();
    if (reason) record.reason = boundedReason(reason);
    this.resolveCancellationWaiters(record);
    if (!record.result) {
      const result = emptyResult(record.reason ?? `Workflow attempt ${state}.`);
      record.result = result;
      this.results.set(record.attempt.identity, result);
    }
    this.changed();
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

  private snapshotRecord(
    record: WorkflowRecord,
  ): DelegateWorkflowAttemptSnapshot {
    const attempt = copyAttempt(record.attempt);
    return Object.freeze({
      attempt,
      logicalId: attempt.logicalId,
      ordinal: attempt.ordinal,
      identity: attempt.identity,
      dependencies: Object.freeze([...record.dependencies]),
      state: record.state,
      createdAt: record.createdAt,
      scheduledAt: record.scheduledAt,
      queuedAt: record.queuedAt,
      startedAt: record.startedAt,
      settledAt: record.settledAt,
      route: record.route,
      jobId: record.jobId,
      reason: record.reason,
    });
  }

  private changed(): void {
    this.onChange?.();
  }
}

export function createDelegateWorkflowCoordinator(
  options: DelegateWorkflowCoordinatorOptions = {},
): DelegateWorkflowCoordinator {
  return new DelegateWorkflowCoordinator(options);
}
