import type {
  Checkout,
  CheckoutSummary,
  CommandReceipt,
  ModelSelection,
  NotificationEvent,
  OrchestrationRuntime,
  Project,
  ProjectSummary,
  Run,
  RunStatus,
  RunSummary,
  SessionIndexEntry,
  Thread,
  ThreadSummary,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';

export interface PushSubscriptionRecord {
  endpoint: string;
  subscription: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ManagedLaunchRecord {
  runtimeId: string;
  workspaceId: string;
  placement: {
    tmuxSession: string;
    tmuxWindowId: string;
    tmuxPaneId: string;
    displayTarget: string;
  };
  identityTokenHash: string;
  launchTokenHash: string;
  launchConsumed: boolean;
  launchedAt: number;
  stoppedAt?: number;
}

export interface MetadataRepository {
  saveWorkspace(workspace: WorkspaceTarget): void;
  saveRuntime(snapshot: import('@pi-dashboard/protocol').RuntimeSnapshot): void;
  saveSession(session: SessionIndexEntry): void;
  recordManagedLaunch(
    runtimeId: string,
    workspaceId: string,
    placement: Omit<ManagedLaunchRecord['placement'], 'displayTarget'> & {
      displayTarget?: string;
    },
    credentials: {
      identityToken: string;
      launchToken: string;
      launchConsumed?: boolean;
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
  runtimeProvider?: string;
  runtimeId?: string;
  piSessionId?: string;
  initialPrompt: string;
  model?: ModelSelection;
  status?: RunStatus;
  createdAt?: number;
}

export interface CreateThreadWithRunInput {
  thread: CreateThreadInput;
  run: Omit<CreateRunInput, 'threadId'> & { threadId?: string };
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
    | 'status'
  >
>;
export type CheckoutPatch = Partial<
  Pick<Checkout, 'kind' | 'path' | 'branch' | 'baseSha' | 'status'>
>;
export type ThreadPatch = Partial<
  Pick<Thread, 'title' | 'checkoutId' | 'status'>
>;

export interface BindRuntimeInput {
  runtimeId: string;
  piSessionId: string;
  runId?: string;
  status?: OrchestrationRuntime['status'];
  createdAt?: number;
  updatedAt?: number;
}

export interface OrchestrationRepository {
  createProject(input: CreateProjectInput): Project;
  getProject(id: string): Project | undefined;
  listProjects(): Project[];
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
  getRun(id: string): Run | undefined;
  listRuns(threadId?: string): Run[];
  deleteRun(id: string): void;
  runSummaries(): RunSummary[];
  transitionRun(id: string, status: RunStatus, now?: number): Run;
  transitionThread(id: string, status: Thread['status'], now?: number): Thread;
  transitionCheckout(
    id: string,
    status: Checkout['status'],
    now?: number,
  ): Checkout;
  createThreadWithRun(
    idempotencyKey: string,
    input: CreateThreadWithRunInput,
  ): { thread: Thread; run: Run; receipt: CommandReceipt };
  getCommandReceipt(idempotencyKey: string): CommandReceipt | undefined;
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
