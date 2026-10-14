/// <reference path="./web-push.d.ts" />

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

export interface PushForegroundReport {
  endpoint: string;
  tabId: string;
  visible: boolean;
  focused: boolean;
  sessionId?: string;
  runtimeId?: string;
}

export interface PushSender {
  notify(event: NotificationEvent): Promise<void>;
  clearWaiting?(runtimeId: string): Promise<void>;
  reportForeground?(report: PushForegroundReport): void;
  close?(): void;
}

const FOREGROUND_LEASE_MS = 30_000;
const MAX_FOREGROUND_TABS_PER_SUBSCRIPTION = 32;

type ForegroundClient = Omit<PushForegroundReport, 'endpoint' | 'tabId'> & {
  expiresAt: number;
};

/** Per-process, per-subscription foreground reports with bounded leases. */
export class PushForegroundClients {
  private readonly subscriptions = new Map<
    string,
    Map<string, ForegroundClient>
  >();

  constructor(private readonly now: () => number = Date.now) {}

  update(report: PushForegroundReport): void {
    this.removeExpired();
    let tabs = this.subscriptions.get(report.endpoint);
    if (
      !report.visible ||
      !report.focused ||
      (!report.sessionId && !report.runtimeId)
    ) {
      tabs?.delete(report.tabId);
      if (tabs?.size === 0) this.subscriptions.delete(report.endpoint);
      return;
    }
    if (!tabs) {
      tabs = new Map();
      this.subscriptions.set(report.endpoint, tabs);
    }
    if (
      !tabs.has(report.tabId) &&
      tabs.size >= MAX_FOREGROUND_TABS_PER_SUBSCRIPTION
    )
      return;
    tabs.set(report.tabId, {
      visible: true,
      focused: true,
      ...(report.sessionId ? { sessionId: report.sessionId } : {}),
      ...(report.runtimeId ? { runtimeId: report.runtimeId } : {}),
      expiresAt: this.now() + FOREGROUND_LEASE_MS,
    });
  }

  matches(endpoint: string, event: NotificationEvent): boolean {
    if (event.kind !== 'settled') return false;
    this.removeExpired();
    return [...(this.subscriptions.get(endpoint)?.values() ?? [])].some(
      (client) =>
        client.visible &&
        client.focused &&
        ((event.sessionId && client.sessionId === event.sessionId) ||
          (event.runtimeId && client.runtimeId === event.runtimeId)),
    );
  }

  removeEndpoint(endpoint: string): void {
    this.subscriptions.delete(endpoint);
  }

  clear(): void {
    this.subscriptions.clear();
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [endpoint, tabs] of this.subscriptions) {
      for (const [tabId, client] of tabs)
        if (client.expiresAt <= now) tabs.delete(tabId);
      if (tabs.size === 0) this.subscriptions.delete(endpoint);
    }
  }
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
      reportForeground() {
        /* push is not configured */
      },
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
    const foreground = new PushForegroundClients();
    return {
      reportForeground(report) {
        if (
          metadata
            .pushSubscriptions()
            .some((subscription) => subscription.endpoint === report.endpoint)
        )
          foreground.update(report);
      },
      close() {
        foreground.clear();
      },
      async notify(event) {
        const stale: string[] = [];
        for (const subscription of metadata.pushSubscriptions()) {
          if (foreground.matches(subscription.endpoint, event)) continue;
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
        for (const endpoint of stale) {
          metadata.removePushSubscription(endpoint);
          foreground.removeEndpoint(endpoint);
        }
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
