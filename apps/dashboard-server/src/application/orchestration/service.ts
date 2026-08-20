import { realpathSync } from 'node:fs';
import path from 'node:path';
import { TERMINAL_RUN_STATUSES } from '@pi-dashboard/domain';
import type {
  Checkout,
  CommandReceipt,
  Project,
  Run,
  SessionAdoptCommand,
  Thread,
} from '@pi-dashboard/protocol';
import {
  createWorktreeCreator,
  createWorktreeFinisher,
  type WorktreeRecord,
  type WorktreeStore,
} from '@pi-dashboard/worktree-manager';
import type { OrchestrationRepository } from '../../repositories/types.js';
import type { RuntimeManager } from '../../runtime-manager.js';
import type {
  RegistryChange,
  RuntimeRegistry,
} from '../../runtime-registry.js';
import {
  assertCheckoutQuiescent as assertCheckoutQuiescentRule,
  mergeCheckout as mergeCheckoutLifecycle,
  quiesceCheckoutRuntimes as quiesceCheckoutRuntimesRule,
  retireCheckout as retireCheckoutLifecycle,
  reviewCheckout as reviewCheckoutLifecycle,
} from './checkouts.js';
import {
  boundedErrorText,
  type CreateProjectCommand,
  type CreateThreadCommand,
  commandReceipt,
  idempotencyConflict,
  type OrchestrationHost,
  type OrchestrationServiceOptions,
} from './helpers.js';
import { adoptProject, createProject } from './projects.js';
import {
  cancelRun as cancelRunLifecycle,
  drain as drainLifecycle,
  reconcile as reconcileLifecycle,
  retryRun as retryRunLifecycle,
} from './runs.js';
import {
  handleRegistryChange as handleRegistryChangeLifecycle,
  onRegistryChange as onRegistryChangeLifecycle,
} from './runtime-binding.js';
import {
  adoptSession as adoptSessionLifecycle,
  archiveThread as archiveThreadLifecycle,
  createThread as createThreadLifecycle,
  pinThread as pinThreadLifecycle,
  restoreThread as restoreThreadLifecycle,
  unpinThread as unpinThreadLifecycle,
} from './threads.js';

/**
 * Durable project/thread/run application boundary and its deliberately small
 * worker. Lifecycle rules live in sibling modules; this class owns shared state
 * and the public facade.
 */
