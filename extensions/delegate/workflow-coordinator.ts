import {
  DelegateJobManager,
  type DelegateJobResult,
  type DelegateJobSnapshot,
  type DelegateJobStartOptions,
} from './jobs';
import { buildParentHandoff } from './output';
import {
  type BoundWorkflowSelector,
  type ResolvedWorkflowInput,
  type ResolvedWorkflowInputs,
  resolveWorkflowInputs,
  type SymbolicWorkflowSelector,
  WorkflowInputBlockedError,
  type WorkflowInputSource,
} from './workflow-inputs';
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
import { failedLifecycleRun } from './worktree-lifecycle';

const MAX_WORKFLOW_REASON_LENGTH = 256;

export interface DelegateWorkflowLaunchContext {
  readonly attempt: WorkflowAttempt;
  readonly dependencies: readonly BoundWorkflowSelector[];
  readonly inputs: readonly ResolvedWorkflowInput[];
  readonly handoffText: string;
  /** Resolve another bound source without exposing it in coordinator snapshots. */
  readonly resolve: (
    identity: AttemptIdentity,
  ) => readonly ResolvedWorkflowInput[];
}

export type DelegateWorkflowLaunchFactory = (
  context: DelegateWorkflowLaunchContext,
) => DelegateJobStartOptions | Promise<DelegateJobStartOptions>;

export interface DelegateWorkflowScheduleOptions
  extends Omit<
    DelegateJobStartOptions,
    'workflowAttempt' | 'onTerminal' | 'mode' | 'tasks' | 'execute'
  > {
  /** Logical identity of the new attempt. */
  logicalId: string;
  /** Continue the latest attempt in this lineage instead of creating @1. */
  continuation?: boolean;
  /** References to attempts that must settle before this attempt launches. */
  after?: readonly string[];
  /** Symbolic sources, each of which becomes an implicit dependency. */
  inputs?: readonly SymbolicWorkflowSelector[];
  /** Mutually exclusive lazy preparation for the actual job launch. */
  prepare?: DelegateWorkflowLaunchFactory;
  mode?: DelegateJobStartOptions['mode'];
  tasks?: string[];
  execute?: DelegateJobStartOptions['execute'];
}

