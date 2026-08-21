import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  NotificationEvent,
  RuntimeLocation,
  RuntimeSnapshot,
  SessionIndexEntry,
} from '@pi-dashboard/protocol';
import { credentialHash } from './metadata-credentials.js';
import { runMigrations } from './repositories/migrations.js';
import { SqliteMetadataRepository } from './repositories/sqlite-metadata-repository.js';
import { SqliteNotificationRepository } from './repositories/sqlite-notification-repository.js';
import { SqliteOrchestrationRepository } from './repositories/sqlite-orchestration-repository.js';

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
  readonly notifications: SqliteNotificationRepository;
  /** Durable project/thread/run state; runtime and transcript storage stay separate. */
  readonly orchestration: SqliteOrchestrationRepository;

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
    this.notifications = new SqliteNotificationRepository(this.db);
    this.orchestration = new SqliteOrchestrationRepository(this.db);
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
