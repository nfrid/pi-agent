import type {
  BridgeEvent,
  BrowserSnapshot,
  NotificationEvent,
  RuntimeSnapshot,
  SessionIndexEntry,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { DashboardEventStream } from '../event-stream.js';
import type { MetadataStore } from '../metadata.js';
import type { PushSender } from '../push.js';
import type { SqliteOrchestrationRepository } from '../repositories/sqlite-orchestration-repository.js';
import type { RuntimeManager } from '../runtime-manager.js';
import type { RegistryChange, RuntimeRegistry } from '../runtime-registry.js';
import type { SeshAdapter } from '../sesh.js';
import type { SessionIndex } from '../session-index.js';
import type { UsageProvider } from '../usage.js';
import { ComposerCommandService } from './composer-command-service.js';
import { NotificationService } from './notification-service.js';
import type { OrchestrationService } from './orchestration-service.js';
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
  sessionId?: string;
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
  orchestration?: OrchestrationService;
}

/** Framework-independent application boundary for the dashboard daemon. */
export class DashboardApplication {
  readonly runtime: RuntimeService;
  readonly sessions: SessionService;
  readonly workspaces: WorkspaceService;
  readonly notifications: NotificationService;
  readonly composerCommands: ComposerCommandService;
  readonly usage: UsageService;
  readonly uploads: UploadService;
  readonly eventStream: DashboardEventStream;
  private readonly registry: RuntimeRegistry;
  private readonly manager: RuntimeManager;
  private readonly metadata: MetadataStore;
  readonly orchestration: SqliteOrchestrationRepository;
  private readonly sessionIndex: SessionIndex;
  readonly orchestrationService?: OrchestrationService;

  constructor(options: DashboardApplicationOptions) {
    this.registry = options.registry;
    this.manager = options.manager;
    this.metadata = options.metadata;
    this.orchestration = options.metadata.orchestration;
    this.sessionIndex = options.sessions;
    this.orchestrationService = options.orchestration;
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
    this.composerCommands = new ComposerCommandService();
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

  /** Authoritative session metadata, including live runtime overlays. */
  sessionMetadata(
    liveRuntimes = this.registry.snapshots(),
  ): SessionIndexEntry[] {
    const activeRuntimes = new Map(
      liveRuntimes
        .filter((runtime) => runtime.online !== false)
        .map((runtime) => [runtime.session.id, runtime]),
    );
    return this.sessions.list().map((session) => {
      const runtime = activeRuntimes.get(session.id);
      return {
        ...session,
        ...(runtime?.session.name !== undefined
          ? { name: runtime.session.name }
          : {}),
        ...(runtime?.session.title !== undefined
          ? { title: runtime.session.title }
          : {}),
        activeRuntimeId: runtime?.runtimeId,
      };
    });
  }

  snapshot(
    serverId: string,
    revision: number,
    cursor = this.eventStream.cursor,
  ): BrowserSnapshot {
    const liveRuntimes = this.registry.snapshots();
    return {
      serverId,
      revision,
      cursor,
      runtimes: liveRuntimes.map((runtime) => ({
        ...runtime,
        session: { ...runtime.session, entries: [] },
      })),
      workspaces: this.workspaces.list(),
      projects: this.orchestration.projectSummaries(),
      checkouts: this.orchestration.checkoutSummaries(),
      threads: this.orchestration.threadSummaries(),
      runs: this.orchestration.runSummaries(),
      sessions: this.sessionMetadata(liveRuntimes),
      usage: this.usage.cached(),
      unread: this.metadata.unreadNotifications(),
    };
  }

  onRegistryChange(change: RegistryChange): ApplicationChange {
    this.orchestrationService?.onRegistryChange(change);
    if (this.notifications.shouldPersistRuntime(change))
      this.metadata.saveRuntime(change.snapshot);
    this.manager.onRegistryChange(change);
    this.notifications.handle(change);
    const provenance = {
      ...(change.runtimeEpoch === undefined
        ? {}
        : { runtimeEpoch: change.runtimeEpoch }),
      ...(change.runtimeSeq === undefined
        ? {}
        : { runtimeSeq: change.runtimeSeq }),
    };
    if (change.kind === 'registered' && change.reconnected) {
      const snapshot = {
        ...change.snapshot,
        session: {
          ...change.snapshot.session,
          entries: [],
          entriesComplete: false,
        },
      };
      return {
        type: 'event',
        event: { type: 'runtime.hello', protocolVersion: 1, snapshot },
        runtimeId: snapshot.runtimeId,
        sessionId: snapshot.session.id,
        ...provenance,
      };
    }
    if (change.kind === 'offline')
      return {
        type: 'event',
        event: {
          type: 'runtime.stateChanged',
          state: change.snapshot.liveState,
          snapshot: {
            online: false,
            ...(change.snapshot.lastSeenAt === undefined
              ? {}
              : { lastSeenAt: change.snapshot.lastSeenAt }),
          },
        },
        runtimeId: change.snapshot.runtimeId,
        sessionId: change.snapshot.session.id,
        ...provenance,
      };
    if (change.kind === 'event')
      return {
        type: 'event',
        event: change.event,
        runtimeId: change.runtimeId,
        ...provenance,
      };
    return { type: 'snapshot', snapshot: change.snapshot };
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
    await this.orchestrationService?.stop();
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
