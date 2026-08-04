import type { DatabaseSync } from 'node:sqlite';
import type { NotificationEvent } from '@pi-dashboard/protocol';
import type {
  NotificationRepository,
  PushSubscriptionRecord,
} from './types.js';

export class SqliteNotificationRepository implements NotificationRepository {
  constructor(private readonly db: DatabaseSync) {}

  addNotification(event: NotificationEvent): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO notification (id,kind,runtime_id,session_id,title,body,created_at,read_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.id,
        event.kind,
        event.runtimeId ?? null,
        event.sessionId ?? null,
        event.title,
        event.body,
        event.createdAt,
        event.readAt ?? null,
      );
  }

  unreadNotifications(): NotificationEvent[] {
    const rows = this.db
      .prepare(
        'SELECT id,kind,runtime_id as runtimeId,session_id as sessionId,title,body,created_at as createdAt,read_at as readAt FROM notification WHERE read_at IS NULL ORDER BY created_at DESC LIMIT 100',
      )
      .all() as Array<
      Omit<NotificationEvent, 'runtimeId' | 'sessionId' | 'readAt'> & {
        runtimeId: string | null;
        sessionId: string | null;
        readAt: number | null;
      }
    >;
    return rows.map(({ runtimeId, sessionId, readAt, ...event }) => ({
      ...event,
      ...(runtimeId === null ? {} : { runtimeId }),
      ...(sessionId === null ? {} : { sessionId }),
      ...(readAt === null ? {} : { readAt }),
    }));
  }

  markNotificationRead(id: string): void {
    this.db
      .prepare('UPDATE notification SET read_at=? WHERE id=?')
      .run(Date.now(), id);
  }

  markAllNotificationsRead(): void {
    this.db
      .prepare('UPDATE notification SET read_at=? WHERE read_at IS NULL')
      .run(Date.now());
  }

  clearWaitingNotifications(runtimeId: string): void {
    this.db
      .prepare(
        "UPDATE notification SET read_at=? WHERE runtime_id=? AND kind='waiting' AND read_at IS NULL",
      )
      .run(Date.now(), runtimeId);
  }

  savePushSubscription(record: PushSubscriptionRecord): void {
    this.db
      .prepare(
        `INSERT INTO push_subscription (endpoint,subscription_json,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json,updated_at=excluded.updated_at`,
      )
      .run(
        record.endpoint,
        JSON.stringify(record.subscription),
        record.createdAt,
        record.updatedAt,
      );
  }

  pushSubscriptions(): PushSubscriptionRecord[] {
    return this.db
      .prepare(
        'SELECT endpoint,subscription_json as subscriptionJson,created_at as createdAt,updated_at as updatedAt FROM push_subscription',
      )
      .all()
      .map((row) => ({
        endpoint: String(row.endpoint),
        subscription: JSON.parse(String(row.subscriptionJson)),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      }));
  }

  removePushSubscription(endpoint: string): void {
    this.db
      .prepare('DELETE FROM push_subscription WHERE endpoint=?')
      .run(endpoint);
  }
}