export class OrchestrationService implements OrchestrationHost {
  readonly repository: OrchestrationRepository;
  readonly manager: RuntimeManager;
  readonly registry: RuntimeRegistry;
  readonly workspaces: () => readonly import('@pi-dashboard/protocol').WorkspaceTarget[];
  private readonly onChange?: () => void;
  private readonly pollMs: number;
  readonly reconnectGraceMs: number;
  readonly beforeWorktreePreparation?: () => Promise<void>;
  readonly beforeWorktreeFinish?: () => Promise<void>;
  readonly defaultRuntimeProvider: Run['runtimeProvider'];
  readonly readSession?: OrchestrationServiceOptions['readSession'];
  readonly getSession?: OrchestrationServiceOptions['getSession'];
  readonly inFlight = new Set<string>();
  /** Execution remains observable while preparation or manager.launch is pending. */
  readonly executionTasks = new Map<string, Promise<void>>();
  /** Fresh WIP branches are discarded on cancellation, unlike resumable records. */
  readonly freshWorktreeRuns = new Set<string>();
  readonly registryTasks = new Set<Promise<void>>();
  /** Registry callbacks for one durable run are reduced in bridge arrival order. */
  readonly registryRunQueues = new Map<string, Promise<void>>();
  /** Concurrent cancellation requests for one command share all side effects. */
  readonly cancelTasks = new Map<
    string,
    { runId: string; task: Promise<unknown> }
  >();
  /** One checkout has one merge owner; callers with that command share it. */
  readonly mergeTasks = new Map<
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
  draining = false;
  started = false;
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
    this.defaultRuntimeProvider =
      options.defaultRuntimeProvider ?? 'extension-bridge';
    this.readSession = options.readSession;
    this.getSession = options.getSession;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await reconcileLifecycle(this);
    this.timer = setInterval(() => void drainLifecycle(this), this.pollMs);
    this.timer.unref?.();
    void drainLifecycle(this);
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
    if (this.started) void drainLifecycle(this);
  }

  async createProject(command: CreateProjectCommand): Promise<unknown> {
    return createProject(this, command);
  }

  async adoptProject(command: CreateProjectCommand): Promise<unknown> {
    return adoptProject(this, command);
  }

  async adoptSession(
    projectId: string,
    sessionId: string,
    command: SessionAdoptCommand,
  ): Promise<{ thread: Thread; run: Run; receipt: CommandReceipt }> {
    return adoptSessionLifecycle(this, projectId, sessionId, command);
  }

  async createThread(
    projectId: string,
    command: CreateThreadCommand,
  ): Promise<unknown> {
    return createThreadLifecycle(this, projectId, command);
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
    return retryRunLifecycle(this, threadId, command);
  }

  async cancel(runId: string, commandId: string): Promise<unknown> {
    return this.cancelRun(runId, commandId);
  }

  async cancelRun(runId: string, commandId: string): Promise<unknown> {
    return cancelRunLifecycle(this, runId, commandId);
  }

  async archiveThread(threadId: string, commandId: string): Promise<Thread> {
    return archiveThreadLifecycle(this, threadId, commandId);
  }

  async restoreThread(threadId: string, commandId: string): Promise<Thread> {
    return restoreThreadLifecycle(this, threadId, commandId);
  }

  async pinThread(threadId: string, commandId: string): Promise<Thread> {
    return pinThreadLifecycle(this, threadId, commandId);
  }

  async unpinThread(threadId: string, commandId: string): Promise<Thread> {
    return unpinThreadLifecycle(this, threadId, commandId);
  }

  async reviewCheckout(checkoutId: string): Promise<unknown> {
    return reviewCheckoutLifecycle(this, checkoutId);
  }

  async mergeCheckout(checkoutId: string, commandId: string): Promise<unknown> {
    return mergeCheckoutLifecycle(this, checkoutId, commandId);
  }

  async retireCheckout(
    checkoutId: string,
    commandId: string,
  ): Promise<unknown> {
    return retireCheckoutLifecycle(this, checkoutId, commandId);
  }

  /** Registry callback is deliberately synchronous at the transport boundary. */
  onRegistryChange(change: RegistryChange): void {
    onRegistryChangeLifecycle(this, change);
  }

  /** Test and reconcile seam for per-run registry reduction. */
  handleRegistryChange(change: RegistryChange): Promise<void> {
    return handleRegistryChangeLifecycle(this, change);
  }

  /** Startup reconciliation seam used by tests and start(). */
  reconcile(): Promise<void> {
    return reconcileLifecycle(this);
  }

  creatorFor(checkout: { id: string }) {
    return this.toolsFor(checkout.id).creator;
  }

  worktreeRecord(checkout: { id: string }): WorktreeRecord | undefined {
    return this.repository.loadWorktreeRecord(checkout.id);
  }

  storeFor(checkout: { id: string }): WorktreeStore {
    const repository = this.repository;
    const checkoutId = checkout.id;
    return {
      loadWorktree: (id: string) => {
        const record = repository.loadWorktreeRecord(checkoutId);
        return record?.id === id ? record : undefined;
      },
      writeWorktreeRecord: (record: WorktreeRecord) =>
        repository.writeWorktreeRecord(checkoutId, record),
      deleteWorktreeRecord: () => repository.deleteWorktreeRecord(checkoutId),
    };
  }

  toolsFor(checkoutId: string): {
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

  containsPath(root: string, target: string): boolean {
    const canonical = (value: string): string => {
      try {
        return realpathSync.native(value);
      } catch {
        return path.resolve(value);
      }
    };
    const relative = path.relative(canonical(root), canonical(target));
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    );
  }

  mainCheckout(projectId: string): Checkout | undefined {
    return this.repository
      .listCheckouts(projectId)
      .find((checkout) => checkout.kind === 'main');
  }

  promptReceiptId(runId: string): string {
    return `run-prompt:${runId}`;
  }

  receipt(id: string, type: string): CommandReceipt | undefined {
    const value = this.repository.getCommandReceipt(id);
    if (value && value.commandType !== type)
      throw idempotencyConflict(id, value.commandType);
    return value;
  }

  saveReceipt(id: string, type: string, result: unknown): unknown {
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

  assertCheckoutQuiescent(checkoutId: string): void {
    assertCheckoutQuiescentRule(this, checkoutId);
  }

  async quiesceCheckoutRuntimes(checkoutId: string): Promise<void> {
    await quiesceCheckoutRuntimesRule(this, checkoutId);
  }

  async serializedPreparation<T>(operation: () => Promise<T>): Promise<T> {
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

  waitForRun(id: string): Promise<void> {
    return new Promise((resolve) => {
      const check = () =>
        this.inFlight.has(id) ? setTimeout(check, 10) : resolve();
      check();
    });
  }

  async recoverManagedRuntime(runtimeId: string): Promise<boolean> {
    const manager = this.manager as RuntimeManager & {
      recover?: (id: string) => Promise<boolean>;
      placement?: (id: string) => unknown;
    };
    if (manager.recover) return manager.recover(runtimeId);
    return Boolean(manager.placement?.(runtimeId));
  }

  async waitForRuntimeHello(runtimeId: string): Promise<boolean> {
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

  async stopRecoveredRuntime(runtimeId: string): Promise<void> {
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

  requireProject(id: string): Project {
    const project = this.repository.getProject(id);
    if (!project) throw new Error(`Project ${id} does not exist.`);
    return project;
  }

  requireThread(id: string): Thread {
    const thread = this.repository.getThread(id);
    if (!thread) throw new Error(`Thread ${id} does not exist.`);
    return thread;
  }

  requireRun(id: string): Run {
    const run = this.repository.getRun(id);
    if (!run) throw new Error(`Run ${id} does not exist.`);
    return run;
  }

  latestRun(threadId: string): Run {
    const run = this.repository.listRuns(threadId).at(-1);
    if (!run) throw new Error(`Thread ${threadId} has no run to retry.`);
    return run;
  }

  requireCheckout(id: string): Checkout {
    const checkout = this.repository.getCheckout(id);
    if (!checkout) throw new Error(`Checkout ${id} does not exist.`);
    return checkout;
  }

  failRun(id: string, status: 'failed' | 'interrupted', error: string): void {
    const current = this.repository.getRun(id);
    if (!current || TERMINAL_RUN_STATUSES.includes(current.status)) return;
    try {
      this.repository.transitionRun(id, status);
    } catch {
      /* another reconciler won */
    }
    this.repository.setRunError(id, boundedErrorText(error));
  }

  transitionIfPossible(id: string, status: Run['status']): void {
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

  changed(): void {
    this.onChange?.();
  }
}
