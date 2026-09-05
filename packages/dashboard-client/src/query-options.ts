import type {
  AuthoritativeSessionSnapshot,
  BrowserSnapshot,
  DashboardSettings,
  DelegateHistoryResponse,
  DelegateHistoryRunDetailResponse,
  DraftDefaults,
  GitContext,
  ModelDisplayPreference,
  ModelDisplayPreferences,
  ProjectAdoptCommand,
  ProjectCreateCommand,
  ProjectRenameCommand,
  RetryCommand,
  SessionAdoptCommand,
  StartRuntimeRequest,
  ThreadCreateCommand,
  UsageHistoryRange,
} from '@pi-dashboard/protocol';
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from '@tanstack/react-query';
import {
  type DashboardHttpClient,
  dashboardHttpErrorKind,
} from './http-client.js';

export const dashboardQueryKeys = {
  all: ['dashboard'] as const,
  snapshot: () => ['dashboard', 'snapshot'] as const,
  usage: () => ['dashboard', 'usage'] as const,
  usageHistory: (range: UsageHistoryRange, before?: number) =>
    ['dashboard', 'usage-history', range, before ?? 'current'] as const,
  session: (id: string) => ['dashboard', 'session', id] as const,
  delegateHistory: (id: string) =>
    ['dashboard', 'delegate-history', id] as const,
  delegateHistoryDetail: (id: string) =>
    ['dashboard', 'delegate-history-detail', id] as const,
  delegateHistoryRun: (
    sessionId: string,
    lineageId: string,
    runId: string,
    leafId?: string,
  ) =>
    [
      ...dashboardQueryKeys.delegateHistoryDetail(sessionId),
      'run',
      lineageId,
      runId,
      leafId ?? '',
    ] as const,
  runtime: (id: string) => ['dashboard', 'runtime', id] as const,
  notifications: () => ['dashboard', 'notifications'] as const,
  settings: () => ['dashboard', 'settings'] as const,
  draftDefaults: (projectId: string) =>
    ['dashboard', 'draft-defaults', projectId] as const,
  projects: () => ['dashboard', 'projects'] as const,
  checkouts: () => ['dashboard', 'checkouts'] as const,
  threads: () => ['dashboard', 'threads'] as const,
  sessionThreadLinks: () => ['dashboard', 'session-threads'] as const,
  runs: () => ['dashboard', 'runs'] as const,
  project: (id: string) => ['dashboard', 'project', id] as const,
  gitContext: (id: string) => ['dashboard', 'git-context', id] as const,
  checkout: (id: string) => ['dashboard', 'checkout', id] as const,
  composerCommands: (cwd: string) =>
    ['dashboard', 'composer-commands', cwd] as const,
  thread: (id: string) => ['dashboard', 'thread', id] as const,
  run: (id: string) => ['dashboard', 'run', id] as const,
};

type CommandInput<T extends { commandId: string }> = Omit<T, 'commandId'> & {
  commandId?: string;
};

function mutationCommandId(prefix: string): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function withMutationCommandId<T extends { commandId: string }>(
  prefix: string,
  command: CommandInput<T>,
): T {
  return {
    ...command,
    commandId: command.commandId ?? mutationCommandId(prefix),
  } as T;
}

const snapshotRequestGenerations = new WeakMap<object, number>();
const runtimeCommandIds = new WeakMap<object, string>();
const lifecycleCommandIds = new WeakMap<object, string>();

function runtimeCommandId(command: Record<string, unknown>): string {
  if (typeof command.id === 'string' && command.id.length > 0)
    return command.id;
  const prior = runtimeCommandIds.get(command);
  if (prior) return prior;
  const id = mutationCommandId('dashboard-command');
  runtimeCommandIds.set(command, id);
  return id;
}

function lifecycleCommandId(
  prefix: string,
  variables: Record<string, unknown>,
): string {
  if (typeof variables.commandId === 'string' && variables.commandId.length > 0)
    return variables.commandId;
  const prior = lifecycleCommandIds.get(variables);
  if (prior) return prior;
  const id = mutationCommandId(prefix);
  lifecycleCommandIds.set(variables, id);
  return id;
}

const commandNetworkRetry = (failureCount: number, error: unknown): boolean =>
  dashboardHttpErrorKind(error) === 'network' && failureCount < 2;

export function snapshotRequestGeneration(
  snapshot: BrowserSnapshot,
): number | undefined {
  return snapshotRequestGenerations.get(snapshot);
}

const networkRetry = (failureCount: number, error: unknown): boolean =>
  dashboardHttpErrorKind(error) === 'network' && failureCount < 2;

