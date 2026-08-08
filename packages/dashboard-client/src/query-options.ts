import type {
  BrowserSnapshot,
  ProjectAdoptCommand,
  ProjectCreateCommand,
  RetryCommand,
  SessionAdoptCommand,
  SessionApiResponse,
  StartRuntimeRequest,
  ThreadCreateCommand,
} from '@pi-dashboard/protocol';
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from '@tanstack/react-query';
import type { DashboardHttpClient } from './http-client.js';

export const dashboardQueryKeys = {
  all: ['dashboard'] as const,
  snapshot: () => ['dashboard', 'snapshot'] as const,
  usage: () => ['dashboard', 'usage'] as const,
  session: (id: string) => ['dashboard', 'session', id] as const,
  workspace: (id: string) => ['dashboard', 'workspace', id] as const,
  composerCommands: (workspaceId: string) =>
    ['dashboard', 'composer-commands', workspaceId] as const,
  runtime: (id: string) => ['dashboard', 'runtime', id] as const,
  notifications: () => ['dashboard', 'notifications'] as const,
  settings: () => ['dashboard', 'settings'] as const,
  projects: () => ['dashboard', 'projects'] as const,
  checkouts: () => ['dashboard', 'checkouts'] as const,
  threads: () => ['dashboard', 'threads'] as const,
  runs: () => ['dashboard', 'runs'] as const,
  project: (id: string) => ['dashboard', 'project', id] as const,
  checkout: (id: string) => ['dashboard', 'checkout', id] as const,
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

export function snapshotRequestGeneration(
  snapshot: BrowserSnapshot,
): number | undefined {
  return snapshotRequestGenerations.get(snapshot);
}

const networkRetry = (failureCount: number, error: unknown): boolean => {
  const status =
    error && typeof error === 'object' && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 401 || status === 403) return false;
  return failureCount < 2;
};

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

export function sessionQueryOptions(client: DashboardHttpClient, id: string) {
  return queryOptions<SessionApiResponse>({
    queryKey: dashboardQueryKeys.session(id),
    queryFn: ({ signal }) => client.session(id, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
    enabled: Boolean(id),
  });
}

export function usageQueryOptions(client: DashboardHttpClient) {
  return queryOptions({
    queryKey: dashboardQueryKeys.usage(),
    queryFn: () => client.usage(),
    staleTime: 30_000,
    retry: networkRetry,
  });
}

export function composerCommandsQueryOptions(
  client: DashboardHttpClient,
  workspaceId: string,
) {
  return queryOptions({
    queryKey: dashboardQueryKeys.composerCommands(workspaceId),
    queryFn: ({ signal }) => client.composerCommands(workspaceId, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
    enabled: Boolean(workspaceId),
  });
}

export function workspaceQueryOptions(client: DashboardHttpClient, id: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.workspace(id),
    queryFn: async () => {
      const snapshot = await client.snapshot();
      return snapshot.workspaces.find((workspace) => workspace.id === id);
    },
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

export function settingsQueryOptions(client: DashboardHttpClient) {
  return queryOptions({
    queryKey: dashboardQueryKeys.settings(),
    queryFn: () => client.request<unknown>('/api/settings'),
    staleTime: Number.POSITIVE_INFINITY,
    retry: networkRetry,
  });
}

export function renameSessionMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      client.renameSession(id, name),
    retry: false,
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
    }) => client.sendCommand(runtimeId, command),
    retry: false,
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
    mutationFn: ({
      runtimeId,
      force = false,
    }: {
      runtimeId: string;
      force?: boolean;
    }) => client.stopRuntime(runtimeId, force),
    retry: false,
  });
}

export function restartRuntimeMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (runtimeId: string) => client.restartRuntime(runtimeId),
    retry: false,
  });
}

export function interactionAnswerMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: ({ id, answer }: { id: string; answer: string }) =>
      client.answerInteraction(id, answer),
    retry: false,
  });
}

export function interactionCancelMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (id: string) => client.cancelInteraction(id),
    retry: false,
  });
}

export function pushSubscribeMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (subscription: unknown) => client.subscribePush(subscription),
    retry: false,
  });
}

export function workspaceRefreshMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: () => client.refreshWorkspaces(),
    retry: false,
  });
}

export function startRuntimeMutationOptions(client: DashboardHttpClient) {
  return mutationOptions({
    mutationFn: (request: StartRuntimeRequest) => client.startRuntime(request),
    retry: false,
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
    mutationFn: ({
      threadId,
      commandId,
    }: {
      threadId: string;
      commandId?: string;
    }) =>
      client.archiveThread(threadId, {
        commandId: commandId ?? mutationCommandId('thread-archive'),
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
