/// <reference path="./web-push.d.ts" />

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { NotificationEvent } from '@pi-dashboard/protocol';
import type { MetadataStore } from './metadata.js';
import {
  NATIVE_ENDPOINT,
  NativeNotifications,
} from './native-notifications.js';

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

export interface NotificationPresentation {
  project: string;
  thread: string;
  url: string;
}
export function notificationUrl(
  event: NotificationEvent,
  transport: 'web' | 'native' = 'web',
): string {
  return event.sessionId
    ? `/sessions/${encodeURIComponent(event.sessionId)}`
    : transport === 'native' && event.runtimeId
      ? `/runtimes/${encodeURIComponent(event.runtimeId)}`
      : '/';
}
export interface PushSender {
  native?: NativeNotifications;
  replaceWithNative?(endpoint: string): void;
  notify(
    event: NotificationEvent,
    presentation?: NotificationPresentation,
  ): Promise<void>;
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

  transferEndpoint(endpoint: string, target: string): void {
    this.removeExpired();
    const source = this.subscriptions.get(endpoint);
    if (!source) return;
    const tabs =
      this.subscriptions.get(target) ?? new Map<string, ForegroundClient>();
    for (const [tabId, client] of source) {
      if (tabs.has(tabId) || tabs.size < MAX_FOREGROUND_TABS_PER_SUBSCRIPTION)
        tabs.set(tabId, client);
    }
    this.subscriptions.delete(endpoint);
    this.subscriptions.set(target, tabs);
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
  nativeSocketPath?: string,
): Promise<PushSender> {
  const foreground = new PushForegroundClients();
  const executable = path.join(
    homedir(),
    'Applications/Pi Dashboard Notifications.app/Contents/MacOS/PiNotifications',
  );
  let native: NativeNotifications | undefined;
  if (
    process.platform === 'darwin' &&
    nativeSocketPath &&
    existsSync(executable)
  ) {
    native = new NativeNotifications(nativeSocketPath, executable, foreground);
    try {
      await native.start();
    } catch {
      native.close();
      native = undefined;
    }
  }
  const removeSubscription = (endpoint: string) => {
    metadata.removePushSubscription(endpoint);
    foreground.removeEndpoint(endpoint);
  };
  const wrap = (web: PushSender): PushSender => ({
    native,
    replaceWithNative(endpoint) {
      const subscription = metadata
        .pushSubscriptions()
        .find((value) => value.endpoint === endpoint);
      foreground.transferEndpoint(endpoint, NATIVE_ENDPOINT);
      try {
        removeSubscription(endpoint);
      } catch (error) {
        if (subscription) metadata.savePushSubscription(subscription);
        foreground.transferEndpoint(NATIVE_ENDPOINT, endpoint);
        throw error;
      }
    },
    reportForeground(report) {
      if (report.endpoint === NATIVE_ENDPOINT && native?.isEnabled())
        foreground.update(report);
      else web.reportForeground?.(report);
    },
    async notify(event, presentation) {
      await Promise.allSettled([
        presentation ? native?.notify(event, presentation) : undefined,
        web.notify(event),
      ]);
    },
    clearWaiting: web.clearWaiting,
    close() {
      native?.close();
      foreground.clear();
    },
  });
  const publicKey = process.env.PI_DASHBOARD_VAPID_PUBLIC_KEY;
  const privateKey = process.env.PI_DASHBOARD_VAPID_PRIVATE_KEY;
  const subject =
    process.env.PI_DASHBOARD_VAPID_SUBJECT ?? 'mailto:pi-dashboard@localhost';
  if (!publicKey || !privateKey)
    return wrap({
      reportForeground() {
        /* push is not configured */
      },
      async notify() {
        /* not configured; in-app events remain */
      },
      async clearWaiting() {
        /* push is optional */
      },
    });
  try {
    const module = await import('web-push');
    module.default?.setVapidDetails(subject, publicKey, privateKey);
    return wrap({
      reportForeground(report) {
        if (
          metadata
            .pushSubscriptions()
            .some((subscription) => subscription.endpoint === report.endpoint)
        )
          foreground.update(report);
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
                url: notificationUrl(event),
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
        for (const endpoint of stale) removeSubscription(endpoint);
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
    });
  } catch {
    return wrap({
      async notify() {
        /* optional dependency/configuration failure */
      },
      async clearWaiting() {
        /* optional dependency/configuration failure */
      },
    });
  }
}