export function snapshotQueryOptions(
  client: DashboardHttpClient,
  getRequestGeneration?: () => number,
) {
  return queryOptions({
    queryKey: dashboardQueryKeys.snapshot(),
    queryFn: async () => {
      const requestGeneration = getRequestGeneration?.();
      const snapshot = await client.snapshot();
      if (requestGeneration !== undefined)
        snapshotRequestGenerations.set(snapshot, requestGeneration);
      return snapshot;
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
  });
}

export function composerCommandsQueryOptions(
  client: DashboardHttpClient,
  cwd: string,
) {
  return queryOptions({
    queryKey: dashboardQueryKeys.composerCommands(cwd),
    queryFn: ({ signal }) => client.composerCommands(cwd, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
    enabled: Boolean(cwd),
  });
}

export function sessionQueryOptions(client: DashboardHttpClient, id: string) {
  return queryOptions<AuthoritativeSessionSnapshot>({
    queryKey: dashboardQueryKeys.session(id),
    queryFn: ({ signal }) => client.session(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
    enabled: Boolean(id),
  });
}

export function delegateHistoryQueryOptions(
  client: DashboardHttpClient,
  id: string,
) {
  return queryOptions<DelegateHistoryResponse>({
    queryKey: dashboardQueryKeys.delegateHistory(id),
    queryFn: ({ signal }) => client.delegateHistory(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
    enabled: Boolean(id),
  });
}

export const sessionDelegateHistoryQueryOptions = delegateHistoryQueryOptions;

export function delegateHistoryRunQueryOptions(
  client: DashboardHttpClient,
  sessionId: string,
  lineageId: string,
  runId: string,
  leafId?: string,
) {
  return queryOptions<DelegateHistoryRunDetailResponse>({
    queryKey: dashboardQueryKeys.delegateHistoryRun(
      sessionId,
      lineageId,
      runId,
      leafId,
    ),
    queryFn: ({ signal }) =>
      client.delegateHistoryRun(
        sessionId,
        runId,
        { lineageId, ...(leafId === undefined ? {} : { leafId }) },
        signal,
      ),
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
    enabled: Boolean(sessionId && lineageId && runId),
  });
}

export const delegateHistoryDetailQueryOptions = delegateHistoryRunQueryOptions;

export function usageQueryOptions(client: DashboardHttpClient) {
  return queryOptions({
    queryKey: dashboardQueryKeys.usage(),
    queryFn: () => client.usage(),
    staleTime: 30_000,
    retry: networkRetry,
  });
}

export function usageHistoryQueryOptions(
  client: DashboardHttpClient,
  range: UsageHistoryRange,
  before?: number,
) {
  return queryOptions({
    queryKey: dashboardQueryKeys.usageHistory(range, before),
    queryFn: () => client.usageHistory(range, before),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: networkRetry,
  });
}

export function threadsQueryOptions(
  client: DashboardHttpClient,
  projectId?: string,
) {
  return queryOptions({
    queryKey: [...dashboardQueryKeys.threads(), projectId ?? ''] as const,
    queryFn: ({ signal }) => client.listThreads(projectId, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
  });
}

export const threadListQueryOptions = threadsQueryOptions;

export function sessionThreadLinksQueryOptions(client: DashboardHttpClient) {
  return queryOptions({
    queryKey: dashboardQueryKeys.sessionThreadLinks(),
    queryFn: ({ signal }) => client.listSessionThreadLinks(signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
  });
}

export const sessionThreadsQueryOptions = sessionThreadLinksQueryOptions;

export function threadQueryOptions(client: DashboardHttpClient, id: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.thread(id),
    queryFn: ({ signal }) => client.thread(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
    enabled: Boolean(id),
  });
}

export function runtimeQueryOptions(client: DashboardHttpClient, id: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.runtime(id),
    queryFn: async () => {
      const snapshot = await client.snapshot();
      return snapshot.runtimes.find((runtime) => runtime.runtimeId === id);
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
    enabled: Boolean(id),
  });
}

export function notificationsQueryOptions(client: DashboardHttpClient) {
  return queryOptions({
    queryKey: dashboardQueryKeys.notifications(),
    queryFn: async () => (await client.snapshot()).unread,
    staleTime: 30_000,
    retry: networkRetry,
  });
}

export function pushVapidPublicKeyQueryOptions(client: DashboardHttpClient) {
  return queryOptions({
    queryKey: ['dashboard', 'push', 'vapid-public-key'] as const,
    queryFn: () => client.pushVapidPublicKey(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
  });
}

export function draftDefaultsQueryOptions(
  client: DashboardHttpClient,
  projectId: string,
) {
  return queryOptions<DraftDefaults>({
    queryKey: dashboardQueryKeys.draftDefaults(projectId),
    queryFn: ({ signal }) => client.draftDefaults(projectId, signal),
    staleTime: 30_000,
    retry: networkRetry,
    enabled: Boolean(projectId),
  });
}

export function settingsQueryOptions(client: DashboardHttpClient) {
  return queryOptions<DashboardSettings>({
    queryKey: dashboardQueryKeys.settings(),
    queryFn: ({ signal }) => client.settings(signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: networkRetry,
  });
}

export function updateDashboardDefaultModelMutationOptions(
  client: DashboardHttpClient,
) {
  return mutationOptions<
    DashboardSettings,
    Error,
    { model: import('@pi-dashboard/protocol').ModelSelection }
  >({
    mutationFn: ({ model }) => client.updateDashboardDefaultModel(model),
    retry: false,
    scope: { id: 'dashboard-default-model' },
  });
}

export function resetDashboardDefaultModelMutationOptions(
  client: DashboardHttpClient,
) {
  return mutationOptions<DashboardSettings, Error, void>({
    mutationFn: () => client.resetDashboardDefaultModel(),
    retry: false,
    scope: { id: 'dashboard-default-model' },
  });
}

export function updateProjectDefaultModelMutationOptions(
  client: DashboardHttpClient,
) {
  return mutationOptions<
    import('@pi-dashboard/protocol').Project,
    Error,
    {
      projectId: string;
      defaultModel: import('@pi-dashboard/protocol').ModelSelection | null;
    }
  >({
    mutationFn: ({ projectId, defaultModel }) =>
      client.updateProjectDefaultModel(projectId, {
        commandId: mutationCommandId('dashboard-project-default'),
        defaultModel,
      }),
    retry: false,
    scope: { id: 'dashboard-project-default-model' },
  });
}

export function updateModelDisplayPreferenceMutationOptions(
  client: DashboardHttpClient,
) {
  return mutationOptions<
    DashboardSettings,
    Error,
    { modelKey: string; preference: ModelDisplayPreference }
  >({
    mutationFn: ({ modelKey, preference }) =>
      client.updateModelDisplayPreference(modelKey, preference),
    retry: false,
    scope: { id: 'dashboard-model-display-preferences' },
  });
}

export function resetModelDisplayPreferenceMutationOptions(
  client: DashboardHttpClient,
) {
  return mutationOptions<DashboardSettings, Error, { modelKey: string }>({
    mutationFn: ({ modelKey }) => client.resetModelDisplayPreference(modelKey),
    retry: false,
    scope: { id: 'dashboard-model-display-preferences' },
  });
}

export function importModelDisplayPreferencesMutationOptions(
  client: DashboardHttpClient,
) {
  return mutationOptions<DashboardSettings, Error, ModelDisplayPreferences>({
    mutationFn: (preferences) =>
      client.importModelDisplayPreferences(preferences),
    retry: false,
    scope: { id: 'dashboard-model-display-preferences' },
  });
}

export function renameSessionMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; name: string; commandId?: string }) =>
      client.renameSession(
        variables.id,
        variables.name,
        lifecycleCommandId('dashboard-rename', variables),
      ),
    retry: commandNetworkRetry,
  });
}

export function commandMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: ({
      runtimeId,
      command,
    }: {
      runtimeId: string;
      command: Record<string, unknown>;
    }) =>
      client.sendCommand(runtimeId, {
        ...command,
        id: runtimeCommandId(command),
      }),
    retry: commandNetworkRetry,
  });
}

