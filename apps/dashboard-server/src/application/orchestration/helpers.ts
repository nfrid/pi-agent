import type {
  Checkout,
  CommandReceipt,
  Project,
  Run,
  SessionIndexEntry,
  Thread,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import type {
  createWorktreeCreator,
  WorktreeRecord,
  WorktreeStore,
} from '@pi-dashboard/worktree-manager';
import type { OrchestrationRepository } from '../../repositories/types.js';
import type { RuntimeManager } from '../../runtime-manager.js';
import type { RuntimeRegistry } from '../../runtime-registry.js';

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
  /** Experimental default applies only to durable managed orchestration runs. */
  defaultRuntimeProvider?: Run['runtimeProvider'];
  /** Legacy transcript access used by session adoption. */
  readSession?: (id: string) => Promise<{
    metadata: SessionIndexEntry;
    entries: unknown[];
  }>;
  getSession?: (id: string) => SessionIndexEntry | undefined;
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

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function boundedErrorText(error: unknown): string {
  const text = errorText(error);
  return text.length <= 2_000 ? text : `${text.slice(0, 1_999)}…`;
}

export function idempotencyConflict(
  id: string,
  owner: string,
): Error & { code: string } {
  return Object.assign(
    new Error(`Idempotency key ${id} belongs to ${owner}.`),
    { code: 'idempotency-conflict' },
  );
}

export function commandReceipt(
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
 * Shared service surface for lifecycle modules. Mutable worker state lives here
 * so projects/threads/runs/checkouts/runtime-binding stay focused on rules.
 */
export interface OrchestrationHost {
  readonly repository: OrchestrationRepository;
  readonly manager: RuntimeManager;
  readonly registry: RuntimeRegistry;
  readonly workspaces: () => readonly WorkspaceTarget[];
  readonly beforeWorktreePreparation?: () => Promise<void>;
  readonly beforeWorktreeFinish?: () => Promise<void>;
  readonly defaultRuntimeProvider: Run['runtimeProvider'];
  readonly readSession?: OrchestrationServiceOptions['readSession'];
  readonly getSession?: OrchestrationServiceOptions['getSession'];
  readonly reconnectGraceMs: number;

  readonly inFlight: Set<string>;
  readonly executionTasks: Map<string, Promise<void>>;
  readonly freshWorktreeRuns: Set<string>;
  readonly registryTasks: Set<Promise<void>>;
  readonly registryRunQueues: Map<string, Promise<void>>;
  readonly cancelTasks: Map<string, { runId: string; task: Promise<unknown> }>;
  readonly mergeTasks: Map<
    string,
    { commandId: string; task: Promise<unknown> }
  >;

  started: boolean;
  draining: boolean;

  kick(): void;
  changed(): void;
  receipt(id: string, type: string): CommandReceipt | undefined;
  saveReceipt(id: string, type: string, result: unknown): unknown;
  requireProject(id: string): Project;
  requireThread(id: string): Thread;
  requireRun(id: string): Run;
  requireCheckout(id: string): Checkout;
  mainCheckout(projectId: string): Checkout | undefined;
  latestRun(threadId: string): Run;
  containsPath(root: string, target: string): boolean;
  promptReceiptId(runId: string): string;
  worktreeRecord(checkout: { id: string }): WorktreeRecord | undefined;
  storeFor(checkout: { id: string }): WorktreeStore;
  creatorFor(checkout: {
    id: string;
  }): ReturnType<typeof createWorktreeCreator>;
  failRun(id: string, status: 'failed' | 'interrupted', error: string): void;
  transitionIfPossible(id: string, status: Run['status']): void;
  assertCheckoutQuiescent(checkoutId: string): void;
  quiesceCheckoutRuntimes(checkoutId: string): Promise<void>;
  serializedPreparation<T>(operation: () => Promise<T>): Promise<T>;
  waitForRun(id: string): Promise<void>;
  recoverManagedRuntime(runtimeId: string): Promise<boolean>;
  waitForRuntimeHello(runtimeId: string): Promise<boolean>;
  stopRecoveredRuntime(runtimeId: string): Promise<void>;
}
