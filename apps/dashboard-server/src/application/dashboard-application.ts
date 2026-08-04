import type {
  BridgeEvent,
  BrowserSnapshot,
  NotificationEvent,
  RuntimeSnapshot,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { DashboardEventStream } from '../event-stream.js';
import type { MetadataStore } from '../metadata.js';
import type { PushSender } from '../push.js';
import type { RuntimeManager } from '../runtime-manager.js';
import type { RegistryChange, RuntimeRegistry } from '../runtime-registry.js';
import type { SeshAdapter } from '../sesh.js';
import type { SessionIndex } from '../session-index.js';
import type { UsageProvider } from '../usage.js';
import { NotificationService } from './notification-service.js';
import { RuntimeService } from './runtime-service.js';
import { SessionService } from './session-service.js';
import { UploadService } from './upload-service.js';
import { UsageService } from './usage-service.js';
import { WorkspaceService } from './workspace-service.js';

export interface ApplicationChange {
  type: 'event' | 'snapshot';
  event?: BridgeEvent;
  runtimeId?: string;
  runtimeEpoch?: string;
  runtimeSeq?: number;
  snapshot?: RuntimeSnapshot;
}

export interface DashboardApplicationOptions {
  registry: RuntimeRegistry;
  manager: RuntimeManager;
  sessions: SessionIndex;
  metadata: MetadataStore;
  sesh: SeshAdapter;
  usage: UsageProvider;
  push: PushSender;
  stateDir: string;
  eventStream?: DashboardEventStream;
  onChange?: () => void;
}

/** Framework-independent application boundary for the dashboard daemon. */
export class DashboardApplication {
  readonly runtime: RuntimeService;
  readonly sessions: SessionService;
  readonly workspaces: WorkspaceService;
  readonly notifications: NotificationService;
  readonly usage: UsageService;
  readonly uploads: UploadService;
  readonly eventStream: DashboardEventStream;
  private readonly registry: RuntimeRegistry;
  private readonly manager: RuntimeManager;
  private readonly metadata: MetadataStore;
  private readonly sessionIndex: SessionIndex;
  private readonly onChange?: () => void;

  constructor(options: DashboardApplicationOptions) {
    this.registry = options.registry;
    this.manager = options.manager;
    this.metadata = options.metadata;
    this.sessionIndex = options.sessions;
    this.onChange = options.onChange;
    this.eventStream = options.eventStream ?? new DashboardEventStream(256);
    this.runtime = new RuntimeService(
      options.registry,
      options.manager,
      options.sessions,
    );
    this.sessions = new SessionService(options.sessions);
    this.workspaces = new WorkspaceService(
      options.sesh,
      options.manager,
      options.sessions,
      options.metadata,
      options.onChange,
    );
    this.notifications = new NotificationService(
      options.metadata,
      options.push,
    );
    this.usage = new UsageService(options.usage, options.onChange);
    this.uploads = new UploadService(options.stateDir);
  }

  async start(): Promise<void> {
    await this.uploads.start();
    await this.workspaces.refresh();
    await this.sessionsStart();
  }

  async refreshWorkspaces(): Promise<WorkspaceTarget[]> {
    return this.workspaces.refresh();
  }

  setPush(push: PushSender): void {
    this.notifications.setPush(push);
  }

  snapshot(
    serverId: string,
    revision: number,
    cursor = this.eventStream.cursor,
  ): BrowserSnapshot {
    const liveRuntimes = this.registry.snapshots();
    const activeSessions = new Map(
      liveRuntimes
        .filter((runtime) => runtime.online !== false)
        .map((runtime) => [runtime.session.id, runtime.runtimeId]),
    );
    return {
      serverId,
      revision,
      cursor,
      runtimes: liveRuntimes.map((runtime) => ({
        ...runtime,
        session: { ...runtime.session, entries: [] },
      })),
      workspaces: this.workspaces.list(),
      sessions: this.sessions.list().map((session) => {
        const runtime = liveRuntimes.find(
          (item) => item.session.id === session.id && item.online !== false,
        );
        return {
          ...session,
          ...(runtime?.session.name !== undefined
            ? { name: runtime.session.name }
            : {}),
          ...(runtime?.session.title !== undefined
            ? { title: runtime.session.title }
            : {}),
          activeRuntimeId: activeSessions.get(session.id),
        };
      }),
      usage: this.usage.cached(),
      unread: this.metadata.unreadNotifications(),
    };
  }

  onRegistryChange(change: RegistryChange): ApplicationChange {
    if (this.notifications.shouldPersistRuntime(change))
      this.metadata.saveRuntime(change.snapshot);
    this.manager.onRegistryChange(change);
    this.notifications.handle(change);
    this.onChange?.();
    return change.kind === 'event'
      ? {
          type: 'event',
          event: change.event,
          runtimeId: change.runtimeId,
          ...(change.runtimeEpoch === undefined
            ? {}
            : { runtimeEpoch: change.runtimeEpoch }),
          ...(change.runtimeSeq === undefined
            ? {}
            : { runtimeSeq: change.runtimeSeq }),
        }
      : { type: 'snapshot', snapshot: change.snapshot };
  }

  markNotificationRead(id: string): void {
    this.metadata.markNotificationRead(id);
  }

  markAllNotificationsRead(): void {
    this.metadata.markAllNotificationsRead();
  }

  savePushSubscription(
    record: Parameters<MetadataStore['savePushSubscription']>[0],
  ): void {
    this.metadata.savePushSubscription(record);
  }

  async close(): Promise<void> {
    await this.uploads.close();
    this.sessionIndex.close();
    this.eventStream.close();
    this.registry.close();
    this.notifications.close();
    this.metadata.close();
  }

  private async sessionsStart(): Promise<void> {
    // SessionIndex.start is intentionally kept behind the application boundary.
    await this.sessionIndex.start(this.workspaces.list());
  }
}

export type DashboardNotification = NotificationEvent;
