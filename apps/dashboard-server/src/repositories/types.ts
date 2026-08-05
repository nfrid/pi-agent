import type {
  NotificationEvent,
  SessionIndexEntry,
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
