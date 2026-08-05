import type {
  BrowserSnapshot,
  SessionApiResponse,
  StartRuntimeRequest,
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
  runtime: (id: string) => ['dashboard', 'runtime', id] as const,
  notifications: () => ['dashboard', 'notifications'] as const,
  settings: () => ['dashboard', 'settings'] as const,
};

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
    queryFn: () => client.session(id),
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

/** Invalidate fetchable state after a mutation; the live stream remains separate. */
export function invalidateDashboardQueries(
  queryClient: QueryClient,
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.all });
}
