import { createHash } from 'node:crypto';
import type { NotificationEvent } from '@pi-dashboard/protocol';
import type { MetadataStore } from './metadata.js';

/** Web Push topic is capped at 32 UTF-8 bytes by the protocol. */
export function notificationTopic(
  kind: string,
  runtimeId: string | undefined,
  id: string,
): string {
  const input = `${kind}:${runtimeId ?? ''}:${kind === 'waiting' ? 'waiting' : id}`;
  const digest = createHash('sha256').update(input).digest('base64url');
  return `${kind.slice(0, 7)}-${digest.slice(0, 24)}`.slice(0, 32);
}

export interface PushSender {
  notify(event: NotificationEvent): Promise<void>;
  clearWaiting?(runtimeId: string): Promise<void>;
  close?(): void;
}

/** Push is intentionally an optional, failure-isolated adapter. */
export async function createPushSender(
  metadata: MetadataStore,
): Promise<PushSender> {
  const publicKey = process.env.PI_DASHBOARD_VAPID_PUBLIC_KEY;
  const privateKey = process.env.PI_DASHBOARD_VAPID_PRIVATE_KEY;
  const subject =
    process.env.PI_DASHBOARD_VAPID_SUBJECT ?? 'mailto:pi-dashboard@localhost';
  if (!publicKey || !privateKey)
    return {
      async notify() {
        /* not configured; in-app events remain */
      },
      async clearWaiting() {
        /* push is optional */
      },
    };
  try {
    const module = await import('web-push');
    module.default?.setVapidDetails(subject, publicKey, privateKey);
    return {
      async notify(event) {
        const stale: string[] = [];
        for (const subscription of metadata.pushSubscriptions()) {
          try {
            await module.default?.sendNotification(
              subscription.subscription as never,
              JSON.stringify({
                ...event,
                url: event.sessionId
                  ? `/sessions/${encodeURIComponent(event.sessionId)}`
                  : '/',
              }),
              {
                TTL: 60,
                topic: notificationTopic(event.kind, event.runtimeId, event.id),
              },
            );
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410)
              stale.push(subscription.endpoint);
          }
        }
        // Expired subscriptions are removed by the same adapter only. Runtime
        // state/control never awaits this path.
        for (const endpoint of stale)
          metadata.db
            .prepare('DELETE FROM push_subscription WHERE endpoint=?')
            .run(endpoint);
      },
      async clearWaiting(runtimeId) {
        for (const subscription of metadata.pushSubscriptions()) {
          try {
            await module.default?.sendNotification(
              subscription.subscription as never,
              JSON.stringify({ clear: true, runtimeId }),
              {
                TTL: 60,
                topic: notificationTopic(
                  'waiting',
                  runtimeId,
                  `waiting:${runtimeId}`,
                ),
              },
            );
          } catch {
            // A stale/temporarily unavailable push endpoint is handled on the next notification.
          }
        }
      },
    };
  } catch {
    return {
      async notify() {
        /* optional dependency/configuration failure */
      },
      async clearWaiting() {
        /* optional dependency/configuration failure */
      },
    };
  }
}
