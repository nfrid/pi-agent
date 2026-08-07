import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '@pi-dashboard/domain';
import type {
  Checkout,
  CommandReceipt,
  Project,
  Run,
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
 * worker. Side effects happen only after the queued run and complete prompt
 * have committed to SQLite.
 */
export class OrchestrationService {
  private readonly repository: OrchestrationRepository;
  private readonly manager: RuntimeManager;
  private readonly registry: RuntimeRegistry;
  private readonly workspaces: () => readonly WorkspaceTarget[];
  private readonly onChange?: () => void;
  private readonly pollMs: number;
  private readonly inFlight = new Set<string>();
  private readonly registryTasks = new Set<Promise<void>>();
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
    await Promise.allSettled([
      ...[...this.inFlight].map((id) => this.waitForRun(id)),
      ...this.registryTasks,
    ]);
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
    const existing = this.repository
      .listProjects()
      .find((project) => project.repositoryIdentity === identity);
    if (existing) {
      const result = {
        project: existing,
        checkout: this.mainCheckout(existing.id),
      };
      this.saveReceipt(command.commandId, 'project.adopt', result);
      return result;
    }
    const branch = await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const baseSha = await gitText(root, ['rev-parse', 'HEAD']);
    const now = Date.now();
    const project = this.repository.createProject({
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
    });
    let checkout: Checkout;
    try {
      checkout = this.repository.createCheckout({
        id: `checkout-${randomUUID()}`,
        projectId: project.id,
        kind: 'main',
        path: root,
        ...(branch === 'HEAD' ? {} : { branch }),
        baseSha,
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      this.repository.deleteProject(project.id);
      throw error;
    }
    const result = { project, checkout };
    this.saveReceipt(command.commandId, 'project.adopt', result);
    this.changed();
    return result;
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
    const checkout = command.checkoutId
      ? this.requireCheckout(command.checkoutId)
      : this.checkoutForNewRun(project, command.isolation, runId);
    if (checkout.projectId !== project.id)
      throw new Error('Checkout does not belong to this project.');
    const input: CreateThreadWithRunInput = {
      thread: {
        id: `thread-${randomUUID()}`,
        projectId,
        title: command.title,
        checkoutId: checkout.id,
      },
      run: {
        id: runId,
        initialPrompt: command.prompt,
        mode: command.mode ?? 'write',
        runtimeProvider: command.runtimeProvider ?? 'extension-bridge',
        model: command.model,
        status: 'queued',
      },
    };
    let result: { thread: Thread; run: Run; receipt: CommandReceipt };
    try {
      result = this.repository.createThreadWithRun(command.commandId, input);
    } catch (error) {
      if (!command.checkoutId && checkout.kind === 'worktree')
        this.repository.deleteCheckout(checkout.id);
      throw error;
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
    const prior = this.receipt(command.commandId, 'run.retry');
    if (prior) return prior.result;
    const thread = this.requireThread(threadId);
    const runs = this.repository.listRuns(threadId);
    const previous = runs[runs.length - 1];
    if (!previous || !TERMINAL_RUN_STATUSES.includes(previous.status))
      throw new Error('Only a terminal run can be retried.');
    const project = this.requireProject(thread.projectId);
    const oldCheckout = this.requireCheckout(previous.checkoutId);
    const checkout =
      oldCheckout.kind === 'main'
        ? oldCheckout
        : this.repository.createCheckout({
            id: `checkout-${randomUUID()}`,
            projectId: project.id,
            kind: 'worktree',
            path: path.join(
              project.rootPath,
              '.worktrees',
              `.pending-${randomUUID()}`,
            ),
            status: 'preparing',
          });
    try {
      const run = this.repository.createRun({
        id: `run-${randomUUID()}`,
        threadId,
        checkoutId: checkout.id,
        parentRunId: previous.id,
        initialPrompt: command.prompt ?? previous.initialPrompt,
        model: command.model ?? previous.model,
        mode: previous.mode,
        runtimeProvider: previous.runtimeProvider,
        status: 'queued',
      });
      const nextThread = this.repository.updateThread(threadId, {
        checkoutId: checkout.id,
      });
      const result = { run, thread: nextThread };
      this.saveReceipt(command.commandId, 'run.retry', result);
      this.changed();
      this.kick();
      return result;
    } catch (error) {
      if (checkout.id !== oldCheckout.id)
        this.repository.deleteCheckout(checkout.id);
      throw error;
    }
  }

  async cancel(runId: string, commandId: string): Promise<unknown> {
    return this.cancelRun(runId, commandId);
  }

  async cancelRun(runId: string, commandId: string): Promise<unknown> {
    const prior = this.receipt(commandId, 'run.cancel');
    if (prior) return prior.result;
    const run = this.requireRun(runId);
    if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
      if (run.runtimeId)
        await this.manager.stop(run.runtimeId, true).catch(() => undefined);
      const current = this.repository.getRun(runId);
      if (current && !TERMINAL_RUN_STATUSES.includes(current.status)) {
        try {
          this.repository.transitionRun(runId, 'cancelled');
        } catch {
          this.repository.transitionRun(runId, 'interrupted');
        }
      }
    }
    const result = this.repository.getRun(runId) as Run;
    const checkout = this.repository.getCheckout(result.checkoutId);
    if (checkout?.kind === 'worktree') {
      const record = this.worktreeRecord(checkout);
      if (record) {
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
      }
    }
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
    const checkout = this.requireCheckout(checkoutId);
    const record = this.worktreeRecord(checkout);
    if (!record) throw new Error('Checkout has no prepared worktree record.');
    this.repository.transitionCheckout(checkoutId, 'merging');
    try {
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
    if (checkout.kind !== 'worktree') {
      const result = this.repository.transitionCheckout(checkoutId, 'retired');
      this.saveReceipt(commandId, 'checkout.retire', result);
      this.changed();
      return result;
    }
    const record = this.worktreeRecord(checkout);
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

  private async handleRegistryChange(change: RegistryChange): Promise<void> {
    const runtimeId =
      change.kind === 'registered' || change.kind === 'offline'
        ? change.snapshot.runtimeId
        : change.runtimeId;
    const run = this.repository.getRunByRuntimeId(runtimeId);
    if (!run) return;
    try {
      if (change.kind === 'registered') {
        const piSessionId = change.snapshot.session.id;
        const wasStarting =
          run.status === 'starting' || run.status === 'preparing';
        const promptReceiptId = this.promptReceiptId(run.id);
        const promptAlreadyRecorded = Boolean(
          this.repository.getCommandReceipt(promptReceiptId),
        );
        this.repository.bindRuntime({
          runtimeId,
          piSessionId,
          runId: run.id,
          status: 'starting',
        });
        if (wasStarting && !promptAlreadyRecorded) {
          this.saveReceipt(promptReceiptId, 'run.prompt', {
            runId: run.id,
          });
          const sendPrompt = (
            this.manager as RuntimeManager & {
              sendInitialPromptOnce?: (id: string, prompt: string) => void;
            }
          ).sendInitialPromptOnce;
          sendPrompt?.call(this.manager, runtimeId, run.initialPrompt);
        }
        if (run.status === 'preparing')
          this.transitionIfPossible(run.id, 'starting');
        if (run.status === 'starting')
          this.repository.transitionRun(run.id, 'running');
        this.repository.transitionRuntime(runtimeId, 'running');
      } else if (change.kind === 'event') {
        if (change.event.type === 'agent.settled') await this.settle(run.id);
        else if (change.event.type === 'runtime.stateChanged') {
          const state = change.event.state;
          if (state === 'waiting') this.transitionIfPossible(run.id, 'waiting');
          else if (state === 'working')
            this.transitionIfPossible(run.id, 'running');
        }
      } else if (
        change.kind === 'offline' &&
        ACTIVE_RUN_STATUSES.includes(run.status)
      ) {
        this.failRun(
          run.id,
          'interrupted',
          'Runtime disconnected before the run settled.',
        );
      }
    } catch (error) {
      this.repository.setRunError(run.id, errorText(error));
    }
    this.changed();
    this.kick();
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
        await createWorktreeFinisher(this.storeFor(checkout)).finishWorktree(
          record.id,
          {
            taskName: this.requireThread(run.threadId).title,
            outcome: 'success',
          },
        );
        this.repository.transitionCheckout(checkout.id, 'dirty');
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
        // Worktree preparation is restart-safe only before the record is
        // written. Remove a half-prepared checkout before requeueing it; a
        // requested worktree is never replaced by main.
        const checkout = this.repository.getCheckout(run.checkoutId);
        if (checkout?.kind === 'worktree') {
          const record = this.worktreeRecord(checkout);
          if (record) {
            await createWorktreeFinisher(
              this.storeFor(checkout),
            ).discardFreshWorktree(record.id);
            try {
              if (checkout.status !== 'preparing')
                this.repository.transitionCheckout(checkout.id, 'failed');
              if (this.repository.getCheckout(checkout.id)?.status === 'failed')
                this.repository.transitionCheckout(checkout.id, 'preparing');
            } catch {
              /* the next worker will fail closed if state is inconsistent */
            }
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
        if (await this.recoverManagedRuntime(run.runtimeId)) continue;
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
        void this.execute(claimed).finally(() => {
          this.inFlight.delete(run.id);
          void this.drain();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(run: Run): Promise<void> {
    const checkout = this.requireCheckout(run.checkoutId);
    const project = this.requireProject(
      this.requireThread(run.threadId).projectId,
    );
    try {
      let cwd = checkout.path;
      if (checkout.kind === 'worktree') {
        const creator = this.creatorFor(checkout);
        const prepared = await this.serializedPreparation(() =>
          creator.prepareWorktree({
            cwd: project.rootPath,
            name: this.requireThread(run.threadId).title,
            base: 'wip',
          }),
        );
        if (!prepared.worktree) {
          this.failRun(
            run.id,
            'failed',
            prepared.fallbackReason ?? 'Requested worktree preparation failed.',
          );
          this.repository.transitionCheckout(checkout.id, 'failed');
          this.changed();
          return;
        }
        cwd = prepared.worktree.record.worktreePath;
        this.repository.updateCheckout(checkout.id, {
          path: cwd,
          branch: prepared.worktree.record.branch,
          baseSha: prepared.worktree.record.baseHead,
        });
        this.repository.transitionCheckout(checkout.id, 'ready');
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
      const runtimeId = run.runtimeId ?? `runtime-${randomUUID()}`;
      this.repository.setRunRuntime(run.id, runtimeId);
      this.repository.transitionRun(run.id, 'starting');
      // Record the at-most-once prompt handoff before launch. If the daemon
      // dies after tmux starts, reconciliation will not send a second turn to
      // a runtime that may already have accepted this prompt.
      if (!this.repository.getCommandReceipt(this.promptReceiptId(run.id)))
        this.saveReceipt(this.promptReceiptId(run.id), 'run.prompt', {
          runId: run.id,
        });
      await this.manager.launch({
        workspaceId: anchor.id,
        runtimeId,
        checkoutCwd: cwd,
        name: this.requireThread(run.threadId).title,
        initialPrompt: run.initialPrompt,
        model: run.model,
      });
    } catch (error) {
      this.failRun(run.id, 'failed', errorText(error));
      if (checkout.kind === 'worktree') {
        const record = this.worktreeRecord(
          this.repository.getCheckout(checkout.id) ?? checkout,
        );
        if (record)
          await createWorktreeFinisher(
            this.storeFor(checkout),
          ).discardFreshWorktree(record.id);
        if (this.repository.getCheckout(checkout.id)?.status !== 'failed') {
          try {
            this.repository.transitionCheckout(checkout.id, 'failed');
          } catch {
            /* preserve error */
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

  private checkoutForNewRun(
    project: Project,
    isolation: 'worktree' | 'main' | undefined,
    runId: string,
  ) {
    const chosen = isolation ?? project.defaultIsolation;
    if (chosen === 'main') {
      const main = this.mainCheckout(project.id);
      if (!main) throw new Error('Project has no persisted main checkout.');
      return main;
    }
    return this.repository.createCheckout({
      id: `checkout-${randomUUID()}`,
      projectId: project.id,
      kind: 'worktree',
      path: path.join(project.rootPath, '.worktrees', `.pending-${runId}`),
      status: 'preparing',
    });
  }

  private promptReceiptId(runId: string): string {
    return `run-prompt:${runId}`;
  }

  private receipt(id: string, type: string): CommandReceipt | undefined {
    const value = this.repository.getCommandReceipt(id);
    if (value && value.commandType !== type)
      throw new Error(`Idempotency key ${id} belongs to ${value.commandType}.`);
    return value;
  }

  private saveReceipt(id: string, type: string, result: unknown): void {
    this.repository.recordCommandReceipt(commandReceipt(id, type, result));
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
    this.repository.setRunError(id, error);
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
