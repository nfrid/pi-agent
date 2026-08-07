import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@pi-dashboard/domain';
import type {
  CommandReceipt,
  Project,
  Run,
  RuntimeSnapshot,
  Thread,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import {
  createWorktreeCreator,
  createWorktreeFinisher,
  createWorktreeIntegrator,
  gitText,
  repositoryIdentity,
  repositoryRoot,
  type WorktreeRecord,
  type WorktreeStore,
} from '@pi-dashboard/worktree-manager';
import type {
  CreateThreadWithRunInput,
  OrchestrationRepository,
} from '../repositories/types.js';
import type { RuntimeManager } from '../runtime-manager.js';
import type { RegistryChange, RuntimeRegistry } from '../runtime-registry.js';

export interface OrchestrationServiceOptions {
  repository: OrchestrationRepository;
  manager: RuntimeManager;
  registry: RuntimeRegistry;
  /** Discovery only: durable projects never store a WorkspaceTarget. */
  workspaces: () => readonly WorkspaceTarget[];
  onChange?: () => void;
  pollMs?: number;
  /** How long startup waits for a restored provider runtime to say hello. */
  reconnectGraceMs?: number;
  /** Test seam for deterministically racing cancellation with worktree setup. */
  beforeWorktreePreparation?: () => Promise<void>;
  /** Test seam for deterministically racing goodbye with worktree settlement. */
  beforeWorktreeFinish?: () => Promise<void>;
}

export interface CreateProjectCommand {
  commandId: string;
  title?: string;
  rootPath?: string;
  workspaceId?: string;
  defaultBaseBranch?: string;
  defaultModel?: Project['defaultModel'];
  defaultIsolation?: Project['defaultIsolation'];
  maxParallelRuns?: number;
}

export interface CreateThreadCommand {
  commandId: string;
  title: string;
  prompt: string;
  checkoutId?: string;
  isolation?: 'worktree' | 'main';
  mode?: 'read' | 'write';
  model?: Run['model'];
  runtimeProvider?: Run['runtimeProvider'];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedErrorText(error: unknown): string {
  const text = errorText(error);
  return text.length <= 2_000 ? text : `${text.slice(0, 1_999)}…`;
}

function idempotencyConflict(
  id: string,
  owner: string,
): Error & { code: string } {
  return Object.assign(
    new Error(`Idempotency key ${id} belongs to ${owner}.`),
    { code: 'idempotency-conflict' },
  );
}

function commandReceipt(
  id: string,
  type: string,
  result: unknown,
): CommandReceipt {
  return {
    idempotencyKey: id,
    commandType: type,
    result,
    createdAt: Date.now(),
  };
}

/**
 * Durable project/thread/run application boundary and its deliberately small
 * worker. Runtime launch happens after the queued run commits; the durable
 * initial prompt is acknowledged and recorded only after the runtime says hello.
 */
export class OrchestrationService {
  private readonly repository: OrchestrationRepository;
  private readonly manager: RuntimeManager;
  private readonly registry: RuntimeRegistry;
  private readonly workspaces: () => readonly WorkspaceTarget[];
  private readonly onChange?: () => void;
  private readonly pollMs: number;
  private readonly reconnectGraceMs: number;
  private readonly beforeWorktreePreparation?: () => Promise<void>;
  private readonly beforeWorktreeFinish?: () => Promise<void>;
  private readonly inFlight = new Set<string>();
  /** Execution remains observable while preparation or manager.launch is pending. */
  private readonly executionTasks = new Map<string, Promise<void>>();
  /** Fresh WIP branches are discarded on cancellation, unlike resumable records. */
  private readonly freshWorktreeRuns = new Set<string>();
  private readonly registryTasks = new Set<Promise<void>>();
  /** Registry callbacks for one durable run are reduced in bridge arrival order. */
  private readonly registryRunQueues = new Map<string, Promise<void>>();
  /** Concurrent cancellation requests for one command share all side effects. */
  private readonly cancelTasks = new Map<
    string,
    { runId: string; task: Promise<unknown> }
  >();
  /** One checkout has one merge owner; callers with that command share it. */
  private readonly mergeTasks = new Map<
    string,
    { commandId: string; task: Promise<unknown> }
  >();
  private readonly tools = new Map<
    string,
    {
      creator: ReturnType<typeof createWorktreeCreator>;
      finisher: ReturnType<typeof createWorktreeFinisher>;
    }
  >();
  private timer: NodeJS.Timeout | undefined;
  private draining = false;
  private started = false;
  private preparationTail: Promise<void> = Promise.resolve();

  constructor(options: OrchestrationServiceOptions) {
    this.repository = options.repository;
    this.manager = options.manager;
    this.registry = options.registry;
    this.workspaces = options.workspaces;
    this.onChange = options.onChange;
    this.pollMs = options.pollMs ?? 500;
    const reconnectGraceMs = options.reconnectGraceMs ?? 5_000;
    this.reconnectGraceMs = Number.isFinite(reconnectGraceMs)
      ? Math.min(60_000, Math.max(0, reconnectGraceMs))
      : 5_000;
    this.beforeWorktreePreparation = options.beforeWorktreePreparation;
    this.beforeWorktreeFinish = options.beforeWorktreeFinish;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.reconcile();
    this.timer = setInterval(() => void this.drain(), this.pollMs);
    this.timer.unref?.();
    void this.drain();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
    // Registry callbacks can enqueue another per-run reduction while the
    // current one completes. Drain until both the execution and callback sets
    // are empty so shutdown cannot leave a queued lifecycle task behind.
    while (this.inFlight.size > 0 || this.registryTasks.size > 0) {
      await Promise.allSettled([
        ...[...this.inFlight].map((id) => this.waitForRun(id)),
        ...this.registryTasks,
      ]);
    }
  }

  /** Wake the worker after a command or a projection mutation. */
  kick(): void {
    if (this.started) void this.drain();
  }

  async createProject(command: CreateProjectCommand): Promise<unknown> {
    return this.adoptProject(command);
  }

  async adoptProject(command: CreateProjectCommand): Promise<unknown> {
    const prior = this.receipt(command.commandId, 'project.adopt');
    if (prior) return prior.result;
    const workspace = command.workspaceId
      ? this.workspaces().find((item) => item.id === command.workspaceId)
      : undefined;
    const candidate = command.rootPath ?? workspace?.canonicalPath;
    if (!candidate) throw new Error('A rootPath or workspaceId is required.');
    const discoveredRoot = await repositoryRoot(candidate);
    const worktrees = await gitText(discoveredRoot, [
      'worktree',
      'list',
      '--porcelain',
    ]);
    const mainLine = worktrees
      .split('\n')
      .find((line) => line.startsWith('worktree '));
    const root = mainLine
      ? mainLine.slice('worktree '.length).trim()
      : discoveredRoot;
    const identity = await repositoryIdentity(candidate);
    const existing = this.repository.getProjectByRepositoryIdentity(identity);
    if (existing) {
      const checkout = this.mainCheckout(existing.id);
      if (!checkout) throw new Error('Adopted project has no main checkout.');
      const result = { project: existing, checkout };
      const persisted = this.saveReceipt(
        command.commandId,
        'project.adopt',
        result,
      );
      return persisted as typeof result;
    }
    const branch = await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const baseSha = await gitText(root, ['rev-parse', 'HEAD']);
    const now = Date.now();
    const projectInput = {
      title: command.title ?? path.basename(root),
      rootPath: root,
      repositoryIdentity: identity,
      defaultBaseBranch:
        command.defaultBaseBranch ?? (branch === 'HEAD' ? undefined : branch),
      defaultModel: command.defaultModel,
      defaultIsolation: command.defaultIsolation ?? 'worktree',
      maxParallelRuns: command.maxParallelRuns ?? 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const result = this.repository.createProjectWithCheckout(projectInput, {
        id: `checkout-${randomUUID()}`,
        kind: 'main',
        path: root,
        ...(branch === 'HEAD' ? {} : { branch }),
        baseSha,
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      });
      const persisted = this.saveReceipt(
        command.commandId,
        'project.adopt',
        result,
      );
      this.changed();
      return persisted as typeof result;
    } catch (error) {
      // The repository identity index serializes concurrent adopters. Read the
      // committed winner (including its main checkout) instead of leaving a
      // duplicate project or treating a harmless race as a failed command.
      const winner = this.repository.getProjectByRepositoryIdentity(identity);
      const checkout = winner && this.mainCheckout(winner.id);
      if (!winner || !checkout) throw error;
      const result = { project: winner, checkout };
      const persisted = this.saveReceipt(
        command.commandId,
        'project.adopt',
        result,
      );
      this.changed();
      return persisted as typeof result;
    }
  }

  async createThread(
    projectId: string,
    command: CreateThreadCommand,
  ): Promise<unknown> {
    const prior = this.receipt(command.commandId, 'thread.create');
    if (prior) {
      const result = prior.result as { thread: Thread; run: Run };
      return { ...result, receipt: prior };
    }
    const project = this.requireProject(projectId);
    if (project.status !== 'active') throw new Error('Project is archived.');
    const runId = `run-${randomUUID()}`;
    const thread = {
      id: `thread-${randomUUID()}`,
      projectId,
      title: command.title,
    };
    const run = {
      id: runId,
      initialPrompt: command.prompt,
      mode: command.mode ?? ('write' as const),
      runtimeProvider: command.runtimeProvider ?? ('extension-bridge' as const),
      model: command.model,
      status: 'queued' as const,
    };
    let result: { thread: Thread; run: Run; receipt: CommandReceipt };
    const chosenIsolation = command.isolation ?? project.defaultIsolation;
    if (command.checkoutId || chosenIsolation === 'main') {
      const checkout = command.checkoutId
        ? this.requireCheckout(command.checkoutId)
        : this.mainCheckout(project.id);
      if (!checkout) throw new Error('Project has no persisted main checkout.');
      if (checkout.projectId !== project.id)
        throw new Error('Checkout does not belong to this project.');
      if (checkout.status === 'retired')
        throw Object.assign(
          new Error('A retired checkout cannot receive a new thread.'),
          { code: 'orchestration-conflict' },
        );
      const input: CreateThreadWithRunInput = {
        thread: { ...thread, checkoutId: checkout.id },
        run,
      };
      result = this.repository.createThreadWithRun(command.commandId, input);
    } else {
      // The repository allocates this preparing checkout only after it has
      // checked the durable receipt, inside the same transaction as all rows.
      result = this.repository.createIsolatedThreadWithRun(command.commandId, {
        checkout: {
          id: `checkout-${randomUUID()}`,
          kind: 'worktree',
          path: path.join(project.rootPath, '.worktrees', `.pending-${runId}`),
          status: 'preparing',
        },
        thread,
        run,
      });
    }
    this.changed();
    this.kick();
    return result;
  }

  async retry(
    threadId: string,
    command: { commandId: string; prompt?: string; model?: Run['model'] },
  ): Promise<unknown> {
    return this.retryRun(threadId, command);
  }

  async retryRun(
    threadId: string,
    command: { commandId: string; prompt?: string; model?: Run['model'] },
  ): Promise<unknown> {
    this.requireThread(threadId);
    const { receipt: _receipt, ...result } = this.repository.retryRunIdempotent(
      command.commandId,
      {
        threadId,
        initialPrompt: command.prompt ?? this.latestRun(threadId).initialPrompt,
        model: command.model,
      },
    );
    this.changed();
    this.kick();
    return result;
  }

  async cancel(runId: string, commandId: string): Promise<unknown> {
    return this.cancelRun(runId, commandId);
  }

  async cancelRun(runId: string, commandId: string): Promise<unknown> {
    const prior = this.receipt(commandId, 'run.cancel');
    if (prior) {
      const result = prior.result as Run;
      if (result.id !== runId)
        throw idempotencyConflict(commandId, 'run.cancel');
      return prior.result;
    }
    const active = this.cancelTasks.get(commandId);
    if (active) {
      if (active.runId !== runId)
        throw idempotencyConflict(commandId, 'run.cancel');
      return active.task;
    }
    const task = this.performCancel(runId, commandId);
    this.cancelTasks.set(commandId, { runId, task });
    void task.then(
      () => {
        if (this.cancelTasks.get(commandId)?.task === task)
          this.cancelTasks.delete(commandId);
      },
      () => {
        if (this.cancelTasks.get(commandId)?.task === task)
          this.cancelTasks.delete(commandId);
      },
    );
    return task;
  }

  private async performCancel(runId: string, commandId: string): Promise<Run> {
    const run = this.requireRun(runId);
    const execution = this.executionTasks.get(runId);
    if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
      // Publish cancellation before waiting. The worker rechecks this durable
      // intent after every side-effect boundary and will stop a launch that
      // was already in flight rather than letting it become orphaned.
      try {
        this.repository.transitionRun(runId, 'cancelled');
      } catch {
        try {
          this.repository.transitionRun(runId, 'interrupted');
        } catch {
          /* another lifecycle transition won */
        }
      }
    }
    if (execution) await execution;
    else if (run.runtimeId) {
      try {
        await this.manager.stop(run.runtimeId, true);
      } catch (error) {
        this.repository.setRunError(runId, boundedErrorText(error));
        this.changed();
        this.kick();
        throw error;
      }
    }

    let result = this.repository.getRun(runId) as Run;
    const checkout = this.repository.getCheckout(result.checkoutId);
    // An execution task owns fresh-worktree cleanup. In particular, do not
    // finish a fresh checkout after its provider stop failed: retaining the
    // record is the retry handle for the leaked placement. A later retry of
    // the same cancellation reaches this branch after stop succeeds.
    if (!execution && checkout?.kind === 'worktree') {
      const record = this.worktreeRecord(checkout);
      if (this.freshWorktreeRuns.has(runId)) {
        if (record) {
          const discarded = await createWorktreeFinisher(
            this.storeFor(checkout),
          ).discardFreshWorktree(record.id);
          if (discarded.warning) throw new Error(discarded.warning);
        }
        this.freshWorktreeRuns.delete(runId);
        try {
          this.repository.transitionCheckout(checkout.id, 'retired');
        } catch {
          /* retain terminal state */
        }
      } else if (record) {
        await createWorktreeFinisher(this.storeFor(checkout)).finishWorktree(
          record.id,
          {
            taskName: this.requireThread(result.threadId).title,
            outcome: 'aborted',
          },
        );
        try {
          this.repository.transitionCheckout(checkout.id, 'dirty');
        } catch {
          /* retain terminal state */
        }
      } else {
        try {
          this.repository.transitionCheckout(checkout.id, 'retired');
        } catch {
          /* retain terminal state */
        }
      }
    }
    this.repository.clearRunError(runId);
    result = this.repository.getRun(runId) as Run;
    this.saveReceipt(commandId, 'run.cancel', result);
    this.changed();
    this.kick();
    return result;
  }

  async archiveThread(threadId: string, commandId: string): Promise<Thread> {
    const prior = this.receipt(commandId, 'thread.archive');
    if (prior) return prior.result as Thread;
    this.requireThread(threadId);
    if (
      this.repository
        .listRuns(threadId)
        .some((run) => !TERMINAL_RUN_STATUSES.includes(run.status))
    )
      throw new Error('A thread with an active run cannot be archived.');
    const archived = this.repository.transitionThread(threadId, 'archived');
    this.saveReceipt(commandId, 'thread.archive', archived);
    this.changed();
    return archived;
  }

  async reviewCheckout(checkoutId: string): Promise<unknown> {
    const checkout = this.requireCheckout(checkoutId);
    const record = this.worktreeRecord(checkout);
    if (!record) throw new Error('Checkout has no prepared worktree record.');
    return createWorktreeIntegrator().reviewBranch(record);
  }

  async mergeCheckout(checkoutId: string, commandId: string): Promise<unknown> {
    const prior = this.receipt(commandId, 'checkout.merge');
    if (prior) return prior.result;
    const active = this.mergeTasks.get(checkoutId);
    if (active) {
      if (active.commandId !== commandId)
        throw Object.assign(
          new Error('A different merge command already owns this checkout.'),
          { code: 'orchestration-conflict' },
        );
      return active.task;
    }
    const task = this.performMergeCheckout(checkoutId, commandId);
    this.mergeTasks.set(checkoutId, { commandId, task });
    void task.then(
      () => {
        if (this.mergeTasks.get(checkoutId)?.task === task)
          this.mergeTasks.delete(checkoutId);
      },
      () => {
        if (this.mergeTasks.get(checkoutId)?.task === task)
          this.mergeTasks.delete(checkoutId);
      },
    );
    return task;
  }

  private async performMergeCheckout(
    checkoutId: string,
    commandId: string,
  ): Promise<unknown> {
    const checkout = this.requireCheckout(checkoutId);
    this.assertCheckoutQuiescent(checkoutId);
    const record = this.worktreeRecord(checkout);
    if (!record) throw new Error('Checkout has no prepared worktree record.');
    const claimed = this.repository.claimCheckoutForMerge(checkoutId);
    if (!claimed) {
      const current = this.repository.getCheckout(checkoutId);
      throw Object.assign(
        new Error(
          current?.status === 'merging'
            ? 'Checkout merge is already owned by another command.'
            : `Checkout cannot be merged from ${current?.status ?? 'missing'} state.`,
        ),
        { code: 'orchestration-conflict' },
      );
    }
    try {
      // Stop any retained managed runtime before Git integration can mutate
      // main. A cleanup failure must leave both sides untouched and reviewable.
      await this.quiesceCheckoutRuntimes(checkoutId);
      const outcome = await createWorktreeIntegrator().mergeBranch(record);
      if (!outcome.merged) {
        this.repository.transitionCheckout(checkoutId, 'dirty');
        throw Object.assign(
          new Error(outcome.reason ?? 'Checkout merge failed.'),
          {
            code: 'merge-conflict',
            outcome,
          },
        );
      }
      await createWorktreeFinisher(this.storeFor(checkout)).removeWorktree(
        record.id,
      );
      const result = {
        checkout: this.repository.transitionCheckout(checkoutId, 'retired'),
        outcome,
      };
      this.saveReceipt(commandId, 'checkout.merge', result);
      this.changed();
      return result;
    } catch (error) {
      if (this.repository.getCheckout(checkoutId)?.status === 'merging')
        this.repository.transitionCheckout(checkoutId, 'dirty');
      this.changed();
      throw error;
    }
  }

  async retireCheckout(
    checkoutId: string,
    commandId: string,
  ): Promise<unknown> {
    const prior = this.receipt(commandId, 'checkout.retire');
    if (prior) return prior.result;
    const checkout = this.requireCheckout(checkoutId);
    this.assertCheckoutQuiescent(checkoutId);
    if (checkout.kind === 'main') {
      throw Object.assign(new Error('The main checkout cannot be retired.'), {
        code: 'orchestration-conflict',
      });
    }
    if (checkout.kind !== 'worktree') {
      const result = this.repository.transitionCheckout(checkoutId, 'retired');
      this.saveReceipt(commandId, 'checkout.retire', result);
      this.changed();
      return result;
    }
    const record = this.worktreeRecord(checkout);
    await this.quiesceCheckoutRuntimes(checkoutId);
    if (record)
      await createWorktreeFinisher(this.storeFor(checkout)).removeWorktree(
        record.id,
      );
    const result = this.repository.transitionCheckout(checkoutId, 'retired');
    this.saveReceipt(commandId, 'checkout.retire', result);
    this.changed();
    return result;
  }

  /** Registry callback is deliberately synchronous at the transport boundary. */
  onRegistryChange(change: RegistryChange): void {
    const task = this.handleRegistryChange(change);
    this.registryTasks.add(task);
    void task.then(
      () => this.registryTasks.delete(task),
      () => this.registryTasks.delete(task),
    );
  }

  private handleRegistryChange(change: RegistryChange): Promise<void> {
    const runtimeId =
      change.kind === 'registered' || change.kind === 'offline'
        ? change.snapshot.runtimeId
        : change.runtimeId;
    const run = this.repository.getRunByRuntimeId(runtimeId);
    if (!run) return Promise.resolve();
    const prior = this.registryRunQueues.get(run.id) ?? Promise.resolve();
    const task = prior
      .catch(() => undefined)
      .then(() => this.reduceRegistryChange(run.id, runtimeId, change));
    this.registryRunQueues.set(run.id, task);
    void task.then(
      () => {
        if (this.registryRunQueues.get(run.id) === task)
          this.registryRunQueues.delete(run.id);
      },
      () => {
        if (this.registryRunQueues.get(run.id) === task)
          this.registryRunQueues.delete(run.id);
      },
    );
    return task;
  }

  private async reduceRegistryChange(
    runId: string,
    runtimeId: string,
    change: RegistryChange,
  ): Promise<void> {
    const run = this.repository.getRun(runId);
    if (!run) return;
    try {
      if (change.kind === 'registered') {
        await this.bindAndDeliverPrompt(
          run.id,
          runtimeId,
          change.snapshot.session.id,
          change.snapshot,
        );
      } else if (change.kind === 'event') {
        if (change.event.type === 'agent.settled') await this.settle(run.id);
        else if (change.event.type === 'interaction.requested') {
          this.transitionIfPossible(run.id, 'waiting');
        } else if (change.event.type === 'interaction.resolved') {
          // The event itself only identifies the interaction. The reducer's
          // post-event snapshot is authoritative when several questions are
          // pending at once.
          if (change.snapshot.pendingInteractions.length === 0)
            this.transitionIfPossible(run.id, 'running');
        } else if (change.event.type === 'runtime.stateChanged') {
          const state = change.event.state;
          // A working state cannot override an outstanding ask-user request.
          if (change.snapshot.pendingInteractions.length > 0) {
            this.transitionIfPossible(run.id, 'waiting');
          } else if (state === 'waiting') {
            this.transitionIfPossible(run.id, 'waiting');
          } else if (state === 'working') {
            this.transitionIfPossible(run.id, 'running');
          }
        } else if (
          change.event.type === 'runtime.goodbye' &&
          change.event.reason !== 'reload'
        ) {
          this.repository.stopRuntime(runtimeId);
          if (ACTIVE_RUN_STATUSES.includes(run.status))
            this.failRun(
              run.id,
              'interrupted',
              `Runtime exited before the run settled${change.event.reason ? ` (${change.event.reason})` : ''}.`,
            );
        }
      } else {
        this.repository.stopRuntime(runtimeId);
        if (ACTIVE_RUN_STATUSES.includes(run.status))
          this.failRun(
            run.id,
            'interrupted',
            'Runtime disconnected before the run settled.',
          );
      }
    } catch (error) {
      this.repository.setRunError(run.id, boundedErrorText(error));
    }
    this.changed();
    this.kick();
  }

  /**
   * A hello is the durable prompt handoff boundary. The receipt is written
   * only after RuntimeRegistry has acknowledged the command, so a reconnect
   * can safely retry the same stable command ID.
   */
  private async bindAndDeliverPrompt(
    runId: string,
    runtimeId: string,
    piSessionId: string,
    registeredSnapshot?: RuntimeSnapshot,
  ): Promise<void> {
    const run = this.repository.getRun(runId);
    if (!run || TERMINAL_RUN_STATUSES.includes(run.status)) return;
    this.repository.bindRuntime({
      runtimeId,
      piSessionId,
      runId,
      status: 'starting',
    });
    const promptReceiptId = this.promptReceiptId(run.id);
    if (!this.repository.getCommandReceipt(promptReceiptId)) {
      await this.registry.sendCommand(runtimeId, {
        id: promptReceiptId,
        type: 'prompt',
        text: run.initialPrompt,
      });
      this.saveReceipt(promptReceiptId, 'run.prompt', { runId: run.id });
      // A prior ACK failure is no longer actionable once this retry was
      // acknowledged by the runtime.
      this.repository.clearRunError(run.id);
    }
    const current = this.repository.getRun(runId);
    if (!current || TERMINAL_RUN_STATUSES.includes(current.status)) return;
    if (current.status === 'preparing')
      this.transitionIfPossible(runId, 'starting');
    const authoritative = this.registry.get(runtimeId);
    const pendingInteractions =
      authoritative?.pendingInteractions ??
      registeredSnapshot?.pendingInteractions ??
      [];
    if (pendingInteractions.length > 0)
      this.transitionIfPossible(runId, 'waiting');
    else if (this.repository.getRun(runId)?.status === 'starting')
      this.repository.transitionRun(runId, 'running');
    this.repository.transitionRuntime(runtimeId, 'running');
  }

  private async settle(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return;
    const current = this.requireRun(runId);
    if (current.status === 'starting')
      this.transitionIfPossible(runId, 'running');
    if (
      this.requireRun(runId).status === 'waiting' ||
      this.requireRun(runId).status === 'running'
    )
      this.transitionIfPossible(runId, 'settled');
    const checkout = this.requireCheckout(run.checkoutId);
    if (checkout.kind === 'worktree') {
      const record = this.worktreeRecord(checkout);
      if (record) {
        await this.beforeWorktreeFinish?.();
        await createWorktreeFinisher(this.storeFor(checkout)).finishWorktree(
          record.id,
          {
            taskName: this.requireThread(run.threadId).title,
            outcome: 'success',
          },
        );
        this.repository.transitionCheckout(checkout.id, 'dirty');
        this.freshWorktreeRuns.delete(runId);
      }
    }
    if (run.runtimeId) {
      try {
        this.repository.transitionRuntime(run.runtimeId, 'stopped');
      } catch {
        /* already offline */
      }
    }
  }

  private async reconcile(): Promise<void> {
    for (const run of this.repository.listRuns()) {
      if (TERMINAL_RUN_STATUSES.includes(run.status)) continue;
      if (run.status === 'preparing') {
        // A durable record is the handoff point: it may describe an earlier
        // attempt whose branch contains useful edits. Keep it and let execute
        // rehydrate the same checkout rather than discarding the branch.
        const checkout = this.repository.getCheckout(run.checkoutId);
        if (checkout?.kind === 'worktree' && checkout.status === 'failed') {
          try {
            this.repository.transitionCheckout(checkout.id, 'preparing');
          } catch {
            /* the next worker will fail closed if state is inconsistent */
          }
        }
        this.transitionIfPossible(run.id, 'queued');
        continue;
      }
      if (run.runtimeId) {
        const live = this.registry.get(run.runtimeId);
        if (live && live.online !== false) {
          await this.handleRegistryChange({
            kind: 'registered',
            snapshot: live,
          });
          continue;
        }
        if (await this.recoverManagedRuntime(run.runtimeId)) {
          if (await this.waitForRuntimeHello(run.runtimeId)) {
            const restored = this.registry.get(run.runtimeId);
            if (restored && restored.online !== false)
              await this.handleRegistryChange({
                kind: 'registered',
                snapshot: restored,
              });
          } else {
            await this.stopRecoveredRuntime(run.runtimeId);
            this.failRun(
              run.id,
              'interrupted',
              'Restored runtime did not reconnect during startup grace.',
            );
          }
          continue;
        }
        this.failRun(
          run.id,
          'interrupted',
          'No recoverable managed runtime was found during startup reconciliation.',
        );
      } else if (['starting', 'running', 'waiting'].includes(run.status)) {
        this.failRun(
          run.id,
          'interrupted',
          'The run had no durable runtime identity during startup reconciliation.',
        );
      }
    }
    this.changed();
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.started) return;
    this.draining = true;
    try {
      for (const run of this.repository.listRuns()) {
        if (run.status !== 'queued' || this.inFlight.has(run.id)) continue;
        const claimed = this.repository.claimQueuedRun(run.id);
        if (!claimed) continue;
        this.inFlight.add(run.id);
        const task = this.execute(claimed);
        this.executionTasks.set(run.id, task);
        void task.then(
          () => {
            if (this.executionTasks.get(run.id) === task)
              this.executionTasks.delete(run.id);
            this.inFlight.delete(run.id);
            void this.drain();
          },
          () => {
            if (this.executionTasks.get(run.id) === task)
              this.executionTasks.delete(run.id);
            this.inFlight.delete(run.id);
            void this.drain();
          },
        );
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(run: Run): Promise<void> {
    const checkout = this.requireCheckout(run.checkoutId);
    if (checkout.status === 'retired') {
      this.failRun(
        run.id,
        'failed',
        'Cannot execute a run on a retired checkout.',
      );
      this.changed();
      return;
    }
    const project = this.requireProject(
      this.requireThread(run.threadId).projectId,
    );
    const existingRecord =
      checkout.kind === 'worktree' ? this.worktreeRecord(checkout) : undefined;
    let freshPrepared = false;
    let runtimeId = run.runtimeId;
    // Once a terminal run has reached this boundary, a failed stop must retain
    // the fresh worktree as evidence rather than allowing the catch path to
    // discard the provider's still-live placement.
    let terminalStopAttempted = false;
    let launchAttempted = false;
    try {
      let cwd = checkout.path;
      if (checkout.kind === 'worktree') {
        const creator = this.creatorFor(checkout);
        const record = existingRecord;
        let prepared: WorktreeRecord;
        if (record) {
          // A retry owns the same durable branch. Rehydrate a removed checkout
          // or use its extant path; never prepare a new WIP branch over it.
          prepared = (
            await this.serializedPreparation(() =>
              creator.rehydrateWorktree(record),
            )
          ).record;
        } else {
          const fresh = await this.serializedPreparation(async () => {
            await this.beforeWorktreePreparation?.();
            return creator.prepareWorktree({
              cwd: project.rootPath,
              name: this.requireThread(run.threadId).title,
              base: 'wip',
            });
          });
          if (!fresh.worktree) {
            this.failRun(
              run.id,
              'failed',
              fresh.fallbackReason ?? 'Requested worktree preparation failed.',
            );
            const failedCheckout = this.repository.getCheckout(checkout.id);
            const record =
              failedCheckout && this.worktreeRecord(failedCheckout);
            if (record)
              await createWorktreeFinisher(
                this.storeFor(checkout),
              ).discardFreshWorktree(record.id);
            try {
              this.repository.transitionCheckout(checkout.id, 'failed');
            } catch {
              /* preserve the run failure if another lifecycle update won */
            }
            this.changed();
            return;
          }
          prepared = fresh.worktree.record;
          freshPrepared = true;
          this.freshWorktreeRuns.add(run.id);
        }
        cwd = prepared.worktreePath;
        this.repository.updateCheckout(checkout.id, {
          path: cwd,
          branch: prepared.branch,
          baseSha: prepared.baseHead,
        });
        const current = this.repository.getCheckout(checkout.id);
        if (current?.status === 'failed')
          this.repository.transitionCheckout(checkout.id, 'preparing');
        if (this.repository.getCheckout(checkout.id)?.status !== 'ready')
          this.repository.transitionCheckout(checkout.id, 'ready');
      }

      // Preparation is an irreversible Git side effect. A cancellation may
      // have won while it was pending, so never proceed to launch on stale
      // claimed state.
      const afterPreparation = this.repository.getRun(run.id);
      if (
        afterPreparation &&
        TERMINAL_RUN_STATUSES.includes(afterPreparation.status)
      ) {
        if (runtimeId) {
          terminalStopAttempted = true;
          await this.manager.stop(runtimeId, true);
        }
        if (freshPrepared) {
          const record = this.worktreeRecord(
            this.repository.getCheckout(checkout.id) ?? checkout,
          );
          const discarded = record
            ? await createWorktreeFinisher(
                this.storeFor(checkout),
              ).discardFreshWorktree(record.id)
            : {};
          if (!discarded.warning) {
            this.freshWorktreeRuns.delete(run.id);
            try {
              this.repository.transitionCheckout(checkout.id, 'retired');
            } catch {
              /* terminal cancellation remains durable */
            }
          }
        }
        return;
      }

      const anchor = this.workspaces().find((item) => {
        try {
          return (
            realpathSync.native(item.canonicalPath) === project.rootPath ||
            realpathSync.native(item.path) === project.rootPath
          );
        } catch {
          return (
            item.canonicalPath === project.rootPath ||
            item.path === project.rootPath
          );
        }
      });
      if (!anchor)
        throw new Error(
          'The project parent workspace is not available as a launch anchor.',
        );
      runtimeId = runtimeId ?? `runtime-${randomUUID()}`;
      this.repository.setRunRuntime(run.id, runtimeId);
      this.repository.transitionRun(run.id, 'starting');
      // Orchestration owns durable prompt delivery after hello. Do not route
      // the prompt through RuntimeManager's legacy memory-only launch path.
      await this.manager.launch({
        workspaceId: anchor.id,
        runtimeId,
        checkoutCwd: cwd,
        name: this.requireThread(run.threadId).title,
        model: run.model,
      });

      // Cancellation can race the provider start itself. The manager now
      // accepts stopping a managed launch before hello/registry registration.
      launchAttempted = true;
      const afterLaunch = this.repository.getRun(run.id);
      if (afterLaunch && TERMINAL_RUN_STATUSES.includes(afterLaunch.status)) {
        terminalStopAttempted = true;
        await this.manager.stop(runtimeId, true);
        if (freshPrepared) {
          const record = this.worktreeRecord(
            this.repository.getCheckout(checkout.id) ?? checkout,
          );
          const discarded = record
            ? await createWorktreeFinisher(
                this.storeFor(checkout),
              ).discardFreshWorktree(record.id)
            : {};
          if (!discarded.warning) {
            this.freshWorktreeRuns.delete(run.id);
            try {
              this.repository.transitionCheckout(checkout.id, 'retired');
            } catch {
              /* terminal cancellation remains durable */
            }
          }
        }
      } else if (freshPrepared) {
        // Once launch has succeeded and no terminal stop is required, later
        // cancellation must preserve model edits via finishWorktree().
        this.freshWorktreeRuns.delete(run.id);
      }
    } catch (error) {
      const current = this.repository.getRun(run.id);
      if (!current || !TERMINAL_RUN_STATUSES.includes(current.status))
        this.failRun(run.id, 'failed', errorText(error));
      // Do not swallow a provider failure while the manager still owns a
      // launch. The durable run error and retained provider/worktree evidence
      // make the same command retryable.
      const manager = this.manager as RuntimeManager & {
        hasLaunch?: (id: string) => boolean;
      };
      const retainedLaunch = runtimeId
        ? (manager.hasLaunch?.(runtimeId) ?? false)
        : false;
      if (retainedLaunch) {
        this.repository.setRunError(run.id, boundedErrorText(error));
        this.changed();
        throw error;
      }
      if (checkout.kind === 'worktree') {
        if (!terminalStopAttempted && !retainedLaunch) {
          const record = this.worktreeRecord(
            this.repository.getCheckout(checkout.id) ?? checkout,
          );
          if (record) {
            const discarded = await createWorktreeFinisher(
              this.storeFor(checkout),
            ).discardFreshWorktree(record.id);
            if (!discarded.warning) this.freshWorktreeRuns.delete(run.id);
          }
        }
        if (
          !current ||
          !TERMINAL_RUN_STATUSES.includes(current.status) ||
          (!terminalStopAttempted && !retainedLaunch && launchAttempted)
        ) {
          if (this.repository.getCheckout(checkout.id)?.status !== 'failed') {
            try {
              this.repository.transitionCheckout(checkout.id, 'failed');
            } catch {
              /* preserve error */
            }
          }
        }
      }
    }
    this.changed();
  }

  private async recoverManagedRuntime(runtimeId: string): Promise<boolean> {
    const manager = this.manager as RuntimeManager & {
      recover?: (id: string) => Promise<boolean>;
      placement?: (id: string) => unknown;
    };
    if (manager.recover) return manager.recover(runtimeId);
    return Boolean(manager.placement?.(runtimeId));
  }

  private async waitForRuntimeHello(runtimeId: string): Promise<boolean> {
    const deadline = Date.now() + this.reconnectGraceMs;
    while (true) {
      const live = this.registry.get(runtimeId);
      if (live && live.online !== false) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(10, remaining)),
      );
    }
  }

  private async stopRecoveredRuntime(runtimeId: string): Promise<void> {
    const manager = this.manager as RuntimeManager & {
      stopRecovered?: (id: string) => Promise<void>;
      stop?: (id: string, force?: boolean) => Promise<void>;
    };
    if (manager.stopRecovered) {
      await manager.stopRecovered(runtimeId);
      return;
    }
    // Compatibility for provider-manager test doubles and older managers that
    // expose only stop(). A restored runtime has no live registry snapshot, so
    // force is the only meaningful cleanup request.
    if (manager.stop) await manager.stop(runtimeId, true);
  }

  private async serializedPreparation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.preparationTail;
    let release!: () => void;
    this.preparationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private waitForRun(id: string): Promise<void> {
    return new Promise((resolve) => {
      const check = () =>
        this.inFlight.has(id) ? setTimeout(check, 10) : resolve();
      check();
    });
  }

  private creatorFor(checkout: { id: string }) {
    return this.toolsFor(checkout.id).creator;
  }

  private worktreeRecord(checkout: { id: string }): WorktreeRecord | undefined {
    return this.repository.loadWorktreeRecord(checkout.id);
  }

  private storeFor(checkout: { id: string }): WorktreeStore {
    const repository = this.repository;
    const checkoutId = checkout.id;
    return {
      loadWorktree: (id) => {
        const record = repository.loadWorktreeRecord(checkoutId);
        return record?.id === id ? record : undefined;
      },
      writeWorktreeRecord: (record) =>
        repository.writeWorktreeRecord(checkoutId, record),
      deleteWorktreeRecord: () => repository.deleteWorktreeRecord(checkoutId),
    };
  }

  private toolsFor(checkoutId: string): {
    creator: ReturnType<typeof createWorktreeCreator>;
    finisher: ReturnType<typeof createWorktreeFinisher>;
  } {
    const existing = this.tools.get(checkoutId);
    if (existing) return existing;
    const store = this.storeFor({ id: checkoutId });
    const value = {
      creator: createWorktreeCreator(store),
      finisher: createWorktreeFinisher(store),
    };
    this.tools.set(checkoutId, value);
    return value;
  }

  private mainCheckout(projectId: string) {
    return this.repository
      .listCheckouts(projectId)
      .find((checkout) => checkout.kind === 'main');
  }

  private promptReceiptId(runId: string): string {
    return `run-prompt:${runId}`;
  }

  private receipt(id: string, type: string): CommandReceipt | undefined {
    const value = this.repository.getCommandReceipt(id);
    if (value && value.commandType !== type)
      throw idempotencyConflict(id, value.commandType);
    return value;
  }

  private saveReceipt(id: string, type: string, result: unknown): unknown {
    try {
      this.repository.recordCommandReceipt(commandReceipt(id, type, result));
      return result;
    } catch (error) {
      const existing = this.repository.getCommandReceipt(id);
      if (!existing) throw error;
      if (existing.commandType !== type)
        throw idempotencyConflict(id, existing.commandType);
      return existing.result;
    }
  }

  private assertCheckoutQuiescent(checkoutId: string): void {
    const active = this.repository
      .listRuns()
      .filter(
        (run) =>
          run.checkoutId === checkoutId &&
          !TERMINAL_RUN_STATUSES.includes(run.status),
      );
    if (active.length > 0)
      throw Object.assign(
        new Error('A checkout with an active run cannot be changed.'),
        { code: 'orchestration-conflict' },
      );
  }

  private async quiesceCheckoutRuntimes(checkoutId: string): Promise<void> {
    const runtimeIds = new Set(
      this.repository
        .listRuns()
        .filter(
          (run) => run.checkoutId === checkoutId && run.runtimeId !== undefined,
        )
        .map((run) => run.runtimeId as string),
    );
    const manager = this.manager as RuntimeManager & {
      stopRecovered?: (id: string) => Promise<void>;
    };
    for (const runtimeId of runtimeIds) {
      const live = this.registry.get(runtimeId);
      if (live && live.online !== false) {
        await this.manager.stop(runtimeId, true);
      } else if (manager.stopRecovered) {
        await manager.stopRecovered(runtimeId);
      } else {
        await this.manager.stop(runtimeId, true);
      }
    }
  }

  private requireProject(id: string): Project {
    const project = this.repository.getProject(id);
    if (!project) throw new Error(`Project ${id} does not exist.`);
    return project;
  }

  private requireThread(id: string): Thread {
    const thread = this.repository.getThread(id);
    if (!thread) throw new Error(`Thread ${id} does not exist.`);
    return thread;
  }

  private requireRun(id: string): Run {
    const run = this.repository.getRun(id);
    if (!run) throw new Error(`Run ${id} does not exist.`);
    return run;
  }

  private latestRun(threadId: string): Run {
    const run = this.repository.listRuns(threadId).at(-1);
    if (!run) throw new Error(`Thread ${threadId} has no run to retry.`);
    return run;
  }

  private requireCheckout(id: string) {
    const checkout = this.repository.getCheckout(id);
    if (!checkout) throw new Error(`Checkout ${id} does not exist.`);
    return checkout;
  }

  private failRun(
    id: string,
    status: 'failed' | 'interrupted',
    error: string,
  ): void {
    const current = this.repository.getRun(id);
    if (!current || TERMINAL_RUN_STATUSES.includes(current.status)) return;
    try {
      this.repository.transitionRun(id, status);
    } catch {
      /* another reconciler won */
    }
    this.repository.setRunError(id, boundedErrorText(error));
  }

  private transitionIfPossible(id: string, status: Run['status']): void {
    const current = this.repository.getRun(id);
    if (
      !current ||
      current.status === status ||
      TERMINAL_RUN_STATUSES.includes(current.status)
    )
      return;
    try {
      this.repository.transitionRun(id, status);
    } catch {
      /* stale registry update */
    }
  }

  private changed(): void {
    this.onChange?.();
  }
}
