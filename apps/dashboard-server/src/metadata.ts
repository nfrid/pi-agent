import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  DashboardSettings,
  ModelDisplayPreference,
  ModelDisplayPreferences,
  NotificationEvent,
  RuntimeLocation,
  RuntimeSnapshot,
  SessionIndexEntry,
} from '@pi-dashboard/protocol';
import { credentialHash } from './metadata-credentials.js';
import { runMigrations } from './repositories/migrations.js';
import { SqliteDashboardSettingsRepository } from './repositories/sqlite-dashboard-settings-repository.js';
import { SqliteMetadataRepository } from './repositories/sqlite-metadata-repository.js';
import { SqliteModelDisplayPreferenceRepository } from './repositories/sqlite-model-display-preference-repository.js';
import { SqliteNotificationRepository } from './repositories/sqlite-notification-repository.js';
import { SqliteOrchestrationRepository } from './repositories/sqlite-orchestration-repository.js';
import { SqliteSessionUsageRepository } from './repositories/sqlite-session-usage-repository.js';
import { SqliteUsageHistoryRepository } from './repositories/sqlite-usage-history-repository.js';

export { SqliteOrchestrationRepository } from './repositories/sqlite-orchestration-repository.js';

import type {
  ManagedLaunchIdentity,
  ManagedLaunchRecord,
  PushSubscriptionRecord,
} from './repositories/types.js';

export type {
  ManagedLaunchIdentity,
  ManagedLaunchRecord,
  PushSubscriptionRecord,
} from './repositories/types.js';
export { credentialHash };

/**
 * Compatibility facade for the original metadata API.
 *
 * New code should depend on the narrower repository interfaces. Keeping this
 * facade lets existing runtime/session collaborators migrate independently and
 * keeps the SQLite boundary in one place.
 */
export class MetadataStore {
  readonly db: DatabaseSync;
  readonly metadata: SqliteMetadataRepository;
  readonly modelDisplayPreferences: SqliteModelDisplayPreferenceRepository;
  readonly dashboardSettings: SqliteDashboardSettingsRepository;
  readonly notifications: SqliteNotificationRepository;
  /** Durable project/thread/run state; runtime and transcript storage stay separate. */
  readonly orchestration: SqliteOrchestrationRepository;
  readonly usageHistory: SqliteUsageHistoryRepository;
  readonly sessionUsage: SqliteSessionUsageRepository;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      chmodSync(path.dirname(file), 0o700);
    } catch {
      /* best effort on non-POSIX test hosts */
    }
    this.db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    runMigrations(this.db);
    this.metadata = new SqliteMetadataRepository(this.db);
    this.modelDisplayPreferences = new SqliteModelDisplayPreferenceRepository(
      this.db,
    );
    this.dashboardSettings = new SqliteDashboardSettingsRepository(this.db);
    this.notifications = new SqliteNotificationRepository(this.db);
    this.orchestration = new SqliteOrchestrationRepository(this.db);
    this.usageHistory = new SqliteUsageHistoryRepository(this.db);
    this.sessionUsage = new SqliteSessionUsageRepository(this.db);
  }

  saveRuntime(snapshot: RuntimeSnapshot): void {
    this.metadata.saveRuntime(snapshot);
  }

  saveSession(session: SessionIndexEntry): void {
    this.metadata.saveSession(session);
  }

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
  ): void {
    this.metadata.recordManagedLaunch(
      runtimeId,
      identity,
      location,
      credentials,
    );
  }

  managedLaunches(): ManagedLaunchRecord[] {
    return this.metadata.managedLaunches();
  }

  consumeLaunchCredential(runtimeId: string): void {
    this.metadata.consumeLaunchCredential(runtimeId);
  }

  markManagedStopped(runtimeId: string): void {
    this.metadata.markManagedStopped(runtimeId);
  }

  getDashboardSettings(): DashboardSettings {
    return this.withDashboardDefault(this.modelDisplayPreferences.read());
  }

  private withDashboardDefault(settings: DashboardSettings): DashboardSettings {
    const defaultModel = this.dashboardSettings.readDefaultModel();
    return {
      ...settings,
      ...(defaultModel === undefined ? {} : { defaultModel }),
    };
  }

  updateDashboardDefaultModel(
    model: import('@pi-dashboard/protocol').ModelSelection | null,
  ): DashboardSettings {
    this.dashboardSettings.setDefaultModel(model);
    return this.getDashboardSettings();
  }

  updateModelDisplayPreference(
    modelKey: string,
    preference: ModelDisplayPreference,
  ): DashboardSettings {
    return this.withDashboardDefault(
      this.modelDisplayPreferences.set(modelKey, preference),
    );
  }

  resetModelDisplayPreference(modelKey: string): DashboardSettings {
    return this.withDashboardDefault(
      this.modelDisplayPreferences.reset(modelKey),
    );
  }

  importModelDisplayPreferences(
    preferences: ModelDisplayPreferences,
  ): DashboardSettings {
    return this.withDashboardDefault(
      this.modelDisplayPreferences.importMissing(preferences),
    );
  }

  addNotification(event: NotificationEvent): void {
    this.notifications.addNotification(event);
  }

  unreadNotifications(): NotificationEvent[] {
    return this.notifications.unreadNotifications();
  }

  markNotificationRead(id: string): void {
    this.notifications.markNotificationRead(id);
  }

  markAllNotificationsRead(): void {
    this.notifications.markAllNotificationsRead();
  }

  clearWaitingNotifications(runtimeId: string): void {
    this.notifications.clearWaitingNotifications(runtimeId);
  }

  savePushSubscription(record: PushSubscriptionRecord): void {
    this.notifications.savePushSubscription(record);
  }

  pushSubscriptions(): PushSubscriptionRecord[] {
    return this.notifications.pushSubscriptions();
  }

  removePushSubscription(endpoint: string): void {
    this.notifications.removePushSubscription(endpoint);
  }

  close(): void {
    this.db.close();
  }
}