export function actionMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: ({
      runtimeId,
      actionId,
      input,
      commandId,
    }: {
      runtimeId: string;
      actionId: string;
      input: unknown;
      commandId?: string;
    }) => client.invokeAction(runtimeId, actionId, input, commandId),
    retry: false,
  });
}

export function stopRuntimeMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (variables: {
      runtimeId: string;
      force?: boolean;
      commandId?: string;
    }) =>
      client.stopRuntime(
        variables.runtimeId,
        variables.force ?? false,
        lifecycleCommandId('dashboard-stop', variables),
      ),
    retry: commandNetworkRetry,
  });
}

export function restartRuntimeMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (variables: { runtimeId: string; commandId?: string }) =>
      client.restartRuntime(
        variables.runtimeId,
        lifecycleCommandId('dashboard-restart', variables),
      ),
    retry: commandNetworkRetry,
  });
}

export function pushSubscribeMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (subscription: unknown) => client.subscribePush(subscription),
    retry: false,
  });
}

export function startRuntimeMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (request: StartRuntimeRequest & { commandId?: string }) =>
      client.startRuntime({
        ...request,
        commandId: lifecycleCommandId('dashboard-start', request),
      }),
    retry: commandNetworkRetry,
  });
}

export function notificationReadMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: ({ id, all }: { id?: string; all?: boolean }) =>
      all ? client.readAllNotifications() : client.readNotification(id ?? ''),
    retry: false,
  });
}

export function adoptProjectMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (command: CommandInput<ProjectAdoptCommand>) =>
      client.adoptProject(
        withMutationCommandId<ProjectAdoptCommand>('project-adopt', command),
      ),
    retry: false,
  });
}

