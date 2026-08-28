import type {
  Checkout,
  CheckoutSummary,
  CommandReceipt,
  DashboardSettings,
  ModelDisplayPreference,
  ModelDisplayPreferences,
  ModelSelection,
  NotificationEvent,
  OrchestrationRuntime,
  Project,
  ProjectSummary,
  Run,
  RunStatus,
  RunSummary,
  RuntimeLocation,
  RuntimeProvider,
  SessionIndexEntry,
  SessionThreadLink,
  Thread,
  ThreadLifecycleCommandResult,
  ThreadLifecycleEvent,
  ThreadSummary,
} from '@pi-dashboard/protocol';
import type { WorktreeRecord } from '@pi-dashboard/worktree-manager';

export interface ModelDisplayPreferenceRepository {
  read(): DashboardSettings;
  set(modelKey: string, preference: ModelDisplayPreference): DashboardSettings;
  reset(modelKey: string): DashboardSettings;
  importMissing(preferences: ModelDisplayPreferences): DashboardSettings;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  subscription: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ManagedLaunchIdentity {
  projectId?: string;
  checkoutId?: string;
  cwd?: string;
}

export interface ManagedLaunchRecord {
  runtimeId: string;
  projectId?: string;
  checkoutId?: string;
  cwd?: string;
  /** Opaque location owned by the runtime provider/host. */
  location: RuntimeLocation;
  /** Managed Pi tool capability; old rows are treated as writable. */
  mode: 'read' | 'write';
  identityTokenHash: string;
  launchTokenHash: string;
  launchConsumed: boolean;
  launchedAt: number;
  stoppedAt?: number;
}

export interface MetadataRepository {
  saveRuntime(snapshot: import('@pi-dashboard/protocol').RuntimeSnapshot): void;
  saveSession(session: SessionIndexEntry): void;
  recordManagedLaunch(
    runtimeId: string,
    identity: ManagedLaunchIdentity,
    location: RuntimeLocation,
    credentials: {
      identityToken: string;
      launchToken: string;
      launchConsumed?: boolean;
      mode?: 'read' | 'write';
    },
  ): void;
  managedLaunches(): ManagedLaunchRecord[];
  consumeLaunchCredential(runtimeId: string): void;
  markManagedStopped(runtimeId: string): void;
}

export interface CreateProjectInput {
  id?: string;
  title: string;
  rootPath: string;
  repositoryIdentity?: string;
  defaultBaseBranch?: string;
  defaultModel?: ModelSelection;
  defaultIsolation?: 'worktree' | 'main';
  maxParallelRuns?: number;
  status?: Project['status'];
  createdAt?: number;
  updatedAt?: number;
}

export interface CreateCheckoutInput {
  id?: string;
  projectId: string;
  kind: Checkout['kind'];
  path: string;
  branch?: string;
  baseSha?: string;
  status?: Checkout['status'];
  createdAt?: number;
  updatedAt?: number;
}

export interface CreateThreadInput {
  id?: string;
  projectId: string;
  title: string;
  checkoutId?: string;
  pinnedAt?: number;
  archivedAt?: number;
  status?: Thread['status'];
  createdAt?: number;
  updatedAt?: number;
}

export interface CreateRunInput {
  id?: string;
  threadId: string;
  checkoutId?: string;
  attempt?: number;
  parentRunId?: string;
  mode?: 'read' | 'write';
  /** Compatibility spelling for callers that model writer ownership as a flag. */
  isWriter?: boolean;
  runtimeProvider?: RuntimeProvider;
  runtimeId?: string;
  piSessionId?: string;
  initialPrompt: string;
  model?: ModelSelection;
  status?: RunStatus;
  createdAt?: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface CreateThreadWithRunInput {
  thread: CreateThreadInput;
  run: Omit<CreateRunInput, 'threadId'> & { threadId?: string };
}

export interface SessionThreadLinkRecord extends SessionThreadLink {
  source: string;
  sourceFile: string;
  createdAt: number;
  updatedAt: number;
}

export interface AdoptSessionWithThreadAndRunInput {
  thread: CreateThreadInput;
  run: Omit<CreateRunInput, 'threadId'> & { threadId?: string };
  /** Exact SessionIndex file identity used by the link projection. */
  sessionSourceFile?: string;
  runtime?: {
    runtimeId: string;
    piSessionId: string;
    status: 'running';
  };
}

export interface CreateIsolatedThreadWithRunInput {
  checkout: Omit<CreateCheckoutInput, 'projectId'>;
  thread: Omit<CreateThreadInput, 'checkoutId'>;
  run: Omit<CreateRunInput, 'threadId' | 'checkoutId'> & {
    threadId?: string;
    checkoutId?: string;
  };
}

export interface RetryRunInput {
  threadId: string;
  initialPrompt: string;
  model?: ModelSelection;
}

export type ProjectPatch = Partial<
  Pick<
    Project,
    | 'title'
    | 'rootPath'
    | 'repositoryIdentity'
    | 'defaultBaseBranch'
    | 'defaultModel'
    | 'defaultIsolation'
    | 'maxParallelRuns'
  >
>;
export type CheckoutPatch = Partial<
  Pick<Checkout, 'kind' | 'path' | 'branch' | 'baseSha'>
>;
export type ThreadPatch = Partial<
  Pick<Thread, 'title' | 'checkoutId' | 'pinnedAt' | 'archivedAt'>
>;

export interface BindRuntimeInput {
  runtimeId: string;
  piSessionId: string;
  runId: string;
  status?: OrchestrationRuntime['status'];
  createdAt?: number;
  updatedAt?: number;
}

export interface ProjectLookupRepository {
  getProject(id: string): Project | undefined;
  getProjectByRepositoryIdentity(identity: string): Project | undefined;
  listProjects(): Project[];
}

export interface OrchestrationRepository extends ProjectLookupRepository {
  createProject(input: CreateProjectInput): Project;
  createProjectWithCheckout(
    input: CreateProjectInput,
    checkout: Omit<CreateCheckoutInput, 'projectId'>,
  ): { project: Project; checkout: Checkout };
  updateProject(id: string, patch: ProjectPatch, now?: number): Project;
  deleteProject(id: string): void;
  projectSummaries(): ProjectSummary[];
  transitionProject(
    id: string,
    status: Project['status'],
    now?: number,
  ): Project;
  createCheckout(input: CreateCheckoutInput): Checkout;
  getCheckout(id: string): Checkout | undefined;
  listCheckouts(projectId?: string): Checkout[];
  updateCheckout(id: string, patch: CheckoutPatch, now?: number): Checkout;
  deleteCheckout(id: string): void;
  checkoutSummaries(): CheckoutSummary[];
  createThread(input: CreateThreadInput): Thread;
  getThread(id: string): Thread | undefined;
  listThreads(projectId?: string): Thread[];
  updateThread(id: string, patch: ThreadPatch, now?: number): Thread;
  deleteThread(id: string): void;
  threadSummaries(): ThreadSummary[];
  createRun(input: CreateRunInput): Run;
  createRunIdempotent(idempotencyKey: string, input: CreateRunInput): Run;
  retryRunIdempotent(
    idempotencyKey: string,
    input: RetryRunInput,
  ): { run: Run; thread: Thread; receipt: CommandReceipt };
  getRun(id: string): Run | undefined;
  listRuns(threadId?: string): Run[];
  deleteRun(id: string): void;
  runSummaries(): RunSummary[];
  transitionRun(id: string, status: RunStatus, now?: number): Run;
  /** Atomically claim a queued run, subject to checkout writer safety. */
  claimQueuedRun(id: string, now?: number): Run | undefined;
  transitionThread(id: string, status: Thread['status'], now?: number): Thread;
  /** Atomic visibility/order commands; each accepted call appends one event. */
  archiveThread(
    commandId: string,
    threadId: string,
    now?: number,
  ): ThreadLifecycleCommandResult;
  restoreThread(
    commandId: string,
    threadId: string,
    now?: number,
  ): ThreadLifecycleCommandResult;
  pinThread(
    commandId: string,
    threadId: string,
    now?: number,
  ): ThreadLifecycleCommandResult;
  unpinThread(
    commandId: string,
    threadId: string,
    now?: number,
  ): ThreadLifecycleCommandResult;
  settleThread(
    commandId: string,
    threadId: string,
    now?: number,
  ): ThreadLifecycleCommandResult;
  unsettleThread(
    commandId: string,
    threadId: string,
    now?: number,
  ): ThreadLifecycleCommandResult;
  /** Internal inspection seam; HTTP never exposes event history. */
  listThreadEvents(threadId: string): ThreadLifecycleEvent[];
  transitionCheckout(
    id: string,
    status: Checkout['status'],
    now?: number,
  ): Checkout;
  /** Atomically claims a ready or dirty checkout for one merge owner. */
  claimCheckoutForMerge(id: string, now?: number): Checkout | undefined;
  createThreadWithRun(
    idempotencyKey: string,
    input: CreateThreadWithRunInput,
  ): { thread: Thread; run: Run; receipt: CommandReceipt };
  adoptSessionWithThreadAndRun(
    idempotencyKey: string,
    input: AdoptSessionWithThreadAndRunInput,
  ): { thread: Thread; run: Run; receipt: CommandReceipt };
  createIsolatedThreadWithRun(
    idempotencyKey: string,
    input: CreateIsolatedThreadWithRunInput,
  ): { thread: Thread; run: Run; receipt: CommandReceipt };
  getCommandReceipt(idempotencyKey: string): CommandReceipt | undefined;
  recordCommandReceipt(receipt: CommandReceipt): void;
  setRunRuntime(id: string, runtimeId: string): Run;
  setRunError(id: string, error: string): Run;
  clearRunError(id: string): Run;
  getRunByRuntimeId(runtimeId: string): Run | undefined;
  getRunByPiSessionId(piSessionId: string): Run | undefined;
  getSessionThreadLink(sessionId: string): SessionThreadLinkRecord | undefined;
  getSessionThreadLinkByThreadId(
    threadId: string,
  ): SessionThreadLinkRecord | undefined;
  listSessionThreadLinkRecords(): SessionThreadLinkRecord[];
  sessionThreadLinks(): SessionThreadLink[];
  listSessionThreadLinks(): SessionThreadLink[];
  ensureSessionThreadLinks(sessions: readonly SessionIndexEntry[]): void;
  loadWorktreeRecord(checkoutId: string): WorktreeRecord | undefined;
  writeWorktreeRecord(checkoutId: string, record: WorktreeRecord): void;
  deleteWorktreeRecord(checkoutId: string): void;
  bindRuntime(input: BindRuntimeInput): OrchestrationRuntime;
  transitionRuntime(
    runtimeId: string,
    status: OrchestrationRuntime['status'],
    now?: number,
  ): OrchestrationRuntime;
  stopRuntime(runtimeId: string, status?: 'stopped' | 'failed'): void;
  getRuntime(runtimeId: string): OrchestrationRuntime | undefined;
}

export interface NotificationRepository {
  addNotification(event: NotificationEvent): void;
  unreadNotifications(): NotificationEvent[];
  markNotificationRead(id: string): void;
  markAllNotificationsRead(): void;
  clearWaitingNotifications(runtimeId: string): void;
  savePushSubscription(record: PushSubscriptionRecord): void;
  pushSubscriptions(): PushSubscriptionRecord[];
  removePushSubscription(endpoint: string): void;
}