export interface DelegateWorkflowAttemptSnapshot {
  readonly attempt: WorkflowAttempt;
  readonly logicalId: string;
  readonly ordinal: number;
  readonly identity: AttemptIdentity;
  readonly dependencies: readonly AttemptIdentity[];
  readonly inputs: readonly BoundWorkflowSelector[];
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

export type DelegateWorkflowTerminalListener = (
  attempt: DelegateWorkflowAttemptSnapshot,
) => void;

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
  selectors: readonly BoundWorkflowSelector[];
  prepare?: DelegateWorkflowLaunchFactory;
  preparationInFlight?: Promise<void>;
  launch?: DelegateJobStartOptions;
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
  if (options.inputs !== undefined && !Array.isArray(options.inputs))
    throw new Error('Invalid symbolic workflow inputs: expected an array.');
  if (options.prepare !== undefined && typeof options.prepare !== 'function')
    throw new Error('Invalid lazy workflow launch factory.');
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

function emptyResult(reason: string): DelegateJobResult {
  return { runs: [], handoff: reason };
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
  return { runs: [run], handoff: buildParentHandoff([run]) };
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
  private readonly terminalListeners =
    new Set<DelegateWorkflowTerminalListener>();
  private readonly records = new Map<AttemptIdentity, WorkflowRecord>();
  private readonly results = new Map<AttemptIdentity, DelegateJobResult>();
  private disposed = false;

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
    if (this.disposed)
      throw new Error('Delegate workflow coordinator is disposed.');
    validateScheduleInput(options);
    const plan = options.continuation
      ? this.model.planContinuation(options.logicalId)
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
      dependencies: Object.freeze([...dependencies]),
      state: 'scheduled',
      createdAt: timestamp,
      scheduledAt: timestamp,
      route: options.route,
      launched: false,
      cancellationRequested: false,
      cancellationWaiters: [],
      selectors,
      prepare: options.prepare,
      launch:
        options.prepare === undefined
          ? {
              name: options.name,
              ownerSessionId: options.ownerSessionId,
              mode: options.mode as DelegateJobStartOptions['mode'],
              tasks: [...(options.tasks ?? [])],
              execute: options.execute as DelegateJobStartOptions['execute'],
              materialize: options.materialize,
              deliveryEpoch: options.deliveryEpoch,
              route: options.route,
              allowWrites: options.allowWrites,
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
    if (this.disposed) return;
    this.disposed = true;
    const identities = this.list().map((attempt) => attempt.identity);
    await this.cancel(identities);
    if (this.ownsJobs) await this.jobs.dispose();
    this.records.clear();
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
      if (
        selector.include &&
        selector.include.length === 0 &&
        selector.view === undefined
      )
        throw new Error('Symbolic workflow selector include cannot be empty.');
      if (include && new Set(include).size !== include.length)
        throw new Error(
          'Duplicate symbolic workflow input kinds are not allowed.',
        );
      if (
        selector.view !== undefined &&
        (typeof selector.view !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(selector.view))
      )
        throw new Error(
          'Invalid or noncanonical symbolic workflow selector view.',
        );
      if (
        selector.label !== undefined &&
        (typeof selector.label !== 'string' || selector.label.length > 120)
      )
        throw new Error(
          'Symbolic workflow selector label exceeds 120 characters.',
        );
      const attempt = this.model.bind(selector.node);
      if (!this.records.has(attempt.identity))
        throw new Error(
          `Unknown workflow attempt "${attempt.identity}" in coordinator.`,
        );
      return Object.freeze({
        selector: Object.freeze({
          node: selector.node,
          ...(include ? { include: Object.freeze(include) } : {}),
          ...(selector.view !== undefined ? { view: selector.view } : {}),
          ...(selector.label !== undefined ? { label: selector.label } : {}),
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
      this.changed();
      const work = this.prepareAndLaunch(record);
      record.preparationInFlight = work;
      void work.finally(() => {
        if (record.preparationInFlight === work)
          record.preparationInFlight = undefined;
      });
      return;
    }
    this.startJob(record, record.launch);
  }

  private async prepareAndLaunch(record: WorkflowRecord): Promise<void> {
    try {
      const resolved = resolveWorkflowInputs(record.selectors, (identity) =>
        this.sourceFor(identity),
      );
      if (
        record.cancellationRequested ||
        isTerminalWorkflowAttemptState(record.state)
      )
        return;
      const prepare = record.prepare;
      if (!prepare) throw new Error('Missing workflow launch factory.');
      const launch = await prepare({
        attempt: copyAttempt(record.attempt),
        dependencies: record.selectors,
        inputs: resolved.inputs,
        handoffText: resolved.handoffText,
        resolve: (identity) =>
          resolved.inputs.filter((input) => input.identity === identity),
      });
      if (
        record.cancellationRequested ||
        isTerminalWorkflowAttemptState(record.state)
      )
        return;
      this.validatePreparedLaunch(launch);
      if (launch.route !== undefined) record.route = launch.route;
      this.startJob(record, launch);
    } catch (error) {
      if (isTerminalWorkflowAttemptState(record.state)) return;
      this.settle(
        record,
        error instanceof WorkflowInputBlockedError ? 'blocked' : 'error',
        boundedReason(error),
      );
    }
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
    if (!launch) {
      this.settle(
        record,
        'error',
        'No static or lazy workflow launch options were supplied.',
      );
      return;
    }
    if (record.cancellationRequested) {
      this.settle(record, 'cancelled', 'Cancelled before launch.');
      return;
    }
    record.reason = undefined;
    record.queuedAt = this.now();
    this.transition(record, 'queued');
    try {
      // Lazy capacity is checked here, immediately before the adapter call.
      this.jobs.assertAccepting();
      const job = this.jobs.start({
        ...launch,
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
      const result =
        state === 'error' || state === 'blocked'
          ? setupFailureResult(
              record,
              record.reason ?? `Workflow attempt ${state}.`,
            )
          : emptyResult(record.reason ?? `Workflow attempt ${state}.`);
      record.result = result;
      this.results.set(record.attempt.identity, result);
    }
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