export function adoptSessionMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: ({
      projectId,
      sessionId,
      command,
    }: {
      projectId: string;
      sessionId: string;
      command?: CommandInput<SessionAdoptCommand>;
    }) =>
      client.adoptSession(
        projectId,
        sessionId,
        withMutationCommandId<SessionAdoptCommand>(
          'session-adopt',
          command ?? {},
        ),
      ),
    retry: false,
  });
}

export function createProjectMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (command: CommandInput<ProjectCreateCommand>) =>
      client.createProject(
        withMutationCommandId<ProjectCreateCommand>('project-create', command),
      ),
    retry: false,
  });
}

export function renameProjectMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: ({
      projectId,
      command,
    }: {
      projectId: string;
      command: CommandInput<ProjectRenameCommand>;
    }) =>
      client.renameProject(
        projectId,
        withMutationCommandId<ProjectRenameCommand>('project-rename', command),
      ),
    retry: false,
  });
}

export function gitContextQueryOptions(
  client: DashboardHttpClient,
  projectId: string,
) {
  return queryOptions<GitContext>({
    queryKey: dashboardQueryKeys.gitContext(projectId),
    queryFn: ({ signal }) => client.gitContext(projectId, signal),
    staleTime: 15_000,
    retry: networkRetry,
    enabled: Boolean(projectId),
  });
}

export function createThreadMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: ({
      projectId,
      command,
    }: {
      projectId: string;
      command: CommandInput<ThreadCreateCommand>;
    }) =>
      client.createThread(
        projectId,
        withMutationCommandId<ThreadCreateCommand>('thread-create', command),
      ),
    retry: false,
  });
}

export function retryThreadMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: ({
      threadId,
      command = {},
    }: {
      threadId: string;
      command?: CommandInput<RetryCommand>;
    }) =>
      client.retryThread(
        threadId,
        withMutationCommandId<RetryCommand>('run-retry', command),
      ),
    retry: false,
  });
}

export function cancelRunMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: ({ runId, commandId }: { runId: string; commandId?: string }) =>
      client.cancelRun(runId, {
        commandId: commandId ?? mutationCommandId('run-cancel'),
      }),
    retry: false,
  });
}

export function reviewCheckoutMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (checkoutId: string) => client.reviewCheckout(checkoutId),
    retry: false,
  });
}

export function mergeCheckoutMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: ({
      checkoutId,
      commandId,
    }: {
      checkoutId: string;
      commandId?: string;
    }) =>
      client.mergeCheckout(checkoutId, {
        commandId: commandId ?? mutationCommandId('checkout-merge'),
      }),
    retry: false,
  });
}

export function retireCheckoutMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: ({
      checkoutId,
      commandId,
    }: {
      checkoutId: string;
      commandId?: string;
    }) =>
      client.retireCheckout(checkoutId, {
        commandId: commandId ?? mutationCommandId('checkout-retire'),
      }),
    retry: false,
  });
}

export function archiveThreadMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (variables: { threadId: string; commandId?: string }) =>
      client.archiveThread(variables.threadId, {
        commandId: lifecycleCommandId('thread-archive', variables),
      }),
    retry: false,
  });
}

export function restoreThreadMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (variables: { threadId: string; commandId?: string }) =>
      client.restoreThread(variables.threadId, {
        commandId: lifecycleCommandId('thread-restore', variables),
      }),
    retry: false,
  });
}

export function regenerateThreadTitleMutationOptions(
  client: DashboardHttpClient,
) {
  return mutationOptions({
    mutationFn: (variables: { threadId: string; commandId?: string }) =>
      client.regenerateThreadTitle(variables.threadId, {
        commandId: lifecycleCommandId('thread-regenerate-title', variables),
      }),
    retry: false,
  });
}

export function pinThreadMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (variables: { threadId: string; commandId?: string }) =>
      client.pinThread(variables.threadId, {
        commandId: lifecycleCommandId('thread-pin', variables),
      }),
    retry: false,
  });
}

export function settleThreadMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (variables: { threadId: string; commandId?: string }) =>
      client.settleThread(variables.threadId, {
        commandId: lifecycleCommandId('thread-settle', variables),
      }),
    retry: false,
  });
}

export function unsettleThreadMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (variables: { threadId: string; commandId?: string }) =>
      client.unsettleThread(variables.threadId, {
        commandId: lifecycleCommandId('thread-unsettle', variables),
      }),
    retry: false,
  });
}

export function unpinThreadMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (variables: { threadId: string; commandId?: string }) =>
      client.unpinThread(variables.threadId, {
        commandId: lifecycleCommandId('thread-unpin', variables),
      }),
    retry: false,
  });
}

/** Invalidate fetchable state after a mutation; the live stream remains separate. */
export function invalidateDashboardQueries(
  queryClient: QueryClient,
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.all });
}
